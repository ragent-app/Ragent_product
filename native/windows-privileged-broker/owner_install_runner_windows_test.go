//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerInstallRunner(t *testing.T) {
	for _, tc := range []struct {
		name               string
		exit               int
		runError, mismatch bool
		want               string
	}{
		{"success", 0, false, false, "succeeded"},
		{"failed process", 23, true, false, "failed"},
		{"reboot outcome", 24, true, false, "unknown"},
		{"owner session changed", 0, false, true, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls, leases, handles, queries, discoveries int
			tokens := ownerTokenSource{
				discover: func(string) (uint32, error) {
					discoveries++
					if tc.mismatch && discoveries > 2 {
						return 4, nil
					}
					return 3, nil
				},
				query:     func(uint32) (windows.Token, error) { queries++; handles++; return windows.Token(queries), nil },
				verify:    func(windows.Token, string, uint32) error { return nil },
				sameLogon: func(windows.Token, windows.Token) bool { return true },
				close:     func(windows.Token) error { handles--; return nil },
			}
			runner := ownerInstallRunner{
				acquireRuntime: func() (string, func(), error) { leases++; return `D:\Vendor`, func() { leases-- }, nil },
				tokens:         tokens,
				paths:          func() (string, string, error) { return `C:\Windows`, `C:\Windows\System32`, nil },
				environment: func(windows.Token) ([]string, error) {
					return []string{`USERPROFILE=D:\Owner`, `LOCALAPPDATA=D:\Owner\Local`, `APPDATA=D:\Owner\Roaming`, `PATH=D:\untrusted`}, nil
				},
				run: func(_ context.Context, _ windows.Token, executable string, args, env []string, cwd string) (int, error) {
					calls++
					if executable != filepath.Join(`D:\Vendor`, "PowerShell", "pwsh.exe") || cwd != `C:\Windows\System32` || len(args) != 7 || args[5] != "-EncodedCommand" {
						t.Fatal("unexpected invocation")
					}
					joined := strings.Join(env, "\n")
					if strings.Contains(joined, `D:\untrusted`) || !strings.Contains(joined, "RAGENT_INSTALL_PACKAGE_ID=Vendor.App") || !strings.Contains(joined, "RAGENT_INSTALL_PACKAGE_VERSION=1.2.3") {
						t.Fatal("unexpected environment")
					}
					if tc.runError {
						return tc.exit, errors.New("process exit")
					}
					return tc.exit, nil
				},
			}
			result := runner.install(context.Background(), "S-1-5-21-1-2-3-1001", "Vendor.App", "1.2.3", "user")
			if result.Status != tc.want || handles != 0 || leases != 0 {
				t.Fatalf("result=%+v handles=%d leases=%d", result, handles, leases)
			}
			if tc.mismatch && calls != 0 || !tc.mismatch && calls != 1 {
				t.Fatalf("unexpected process calls: %d", calls)
			}
		})
	}
}
