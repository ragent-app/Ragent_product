//go:build windows

package main

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestSystemLinkedOwnerTokenRejectsNonSystemAndWrongOwner(t *testing.T) {
	current := windows.GetCurrentProcessToken()
	user, err := current.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	session, _ := tokenUint32(current, windows.TokenSessionId)
	if token, err := systemLinkedElevatedOwnerToken(current, "S-1-5-18", session); err == nil {
		_ = token.Close()
		t.Fatal("accepted an invalid owner token")
	}
	if user.User.Sid.String() != "S-1-5-18" {
		if token, err := systemLinkedElevatedOwnerToken(current, user.User.Sid.String(), session); err == nil {
			_ = token.Close()
			t.Fatal("a non-system caller obtained an elevated owner token")
		}
	}
}

// An opt-in service-context probe never installs software. It verifies the
// exact owner's active session and checks the token returned by Windows.
func TestSystemLinkedOwnerTokenLive(t *testing.T) {
	ownerSID := os.Getenv("RAGENT_QA_SYSTEM_OWNER_SID")
	if ownerSID == "" {
		t.Skip("requires a disposable LocalSystem test service and owner SID")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != "S-1-5-18" {
		t.Fatal("live probe must run as LocalSystem")
	}
	source := windowsOwnerTokenSource()
	ordinary, session, err := acquireOwnerSessionToken(ownerSID, source)
	if err != nil {
		t.Fatal(err)
	}
	defer source.close(ordinary)
	elevated, err := systemLinkedElevatedOwnerToken(ordinary, ownerSID, session)
	if err != nil {
		t.Fatal(err)
	}
	defer elevated.Close()
	actual, err := elevated.GetTokenUser()
	if err != nil || actual.User.Sid.String() != ownerSID || !elevated.IsElevated() {
		t.Fatal("elevated token does not match the owner")
	}
	tokenSession, err := tokenUint32(elevated, windows.TokenSessionId)
	if err != nil || tokenSession != session {
		t.Fatal("elevated token does not match the owner session")
	}
}
