//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// The request pipe authenticates the control-plane service. It must bind the
// UUID to an authorized owner turn before submitting this operation.
func readInstalledOwnerHistory(parent context.Context, ownerSID, id, cursor string) (map[string]any, error) {
	if parent == nil || !uuidPattern.MatchString(id) || !historyCursorPattern.MatchString(cursor) {
		return nil, errOwnerSessionUnavailable
	}
	exe, err := os.Executable()
	if err != nil || !filepath.IsAbs(exe) {
		return nil, errOwnerSessionUnavailable
	}
	pin, _, err := pinWindowsServiceImage(exe)
	if err != nil {
		return nil, errOwnerSessionUnavailable
	}
	defer pin.Close()
	if len(pin.handles) < 2 || validatePinnedServiceImageDirectories([]*serviceImagePins{pin}) != nil {
		return nil, errOwnerSessionUnavailable
	}
	image := pin.handles[len(pin.handles)-1]
	sd, err := windows.GetSecurityInfo(image, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil || validateOwnerPolicySecurity(sd, false) != nil {
		return nil, errOwnerSessionUnavailable
	}
	source := windowsOwnerTokenSource()
	token, session, err := acquireOwnerSessionToken(ownerSID, source)
	if err != nil {
		return nil, err
	}
	defer source.close(token)
	userEnv, err := token.Environ(false)
	if err != nil {
		return nil, errOwnerSessionUnavailable
	}
	profile := ""
	codexHome := ""
	for _, item := range userEnv {
		key, value, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(key, "USERPROFILE") {
			if profile != "" || !filepath.IsAbs(value) {
				return nil, errOwnerSessionUnavailable
			}
			profile = value
		}
		if ok && strings.EqualFold(key, "CODEX_HOME") {
			if codexHome != "" || !filepath.IsAbs(value) {
				return nil, errOwnerSessionUnavailable
			}
			codexHome = value
		}
	}
	if profile == "" {
		return nil, errOwnerSessionUnavailable
	}
	fresh, currentSession, err := acquireOwnerSessionToken(ownerSID, source)
	if err != nil {
		return nil, err
	}
	consistent := currentSession == session && source.sameLogon(token, fresh)
	_ = source.close(fresh)
	if !consistent {
		return nil, errOwnerSessionUnavailable
	}
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	env := []string{"USERPROFILE=" + profile}
	if codexHome != "" {
		env = append(env, "CODEX_HOME="+codexHome)
	}
	data, err := runOwnerInspection(ctx, token, exe, []string{"--owner-codex-history", id, cursor}, env, filepath.Dir(exe))
	if err != nil {
		return nil, errOwnerSessionUnavailable
	}
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("owner history response invalid")
	}
	return result, nil
}
