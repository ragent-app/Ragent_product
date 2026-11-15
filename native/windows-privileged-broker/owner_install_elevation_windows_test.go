//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerInstallSelectsBoundElevation(t *testing.T) {
	base := selectedInstallerFacts{ID: "Vendor.App", Version: "1.2.3", Source: "winget", Scope: "User", Elevation: "ElevationRequired", Type: "Msi", NestedType: "Unknown", Architecture: "X64"}
	for _, tc := range []struct {
		name                             string
		facts                            selectedInstallerFacts
		unavailable, malformed           bool
		exit, wantElevations, wantCloses int
		wantCode                         string
	}{
		{"user elevation", base, false, false, 0, 1, 1, "OWNER_INSTALL_SUCCEEDED"},
		{"self elevation", func() selectedInstallerFacts { f := base; f.Elevation = "ElevatesSelf"; return f }(), false, false, 0, 1, 1, "OWNER_INSTALL_SUCCEEDED"},
		{"system selection remains ordinary", func() selectedInstallerFacts { f := base; f.Scope = "System"; return f }(), false, false, 0, 0, 0, "OWNER_INSTALL_SUCCEEDED"},
		{"elevation prohibited", func() selectedInstallerFacts { f := base; f.Elevation = "ElevationProhibited"; return f }(), false, false, 0, 0, 0, "OWNER_INSTALL_SUCCEEDED"},
		{"wrong package", func() selectedInstallerFacts { f := base; f.ID = "Other.App"; return f }(), false, false, 0, 0, 0, "OWNER_INSTALL_SUCCEEDED"},
		{"bad observation", base, false, true, 0, 0, 0, "OWNER_INSTALL_SUCCEEDED"},
		{"linked token unavailable", base, true, false, 0, 1, 0, "OWNER_INSTALL_SUCCEEDED"},
		{"selection changed at execution", base, false, false, 25, 1, 1, "OWNER_INSTALL_SELECTION_CHANGED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls, elevations, closes int
			tokens := ownerTokenSource{
				discover:  func(string) (uint32, error) { return 3, nil },
				query:     func(uint32) (windows.Token, error) { return 7, nil },
				verify:    func(windows.Token, string, uint32) error { return nil },
				sameLogon: func(windows.Token, windows.Token) bool { return true },
				close:     func(windows.Token) error { return nil },
			}
			runner := ownerInstallRunner{
				acquireRuntime: func() (string, func(), error) { return `D:\Vendor`, func() {}, nil },
				tokens:         tokens,
				paths:          func() (string, string, error) { return `C:\Windows`, `C:\Windows\System32`, nil },
				environment: func(windows.Token) ([]string, error) {
					return []string{`USERPROFILE=D:\Owner`, `LOCALAPPDATA=D:\Owner\Local`, `APPDATA=D:\Owner\Roaming`}, nil
				},
				inspect: func(_ context.Context, token windows.Token, _ string, _ []string, env []string, _ string) ([]byte, error) {
					if token != 7 || !strings.Contains(strings.Join(env, "\n"), "RAGENT_INSTALL_INSPECT=1") {
						t.Fatal("inspection did not use the owner")
					}
					if tc.malformed {
						return []byte(`{"id":"Vendor.App"} trailing`), nil
					}
					return json.Marshal(tc.facts)
				},
				elevate: func(token windows.Token, sid string, session uint32) (windows.Token, error) {
					elevations++
					if token != 7 || sid != "S-1-5-21-1-2-3-1001" || session != 3 {
						t.Fatal("incorrect owner binding")
					}
					if tc.unavailable {
						return 0, errors.New("no elevated token")
					}
					return 99, nil
				},
				closeElevated: func(token windows.Token) error {
					if token != 99 {
						t.Fatal("wrong token closed")
					}
					closes++
					return nil
				},
				run: func(_ context.Context, token windows.Token, _ string, _ []string, env []string, _ string) (int, error) {
					calls++
					isElevated := tc.wantElevations > 0 && !tc.unavailable
					if (token == 99) != isElevated || strings.Contains(strings.Join(env, "\n"), "RAGENT_INSTALL_SELECTED=") != isElevated {
						t.Fatal("unexpected execution identity or selection binding")
					}
					if tc.exit != 0 {
						return tc.exit, errors.New("fixture exit")
					}
					return 0, nil
				},
			}
			result := runner.install(context.Background(), "S-1-5-21-1-2-3-1001", "Vendor.App", "1.2.3", "user")
			if result.Code != tc.wantCode || calls != 1 || elevations != tc.wantElevations || closes != tc.wantCloses {
				t.Fatalf("result=%+v calls=%d elevations=%d closes=%d", result, calls, elevations, closes)
			}
		})
	}
}

func TestOwnerInstallDoesNotRunAfterOwnerSessionChanges(t *testing.T) {
	changed, ran, closed := false, false, false
	tokens := ownerTokenSource{
		discover: func(string) (uint32, error) {
			if changed {
				return 4, nil
			}
			return 3, nil
		},
		query:     func(uint32) (windows.Token, error) { return 7, nil },
		verify:    func(windows.Token, string, uint32) error { return nil },
		sameLogon: func(windows.Token, windows.Token) bool { return true },
		close:     func(windows.Token) error { return nil },
	}
	facts := selectedInstallerFacts{ID: "Vendor.App", Version: "1.2.3", Source: "winget", Scope: "User", Elevation: "ElevationRequired", Type: "Msi", NestedType: "Unknown", Architecture: "X64"}
	runner := ownerInstallRunner{
		acquireRuntime: func() (string, func(), error) { return `D:\Vendor`, func() {}, nil },
		tokens:         tokens,
		paths:          func() (string, string, error) { return `C:\Windows`, `C:\Windows\System32`, nil },
		environment: func(windows.Token) ([]string, error) {
			return []string{`USERPROFILE=D:\Owner`, `LOCALAPPDATA=D:\Owner\Local`, `APPDATA=D:\Owner\Roaming`}, nil
		},
		inspect: func(context.Context, windows.Token, string, []string, []string, string) ([]byte, error) {
			return json.Marshal(facts)
		},
		elevate:       func(windows.Token, string, uint32) (windows.Token, error) { changed = true; return 99, nil },
		closeElevated: func(windows.Token) error { closed = true; return nil },
		run: func(context.Context, windows.Token, string, []string, []string, string) (int, error) {
			ran = true
			return 0, nil
		},
	}
	result := runner.install(context.Background(), "S-1-5-21-1-2-3-1001", "Vendor.App", "1.2.3", "user")
	if result.Code != "OWNER_INSTALL_OWNER_UNAVAILABLE" || ran || !closed {
		t.Fatalf("session change was not stopped: result=%+v ran=%v closed=%v", result, ran, closed)
	}
}
