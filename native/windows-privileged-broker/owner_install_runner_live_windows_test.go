//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Uses a purpose-built executable, never WinGet or a real installer. This
// checks the OS process/token path without changing machine or user software.
func TestOwnerInstallRunnerLiveMock(t *testing.T) {
	dir := t.TempDir()
	vendor := filepath.Join(dir, "vendor")
	pwshDir := filepath.Join(vendor, "PowerShell")
	if err := os.MkdirAll(pwshDir, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "fake_pwsh.go")
	program := `package main
import ("encoding/base64";"encoding/binary";"os";"path/filepath";"strings";"unicode/utf16")
func main(){
 if len(os.Args)!=8 || os.Args[6]!="-EncodedCommand" { os.Exit(31) }
 raw,e:=base64.StdEncoding.DecodeString(os.Args[7]);if e!=nil || len(raw)%2!=0 {os.Exit(32)}
 units:=make([]uint16,len(raw)/2);for i:=range units { units[i]=binary.LittleEndian.Uint16(raw[i*2:]) }
 if !strings.Contains(string(utf16.Decode(units)),"$arguments.Scope = 'User'") || os.Getenv("RAGENT_INSTALL_SCOPE")!="user" || os.Getenv("RAGENT_INSTALL_PACKAGE_ID")!="Vendor.App" || os.Getenv("RAGENT_INSTALL_PACKAGE_VERSION")!="1.2.3" || !filepath.IsAbs(os.Getenv("ComSpec")) || os.Getenv("PATHEXT")!=".COM;.EXE;.BAT;.CMD" {os.Exit(33)}
 if os.WriteFile(filepath.Join(os.Getenv("TEMP"),"owner-install-receipt"),[]byte("mock"),0600)!=nil {os.Exit(34)}
}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	compile := exec.Command("go", "build", "-o", filepath.Join(pwshDir, "pwsh.exe"), source)
	if output, err := compile.CombinedOutput(); err != nil {
		t.Fatalf("build mock: %v: %s", err, output)
	}
	var original windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	user, err := original.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	ownerSID := user.User.Sid.String()
	session, err := tokenUint32(original, windows.TokenSessionId)
	if err != nil || session == 0 {
		t.Skip("interactive current-user token required")
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	tokens := ownerTokenSource{
		discover: func(string) (uint32, error) { return session, nil },
		query: func(uint32) (windows.Token, error) {
			var result windows.Token
			err := windows.DuplicateTokenEx(original, windows.TOKEN_ALL_ACCESS, nil, windows.SecurityImpersonation, windows.TokenPrimary, &result)
			return result, err
		},
		verify: verifyOwnerSessionToken,
		sameLogon: func(a, b windows.Token) bool {
			x, e := tokenAuthenticationID(a)
			y, f := tokenAuthenticationID(b)
			return e == nil && f == nil && x == y
		},
		close: func(token windows.Token) error { return token.Close() },
	}
	runner := ownerInstallRunner{
		acquireRuntime: func() (string, func(), error) { return vendor, func() {}, nil },
		tokens:         tokens,
		paths:          func() (string, string, error) { return root, systemDir, nil },
		environment: func(windows.Token) ([]string, error) {
			return []string{"USERPROFILE=" + dir, "LOCALAPPDATA=" + dir, "APPDATA=" + dir, "TEMP=" + dir, "TMP=" + dir}, nil
		},
		run: runOwnerProcess,
	}
	result := runner.install(context.Background(), ownerSID, "Vendor.App", "1.2.3", "user")
	if result.Status != "succeeded" {
		t.Fatalf("mock owner install failed: %+v", result)
	}
	data, err := os.ReadFile(filepath.Join(dir, "owner-install-receipt"))
	if err != nil || string(data) != "mock" {
		t.Fatalf("receipt missing: %v", err)
	}
}
