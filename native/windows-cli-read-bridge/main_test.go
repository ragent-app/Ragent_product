package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReadArguments(t *testing.T) {
	for _, args := range [][]string{
		{"trigger-list", "http://127.0.0.1:7690"},
		{"trigger-list", "http://127.0.0.1:7690", "--json"},
		{"trigger-help", "http://127.0.0.1:7690"},
	} {
		if _, _, err := readArguments(args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{
		{"trigger-list", "http://example.com:7690"}, {"trigger-list", "http://127.0.0.1:7690/other"},
		{"trigger-list", "http://127.0.0.1:7690", "--base-url"}, {"trigger-list", "http://127.0.0.1:7690", "--json", "delete"},
		{"trigger-delete", "http://127.0.0.1:7690"},
		{"trigger-help", "http://127.0.0.1:7690", "--json"},
	} {
		if _, _, err := readArguments(args); err == nil {
			t.Fatalf("unexpectedly accepted %v", args)
		}
	}
}

func TestExecutableUsesInstalledCliWithoutNodeStartupHooks(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("requires the Windows executable")
	}
	node, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(node)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(filepath.Join(root, "node.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(output, input); err != nil {
		t.Fatal(err)
	}
	input.Close()
	output.Close()
	script := `console.log(JSON.stringify({args:process.argv.slice(2),hook:process.env.NODE_OPTIONS||'',base:process.env.AGENTOC_CHAT_BASE_URL}))`
	if err := os.WriteFile(filepath.Join(root, "cli.js"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(root, "bin", "agentoc-cli-read-bridge.exe")
	build := exec.Command("go", "build", "-o", helper, ".")
	if text, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, text)
	}
	cmd := exec.Command(helper, "trigger-list", "http://127.0.0.1:7690", "--json")
	cmd.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "TEMP=" + os.TempDir(), "TMP=" + os.TempDir(),
		"AGENTOC_SESSION_ID=s", "AGENTOC_SESSION_CONTROL_TOKEN=token", "AGENTOC_SESSION_CONTROL_RUN_ID=r",
		"AGENTOC_SESSION_CONTROL_SESSION_ID=s", "AGENTOC_SESSION_CONTROL_TURN_ID=t", "NODE_OPTIONS=--require nonexistent-malicious-module"}
	text, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper: %v: %s", err, text)
	}
	var got struct {
		Args []string `json:"args"`
		Hook string   `json:"hook"`
		Base string   `json:"base"`
	}
	if err := json.Unmarshal(text, &got); err != nil {
		t.Fatal(err)
	}
	if got.Hook != "" || got.Base != "http://127.0.0.1:7690" || strings.Join(got.Args, " ") != "trigger list --base-url http://127.0.0.1:7690 --json" {
		t.Fatalf("unexpected child process: %+v", got)
	}
}

func TestChildEnvironmentStripsNodeHooksAndBindsSession(t *testing.T) {
	input := []string{"SYSTEMROOT=C:\\Windows", "AGENTOC_SESSION_ID=s", "AGENTOC_SESSION_CONTROL_TOKEN=token",
		"AGENTOC_SESSION_CONTROL_RUN_ID=r", "AGENTOC_SESSION_CONTROL_SESSION_ID=s", "AGENTOC_SESSION_CONTROL_TURN_ID=t",
		"NODE_OPTIONS=--require evil.js", "NODE_PATH=attacker", "HTTP_PROXY=http://attacker", "AGENTOC_CHAT_BASE_URL=http://attacker", "AGENTOC_WINDOWS_SERVICE_MODE=0"}
	result, err := childEnvironment(input, "http://127.0.0.1:7690")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(result, "\n")
	for _, bad := range []string{"NODE_OPTIONS", "NODE_PATH", "HTTP_PROXY", "http://attacker"} {
		if strings.Contains(joined, bad) {
			t.Fatalf("unsafe environment retained: %s", bad)
		}
	}
	if !strings.Contains(joined, "AGENTOC_CHAT_BASE_URL=http://127.0.0.1:7690") {
		t.Fatal("trusted endpoint missing")
	}
	if !strings.Contains(joined, "AGENTOC_WINDOWS_SERVICE_MODE=1") || strings.Contains(joined, "AGENTOC_WINDOWS_SERVICE_MODE=0") {
		t.Fatal("managed service mode must be fixed by the helper")
	}
	if _, err := childEnvironment(append(input, "agentoc_session_id=other"), "http://127.0.0.1:7690"); err == nil {
		t.Fatal("duplicate session identity accepted")
	}
	input[1] = "AGENTOC_SESSION_ID=other"
	if _, err := childEnvironment(input, "http://127.0.0.1:7690"); err == nil {
		t.Fatal("mismatched session accepted")
	}
}
