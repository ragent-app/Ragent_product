//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	stateBrokerDirectory = "Ragent-PrivilegedBroker"
	stateFileName        = "state.json"
)

func brokerStateDirectory() (string, error) {
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return "", fmt.Errorf("resolve ProgramData: %w", err)
	}
	return filepath.Join(programData, stateBrokerDirectory), nil
}

func ensureBrokerStateDirectory(path string, brokerSID *windows.SID) error {
	if brokerSID == nil {
		return errors.New("APB_BROKER_SERVICE_SID_UNAVAILABLE")
	}
	expectedDirectory, err := brokerStateDirectory()
	if err != nil || !strings.EqualFold(filepath.Clean(path), filepath.Clean(expectedDirectory)) {
		return errors.New("APB_STATE_PATH_REFUSED")
	}
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return errors.New("APB_PROGRAMDATA_UNAVAILABLE")
	}
	if err := verifyAncestorACL(programData); err != nil {
		return err
	}
	if _, err := windows.GetFileAttributes(mustUTF16(path)); err == nil {
		return nil
	} else if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return errors.New("APB_STATE_DIRECTORY_UNAVAILABLE")
	}

	sd, err := brokerStateDirectorySecurityDescriptor(brokerSID)
	if err != nil {
		return errors.New("APB_STATE_DACL_PREPARE_FAILED")
	}
	attributes := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}
	if err := windows.CreateDirectory(mustUTF16(path), &attributes); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return errors.New("APB_STATE_DIRECTORY_CREATE_FAILED")
	}
	return nil
}

func brokerStateDirectorySecurityDescriptor(brokerSID *windows.SID) (*windows.SECURITY_DESCRIPTOR, error) {
	if brokerSID == nil {
		return nil, errors.New("APB_BROKER_SERVICE_SID_UNAVAILABLE")
	}
	sddl := fmt.Sprintf("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%s)", brokerSID.String())
	return windows.SecurityDescriptorFromString(sddl)
}

func verifyProtectedStateDirectory(path string, brokerSID *windows.SID) error {
	expectedDirectory, err := brokerStateDirectory()
	if err != nil || !strings.EqualFold(filepath.Clean(path), filepath.Clean(expectedDirectory)) {
		return errors.New("APB_STATE_PATH_REFUSED")
	}
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return errors.New("APB_PROGRAMDATA_UNAVAILABLE")
	}
	for _, directory := range []string{programData, path} {
		attributes, err := windows.GetFileAttributes(mustUTF16(directory))
		if err != nil || attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("APB_STATE_ANCESTOR_REFUSED")
		}
	}
	if err := verifyAncestorACL(programData); err != nil {
		return err
	}
	if err := verifyStateRootACL(path, brokerSID); err != nil {
		return err
	}
	statePath := filepath.Join(path, stateFileName)
	if attributes, err := windows.GetFileAttributes(mustUTF16(statePath)); err == nil {
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
			return errors.New("APB_STATE_FILE_REPARSE_REFUSED")
		}
		if err := verifyStateFileACL(statePath, brokerSID); err != nil {
			return err
		}
	} else if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		return errors.New("APB_STATE_FILE_UNAVAILABLE")
	}
	return nil
}

func verifyAncestorACL(path string) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errors.New("APB_STATE_ANCESTOR_ACL_UNAVAILABLE")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errors.New("APB_STATE_ANCESTOR_DACL_UNAVAILABLE")
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil || ace == nil {
			return errors.New("APB_STATE_ANCESTOR_ACE_UNAVAILABLE")
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("APB_STATE_ANCESTOR_ACE_UNSUPPORTED")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ancestorACECanReplacePath(sid, uint32(ace.Mask), ace.Header.AceFlags) {
			return errors.New("APB_STATE_ANCESTOR_WRITABLE")
		}
	}
	return nil
}

func ancestorACECanReplacePath(sid *windows.SID, mask uint32, flags uint8) bool {
	if sid == nil || flags&windows.INHERIT_ONLY_ACE != 0 {
		return false
	}
	// These well-known SIDs are placeholders which are substituted on child
	// object creation; they do not grant access to the ancestor itself.
	if sid.String() == "S-1-3-0" || sid.String() == "S-1-3-1" {
		return false
	}
	return !trustedStatePrincipal(sid) && mask&directoryReplacementRights != 0
}

const directoryReplacementRights = windows.DELETE |
	0x00000040 | // FILE_DELETE_CHILD
	windows.WRITE_DAC |
	windows.WRITE_OWNER |
	windows.GENERIC_WRITE |
	windows.GENERIC_ALL

func trustedStatePrincipal(sid *windows.SID) bool {
	if sid == nil {
		return false
	}
	if sid.String() == "S-1-5-18" {
		return true
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	return err == nil && sid.Equals(adminSID)
}

func verifyStateRootACL(path string, brokerSID *windows.SID) error {
	if brokerSID == nil {
		return errors.New("APB_BROKER_SERVICE_SID_UNAVAILABLE")
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return errors.New("APB_STATE_ACL_UNAVAILABLE")
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("APB_STATE_DACL_INHERITED")
	}
	owner, _, err := sd.Owner()
	if err != nil || (owner.String() != "S-1-5-18" && !isLocalAdministratorsSID(owner)) {
		return errors.New("APB_STATE_OWNER_REFUSED")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount != 3 {
		return errors.New("APB_STATE_DACL_REFUSED")
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return errors.New("APB_STATE_ADMIN_SID_UNAVAILABLE")
	}
	fullAccess := uint32(0x001F01FF)
	principals := map[string]bool{"S-1-5-18": false, adminSID.String(): false, brokerSID.String(): false}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil || ace == nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("APB_STATE_DACL_REFUSED")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		sidString := sid.String()
		if _, trusted := principals[sidString]; !trusted || principals[sidString] || uint32(ace.Mask) != fullAccess || ace.Header.AceFlags != 0x03 {
			return errors.New("APB_STATE_DACL_REFUSED")
		}
		principals[sidString] = true
	}
	for _, granted := range principals {
		if !granted {
			return errors.New("APB_STATE_DACL_REFUSED")
		}
	}
	return nil
}

func verifyStateFileACL(path string, brokerSID *windows.SID) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return errors.New("APB_STATE_FILE_ACL_UNAVAILABLE")
	}
	owner, _, err := sd.Owner()
	if err != nil || (owner.String() != "S-1-5-18" && !isLocalAdministratorsSID(owner)) {
		return errors.New("APB_STATE_FILE_OWNER_REFUSED")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errors.New("APB_STATE_FILE_DACL_UNAVAILABLE")
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return errors.New("APB_STATE_ADMIN_SID_UNAVAILABLE")
	}
	fullAccess := uint32(0x001F01FF)
	fullControl := map[string]bool{"S-1-5-18": false, adminSID.String(): false, brokerSID.String(): false}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil || ace == nil {
			return errors.New("APB_STATE_FILE_ACE_UNAVAILABLE")
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("APB_STATE_FILE_ACE_UNSUPPORTED")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		sidString := sid.String()
		if _, trusted := fullControl[sidString]; !trusted {
			return errors.New("APB_STATE_FILE_ACL_REFUSED")
		}
		if uint32(ace.Mask)&fullAccess == fullAccess {
			fullControl[sidString] = true
		}
	}
	for _, granted := range fullControl {
		if !granted {
			return errors.New("APB_STATE_FILE_ACCESS_INCOMPLETE")
		}
	}
	return nil
}

func isLocalAdministratorsSID(sid *windows.SID) bool {
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	return err == nil && sid != nil && sid.Equals(adminSID)
}

func mustUTF16(value string) *uint16 {
	pointer, err := windows.UTF16PtrFromString(value)
	if err != nil {
		panic(err)
	}
	return pointer
}

func ensureRegularStateFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || info.IsDir() {
		return errors.New("APB_STATE_FILE_REFUSED")
	}
	return nil
}
