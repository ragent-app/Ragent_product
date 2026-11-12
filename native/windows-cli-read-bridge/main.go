// A fixed, non-elevated entry point for approved scoped AgentoC CLI calls.
// It does not evaluate shell text and launches the installed CLI with a
// restricted environment so Node startup hooks cannot change the operation.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func readArguments(args []string) (string, bool, error) {
	if len(args) < 2 || len(args) > 3 || (args[0] != "trigger-list" && args[0] != "trigger-help") ||
		(len(args) == 3 && (args[0] != "trigger-list" || args[2] != "--json")) {
		return "", false, errors.New("unsupported read operation")
	}
	u, err := url.Parse(args[1])
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", false, errors.New("invalid control plane address")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != "127.0.0.1:"+strconv.Itoa(port) {
		return "", false, errors.New("invalid control plane port")
	}
	return u.String(), len(args) == 3, nil
}

func childEnvironment(env []string, base string) ([]string, error) {
	allowed := map[string]bool{
		"SYSTEMROOT": true, "WINDIR": true, "SYSTEMDRIVE": true, "TEMP": true, "TMP": true, "TMPDIR": true,
		"USERPROFILE": true, "HOME": true, "APPDATA": true, "LOCALAPPDATA": true,
		"AGENTOC_SESSION_ID": true, "AGENTOC_SESSION_CONTROL_TOKEN": true,
		"AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN": true, "AGENTOC_SESSION_CONTROL_RENEWAL_TOKEN_FILE": true,
		"AGENTOC_SESSION_CONTROL_RUN_ID": true, "AGENTOC_SESSION_CONTROL_SESSION_ID": true,
		"AGENTOC_SESSION_CONTROL_TURN_ID": true,
	}
	seen := map[string]bool{}
	values := map[string]string{}
	result := make([]string, 0, len(allowed)+2)
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if !ok || !allowed[upper] {
			continue
		}
		if seen[upper] {
			return nil, errors.New("ambiguous environment")
		}
		seen[upper] = true
		values[upper] = value
		result = append(result, entry)
	}
	for _, key := range []string{"AGENTOC_SESSION_CONTROL_TOKEN", "AGENTOC_SESSION_CONTROL_RUN_ID", "AGENTOC_SESSION_CONTROL_SESSION_ID", "AGENTOC_SESSION_CONTROL_TURN_ID"} {
		if !seen[key] || values[key] == "" {
			return nil, errors.New("session capability unavailable")
		}
	}
	if values["AGENTOC_SESSION_ID"] != values["AGENTOC_SESSION_CONTROL_SESSION_ID"] {
		return nil, errors.New("session identity mismatch")
	}
	u, _ := url.Parse(base)
	// This fixed scoped helper runs inside the managed Windows service
	// environment, whose profile legitimately lives under ProgramData.
	// Set the mode ourselves rather than trusting an inherited value.
	result = append(result, "AGENTOC_WINDOWS_SERVICE_MODE=1", "AGENTOC_CHAT_BASE_URL="+base, "CHAT_PORT="+u.Port())
	return result, nil
}

// Do not accept a target session or endpoint from the caller. The fixed
// launcher appends both after validating the same-session capability.
func triggerCreateArguments(encoded string) ([]string, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > 8192 {
		return nil, errors.New("invalid trigger request")
	}
	var args []string
	if json.Unmarshal(data, &args) != nil || len(args) < 4 || len(args) > 61 {
		return nil, errors.New("invalid trigger request")
	}
	values := map[string]bool{"--text": true, "--in": true, "--at": true, "--every": true, "--max-occurrences": true, "--event": true, "--filter": true, "--title": true, "--tool": true, "--model": true, "--effort": true}
	switches := map[string]bool{"--repeat": true, "--thinking": true, "--json": true}
	seen := map[string]bool{}
	schedule := 0
	hasText := false
	for i := 0; i < len(args); i++ {
		flag := args[i]
		if (!values[flag] && !switches[flag]) || (seen[flag] && flag != "--filter") {
			return nil, errors.New("unsupported trigger option")
		}
		seen[flag] = true
		if flag == "--in" || flag == "--at" || flag == "--event" {
			schedule++
		}
		if values[flag] {
			i++
			if i >= len(args) || strings.TrimSpace(args[i]) == "" || len(args[i]) > 8192 || strings.ContainsAny(args[i], "\x00\r\n") || strings.HasPrefix(args[i], "--") {
				return nil, errors.New("invalid trigger option")
			}
			if flag == "--text" {
				hasText = true
			}
		}
	}
	if !hasText || schedule != 1 {
		return nil, errors.New("invalid trigger schedule")
	}
	return args, nil
}

func run(args []string) error {
	asset := len(args) == 3 && args[0] == "asset-publish"
	create := len(args) == 3 && args[0] == "trigger-create"
	var createArgs []string
	if create {
		var err error
		createArgs, err = triggerCreateArguments(args[2])
		if err != nil {
			return err
		}
	}
	var body string
	if asset {
		decoded, err := base64.RawURLEncoding.DecodeString(args[2])
		if err != nil || len(decoded) == 0 || len(decoded) > 8192 {
			return errors.New("invalid asset payload")
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(decoded, &fields) != nil || fields == nil {
			return errors.New("invalid asset payload")
		}
		for key, value := range fields {
			if key != "localPath" && key != "originalName" && key != "mimeType" && key != "renderAs" && key != "text" {
				return errors.New("unsupported asset field")
			}
			var text string
			if json.Unmarshal(value, &text) != nil {
				return errors.New("invalid asset field")
			}
			if key == "localPath" && (!filepath.IsAbs(text) || strings.HasPrefix(text, `\\`)) {
				return errors.New("invalid asset path")
			}
			if key == "renderAs" && text != "file" {
				return errors.New("unsupported asset rendering")
			}
		}
		if _, ok := fields["localPath"]; !ok {
			return errors.New("asset path required")
		}
		body = string(decoded)
	}
	readArgs := args
	if asset || create {
		readArgs = []string{"trigger-help", args[1]}
	}
	base, jsonOutput, err := readArguments(readArgs)
	if err != nil {
		return err
	}
	env, err := childEnvironment(os.Environ(), base)
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(filepath.Dir(self))
	node, cli := filepath.Join(root, "node.exe"), filepath.Join(root, "cli.js")
	for _, file := range []string{node, cli} {
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("installed CLI unavailable")
		}
	}
	argv := []string{cli, "trigger", "list", "--base-url", base}
	if create {
		session := os.Getenv("AGENTOC_SESSION_ID")
		if session == "" || len(session) > 128 || strings.Trim(session, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != "" {
			return errors.New("invalid session identity")
		}
		argv = append([]string{cli, "trigger", "create"}, createArgs...)
		argv = append(argv, "--session", session, "--base-url", base)
	}
	if asset {
		session := os.Getenv("AGENTOC_SESSION_ID")
		if session == "" || len(session) > 128 || strings.Trim(session, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != "" {
			return errors.New("invalid session identity")
		}
		argv = []string{cli, "api", "POST", "/api/sessions/" + url.PathEscape(session) + "/assets", "--body", body, "--base-url", base}
	}
	if args[0] == "trigger-help" {
		argv = append(argv, "--help")
	}
	if jsonOutput {
		argv = append(argv, "--json")
	}
	cmd := exec.Command(node, argv...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, os.Stdout, os.Stderr
	return cmd.Run()
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "AgentoC scoped operation failed:", err)
		if failure, ok := err.(*exec.ExitError); ok {
			os.Exit(failure.ExitCode())
		}
		os.Exit(1)
	}
}
