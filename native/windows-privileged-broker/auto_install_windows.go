//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

type autoInstaller interface {
	Install(context.Context, autoInstallGrant) (requestStatus, string)
}

type runtimeLease struct {
	vendor string
	close  func()
}

type windowsAutoInstaller struct {
	acquire func() (runtimeLease, error)
	run     func(context.Context, string, []string, []string, string) (int, error)
	inspect func(context.Context, string, []string, []string, string) ([]byte, error)
	paths   func() (string, string, string, error)
}

func (installer windowsAutoInstaller) systemPaths() (string, string, string, error) {
	if installer.paths != nil {
		return installer.paths()
	}
	root, rootErr := windows.GetWindowsDirectory()
	systemDir, systemErr := windows.GetSystemDirectory()
	tempDir, tempErr := brokerStateDirectory()
	if rootErr != nil || systemErr != nil || tempErr != nil {
		return "", "", "", errRuntimeIntegrity
	}
	return root, systemDir, tempDir, nil
}

type boundedInspectOutput struct{ bytes.Buffer }

func (output *boundedInspectOutput) Write(data []byte) (int, error) {
	if output.Len()+len(data) > 64*1024 {
		return 0, errors.New("inspection output too large")
	}
	return output.Buffer.Write(data)
}

func runAutoInstallInspection(ctx context.Context, executable string, args, env []string, cwd string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir, cmd.Env = cwd, env
	var output boundedInspectOutput
	cmd.Stdout, cmd.Stderr = &output, io.Discard
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// Inspect obtains selected metadata using the pinned service runtime and the
// same system-scope options as installation. This read-only operation cannot
// authorize or launch an installer.
func (installer windowsAutoInstaller) Inspect(parent context.Context, packageID, versionID string) (*selectedInstallerFacts, error) {
	grant := autoInstallGrant{PackageID: packageID, VersionID: versionID, Source: "winget", InstallScope: "machine"}
	if !autoInstallPackagePattern.MatchString(packageID) || !autoInstallVersionPattern.MatchString(versionID) {
		return nil, errAutoInstallGrant
	}
	lease, err := installer.acquireRuntime()
	if err != nil || lease.close == nil || !filepath.IsAbs(lease.vendor) {
		if lease.close != nil {
			lease.close()
		}
		return nil, errRuntimeIntegrity
	}
	defer lease.close()
	root, systemDir, tempDir, pathsErr := installer.systemPaths()
	if pathsErr != nil || !filepath.IsAbs(root) || !filepath.IsAbs(systemDir) || !filepath.IsAbs(tempDir) {
		return nil, errRuntimeIntegrity
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	env := append(autoInstallEnvironment(lease.vendor, root, systemDir, tempDir, grant), "RAGENT_INSTALL_INSPECT=1")
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellScript(autoInstallModuleScript)}
	run := installer.inspect
	if run == nil {
		run = runAutoInstallInspection
	}
	data, err := run(ctx, filepath.Join(lease.vendor, "PowerShell", "pwsh.exe"), args, env, systemDir)
	if err != nil || len(data) > 64*1024 {
		return nil, errRuntimeIntegrity
	}
	var facts selectedInstallerFacts
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&facts) != nil {
		return nil, errRuntimeIntegrity
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errRuntimeIntegrity
	}
	grant.SelectedInstaller = &facts
	if !validInspectedInstaller(grant) {
		return nil, errRuntimeIntegrity
	}
	return &facts, nil
}

func acquireInstalledAutoRuntime() (runtimeLease, error) {
	executable, err := os.Executable()
	if err != nil {
		return runtimeLease{}, errRuntimeIntegrity
	}
	pins, vendor, err := pinInstalledRuntime(executable, windowsRuntimeManifestSHA256)
	if err != nil {
		return runtimeLease{}, err
	}
	return runtimeLease{vendor: vendor, close: pins.Close}, nil
}

func (installer windowsAutoInstaller) acquireRuntime() (runtimeLease, error) {
	if installer.acquire != nil {
		return installer.acquire()
	}
	return acquireInstalledAutoRuntime()
}

func (installer windowsAutoInstaller) Available() bool {
	lease, err := installer.acquireRuntime()
	if err != nil || lease.close == nil || !filepath.IsAbs(lease.vendor) {
		if lease.close != nil {
			lease.close()
		}
		return false
	}
	if lease.close != nil {
		lease.close()
	}
	return true
}

func encodePowerShellScript(value string) string {
	units := utf16.Encode([]rune(value))
	encoded := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(encoded[i*2:], unit)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

func runAutoInstallProcess(ctx context.Context, executable string, args, env []string, cwd string) (int, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir, cmd.Env = cwd, env
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), err
	}
	return -1, err
}

// The SYSTEM service inherits only a small set of operating-system locations;
// it must not propagate arbitrary PowerShell or .NET startup hooks.
func autoInstallEnvironment(vendor, root, systemDir, tempDir string, grant autoInstallGrant) []string {
	values := []string{"SystemRoot=" + root, "WINDIR=" + root, "PATH=" + systemDir,
		"TEMP=" + tempDir, "TMP=" + tempDir,
		"PSModulePath=" + filepath.Join(vendor, "PowerShell", "Modules"),
		"POWERSHELL_TELEMETRY_OPTOUT=1", "DOTNET_CLI_TELEMETRY_OPTOUT=1",
		"RAGENT_INSTALL_PACKAGE_ID=" + grant.PackageID, "RAGENT_INSTALL_PACKAGE_VERSION=" + grant.VersionID,
		"RAGENT_INSTALL_MODULE=" + filepath.Join(vendor, "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1")}
	if grant.SelectedInstaller != nil {
		if selected, err := json.Marshal(grant.SelectedInstaller); err == nil {
			values = append(values, "RAGENT_INSTALL_SELECTED="+string(selected))
		}
	}
	for _, key := range []string{"ProgramData", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive", "PROCESSOR_ARCHITECTURE"} {
		if value := os.Getenv(key); value != "" {
			values = append(values, key+"="+value)
		}
	}
	return values
}

func (installer windowsAutoInstaller) Install(parent context.Context, grant autoInstallGrant) (requestStatus, string) {
	if !autoInstallPackagePattern.MatchString(grant.PackageID) || !autoInstallVersionPattern.MatchString(grant.VersionID) || grant.Source != "winget" || grant.InstallScope != "machine" || (grant.SelectedInstaller != nil && !validSelectedInstaller(grant)) {
		return statusFailed, "AUTO_INSTALL_INVALID"
	}
	lease, err := installer.acquireRuntime()
	if err != nil || lease.close == nil || !filepath.IsAbs(lease.vendor) {
		if lease.close != nil {
			lease.close()
		}
		return statusFailed, "AUTO_INSTALL_RUNTIME_UNTRUSTED"
	}
	defer lease.close()
	root, systemDir, tempDir, pathsErr := installer.systemPaths()
	if pathsErr != nil || !filepath.IsAbs(root) || !filepath.IsAbs(systemDir) || !filepath.IsAbs(tempDir) {
		return statusFailed, "AUTO_INSTALL_SYSTEM_UNAVAILABLE"
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	executable := filepath.Join(lease.vendor, "PowerShell", "pwsh.exe")
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellScript(autoInstallModuleScript)}
	run := installer.run
	if run == nil {
		run = runAutoInstallProcess
	}
	exitCode, runErr := run(ctx, executable, args, autoInstallEnvironment(lease.vendor, root, systemDir, tempDir, grant), systemDir)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) {
		return statusUnknown, "AUTO_INSTALL_OUTCOME_UNKNOWN"
	}
	if runErr == nil && exitCode == 0 {
		return statusSucceeded, "AUTO_INSTALL_SUCCEEDED"
	}
	switch exitCode {
	case 20:
		return statusFailed, "AUTO_INSTALL_MODULE_UNAVAILABLE"
	case 21:
		return statusFailed, "AUTO_INSTALL_SOURCE_UNVERIFIED"
	case 22:
		return statusFailed, "AUTO_INSTALL_PACKAGE_UNAVAILABLE"
	case 24:
		return statusUnknown, "AUTO_INSTALL_REBOOT_REQUIRED"
	case 25:
		return statusFailed, "AUTO_INSTALL_SELECTION_CHANGED"
	default:
		return statusFailed, "AUTO_INSTALL_FAILED"
	}
}
