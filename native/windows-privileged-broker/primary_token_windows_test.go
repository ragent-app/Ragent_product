//go:build windows

package main

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestServiceSIDVerificationAcceptsPrimaryToken(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	everyone, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatal(err)
	}
	if err := tokenHasExpectedServiceSID(token, everyone); err != nil {
		t.Fatalf("primary process token should contain enabled Everyone SID: %v", err)
	}
	missing, err := windows.CreateWellKnownSid(windows.WinBuiltinGuestsSid)
	if err != nil {
		t.Fatal(err)
	}
	if err := tokenHasExpectedServiceSID(token, missing); err == nil {
		t.Fatal("unexpectedly accepted a SID absent from the process token")
	}
}

func TestInstalledBrokerServerIdentity(t *testing.T) {
	if os.Getenv("RAGENT_TEST_INSTALLED_BROKER_IDENTITY") != "1" {
		t.Skip("requires the local installed broker and an elevated test process")
	}
	name, err := windows.UTF16PtrFromString(adminPipeName)
	if err != nil {
		t.Fatal(err)
	}
	pipe, err := windows.CreateFile(name, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(pipe)
	if err := verifyBrokerAdminPipeServer(pipe); err != nil {
		t.Fatal(err)
	}
}
