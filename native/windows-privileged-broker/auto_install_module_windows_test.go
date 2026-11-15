//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// This test imports only a purpose-built mock. Never use a real package
// manager or -WhatIf here: some WinGet versions perform work despite WhatIf.
func TestAutoInstallModuleScriptWithMock(t *testing.T) {
	pwsh := os.Getenv("RAGENT_TEST_PWSH")
	if pwsh != "" {
		if !filepath.IsAbs(pwsh) {
			t.Fatal("test PowerShell path must be absolute")
		}
	} else {
		var err error
		pwsh, err = exec.LookPath("pwsh.exe")
		if err != nil {
			t.Skip("PowerShell 7 is unavailable")
		}
	}
	dir := t.TempDir()
	module := filepath.Join(dir, "mock.psm1")
	marker := filepath.Join(dir, "called.txt")
	stub := `
function Get-WinGetSource { param($Name) [pscustomobject]@{Name='winget';Type='Microsoft.PreIndexed.Package';Argument=$env:MOCK_URL;TrustLevel='Trusted'} }
function Find-WinGetPackage { param($Id,$Source,$MatchOption) [pscustomobject]@{Id=$Id;Source=$Source;AvailableVersions=@('1.2.3')} }
function Install-WinGetPackage { [CmdletBinding(SupportsShouldProcess)] param($Id,$Version,$Source,$MatchOption,$Mode,$Scope)
  if ($Id -cne 'Vendor.App' -or $Version -cne '1.2.3' -or $Source -cne 'winget' -or $MatchOption -cne 'Equals' -or $Mode -cne 'Silent' -or $Scope -cne 'System') { throw 'bad parameters' }
  [IO.File]::WriteAllText($env:MOCK_MARKER, 'called')
  if ($env:MOCK_RESULT -eq 'failure') { return [pscustomobject]@{Id=$Id;Source=$Source;Status='InstallError';InstallerErrorCode=5;RebootRequired=$false} }
  if ($env:MOCK_RESULT -eq 'reboot') { return [pscustomobject]@{Id=$Id;Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$true} }
  if ($env:MOCK_RESULT -eq 'wrong-id') { return [pscustomobject]@{Id='Other.App';Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$false} }
  if ($env:MOCK_RESULT -eq 'wrong-case') { return [pscustomobject]@{Id='vendor.app';Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$false} }
  if ($env:MOCK_RESULT -eq 'wrong-source') { return [pscustomobject]@{Id=$Id;Source='other';Status='Ok';InstallerErrorCode=0;RebootRequired=$false} }
  [pscustomobject]@{Id=$Id;Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$false}
}



Export-ModuleMember -Function Get-WinGetSource,Find-WinGetPackage,Install-WinGetPackage
`
	if err := os.WriteFile(module, []byte(stub), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, url, version, result string
		exit                       int
		called                     bool
	}{
		{"valid", "https://cdn.winget.microsoft.com/cache", "1.2.3", "ok", 0, true},
		{"substituted source", "https://malicious.example/cache", "1.2.3", "ok", 21, false},
		{"missing version", "https://cdn.winget.microsoft.com/cache", "9.9.9", "ok", 22, false},
		{"failed installation", "https://cdn.winget.microsoft.com/cache", "1.2.3", "failure", 23, true},
		{"restart required", "https://cdn.winget.microsoft.com/cache", "1.2.3", "reboot", 24, true},
		{"wrong result package", "https://cdn.winget.microsoft.com/cache", "1.2.3", "wrong-id", 23, true},
		{"wrong result package case", "https://cdn.winget.microsoft.com/cache", "1.2.3", "wrong-case", 23, true},
		{"wrong result source", "https://cdn.winget.microsoft.com/cache", "1.2.3", "wrong-source", 23, true},
		{"wrong source port", "https://cdn.winget.microsoft.com:444/cache", "1.2.3", "ok", 21, false},
		{"source with userinfo", "https://evil@cdn.winget.microsoft.com/cache", "1.2.3", "ok", 21, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_ = os.Remove(marker)
			cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(autoInstallModuleScript))
			cmd.Env = append(os.Environ(), "RAGENT_INSTALL_PACKAGE_ID=Vendor.App", "RAGENT_INSTALL_PACKAGE_VERSION="+test.version,
				"RAGENT_INSTALL_MODULE="+module, "MOCK_URL="+test.url, "MOCK_MARKER="+marker, "MOCK_RESULT="+test.result)
			output, err := cmd.CombinedOutput()
			actual := 0
			if err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Fatal(err)
				}
				actual = exit.ExitCode()
			}
			if actual != test.exit {
				t.Fatalf("exit %d, expected %d: %s", actual, test.exit, output)
			}
			_, err = os.Stat(marker)
			if (err == nil) != test.called {
				t.Fatalf("installation mock called=%v, expected %v", err == nil, test.called)
			}
		})
	}
	// The ordinary mock has no catalog interface, so a signed selected
	// installer must fail before invoking the installation command.
	_ = os.Remove(marker)
	cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(autoInstallModuleScript))
	cmd.Env = append(os.Environ(), "RAGENT_INSTALL_PACKAGE_ID=Vendor.App", "RAGENT_INSTALL_PACKAGE_VERSION=1.2.3",
		"RAGENT_INSTALL_MODULE="+module, "MOCK_URL=https://cdn.winget.microsoft.com/cache", "MOCK_MARKER="+marker,
		`RAGENT_INSTALL_SELECTED={"id":"Vendor.App","version":"1.2.3","source":"winget","scope":"System","elevation":"ElevationRequired","type":"Msi","nestedType":"Unknown","architecture":"X64","locale":"en-US"}`)
	if err := cmd.Run(); err == nil {
		t.Fatal("missing catalog metadata unexpectedly accepted")
	} else if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 25 {
		t.Fatalf("expected selection failure: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("installer ran without validated metadata")
	}
}

// Read real catalog metadata but replace the installation cmdlet with a local
// marker-writing stub. This test never installs or downloads an application.
func TestOptionalSelectedInstallerAgainstLiveCatalog(t *testing.T) {
	if os.Getenv("RAGENT_TEST_LIVE_WINGET_SELECTED") != "1" {
		t.Skip("live catalog probe is opt-in")
	}
	pwsh, realModule, packageID := os.Getenv("RAGENT_TEST_PWSH"), os.Getenv("RAGENT_TEST_WINGET_MODULE"), os.Getenv("RAGENT_TEST_PACKAGE_ID")
	if !filepath.IsAbs(pwsh) || !filepath.IsAbs(realModule) || !autoInstallPackagePattern.MatchString(packageID) {
		t.Fatal("invalid fixture parameters")
	}
	dir := t.TempDir()
	module, marker := filepath.Join(dir, "mock.psm1"), filepath.Join(dir, "called.txt")
	stub := `
Import-Module $env:RAGENT_TEST_WINGET_MODULE -Force -ErrorAction Stop
function Get-WinGetSource { param($Name) Microsoft.WinGet.Client\Get-WinGetSource -Name $Name -ErrorAction Stop }
function Find-WinGetPackage { param($Id,$Source,$MatchOption) Microsoft.WinGet.Client\Find-WinGetPackage -Id $Id -Source $Source -MatchOption $MatchOption -ErrorAction Stop }
function Install-WinGetPackage { [CmdletBinding(SupportsShouldProcess)] param($Id,$Version,$Source,$MatchOption,$Mode,$Scope)
  [IO.File]::WriteAllText($env:MOCK_MARKER, 'called')
  [pscustomobject]@{Id=$Id;Source=$Source;Status='Ok';InstallerErrorCode=0;RebootRequired=$false}
}
Export-ModuleMember -Function Get-WinGetSource,Find-WinGetPackage,Install-WinGetPackage
`
	if err := os.WriteFile(module, []byte(stub), 0600); err != nil {
		t.Fatal(err)
	}
	prelude := `
$ErrorActionPreference='Stop'
Import-Module $env:RAGENT_TEST_WINGET_MODULE -Force -ErrorAction Stop
$found = @(Find-WinGetPackage -Id $env:RAGENT_TEST_PACKAGE_ID -Source winget -MatchOption Equals -ErrorAction Stop)
if ($found.Count -ne 1) { throw 'package unavailable' }
$property = $found[0].GetType().GetProperty('CatalogPackageCOM',[Reflection.BindingFlags]'Instance,NonPublic')
$catalog = $property.GetValue($found[0]); $version = $catalog.DefaultInstallVersion
$type = $property.PropertyType.Assembly.GetType('Microsoft.Management.Deployment.InstallOptions',$true)
$options = [Activator]::CreateInstance($type); $options.PackageInstallScope = 'System'; $options.PackageInstallMode = 'Silent'
$installer = $version.GetApplicableInstaller($options)
if (-not $installer -or [string]$installer.Scope -cne 'System') { throw 'system installer unavailable' }
$selected = @{id=$version.Id;version=$version.Version;source='winget';scope=[string]$installer.Scope;elevation=[string]$installer.ElevationRequirement;type=[string]$installer.InstallerType;nestedType=[string]$installer.NestedInstallerType;architecture=[string]$installer.Architecture;locale=[string]$installer.Locale}
if ($env:RAGENT_TEST_MUTATE_SELECTED -eq '1') { $selected.architecture = 'tampered' }
$env:RAGENT_INSTALL_SELECTED = $selected | ConvertTo-Json -Compress
$env:RAGENT_INSTALL_PACKAGE_ID = $version.Id; $env:RAGENT_INSTALL_PACKAGE_VERSION = $version.Version; $env:RAGENT_INSTALL_MODULE = $env:MOCK_MODULE
`
	for _, mode := range []string{"match", "mismatch", "inspect"} {
		_ = os.Remove(marker)
		cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(prelude+autoInstallModuleScript))
		value := "0"
		if mode == "mismatch" {
			value = "1"
		}
		cmd.Env = append(os.Environ(), "MOCK_MODULE="+module, "MOCK_MARKER="+marker, "RAGENT_TEST_MUTATE_SELECTED="+value)
		if mode == "inspect" {
			cmd.Env = append(cmd.Env, "RAGENT_INSTALL_INSPECT=1")
		}
		output, err := cmd.CombinedOutput()
		if mode == "mismatch" {
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 25 {
				t.Fatalf("changed selection was not rejected: %v %s", err, output)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("installer ran for changed selection")
			}
		} else if mode == "inspect" {
			if err != nil {
				t.Fatalf("inspection failed: %v %s", err, output)
			}
			var facts selectedInstallerFacts
			if err := json.Unmarshal(output, &facts); err != nil || facts.ID != packageID || facts.Scope != "System" {
				t.Fatalf("invalid inspection output: %v %s", err, output)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("read-only inspection invoked installer")
			}
		} else {
			if err != nil {
				t.Fatalf("matching selection failed: %v %s", err, output)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatalf("matching selection did not reach stub: %v", err)
			}
		}
	}
}

// Inspect the staged vendor module's command contract without looking up or
// installing any package. This catches drift that a mock alone cannot prove.
func TestOptionalStagedWinGetModuleContract(t *testing.T) {
	pwsh, module := os.Getenv("RAGENT_TEST_PWSH"), os.Getenv("RAGENT_TEST_WINGET_MODULE")
	if pwsh == "" || module == "" {
		t.Skip("staged PowerShell and module paths not supplied")
	}
	if !filepath.IsAbs(pwsh) || !filepath.IsAbs(module) {
		t.Fatal("staged paths must be absolute")
	}
	script := `
$ErrorActionPreference = 'Stop'
Import-Module -Name $env:RAGENT_TEST_WINGET_MODULE -Force -ErrorAction Stop
$install = Get-Command Install-WinGetPackage -ErrorAction Stop
$find = Get-Command Find-WinGetPackage -ErrorAction Stop
$source = Get-Command Get-WinGetSource -ErrorAction Stop
foreach ($name in @('Id','Version','Source','MatchOption','Mode','Scope')) { if (-not $install.Parameters.ContainsKey($name)) { throw 'install parameter missing' } }
foreach ($name in @('Id','Source','MatchOption')) { if (-not $find.Parameters.ContainsKey($name)) { throw 'find parameter missing' } }
if (-not $source.Parameters.ContainsKey('Name')) { throw 'source parameter missing' }
if ([Enum]::GetNames($find.Parameters['MatchOption'].ParameterType) -cnotcontains 'Equals') { throw 'exact match unavailable' }
if ([Enum]::GetNames($install.Parameters['Mode'].ParameterType) -cnotcontains 'Silent') { throw 'silent mode unavailable' }
if ([Enum]::GetNames($install.Parameters['Scope'].ParameterType) -cnotcontains 'System') { throw 'system scope unavailable' }
$result = $install.OutputType[0].Type
foreach ($name in @('Id','Source','Status','InstallerErrorCode','RebootRequired')) { if ($null -eq $result.GetProperty($name)) { throw 'result property missing' } }
$package = $find.OutputType[0].Type
foreach ($name in @('Id','Source','AvailableVersions')) { if ($null -eq $package.GetProperty($name)) { throw 'package property missing' } }
`
	cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(script))
	cmd.Env = append(os.Environ(), "RAGENT_TEST_WINGET_MODULE="+module)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("staged module contract failed: %v %s", err, output)
	}
}
