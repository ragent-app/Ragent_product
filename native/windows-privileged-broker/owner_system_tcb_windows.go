//go:build windows

package main

import (
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var ownerPrivilegeCheck = windows.NewLazySystemDLL("advapi32.dll").NewProc("PrivilegeCheck")

type ownerPrivilegeSet struct {
	Count, Control uint32
	Privilege      windows.LUIDAndAttributes
}

// isLocalSystemProcess reports whether the current process runs under LocalSystem.
func isLocalSystemProcess() bool {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && user != nil && user.User.Sid != nil && user.User.Sid.String() == "S-1-5-18"
}

// enableTokenPrivileges enables and verifies each requested privilege on an
// already-open token. AdjustTokenPrivileges can succeed without assigning a
// privilege, so verify all privileges with PrivilegeCheck before proceeding.
func enableTokenPrivileges(token windows.Token, privileges ...string) error {
	if token == 0 || len(privileges) == 0 {
		return errOwnerSessionUnavailable
	}
	for _, privilege := range privileges {
		name, err := windows.UTF16PtrFromString(privilege)
		if err != nil {
			return errOwnerSessionUnavailable
		}
		var luid windows.LUID
		if windows.LookupPrivilegeValue(nil, name, &luid) != nil {
			return errOwnerSessionUnavailable
		}
		requested := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}}
		if windows.AdjustTokenPrivileges(token, false, &requested, 0, nil, nil) != nil {
			return errOwnerSessionUnavailable
		}
		check := ownerPrivilegeSet{Count: 1, Control: 1, Privilege: windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}
		var enabled int32
		result, _, _ := ownerPrivilegeCheck.Call(uintptr(token), uintptr(unsafe.Pointer(&check)), uintptr(unsafe.Pointer(&enabled)))
		if result == 0 || enabled == 0 {
			return errOwnerSessionUnavailable
		}
	}
	return nil
}

// withSystemThreadPrivileges confines impersonation and enabled LocalSystem
// privileges to a dedicated locked OS thread so no privileged thread token can
// leak back onto a Go scheduler thread.
func withSystemThreadPrivileges(privileges []string, action func() error) error {
	if !isLocalSystemProcess() || len(privileges) == 0 || action == nil {
		return errOwnerSessionUnavailable
	}
	completed := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		unlock := true
		defer func() {
			if unlock {
				runtime.UnlockOSThread()
			}
		}()
		fail := func() { completed <- errOwnerSessionUnavailable }
		thread, err := windows.GetCurrentThread()
		if err != nil {
			fail()
			return
		}
		var previous windows.Token
		if err = windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &previous); err == nil {
			_ = previous.Close()
			fail()
			return
		} else if err != windows.ERROR_NO_TOKEN {
			fail()
			return
		}
		if windows.ImpersonateSelf(windows.SecurityImpersonation) != nil {
			fail()
			return
		}
		// A failed revert must never return this OS thread to the Go runtime.
		unlock = false
		var threadToken windows.Token
		var actionErr error
		enabled := false
		if windows.OpenThreadToken(thread, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES, true, &threadToken) == nil {
			if enableTokenPrivileges(threadToken, privileges...) == nil {
				enabled = true
			}
			_ = threadToken.Close()
		}
		if enabled {
			actionErr = action()
		}
		if windows.RevertToSelf() != nil {
			fail()
			return
		}
		unlock = true
		if !enabled {
			fail()
			return
		}
		completed <- actionErr
	}()
	return <-completed
}

// systemLinkedElevatedOwnerToken is an execution primitive, not authorization.
// Its caller must first verify the exact install request and must not expose
// the returned token to a requester. Only a LocalSystem broker may use it.
func systemLinkedElevatedOwnerToken(ordinary windows.Token, ownerSID string, session uint32) (windows.Token, error) {
	var elevated windows.Token
	err := withSystemThreadPrivileges([]string{"SeTcbPrivilege"}, func() error {
		token, linkErr := linkedElevatedOwnerToken(ordinary, ownerSID, session)
		if linkErr != nil {
			return linkErr
		}
		elevated = token
		return nil
	})
	if err != nil || elevated == 0 {
		if elevated != 0 {
			_ = elevated.Close()
		}
		return 0, errOwnerSessionUnavailable
	}
	return elevated, nil
}
