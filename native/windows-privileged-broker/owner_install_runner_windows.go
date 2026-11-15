//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"path/filepath"
	"regexp"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

var ownerPackageIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
var ownerPackageVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$`)

type ownerInstallResult struct{ Status, Code string }
type ownerInstallRunner struct {
	// acquireRuntime must pin the complete verified runtime until release.
	acquireRuntime func() (vendor string, release func(), err error)
	tokens         ownerTokenSource
	environment    func(windows.Token) ([]string, error)
	paths          func() (root, systemDir string, err error)
	run            func(context.Context, windows.Token, string, []string, []string, string) (int, error)
	inspect        func(context.Context, windows.Token, string, []string, []string, string) ([]byte, error)
	elevate        func(windows.Token, string, uint32) (windows.Token, error)
	closeElevated  func(windows.Token) error
}

// install is private and does not authorize, claim, or persist a request. Its
// caller must first verify the exact operation and derive ownerSID from the
// protected installation policy; no request may supply that identity.
func (runner ownerInstallRunner) install(parent context.Context, ownerSID, packageID, version, scope string) ownerInstallResult {
	failed := func(code string) ownerInstallResult { return ownerInstallResult{Status: "failed", Code: code} }
	if parent == nil || !ownerPackageIDPattern.MatchString(packageID) || !ownerPackageVersionPattern.MatchString(version) || (scope != "user" && scope != "default") || runner.acquireRuntime == nil || runner.paths == nil || runner.environment == nil || runner.run == nil {
		return failed("OWNER_INSTALL_INVALID")
	}
	vendor, release, err := runner.acquireRuntime()
	if err != nil || release == nil || !filepath.IsAbs(vendor) {
		if release != nil {
			release()
		}
		return failed("OWNER_INSTALL_RUNTIME_UNTRUSTED")
	}
	defer release()
	root, systemDir, err := runner.paths()
	if err != nil {
		return failed("OWNER_INSTALL_SYSTEM_UNAVAILABLE")
	}
	token, session, err := acquireOwnerSessionToken(ownerSID, runner.tokens)
	if err != nil {
		return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
	}
	defer runner.tokens.close(token)
	userEnv, err := runner.environment(token)
	if err != nil {
		return failed("OWNER_INSTALL_ENVIRONMENT_UNAVAILABLE")
	}
	env, err := ownerInstallEnvironment(userEnv, root, systemDir, vendor)
	if err != nil {
		return failed("OWNER_INSTALL_ENVIRONMENT_UNAVAILABLE")
	}
	env = append(env, "RAGENT_INSTALL_PACKAGE_ID="+packageID, "RAGENT_INSTALL_PACKAGE_VERSION="+version, "RAGENT_INSTALL_SCOPE="+scope)
	units := utf16.Encode([]rune(ownerInstallScript))
	encoded := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(encoded[i*2:], unit)
	}
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(encoded)}
	executable := filepath.Join(vendor, "PowerShell", "pwsh.exe")
	var selected *selectedInstallerFacts
	if runner.inspect != nil && runner.elevate != nil && runner.closeElevated != nil {
		inspectCtx, cancelInspect := context.WithTimeout(parent, 30*time.Second)
		data, inspectErr := runner.inspect(inspectCtx, token, executable, args, append(append([]string{}, env...), "RAGENT_INSTALL_INSPECT=1"), systemDir)
		cancelInspect()
		if inspectErr == nil && len(data) <= 64*1024 {
			var facts selectedInstallerFacts
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			var extra any
			if decoder.Decode(&facts) == nil && decoder.Decode(&extra) == io.EOF && validInstallerFacts(&facts, packageID, version) && facts.Scope == "User" && (facts.Elevation == "ElevationRequired" || facts.Elevation == "ElevatesSelf") {
				selected = &facts
			}
		}
	}
	// Check once more after environment construction, immediately before the
	// child starts. A vanished or ambiguous session cannot be silently reused.
	current, err := runner.tokens.discover(ownerSID)
	if err != nil || current != session || runner.tokens.verify(token, ownerSID, session) != nil {
		return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
	}
	currentToken, currentSession, err := acquireOwnerSessionToken(ownerSID, runner.tokens)
	if err != nil {
		return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
	}
	consistent := currentSession == session && runner.tokens.sameLogon(token, currentToken)
	_ = runner.tokens.close(currentToken)
	if !consistent {
		return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
	}
	if parent.Err() != nil {
		return failed("OWNER_INSTALL_RUN_CANCELLED")
	}
	executionToken := token
	if selected != nil {
		elevated, elevatedErr := runner.elevate(token, ownerSID, session)
		if elevatedErr != nil && elevated != 0 {
			_ = runner.closeElevated(elevated)
		}
		if elevatedErr == nil && elevated != 0 {
			defer runner.closeElevated(elevated)
			fresh, freshSession, freshErr := acquireOwnerSessionToken(ownerSID, runner.tokens)
			if freshErr != nil {
				return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
			}
			stillCurrent := freshSession == session && runner.tokens.sameLogon(token, fresh)
			_ = runner.tokens.close(fresh)
			if !stillCurrent || parent.Err() != nil {
				return failed("OWNER_INSTALL_OWNER_UNAVAILABLE")
			}
			data, marshalErr := json.Marshal(selected)
			if marshalErr != nil {
				return failed("OWNER_INSTALL_INVALID")
			}
			env = append(env, "RAGENT_INSTALL_SELECTED="+string(data))
			executionToken = elevated
		}
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	exit, runErr := runner.run(ctx, executionToken, executable, args, env, systemDir)
	if ctx.Err() != nil {
		return ownerInstallResult{Status: "unknown", Code: "OWNER_INSTALL_OUTCOME_UNKNOWN"}
	}
	if runErr == nil && exit == 0 {
		return ownerInstallResult{Status: "succeeded", Code: "OWNER_INSTALL_SUCCEEDED"}
	}
	switch exit {
	case 20:
		return failed("OWNER_INSTALL_MODULE_UNAVAILABLE")
	case 21:
		return failed("OWNER_INSTALL_SOURCE_UNVERIFIED")
	case 22:
		return failed("OWNER_INSTALL_PACKAGE_UNAVAILABLE")
	case 24:
		return ownerInstallResult{Status: "unknown", Code: "OWNER_INSTALL_REBOOT_REQUIRED"}
	case 25:
		return failed("OWNER_INSTALL_SELECTION_CHANGED")
	default:
		return failed("OWNER_INSTALL_FAILED")
	}
}
