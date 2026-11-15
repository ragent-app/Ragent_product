//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestOwnerInstallScriptUserScope(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh.exe")
	if err != nil {
		t.Skip("PowerShell 7 is unavailable")
	}
	dir := t.TempDir()
	module, marker := filepath.Join(dir, "mock.psm1"), filepath.Join(dir, "called.txt")
	stub := `
function Get-WinGetSource { param($Name) [pscustomobject]@{ Name='winget'; Type='Microsoft.PreIndexed.Package'; Argument=$env:MOCK_URL; TrustLevel='Trusted' } }
function Find-WinGetPackage { param($Id,$Source,$MatchOption) [pscustomobject]@{ Id=$Id; Source=$Source; AvailableVersions=@('1.2.3') } }
function Install-WinGetPackage { [CmdletBinding(SupportsShouldProcess)] param($Id,$Version,$Source,$MatchOption,$Mode,$Scope)
  if ($Id -cne 'Vendor.App' -or $Version -cne '1.2.3' -or $Source -cne 'winget' -or $Mode -cne 'Silent') { throw 'bad parameters' }
  if (($env:RAGENT_INSTALL_SCOPE -ceq 'user' -and $Scope -cne 'User') -or ($env:RAGENT_INSTALL_SCOPE -ceq 'default' -and $PSBoundParameters.ContainsKey('Scope'))) { throw 'bad scope' }
  [IO.File]::WriteAllText($env:MOCK_MARKER, 'called')
  [pscustomobject]@{ Id=$Id; Source=$Source; Status='Ok'; InstallerErrorCode=0; RebootRequired=$false }
}
Export-ModuleMember -Function Get-WinGetSource,Find-WinGetPackage,Install-WinGetPackage
`
	if err := os.WriteFile(module, []byte(stub), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, url, version, scope string
		exit                      int
		called                    bool
	}{
		{"user installation", "https://cdn.winget.microsoft.com/cache", "1.2.3", "user", 0, true},
		{"default installation", "https://cdn.winget.microsoft.com/cache", "1.2.3", "default", 0, true},
		{"untrusted source", "https://malicious.example/cache", "1.2.3", "user", 21, false},
		{"unknown version", "https://cdn.winget.microsoft.com/cache", "9.9.9", "user", 22, false},
		{"invalid scope", "https://cdn.winget.microsoft.com/cache", "1.2.3", "machine", 23, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_ = os.Remove(marker)
			cmd := exec.Command(pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ownerInstallScript)
			cmd.Env = append(os.Environ(), "RAGENT_INSTALL_PACKAGE_ID=Vendor.App", "RAGENT_INSTALL_PACKAGE_VERSION="+tc.version,
				"RAGENT_INSTALL_MODULE="+module, "RAGENT_INSTALL_SCOPE="+tc.scope, "MOCK_URL="+tc.url, "MOCK_MARKER="+marker)
			output, err := cmd.CombinedOutput()
			exit := 0
			if err != nil {
				var e *exec.ExitError
				if !errors.As(err, &e) {
					t.Fatal(err)
				}
				exit = e.ExitCode()
			}
			if exit != tc.exit {
				t.Fatalf("exit %d, expected %d: %s", exit, tc.exit, output)
			}
			_, err = os.Stat(marker)
			if (err == nil) != tc.called {
				t.Fatalf("unexpected mock execution: %v", err)
			}
		})
	}
}
