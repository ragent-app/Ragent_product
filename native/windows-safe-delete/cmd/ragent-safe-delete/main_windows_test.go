//go:build windows

package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envelope(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func TestRequestValidationAndBoundedDeletion(t *testing.T) {
	root := t.TempDir()
	build := filepath.Join(root, "build")
	if err := os.Mkdir(build, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(build, "output.txt")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	valid := request{SchemaVersion: 1, Workspace: root, Relative: "build", RequestKey: "gate:" + strings.Repeat("a", 64)}
	for _, args := range [][]string{nil, {"--request", "bad!"}, {"--other", envelope(t, valid)},
		{"--request", envelope(t, map[string]any{"schemaVersion": 1, "workspace": root, "relative": "build", "requestKey": valid.RequestKey, "extra": true})},
		{"--request", envelope(t, request{SchemaVersion: 1, Workspace: root, Relative: `..\outside`, RequestKey: valid.RequestKey})}} {
		if _, err := run(args); err == nil {
			t.Fatalf("accepted invalid input %v", args)
		}
		if _, err := os.Stat(file); err != nil {
			t.Fatalf("invalid input changed fixture: %v", err)
		}
	}
	count, err := run([]string{"--request", envelope(t, valid)})
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	if _, err = os.Stat(build); !os.IsNotExist(err) {
		t.Fatalf("target remains: %v", err)
	}
	if _, err = os.Stat(root); err != nil {
		t.Fatalf("workspace changed: %v", err)
	}
}

func TestRelativeTargetRequiresApprovedActualWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "build"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "build", "fixture.txt")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(old) }()
	req := request{SchemaVersion: 1, Workspace: root, Target: "build", TargetFromCwd: true, RequestKey: "gate:" + strings.Repeat("b", 64)}
	for _, cwd := range []string{"", filepath.Join(root, "other")} {
		req.ExpectedCwd = cwd
		if _, err = run([]string{"--request", envelope(t, req)}); err == nil {
			t.Fatalf("accepted cwd %q", cwd)
		}
		if _, err = os.Stat(file); err != nil {
			t.Fatalf("fixture changed: %v", err)
		}
	}
	req.ExpectedCwd = root
	count, err := run([]string{"--request", envelope(t, req)})
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestMultipleTargetsRejectUnsafeEntryBeforeDeletion(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"one.txt", "two.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	req := request{SchemaVersion: 1, Workspace: root, Relatives: []string{"one.txt", `..\outside`}, RequestKey: "gate:" + strings.Repeat("c", 64)}
	if _, err := run([]string{"--request", envelope(t, req)}); err == nil {
		t.Fatal("unsafe target accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "one.txt")); err != nil {
		t.Fatalf("first target changed: %v", err)
	}
	req.Relatives = []string{"one.txt", "two.txt"}
	count, err := run([]string{"--request", envelope(t, req)})
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestMultipleTargetsRejectFileReplacedWithDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "one.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "swapped"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "swapped", "keep.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	req := request{SchemaVersion: 1, Workspace: root, Relatives: []string{"one.txt", "swapped"}, FilesOnly: []bool{true, true}, RequestKey: "gate:" + strings.Repeat("d", 64)}
	if _, err := run([]string{"--request", envelope(t, req)}); err == nil {
		t.Fatal("replacement directory accepted")
	}
	for _, name := range []string{"one.txt", filepath.Join("swapped", "keep.txt")} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			t.Fatalf("%s changed: %v", name, err)
		}
	}
	req.FilesOnly = []bool{true, false}
	count, err := run([]string{"--request", envelope(t, req)})
	if err != nil || count != 3 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}
