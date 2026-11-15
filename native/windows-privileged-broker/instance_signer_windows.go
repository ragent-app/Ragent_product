//go:build windows

package main

import (
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func isIdentityPrincipal(sid, control *windows.SID) bool {
	return sid != nil && (isRuntimeAdministrator(sid) || (control != nil && sid.Equals(control)))
}

// The control-plane service must be able to maintain its own identity; other
// non-administrative principals must not be able to modify the directory or
// read or modify the private identity file.
func verifyInstanceIdentityACL(path string, control *windows.SID, file bool) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errAutoInstallGrant
	}
	owner, _, err := sd.Owner()
	if err != nil || !isIdentityPrincipal(owner, control) {
		return errAutoInstallGrant
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errAutoInstallGrant
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return errAutoInstallGrant
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errAutoInstallGrant
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || isIdentityPrincipal(sid, control) {
			continue
		}
		mask := uint32(ace.Mask)
		if mask&runtimeDirectoryMutationRights != 0 || (file && mask&(windows.GENERIC_READ|windows.GENERIC_ALL|0x00000001|0x00000008) != 0) {
			return errAutoInstallGrant
		}
	}
	return nil
}

// The path is derived from Windows' ProgramData known folder, not an argument
// supplied by a run. Handles are held while the bounded identity is read.
func readInstalledInstanceSigner() (string, string, error) {
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil || !filepath.IsAbs(programData) {
		return "", "", errAutoInstallGrant
	}
	control, _, _, err := windows.LookupSID("", `NT SERVICE\Ragent-ControlPlane`)
	if err != nil {
		return "", "", errAutoInstallGrant
	}
	config := filepath.Join(programData, "Ragent", "instances", "owner", "config")
	return readPinnedInstanceSigner(config, control, verifyRuntimeAncestor)
}

func readPinnedInstanceSigner(config string, control *windows.SID, checkAncestor func(string) error) (string, string, error) {
	if control == nil || checkAncestor == nil || !filepath.IsAbs(config) {
		return "", "", errAutoInstallGrant
	}
	pins := &runtimePins{}
	defer pins.Close()
	if pins.add(config, true) != nil || verifyInstanceIdentityACL(config, control, false) != nil {
		return "", "", errAutoInstallGrant
	}
	identity := filepath.Join(config, "instance-identity.json")
	if pins.add(identity, false) != nil || verifyInstanceIdentityACL(identity, control, true) != nil {
		return "", "", errAutoInstallGrant
	}
	for path := filepath.Dir(config); ; path = filepath.Dir(path) {
		if checkAncestor(path) != nil {
			return "", "", errAutoInstallGrant
		}
		if path == filepath.Dir(path) {
			break
		}
	}
	info, err := os.Lstat(identity)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64*1024 {
		return "", "", errAutoInstallGrant
	}
	data, err := os.ReadFile(identity)
	if err != nil {
		return "", "", errAutoInstallGrant
	}
	defer func() {
		for i := range data {
			data[i] = 0
		}
	}()
	return instanceSignerFromJSON(data)
}
