//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"golang.org/x/sys/windows"
)

// Runs the actual process launcher and fixed installation script with the
// staged PowerShell, but replaces WinGet with an inert local fixture module.
// No software is installed and runtime trust is injected only for this test.
func TestSystemAutoInstallLiveProcessMock(t *testing.T) {
	pwsh := os.Getenv("RAGENT_TEST_PWSH")
	if !filepath.IsAbs(pwsh) {
		t.Skip("packaged PowerShell path not supplied")
	}
	dir := t.TempDir()
	vendor := filepath.Join(dir, "vendor")
	psDir := filepath.Join(vendor, "PowerShell")
	moduleDir := filepath.Join(vendor, "Microsoft.WinGet.Client")
	for _, name := range []string{psDir, moduleDir} {
		if err := os.MkdirAll(name, 0700); err != nil {
			t.Fatal(err)
		}
	}
	// The wrapper forwards the launcher's exact arguments and environment to
	// the real staged PowerShell, while requiring the startup-hook filter.
	program := fmt.Sprintf(`package main
import("os";"os/exec")
func main(){
 if os.Getenv("DOTNET_STARTUP_HOOKS")!="" || os.Getenv("RAGENT_INSTALL_PACKAGE_ID")!="Vendor.App" || os.Getenv("RAGENT_INSTALL_PACKAGE_VERSION")!="1.2.3" {os.Exit(31)}
 c:=exec.Command(%s,os.Args[1:]...); c.Env=os.Environ(); c.Stdout=os.Stdout;c.Stderr=os.Stderr
 if e:=c.Run();e!=nil {if x,ok:=e.(*exec.ExitError);ok {os.Exit(x.ExitCode())};os.Exit(32)}
}`, strconv.Quote(pwsh))
	source := filepath.Join(dir, "fixture.go")
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-trimpath", "-o", filepath.Join(psDir, "pwsh.exe"), source)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v: %s", err, output)
	}
	manifest := `@{ RootModule='mock.psm1'; ModuleVersion='1.0'; GUID='7895c776-1a17-4517-bbbf-935d3272906a'; FunctionsToExport=@('Get-WinGetSource','Find-WinGetPackage','Install-WinGetPackage') }`
	module := `
function Get-WinGetSource { param($Name) [pscustomobject]@{Name='winget';Type='Microsoft.PreIndexed.Package';Argument='https://cdn.winget.microsoft.com/cache';TrustLevel='Trusted'} }
function Find-WinGetPackage { param($Id,$Source,$MatchOption) [pscustomobject]@{Id=$Id;Source=$Source;AvailableVersions=@('1.2.3')} }
function Install-WinGetPackage { [CmdletBinding(SupportsShouldProcess)] param($Id,$Version,$Source,$MatchOption,$Mode,$Scope)
 if($Id -cne 'Vendor.App' -or $Version -cne '1.2.3' -or $Source -cne 'winget' -or $MatchOption -cne 'Equals' -or $Mode -cne 'Silent' -or $Scope -cne 'System') { throw 'incorrect install parameters' }
 [IO.File]::WriteAllText((Join-Path $env:TEMP 'fixture-receipt'),'called')
 [pscustomobject]@{Id=$Id;Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$false}
}
Export-ModuleMember -Function Get-WinGetSource,Find-WinGetPackage,Install-WinGetPackage`
	if err := os.WriteFile(filepath.Join(moduleDir, "Microsoft.WinGet.Client.psd1"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "mock.psm1"), []byte(module), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DOTNET_STARTUP_HOOKS", "must-not-reach-child")
	closed := false
	installer := windowsAutoInstaller{
		acquire: func() (runtimeLease, error) {
			return runtimeLease{vendor: vendor, close: func() { closed = true }}, nil
		},
		paths: func() (string, string, string, error) { return root, systemDir, dir, nil },
	}
	status, code := installer.Install(context.Background(), autoInstallGrant{PackageID: "Vendor.App", VersionID: "1.2.3", Source: "winget", InstallScope: "machine"})
	if status != statusSucceeded || code != "AUTO_INSTALL_SUCCEEDED" || !closed {
		probe := exec.Command(filepath.Join(psDir, "pwsh.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellScript(autoInstallModuleScript))
		probe.Dir = systemDir
		probe.Env = autoInstallEnvironment(vendor, root, systemDir, dir, autoInstallGrant{PackageID: "Vendor.App", VersionID: "1.2.3"})
		output, probeErr := probe.CombinedOutput()
		t.Fatalf("unexpected outcome %s/%s, lease closed=%v; probe: %v %s", status, code, closed, probeErr, output)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "fixture-receipt")); err != nil || string(data) != "called" {
		t.Fatalf("fixture receipt missing: %v", err)
	}
}
