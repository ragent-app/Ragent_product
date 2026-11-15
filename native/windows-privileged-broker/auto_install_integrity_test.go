package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeManifestRequiresExactUntamperedFiles(t *testing.T) {
	vendor := t.TempDir()
	content := map[string]string{"PowerShell/pwsh.exe": "shell", "Microsoft.WinGet.Client/Microsoft.WinGet.Client.psd1": "module"}
	manifest := runtimeManifest{SchemaVersion: 1}
	for name, value := range content {
		path := filepath.Join(vendor, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(value))
		manifest.Files = append(manifest.Files, runtimeManifestEntry{Path: name, Size: int64(len(value)), SHA256: fmt.Sprintf("%x", digest)})
	}
	writeManifest := func(value runtimeManifest) string {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(vendor, "runtime-integrity.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		return fmt.Sprintf("%x", digest)
	}
	digest := writeManifest(manifest)
	if _, err := verifyRuntimeManifest(vendor, digest); err != nil {
		t.Fatalf("valid runtime rejected: %v", err)
	}
	exe := filepath.Join(vendor, "PowerShell", "pwsh.exe")
	if err := os.WriteFile(exe, []byte("other"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeManifest(vendor, digest); err == nil {
		t.Fatal("modified executable accepted")
	}
	if err := os.WriteFile(exe, []byte("shell"), 0600); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(vendor, "PowerShell", "extra.dll")
	if err := os.WriteFile(extra, []byte("extra"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeManifest(vendor, digest); err == nil {
		t.Fatal("unlisted executable accepted")
	}
	if err := os.Remove(extra); err != nil {
		t.Fatal(err)
	}
	extraDir := filepath.Join(vendor, "PowerShell", "unexpected")
	if err := os.Mkdir(extraDir, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeManifest(vendor, digest); err == nil {
		t.Fatal("unlisted empty directory accepted")
	}
	if err := os.Remove(extraDir); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeManifest(vendor, fmt.Sprintf("%064d", 0)); err == nil {
		t.Fatal("incorrect manifest digest accepted")
	}
	duplicate := runtimeManifest{SchemaVersion: 1, Files: append(append([]runtimeManifestEntry{}, manifest.Files...), manifest.Files[0])}
	if _, err := verifyRuntimeManifest(vendor, writeManifest(duplicate)); err == nil {
		t.Fatal("duplicate manifest entry accepted")
	}
	manifest.Files[0].Path = "PowerShell/../escape"
	if _, err := verifyRuntimeManifest(vendor, writeManifest(manifest)); err == nil {
		t.Fatal("parent traversal accepted")
	}
}

func TestOptionalStagedRuntimeManifest(t *testing.T) {
	root := os.Getenv("RAGENT_TEST_RUNTIME_VENDOR")
	expected := os.Getenv("RAGENT_TEST_RUNTIME_MANIFEST_SHA256")
	if root == "" || expected == "" {
		t.Skip("no isolated staged runtime supplied")
	}
	manifest, err := verifyRuntimeManifest(root, expected)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) < 100 {
		t.Fatal("staged runtime was unexpectedly incomplete")
	}
}
