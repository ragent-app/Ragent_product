//go:build windows

package main

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func TestRuntimeDirectoryAclRejectsUntrustedMutations(t *testing.T) {
	for _, test := range []struct {
		name, sid string
		mask      uint32
		flags     uint8
		want      bool
	}{
		{"user adds file", "S-1-5-32-545", 0x2, 0, true},
		{"user adds directory", "S-1-5-32-545", 0x4, 0, true},
		{"user deletes child", "S-1-5-32-545", 0x40, 0, true},
		{"user changes dacl", "S-1-5-32-545", windows.WRITE_DAC, 0, true},
		{"user reads", "S-1-5-32-545", windows.GENERIC_READ, 0, false},
		{"inherit-only placeholder", "S-1-3-0", windows.GENERIC_ALL, windows.INHERIT_ONLY_ACE, false},
		{"system", "S-1-5-18", windows.GENERIC_ALL, 0, false},
		{"administrators", "S-1-5-32-544", windows.GENERIC_ALL, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sid, err := windows.StringToSid(test.sid)
			if err != nil {
				t.Fatal(err)
			}
			if got := runtimeDirectoryACECanMutate(sid, test.mask, test.flags); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

func TestOptionalRuntimeDirectoryACLFixtures(t *testing.T) {
	trusted := os.Getenv("RAGENT_TEST_ACL_TRUSTED")
	writable := os.Getenv("RAGENT_TEST_ACL_WRITABLE")
	if trusted == "" || writable == "" {
		t.Skip("no isolated Windows ACL fixtures supplied")
	}
	if err := verifyRuntimeDirectoryACL(trusted); err != nil {
		t.Fatalf("administrator-owned read-only fixture rejected: %v", err)
	}
	if err := verifyRuntimeDirectoryACL(writable); err == nil {
		t.Fatal("user-writable fixture accepted")
	}
	if err := verifyRuntimeAncestor(trusted); err != nil {
		t.Fatalf("trusted ancestor rejected: %v", err)
	}
	if err := verifyRuntimeAncestor(writable); err == nil {
		t.Fatal("replaceable ancestor accepted")
	}
}
