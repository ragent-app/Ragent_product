//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// No real child process or installer is launched by this test.
func TestSystemAutoInstallUsesPinnedRuntimeAndReportsOutcomes(t *testing.T) {
	vendor := filepath.Join(t.TempDir(), "vendor")
	if err := os.Setenv("DOTNET_STARTUP_HOOKS", "untrusted-hook"); err != nil {
		t.Fatal(err)
	}
	defer os.Unsetenv("DOTNET_STARTUP_HOOKS")
	grant := autoInstallGrant{PackageID: "Vendor.App", VersionID: "1.2.3", Source: "winget", InstallScope: "machine"}
	for _, test := range []struct {
		name       string
		exit       int
		runErr     error
		wantStatus requestStatus
		wantCode   string
	}{
		{"success", 0, nil, statusSucceeded, "AUTO_INSTALL_SUCCEEDED"},
		{"bad source", 21, errors.New("exit"), statusFailed, "AUTO_INSTALL_SOURCE_UNVERIFIED"},
		{"package absent", 22, errors.New("exit"), statusFailed, "AUTO_INSTALL_PACKAGE_UNAVAILABLE"},
		{"selection changed", 25, errors.New("exit"), statusFailed, "AUTO_INSTALL_SELECTION_CHANGED"},
		{"reboot", 24, errors.New("exit"), statusUnknown, "AUTO_INSTALL_REBOOT_REQUIRED"},
		{"unexpected", -1, errors.New("spawn failed"), statusFailed, "AUTO_INSTALL_FAILED"},
	} {
		t.Run(test.name, func(t *testing.T) {
			closed := false
			installer := windowsAutoInstaller{
				acquire: func() (runtimeLease, error) {
					return runtimeLease{vendor: vendor, close: func() { closed = true }}, nil
				},
				run: func(_ context.Context, exe string, args, env []string, cwd string) (int, error) {
					if exe != filepath.Join(vendor, "PowerShell", "pwsh.exe") || !filepath.IsAbs(cwd) || len(args) != 7 || args[6] != encodePowerShellScript(autoInstallModuleScript) {
						t.Fatalf("unsafe invocation: %q %q", exe, args)
					}
					joined := "\n" + strings.Join(env, "\n") + "\n"
					for _, required := range []string{"\nRAGENT_INSTALL_PACKAGE_ID=Vendor.App\n", "\nRAGENT_INSTALL_PACKAGE_VERSION=1.2.3\n", "\nRAGENT_INSTALL_MODULE=" + filepath.Join(vendor, "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1") + "\n"} {
						if !strings.Contains(joined, required) {
							t.Fatalf("missing fixed environment value %q", required)
						}
					}
					if strings.Contains(joined, "DOTNET_STARTUP_HOOKS=") {
						t.Fatal("untrusted startup hooks inherited")
					}
					return test.exit, test.runErr
				},
			}
			status, code := installer.Install(context.Background(), grant)
			if status != test.wantStatus || code != test.wantCode || !closed {
				t.Fatalf("got %s/%s, lease closed=%v", status, code, closed)
			}
		})
	}
	called := false
	installer := windowsAutoInstaller{acquire: func() (runtimeLease, error) { called = true; return runtimeLease{}, nil }}
	if status, _ := installer.Install(context.Background(), autoInstallGrant{PackageID: "Vendor.App;evil", VersionID: "1", Source: "winget", InstallScope: "machine"}); status != statusFailed || called {
		t.Fatal("invalid package reached the executor")
	}
	selected := grant
	selected.SelectedInstaller = &selectedInstallerFacts{ID: grant.PackageID, Version: grant.VersionID, Source: "winget", Scope: "System", Elevation: "ElevationRequired", Type: "Msi", NestedType: "Unknown", Architecture: "X64", Locale: "en-US"}
	installer = windowsAutoInstaller{acquire: func() (runtimeLease, error) { return runtimeLease{vendor: vendor, close: func() {}}, nil }, run: func(_ context.Context, _ string, _ []string, env []string, _ string) (int, error) {
		if !strings.Contains(strings.Join(env, "\n"), `RAGENT_INSTALL_SELECTED={"id":"Vendor.App","version":"1.2.3"`) {
			t.Fatal("selected metadata did not reach the fixed runner")
		}
		return 25, errors.New("selection changed")
	}}
	if status, code := installer.Install(context.Background(), selected); status != statusFailed || code != "AUTO_INSTALL_SELECTION_CHANGED" {
		t.Fatal("selected installer mismatch was not reported")
	}
	selected.SelectedInstaller.Scope = "User"
	if status, code := installer.Install(context.Background(), selected); status != statusFailed || code != "AUTO_INSTALL_INVALID" {
		t.Fatal("user scope accepted by system runner")
	}
	closed := false
	installer = windowsAutoInstaller{acquire: func() (runtimeLease, error) {
		return runtimeLease{vendor: "relative", close: func() { closed = true }}, nil
	}}
	if status, _ := installer.Install(context.Background(), grant); status != statusFailed || !closed {
		t.Fatal("invalid runtime lease was not released")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	installer = windowsAutoInstaller{acquire: func() (runtimeLease, error) { return runtimeLease{vendor: vendor, close: func() {}}, nil }, run: func(context.Context, string, []string, []string, string) (int, error) { return -1, context.Canceled }}
	if status, code := installer.Install(ctx, grant); status != statusUnknown || code != "AUTO_INSTALL_OUTCOME_UNKNOWN" {
		t.Fatal("cancellation reported an incorrect result")
	}
}

func TestSystemInstallerInspectionIsReadOnlyAndBound(t *testing.T) {
	vendor := filepath.Join(t.TempDir(), "vendor")
	closed, called := false, false
	output := `{"id":"Vendor.App","version":"1.2.3","source":"winget","scope":"System","elevation":"ElevationRequired","type":"Msi","nestedType":"Unknown","architecture":"X64","locale":"en-US"}`
	installer := windowsAutoInstaller{
		acquire: func() (runtimeLease, error) {
			return runtimeLease{vendor: vendor, close: func() { closed = true }}, nil
		},
		inspect: func(_ context.Context, exe string, args, env []string, cwd string) ([]byte, error) {
			called = true
			if exe != filepath.Join(vendor, "PowerShell", "pwsh.exe") || !filepath.IsAbs(cwd) || args[6] != encodePowerShellScript(autoInstallModuleScript) || !strings.Contains(strings.Join(env, "\n"), "RAGENT_INSTALL_INSPECT=1") {
				t.Fatal("invalid inspection invocation")
			}
			return []byte(output), nil
		},
		run: func(context.Context, string, []string, []string, string) (int, error) {
			t.Fatal("inspection ran installer")
			return 0, nil
		},
	}
	if facts, err := installer.Inspect(context.Background(), "Vendor.App", "1.2.3"); err != nil || facts == nil || !called || !closed {
		t.Fatalf("inspection failed: %v", err)
	}
	for _, invalid := range []string{
		`{"id":"Other.App","version":"1.2.3","source":"winget","scope":"System","elevation":"ElevationRequired","type":"Msi","nestedType":"Unknown","architecture":"X64","locale":"en-US"}`,
		`{"id":"Vendor.App","version":"1.2.3","source":"winget","scope":"User","elevation":"ElevationRequired","type":"Msi","nestedType":"Unknown","architecture":"X64","locale":"en-US"}`,
		`{"id":"Vendor.App","unknown":"field"}`,
		output + `{}`,
	} {
		output = invalid
		if _, err := installer.Inspect(context.Background(), "Vendor.App", "1.2.3"); err == nil {
			t.Fatal("invalid inspection facts accepted")
		}
	}
	called = false
	if _, err := installer.Inspect(context.Background(), "Vendor.App;bad", "1.2.3"); err == nil || called {
		t.Fatal("invalid package reached inspection")
	}
}

func TestOptionalSystemInstallerInspectionWithPinnedRuntime(t *testing.T) {
	if os.Getenv("RAGENT_TEST_LIVE_WINGET_SELECTED") != "1" {
		t.Skip("live catalog inspection is opt-in")
	}
	vendor, digest, packageID, versionID := os.Getenv("RAGENT_TEST_RUNTIME_VENDOR"), os.Getenv("RAGENT_TEST_RUNTIME_MANIFEST_SHA256"), os.Getenv("RAGENT_TEST_PACKAGE_ID"), os.Getenv("RAGENT_TEST_PACKAGE_VERSION")
	if !filepath.IsAbs(vendor) || digest == "" || !autoInstallPackagePattern.MatchString(packageID) || !autoInstallVersionPattern.MatchString(versionID) {
		t.Fatal("invalid isolated fixture")
	}
	temp := t.TempDir()
	installer := windowsAutoInstaller{
		acquire: func() (runtimeLease, error) {
			pins, _, err := pinRuntimeContent(vendor, digest)
			if err != nil {
				return runtimeLease{}, err
			}
			return runtimeLease{vendor: vendor, close: pins.Close}, nil
		},
		paths: func() (string, string, string, error) {
			root, err := windows.GetWindowsDirectory()
			if err != nil {
				return "", "", "", err
			}
			system, err := windows.GetSystemDirectory()
			return root, system, temp, err
		},
	}
	facts, err := installer.Inspect(context.Background(), packageID, versionID)
	if err != nil || facts == nil || facts.ID != packageID || facts.Version != versionID || facts.Scope != "System" {
		t.Fatalf("pinned inspection failed: %+v %v", facts, err)
	}
}
