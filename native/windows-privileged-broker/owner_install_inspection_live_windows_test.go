//go:build windows

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Opt-in read-only contract test against a staged Microsoft module. It does
// not run an installer, change package sources, or modify user software.
func TestOwnerInstallScriptLiveInspection(t *testing.T) {
	pwsh, module := os.Getenv("RAGENT_QA_PWSH"), os.Getenv("RAGENT_QA_WINGET_MODULE")
	id, version := os.Getenv("RAGENT_QA_PACKAGE_ID"), os.Getenv("RAGENT_QA_PACKAGE_VERSION")
	if pwsh == "" || module == "" || id == "" || version == "" {
		t.Skip("staged runtime, package ID and version required")
	}
	for _, scope := range []string{"default", "user"} {
		t.Run(scope, func(t *testing.T) {
			cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(ownerInstallScript))
			cmd.Env = append(os.Environ(), "RAGENT_INSTALL_PACKAGE_ID="+id, "RAGENT_INSTALL_PACKAGE_VERSION="+version,
				"RAGENT_INSTALL_MODULE="+module, "RAGENT_INSTALL_SCOPE="+scope, "RAGENT_INSTALL_INSPECT=1")
			output, err := cmd.Output()
			if err != nil {
				t.Fatalf("inspection failed: %v", err)
			}
			var facts selectedInstallerFacts
			if err := json.Unmarshal(output, &facts); err != nil || !validInstallerFacts(&facts, id, version) {
				t.Fatalf("invalid selected installer: %s (%v)", output, err)
			}
			if scope == "user" && facts.Scope == "System" {
				t.Fatal("user selection returned machine-only installer")
			}
			t.Logf("scope=%s selected=%s elevation=%s", scope, facts.Scope, facts.Elevation)
		})
	}
}

// Uses real catalog observations but replaces installation with a marker-only
// module, so even a failed assertion cannot install software on the host.
func TestOwnerInstallSelectionRevalidatedWithLiveCatalog(t *testing.T) {
	pwsh, realModule := os.Getenv("RAGENT_QA_PWSH"), os.Getenv("RAGENT_QA_WINGET_MODULE")
	id, version := os.Getenv("RAGENT_QA_PACKAGE_ID"), os.Getenv("RAGENT_QA_PACKAGE_VERSION")
	if pwsh == "" || realModule == "" || id == "" || version == "" {
		t.Skip("staged runtime, package ID and version required")
	}
	dir := t.TempDir()
	module, marker := filepath.Join(dir, "mock.psm1"), filepath.Join(dir, "called.txt")
	stub := `
Import-Module $env:REAL_MODULE -Force -ErrorAction Stop
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
	base := append(os.Environ(), "REAL_MODULE="+realModule, "MOCK_MARKER="+marker, "RAGENT_INSTALL_MODULE="+module,
		"RAGENT_INSTALL_PACKAGE_ID="+id, "RAGENT_INSTALL_PACKAGE_VERSION="+version, "RAGENT_INSTALL_SCOPE=user")
	inspect := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(ownerInstallScript))
	inspect.Env = append(append([]string{}, base...), "RAGENT_INSTALL_INSPECT=1")
	data, err := inspect.Output()
	if err != nil {
		t.Fatalf("inspection failed: %v", err)
	}
	var facts selectedInstallerFacts
	if err := json.Unmarshal(data, &facts); err != nil || !validInstallerFacts(&facts, id, version) {
		t.Fatalf("invalid selection: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("inspection invoked installer")
	}
	for _, changed := range []bool{true, false} {
		selected := facts
		if changed {
			selected.Architecture = "changed"
		}
		encoded, err := json.Marshal(selected)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellScript(ownerInstallScript))
		cmd.Env = append(append([]string{}, base...), "RAGENT_INSTALL_SELECTED="+string(encoded))
		err = cmd.Run()
		if changed {
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 25 {
				t.Fatalf("changed selection accepted: %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("changed selection invoked installer")
			}
		} else if err != nil {
			t.Fatalf("matching selection failed: %v", err)
		}
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("matching selection did not invoke the mock")
	}
}
