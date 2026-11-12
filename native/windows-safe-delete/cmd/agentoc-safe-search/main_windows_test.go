//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requestArgs(t *testing.T, value any) []string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return []string{"--request", base64.RawURLEncoding.EncodeToString(data)}
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
