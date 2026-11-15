//go:build windows

package main

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type ownerSystemFolders struct {
	programData, programFiles, programFilesX86, programFilesX64 string
}

// Resolve machine-owned locations from Windows, not the owner's mutable
// environment. Missing known folders are omitted rather than guessed.
func installedOwnerSystemFolders() ownerSystemFolders {
	known := func(id *windows.KNOWNFOLDERID) string {
		value, err := windows.KnownFolderPath(id, windows.KF_FLAG_DEFAULT)
		if err != nil || !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
			return ""
		}
		return value
	}
	return ownerSystemFolders{
		programData: known(windows.FOLDERID_ProgramData), programFiles: known(windows.FOLDERID_ProgramFiles),
		programFilesX86: known(windows.FOLDERID_ProgramFilesX86), programFilesX64: known(windows.FOLDERID_ProgramFilesX64),
	}
}

// ownerInstallEnvironment takes profile paths only from CreateEnvironmentBlock
// for the verified owner token. It deliberately excludes PATH, PowerShell and
// .NET startup variables and all caller-supplied variables.
func ownerInstallEnvironment(userEnvironment []string, root, systemDir, vendor string) ([]string, error) {
	return ownerInstallEnvironmentWithFolders(userEnvironment, root, systemDir, vendor, installedOwnerSystemFolders())
}

func ownerInstallEnvironmentWithFolders(userEnvironment []string, root, systemDir, vendor string, folders ownerSystemFolders) ([]string, error) {
	for _, value := range []string{root, systemDir, vendor} {
		if !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
			return nil, errOwnerSessionUnavailable
		}
	}
	keys := map[string]string{"USERPROFILE": "", "LOCALAPPDATA": "", "APPDATA": "", "TEMP": "", "TMP": ""}
	seen := make(map[string]bool)
	for _, item := range userEnvironment {
		key, value, ok := strings.Cut(item, "=")
		key = strings.ToUpper(key)
		if _, wanted := keys[key]; !ok || !wanted {
			continue
		}
		if seen[key] || !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
			return nil, errOwnerSessionUnavailable
		}
		seen[key] = true
		keys[key] = value
	}
	if keys["USERPROFILE"] == "" || keys["LOCALAPPDATA"] == "" || keys["APPDATA"] == "" {
		return nil, errOwnerSessionUnavailable
	}
	// The user's profile may be on a non-system drive or a redirected share.
	// Don't substitute the service account's temporary directory.
	if keys["TEMP"] == "" {
		keys["TEMP"] = filepath.Join(keys["LOCALAPPDATA"], "Temp")
	}
	if keys["TMP"] == "" {
		keys["TMP"] = keys["TEMP"]
	}
	values := []string{"SystemRoot=" + root, "WINDIR=" + root, "SystemDrive=" + filepath.VolumeName(root),
		"PATH=" + systemDir, "ComSpec=" + filepath.Join(systemDir, "cmd.exe"), "PATHEXT=.COM;.EXE;.BAT;.CMD",
		"PSModulePath=" + filepath.Join(vendor, "PowerShell", "Modules"),
		"POWERSHELL_TELEMETRY_OPTOUT=1", "DOTNET_CLI_TELEMETRY_OPTOUT=1",
		"RAGENT_INSTALL_MODULE=" + filepath.Join(vendor, "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1")}
	for _, key := range []string{"USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"} {
		values = append(values, key+"="+keys[key])
	}
	for _, entry := range []struct{ key, value string }{
		{"ProgramData", folders.programData}, {"ProgramFiles", folders.programFiles},
		{"ProgramFiles(x86)", folders.programFilesX86}, {"ProgramW6432", folders.programFilesX64},
	} {
		if entry.value != "" {
			if !filepath.IsAbs(entry.value) || strings.ContainsRune(entry.value, 0) {
				return nil, errOwnerSessionUnavailable
			}
			values = append(values, entry.key+"="+entry.value)
		}
	}
	return values, nil
}
