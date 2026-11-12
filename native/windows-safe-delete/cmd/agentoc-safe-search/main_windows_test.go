//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func requestArgs(t *testing.T, value any) []string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return []string{"--request", base64.RawURLEncoding.EncodeToString(data)}
}

func TestListingMatchesPowerShellNameOutput(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"aaa.md", "项目.md", "hidden.md", "skip.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "zeta.md"), 0700); err != nil {
		t.Fatal(err)
	}
	hidden, err := windows.UTF16PtrFromString(filepath.Join(root, "hidden.md"))
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(hidden, windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatal(err)
	}
	defer windows.SetFileAttributes(hidden, windows.FILE_ATTRIBUTE_NORMAL)
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	shells := []string{filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	for _, pattern := range []string{"*.md", "a??.md", "[a-z]*.md", "*.MD", "*"} {
		for _, force := range []bool{false, true} {
			for _, output := range []string{"name", "select-name"} {
				input := listingRequest{SchemaVersion: 1, Directory: root, Pattern: pattern, Force: force, Output: output}
				args := requestArgs(t, input)
				args[0] = "--list"
				var got, stderr bytes.Buffer
				if err := run(args, &got, &stderr); err != nil {
					t.Fatalf("bound listing: %v: %s", err, stderr.String())
				}
				source := "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Get-ChildItem -Path " + quote(filepath.Join(root, pattern))
				if force {
					source += " -Force"
				}
				if output == "name" {
					source += " -Name"
				} else {
					source += " | Select-Object Name | Out-String"
				}
				for _, shell := range shells {
					want, err := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source).Output()
					if err != nil {
						t.Fatal(err)
					}
					if strings.TrimSpace(got.String()) != strings.TrimSpace(string(want)) {
						t.Fatalf("shell=%s pattern=%s force=%v output=%s: got %q; want %q", shell, pattern, force, output, got.String(), want)
					}
				}
			}
		}
	}
}

func TestListingMatchesPowerShellFileAndDirectoryFilters(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "folder.md"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	for _, kind := range []string{"file", "directory"} {
		input := listingRequest{SchemaVersion: 1, Directory: root, Pattern: "*.md", Force: true, Kind: kind, Output: "name"}
		args := requestArgs(t, input)
		args[0] = "--list"
		var got, stderr bytes.Buffer
		if err := run(args, &got, &stderr); err != nil {
			t.Fatalf("bound %s listing: %v: %s", kind, err, stderr.String())
		}
		source := "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Get-ChildItem -Path " +
			quote(filepath.Join(root, "*.md")) + " -Force -" + kind + " -Name"
		want, err := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source).Output()
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(got.String()) != strings.TrimSpace(string(want)) {
			t.Fatalf("kind=%s: got %q; want %q", kind, got.String(), want)
		}
	}
}

func TestListingHelperChild(t *testing.T) {
	encoded := os.Getenv("AGENTOC_QA_LISTING_HELPER_CHILD")
	if encoded == "" {
		return
	}
	if err := run([]string{"--list", encoded}, os.Stdout, os.Stderr); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestListingMatchesPowerShellMetadataTable(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "folder.md"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "spaced file.md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, strings.Repeat("long", 20)+".md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	input := listingRequest{SchemaVersion: 1, Directory: root, Pattern: "*.md", Force: true, Output: "select",
		Properties: []string{"Mode", "LastWriteTime", "Length", "Name"}, FormatTable: true}
	args := requestArgs(t, input)
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	source := "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; Get-ChildItem -Path " + quote(filepath.Join(root, "*.md")) +
		" -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize | Out-String"
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shells := []string{filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")}
	if modern := filepath.Join(os.Getenv("ProgramFiles"), "PowerShell", "7", "pwsh.exe"); os.Getenv("ProgramFiles") != "" {
		if info, err := os.Stat(modern); err == nil && !info.IsDir() {
			shells = append(shells, modern)
		}
	}
	normalize := func(value string) string {
		var lines []string
		for _, line := range strings.Split(value, "\n") {
			if fields := strings.Fields(line); len(fields) > 0 {
				lines = append(lines, strings.Join(fields, " "))
			}
		}
		return strings.Join(lines, "\n")
	}
	for _, shell := range shells {
		child := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& "+quote(executable)+" '-test.run=^TestListingHelperChild$'")
		child.Env = append(os.Environ(), "AGENTOC_QA_LISTING_HELPER_CHILD="+args[1])
		got, err := child.Output()
		if err != nil {
			t.Fatalf("bound listing under %s: %v", shell, err)
		}
		want, err := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source).Output()
		if err != nil {
			t.Fatal(err)
		}
		if normalize(string(got)) != normalize(string(want)) {
			t.Fatalf("shell=%s: got %q; want %q", shell, got, want)
		}
	}
}

func TestBoundSearchExecutesOnlyVerifiedLiteralFile(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "outside fixture.txt")
	data := []byte("visible-fixture\n")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	input := request{SchemaVersion: 1, Targets: []target{{Path: file, SHA256: hex.EncodeToString(digest[:])}}, Pattern: "visible-fixture"}
	var out, stderr bytes.Buffer
	if err := run(requestArgs(t, input), &out, &stderr); err != nil {
		t.Fatalf("search failed: %v: %s", err, stderr.String())
	}
	if !strings.Contains(out.String(), "visible-fixture") {
		t.Fatal("verified file result missing")
	}
	input.Switches = []string{"raw", "noemphasis"}
	input.Encoding = "utf8NoBOM"
	out.Reset()
	stderr.Reset()
	if err := run(requestArgs(t, input), &out, &stderr); err != nil || strings.TrimSpace(out.String()) != "visible-fixture" {
		t.Fatalf("raw search did not return the matched line: %q %v %s", out.String(), err, stderr.String())
	}
	input.Switches = nil
	input.Encoding = ""
	if err := os.WriteFile(file, []byte("replaced"), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	stderr.Reset()
	if err := run(requestArgs(t, input), &out, &stderr); err == nil {
		t.Fatal("changed file was searched")
	}
	if out.Len() != 0 {
		t.Fatal("changed file produced output")
	}
}

func TestSearchPatternIsDataAndEnvelopeIsStrict(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "fixture.txt")
	marker := filepath.Join(root, "marker.txt")
	data := []byte("fixture")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	input := request{SchemaVersion: 1, Targets: []target{{Path: file, SHA256: hex.EncodeToString(digest[:])}}, Pattern: "'; Remove-Item '" + marker + "'; #", Switches: []string{"simplematch"}}
	var out, stderr bytes.Buffer
	if err := run(requestArgs(t, input), &out, &stderr); err != nil {
		t.Fatalf("literal pattern search failed: %v: %s", err, stderr.String())
	}
	if got, err := os.ReadFile(marker); err != nil || string(got) != "keep" {
		t.Fatal("pattern was executed as code")
	}
	input.Switches = []string{"force"}
	if err := run(requestArgs(t, input), &out, &stderr); err == nil {
		t.Fatal("unknown switch accepted")
	}
	input.Switches = []string{"quiet", "quiet"}
	if err := run(requestArgs(t, input), &out, &stderr); err == nil {
		t.Fatal("duplicate switch accepted")
	}
	if _, err := decodeRequest(requestArgs(t, map[string]any{"schemaVersion": 1, "unknown": true})); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestDigestUsesPinnedRegularFiles(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "fixture.txt")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	input := digestRequest{SchemaVersion: 1, Paths: []string{file}}
	args := requestArgs(t, input)
	args[0] = "--digest"
	var out, stderr bytes.Buffer
	if err := run(args, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	var targets []target
	digest := sha256.Sum256([]byte("fixture"))
	if err := json.Unmarshal(out.Bytes(), &targets); err != nil || len(targets) != 1 || targets[0].Path != file || targets[0].SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("incorrect pinned digest: %s %v", out.String(), err)
	}
	other := filepath.Join(root, "hard-link.txt")
	if err := os.Link(file, other); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run(args, &out, &stderr); err == nil || out.Len() != 0 {
		t.Fatal("hard-linked target produced a digest")
	}
}
