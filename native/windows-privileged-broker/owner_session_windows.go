//go:build windows

package main

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// tokenUint32 verifies the complete fixed-size Windows token information
// response. An unreadable or unexpected token never becomes an owner token.
func tokenUint32(token windows.Token, class uint32) (uint32, error) {
	var value, length uint32
	err := windows.GetTokenInformation(token, class, (*byte)(unsafe.Pointer(&value)), uint32(unsafe.Sizeof(value)), &length)
	if err != nil || length != uint32(unsafe.Sizeof(value)) {
		return 0, errOwnerSessionUnavailable
	}
	return value, nil
}

func verifyOwnerSessionToken(token windows.Token, expectedSID string, expectedSession uint32) error {
	if token == 0 || expectedSession == 0 || expectedSID == "" {
		return errOwnerSessionUnavailable
	}
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || !strings.EqualFold(user.User.Sid.String(), expectedSID) {
		return errOwnerSessionUnavailable
	}
	session, sessionErr := tokenUint32(token, windows.TokenSessionId)
	tokenType, typeErr := tokenUint32(token, windows.TokenType)
	elevation, elevationErr := tokenUint32(token, windows.TokenElevation)
	if sessionErr != nil || typeErr != nil || elevationErr != nil || session != expectedSession || tokenType != windows.TokenPrimary || elevation != 0 {
		return errOwnerSessionUnavailable
	}
	integrity, err := ownerTokenIntegritySID(token)
	if err != nil || integrity != "S-1-16-8192" {
		return errOwnerSessionUnavailable
	}
	return nil
}

func ownerTokenIntegritySID(token windows.Token) (string, error) {
	var required uint32
	_ = windows.GetTokenInformation(token, windows.TokenIntegrityLevel, nil, 0, &required)
	if required < uint32(unsafe.Sizeof(windows.Tokenmandatorylabel{})) || required > 4096 {
		return "", errOwnerSessionUnavailable
	}
	data := make([]byte, required)
	var returned uint32
	if windows.GetTokenInformation(token, windows.TokenIntegrityLevel, &data[0], required, &returned) != nil || returned > required || returned < uint32(unsafe.Sizeof(windows.Tokenmandatorylabel{})) {
		return "", errOwnerSessionUnavailable
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&data[0]))
	if label.Label.Sid == nil {
		return "", errOwnerSessionUnavailable
	}
	return label.Label.Sid.String(), nil
}

func queryOwnerSessionUserToken(session uint32) (windows.Token, error) {
	var token windows.Token
	query := func() error {
		return windows.WTSQueryUserToken(session, &token)
	}
	var err error
	if isLocalSystemProcess() {
		err = withSystemThreadPrivileges([]string{"SeTcbPrivilege"}, query)
	} else {
		err = query()
	}
	if err != nil || token == 0 {
		if token != 0 {
			_ = token.Close()
		}
		if err == nil {
			err = errOwnerSessionUnavailable
		}
		return 0, err
	}
	return token, nil
}

// discoverOwnerSession reads current WTS sessions and obtains their actual
// tokens. Any unreadable logged-on session prevents a false unique match.
// A future execution path must query and verify the token again before use.
func discoverOwnerSession(ownerSID string) (uint32, error) {
	var info *windows.WTS_SESSION_INFO
	var count uint32
	if windows.WTSEnumerateSessions(0, 0, 1, &info, &count) != nil {
		return 0, errOwnerSessionUnavailable
	}
	if info != nil {
		defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(info)))
	}
	if count > 65536 || (count > 0 && info == nil) {
		return 0, errOwnerSessionUnavailable
	}
	candidates := make([]ownerSessionCandidate, 0)
	for _, session := range unsafe.Slice(info, count) {
		if session.SessionID == 0 || (session.State != windows.WTSActive && session.State != windows.WTSDisconnected) {
			continue
		}
		token, err := queryOwnerSessionUserToken(session.SessionID)
		if err != nil || token == 0 {
			return 0, errOwnerSessionUnavailable
		}
		user, err := token.GetTokenUser()
		if err != nil || user == nil || user.User.Sid == nil {
			token.Close()
			return 0, errOwnerSessionUnavailable
		}
		sid := user.User.Sid.String()
		usable := !strings.EqualFold(sid, ownerSID) || verifyOwnerSessionToken(token, ownerSID, session.SessionID) == nil
		token.Close()
		if strings.EqualFold(sid, ownerSID) && !usable {
			return 0, errOwnerSessionUnavailable
		}
		candidates = append(candidates, ownerSessionCandidate{ID: session.SessionID, SID: sid, Active: session.State == windows.WTSActive, Usable: usable})
	}
	return selectOwnerSession(ownerSID, candidates)
}

type ownerTokenSource struct {
	discover  func(string) (uint32, error)
	query     func(uint32) (windows.Token, error)
	verify    func(windows.Token, string, uint32) error
	sameLogon func(windows.Token, windows.Token) bool
	close     func(windows.Token) error
}

// acquireOwnerSessionToken returns a caller-owned primary token only after a
// fresh lookup, token validation and a second unique-session observation.
// It is a primitive, not an authorization or process-launch interface.
func acquireOwnerSessionToken(ownerSID string, source ownerTokenSource) (windows.Token, uint32, error) {
	if source.discover == nil || source.query == nil || source.verify == nil || source.sameLogon == nil || source.close == nil {
		return 0, 0, errOwnerSessionUnavailable
	}
	session, err := source.discover(ownerSID)
	if err != nil || session == 0 {
		return 0, 0, errOwnerSessionUnavailable
	}
	token, err := source.query(session)
	if err != nil || token == 0 {
		if token != 0 {
			_ = source.close(token)
		}
		return 0, 0, errOwnerSessionUnavailable
	}
	valid := false
	defer func() {
		if !valid {
			_ = source.close(token)
		}
	}()
	if source.verify(token, ownerSID, session) != nil {
		return 0, 0, errOwnerSessionUnavailable
	}
	current, err := source.discover(ownerSID)
	if err != nil || current != session || source.verify(token, ownerSID, session) != nil {
		return 0, 0, errOwnerSessionUnavailable
	}
	currentToken, err := source.query(session)
	if err != nil || currentToken == 0 {
		if currentToken != 0 {
			_ = source.close(currentToken)
		}
		return 0, 0, errOwnerSessionUnavailable
	}
	defer source.close(currentToken)
	if source.verify(currentToken, ownerSID, session) != nil || !source.sameLogon(token, currentToken) {
		return 0, 0, errOwnerSessionUnavailable
	}
	valid = true
	return token, session, nil
}

// TOKEN_STATISTICS is a fixed-size Windows structure. AuthenticationId binds
// tokens to the logon session, even if a numeric WTS session ID is reused.
type ownerTokenStatistics struct {
	TokenID, AuthenticationID                                    windows.LUID
	ExpirationTime                                               int64
	TokenType, ImpersonationLevel                                uint32
	DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount uint32
	ModifiedID                                                   windows.LUID
}

func tokenAuthenticationID(token windows.Token) (windows.LUID, error) {
	var stats ownerTokenStatistics
	var length uint32
	if windows.GetTokenInformation(token, windows.TokenStatistics, (*byte)(unsafe.Pointer(&stats)), uint32(unsafe.Sizeof(stats)), &length) != nil || length != uint32(unsafe.Sizeof(stats)) {
		return windows.LUID{}, errOwnerSessionUnavailable
	}
	return stats.AuthenticationID, nil
}

func windowsOwnerTokenSource() ownerTokenSource {
	return ownerTokenSource{
		discover: discoverOwnerSession,
		query:    queryOwnerSessionUserToken,
		verify:   verifyOwnerSessionToken,
		sameLogon: func(a, b windows.Token) bool {
			first, firstErr := tokenAuthenticationID(a)
			second, secondErr := tokenAuthenticationID(b)
			return firstErr == nil && secondErr == nil && first == second
		},
		close: func(token windows.Token) error { return token.Close() },
	}
}
