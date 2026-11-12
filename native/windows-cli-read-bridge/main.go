// A fixed, non-elevated entry point for approved read-only AgentoC CLI calls.
// It does not evaluate shell text and launches the installed CLI with a
// restricted environment so Node startup hooks cannot change the operation.
package main

import (
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
	// This fixed read-only helper runs inside the managed Windows service
	// environment, whose profile legitimately lives under ProgramData.
	// Set the mode ourselves rather than trusting an inherited value.
	result = append(result, "AGENTOC_WINDOWS_SERVICE_MODE=1", "AGENTOC_CHAT_BASE_URL="+base, "CHAT_PORT="+u.Port())
	return result, nil
}

func run(args []string) error {
	base, jsonOutput, err := readArguments(args)
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
		fmt.Fprintln(os.Stderr, "AgentoC read operation failed:", err)
		if failure, ok := err.(*exec.ExitError); ok {
			os.Exit(failure.ExitCode())
		}
		os.Exit(1)
	}
}
