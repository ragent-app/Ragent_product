//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const ownerPolicyTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"

func ownerPolicyAdmin(sid *windows.SID) bool {
	if sid == nil {
		return false
	}
	switch sid.String() {
	case "S-1-5-18", "S-1-5-32-544", ownerPolicyTrustedInstaller:
		return true
	}
	return false
}

// Policy files must not be writable by the control service, the owner or
// another ordinary principal. Ancestors may allow creation of unrelated files,
// but must not allow untrusted deletion or replacement of existing children.
func validateOwnerPolicySecurity(sd *windows.SECURITY_DESCRIPTOR, directory bool) error {
	if sd == nil {
		return errOwnerSessionUnavailable
	}
	owner, _, err := sd.Owner()
	if err != nil || !ownerPolicyAdmin(owner) {
		return errOwnerSessionUnavailable
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return errOwnerSessionUnavailable
	}
	const basic = windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL
	mask := uint32(basic | 0x40) // FILE_DELETE_CHILD on directories
	if !directory {
		mask = uint32(basic | 0x02 | 0x04 | 0x10 | 0x100)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(dacl, i, &ace) != nil || ace == nil {
			return errOwnerSessionUnavailable
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errOwnerSessionUnavailable
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || ownerPolicyAdmin(sid) {
			continue
		}
		if uint32(ace.Mask)&mask != 0 {
			return errOwnerSessionUnavailable
		}
	}
	return nil
}

func openOwnerPolicyPinned(path string, directory bool) (windows.Handle, error) {
	if !filepath.IsAbs(path) || len(filepath.VolumeName(path)) != 2 {
		return 0, errOwnerSessionUnavailable
	}
	path = filepath.Clean(path)
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, errOwnerSessionUnavailable
	}
	flags, share := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT), uint32(windows.FILE_SHARE_READ)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
		share |= windows.FILE_SHARE_WRITE
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, share, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return 0, errOwnerSessionUnavailable
	}
	keep := false
	defer func() {
		if !keep {
			_ = windows.CloseHandle(handle)
		}
	}()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return 0, errOwnerSessionUnavailable
	}
	buffer := make([]uint16, 32768)
	count, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || count == 0 || count >= uint32(len(buffer)) || !strings.EqualFold(windows.UTF16ToString(buffer[:count]), `\\?\`+path) {
		return 0, errOwnerSessionUnavailable
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || validateOwnerPolicySecurity(sd, directory) != nil {
		return 0, errOwnerSessionUnavailable
	}
	keep = true
	return handle, nil
}

// readInstalledOwnerPolicy derives the location from Windows and pins every
// ancestor and the file while parsing; its caller cannot select a path.
func readInstalledOwnerPolicy() (ownerInstallPolicy, error) {
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil || !filepath.IsAbs(programData) {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	return readPinnedOwnerPolicy(filepath.Join(programData, "Ragent", "instances", "owner", "security", "owner-bootstrap-install.json"))
}

func readPinnedOwnerPolicy(path string) (ownerInstallPolicy, error) {
	if !filepath.IsAbs(path) {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	var handles []windows.Handle
	defer func() {
		for i := len(handles) - 1; i >= 0; i-- {
			_ = windows.CloseHandle(handles[i])
		}
	}()
	var ancestors []string
	for dir := filepath.Dir(filepath.Clean(path)); ; dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if dir == filepath.Dir(dir) {
			break
		}
	}
	for i := len(ancestors) - 1; i >= 0; i-- {
		handle, err := openOwnerPolicyPinned(ancestors[i], true)
		if err != nil {
			return ownerInstallPolicy{}, errOwnerSessionUnavailable
		}
		handles = append(handles, handle)
	}
	file, err := openOwnerPolicyPinned(path, false)
	if err != nil {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	handles = append(handles, file)
	data := make([]byte, 8193)
	var used uint32
	for used < uint32(len(data)) {
		var n uint32
		if err := windows.ReadFile(file, data[used:], &n, nil); err != nil {
			return ownerInstallPolicy{}, errOwnerSessionUnavailable
		}
		if n == 0 {
			break
		}
		used += n
	}
	return parseOwnerInstallPolicy(data[:used])
}
