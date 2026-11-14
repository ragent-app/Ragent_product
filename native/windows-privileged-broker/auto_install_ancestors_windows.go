//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const trustedInstallerSID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"

// Derive locations from the installed service executable, never the current
// user's PATH, a request field, or a particular drive letter.
func installedRuntimePaths(executable string) (product, payload, vendor string, err error) {
	if !filepath.IsAbs(executable) || len(filepath.VolumeName(executable)) != 2 {
		return "", "", "", errRuntimeIntegrity
	}
	executable = filepath.Clean(executable)
	broker := filepath.Dir(executable)
	product = filepath.Dir(broker)
	if !strings.EqualFold(filepath.Base(executable), "AgentoC.PrivilegedBroker.exe") || !strings.EqualFold(filepath.Base(broker), "Broker") || product == filepath.Dir(product) {
		return "", "", "", errRuntimeIntegrity
	}
	payload = filepath.Join(product, "payload")
	vendor = filepath.Join(payload, "vendor")
	return product, payload, vendor, nil
}

// Ancestors above the product need not be exclusive, but untrusted users must
// be unable to replace a child or alter its owner/ACL. TrustedInstaller is a
// normal owner for Windows-managed ancestors.
func verifyRuntimeAncestor(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return errRuntimeIntegrity
	}
	attrs, err := windows.GetFileAttributes(name)
	if err != nil || attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errRuntimeIntegrity
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return errRuntimeIntegrity
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || (!isRuntimeAdministrator(owner) && owner.String() != trustedInstallerSID) {
		return errRuntimeIntegrity
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errRuntimeIntegrity
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return errRuntimeIntegrity
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errRuntimeIntegrity
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || sid.String() == "S-1-3-0" || sid.String() == "S-1-3-1" || isRuntimeAdministrator(sid) {
			continue
		}
		if uint32(ace.Mask)&directoryReplacementRights != 0 {
			return errRuntimeIntegrity
		}
	}
	return nil
}

// Installation ancestors retain directory/reparse checks without requiring a
// privileged owner or DACL. Private identity paths use verifyRuntimeAncestor.
func verifyInstallAncestor(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil { return errRuntimeIntegrity }
	attrs, err := windows.GetFileAttributes(name)
	if err != nil || attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 { return errRuntimeIntegrity }
	return nil
}

type installedRuntimePins struct {
	ancestors *runtimePins
	contents  *runtimePins
}

func (p *installedRuntimePins) Close() {
	if p.contents != nil {
		p.contents.Close()
	}
	if p.ancestors != nil {
		p.ancestors.Close()
	}
}

// Do not invoke this with caller-supplied paths. Service startup supplies its
// own executable and the manifest digest embedded by the trusted build.
func pinInstalledRuntime(executable, expectedDigest string) (*installedRuntimePins, string, error) {
	return pinInstalledRuntimeWithAncestorCheck(executable, expectedDigest, verifyInstallAncestor)
}

// The injectable ancestor check is used only by isolated tests whose fixture
// necessarily lives below a developer-writable workspace. Production always
// supplies verifyInstallAncestor above.
func pinInstalledRuntimeWithAncestorCheck(executable, expectedDigest string, checkAncestor func(string) error) (*installedRuntimePins, string, error) {
	if checkAncestor == nil {
		return nil, "", errRuntimeIntegrity
	}
	product, payload, vendor, err := installedRuntimePaths(executable)
	if err != nil {
		return nil, "", err
	}
	pins := &installedRuntimePins{ancestors: &runtimePins{}}
	fail := func() (*installedRuntimePins, string, error) { pins.Close(); return nil, "", errRuntimeIntegrity }
	for _, path := range []string{product, payload} {
		if pins.ancestors.add(path, true) != nil || verifyRuntimeDirectoryACL(path) != nil {
			return fail()
		}
	}
	for path := filepath.Dir(product); ; path = filepath.Dir(path) {
		if checkAncestor(path) != nil {
			return fail()
		}
		if path == filepath.Dir(path) {
			break
		}
	}
	pins.contents, _, err = pinRuntimeWithDirectoryACL(vendor, expectedDigest, nil)
	if err != nil {
		return fail()
	}
	return pins, vendor, nil
}
