//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestMSIInstallRunnerKeepsPinsAndUsesFixedArguments(t *testing.T) {
	source, publisher := os.Getenv("RAGENT_TEST_SIGNED_MSI"), os.Getenv("RAGENT_TEST_SIGNED_MSI_PUBLISHER_SHA256")
	if source == "" || publisher == "" {
		t.Skip("signed MSI fixture not configured")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "fixture.msi")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	now := time.Now().UTC().Truncate(time.Millisecond)
	grant := msiInstallGrant{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(hash[:]), PublisherSHA256: publisher, ExpiresMS: now.Add(time.Minute).UnixMilli()}
	winDir, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		exit   int
		runErr error
		want   requestStatus
		code   string
	}{
		{"success", 0, nil, statusSucceeded, "MSI_INSTALL_SUCCEEDED"},
		{"reboot", 3010, errors.New("reboot"), statusSucceeded, "MSI_INSTALL_REBOOT_REQUIRED"},
		{"failed", 1603, errors.New("failed"), statusFailed, "MSI_INSTALL_FAILED"},
		{"unknown", -1, errors.New("unknown"), statusUnknown, "MSI_INSTALL_OUTCOME_UNKNOWN"},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			installer := windowsMSIInstaller{now: func() time.Time { return now }, paths: func() (string, string, string, error) { return winDir, systemDir, root, nil }, run: func(executable string, args, env []string, cwd string) (int, error) {
				called = true
				if !strings.EqualFold(executable, filepath.Join(systemDir, "msiexec.exe")) || cwd != systemDir || len(args) != 4 || args[0] != "/i" || args[1] != path || args[2] != "/qn" || args[3] != "/norestart" {
					t.Fatalf("unexpected command %q %q", executable, args)
				}
				if strings.Contains(strings.Join(env, "\n"), "DOTNET_STARTUP_HOOKS=") {
					t.Fatal("inherited untrusted environment")
				}
				if err := os.WriteFile(path, []byte("replacement"), 0600); err == nil {
					t.Fatal("MSI not pinned during execution")
				}
				return test.exit, test.runErr
			}}
			status, code := installer.Install(context.Background(), grant)
			if !called || status != test.want || code != test.code {
				t.Fatalf("got %s/%s called=%v", status, code, called)
			}
		})
	}
	if err := os.WriteFile(path, []byte("after"), 0600); err != nil {
		t.Fatalf("pins not released: %v", err)
	}
}
