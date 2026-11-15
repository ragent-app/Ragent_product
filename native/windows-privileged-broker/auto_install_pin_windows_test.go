//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRuntimePinsPreventWritesAndRejectHardlinks(t *testing.T) {
	root := t.TempDir()
	vendor := filepath.Join(root, "vendor")
	manifest := runtimeManifest{SchemaVersion: 1}
	for name, value := range map[string]string{"PowerShell/pwsh.exe": "shell", "Microsoft.WinGet.Client/Microsoft.WinGet.Client.psd1": "module"} {
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
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vendor, "runtime-integrity.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	pins, _, err := pinRuntimeContent(vendor, fmt.Sprintf("%x", digest))
	if err != nil {
		t.Fatalf("pinning valid fixture failed: %v", err)
	}
	exe := filepath.Join(vendor, "PowerShell", "pwsh.exe")
	if err := os.WriteFile(exe, []byte("other"), 0600); err == nil {
		pins.Close()
		t.Fatal("pinned executable could be overwritten")
	}
	if err := os.Rename(exe, exe+".old"); err == nil {
		pins.Close()
		t.Fatal("pinned executable could be renamed")
	}
	pins.Close()
	if err := os.WriteFile(exe, []byte("shell"), 0600); err != nil {
		t.Fatalf("write remained blocked after release: %v", err)
	}
	checked := map[string]bool{}
	checkedPins, _, err := pinRuntimeWithDirectoryACL(vendor, fmt.Sprintf("%x", digest), func(path string) error { checked[path] = true; return nil })
	if err != nil {
		t.Fatal(err)
	}
	checkedPins.Close()
	for _, expected := range []string{vendor, filepath.Join(vendor, "PowerShell"), filepath.Join(vendor, "Microsoft.WinGet.Client")} {
		if !checked[expected] {
			t.Fatalf("directory ACL not checked: %s", expected)
		}
	}
	if _, _, err := pinRuntimeWithDirectoryACL(vendor, fmt.Sprintf("%x", digest), func(string) error { return errors.New("untrusted") }); err == nil {
		t.Fatal("untrusted directory accepted")
	}
	if err := os.WriteFile(exe, []byte("shell"), 0600); err != nil {
		t.Fatalf("pins leaked after ACL rejection: %v", err)
	}
	link := filepath.Join(root, "other-link.exe")
	if err := os.Link(exe, link); err != nil {
		t.Skipf("test volume does not support hardlinks: %v", err)
	}
	if pins, _, err := pinRuntimeContent(vendor, fmt.Sprintf("%x", digest)); err == nil {
		pins.Close()
		t.Fatal("hard-linked executable accepted")
	}
}

func TestOptionalStagedRuntimePins(t *testing.T) {
	root := os.Getenv("RAGENT_TEST_RUNTIME_VENDOR")
	digest := os.Getenv("RAGENT_TEST_RUNTIME_MANIFEST_SHA256")
	if root == "" || digest == "" {
		t.Skip("no isolated staged runtime supplied")
	}
	pins, manifest, err := pinRuntimeContent(root, digest)
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if len(manifest.Files) < 100 {
		t.Fatal("staged runtime was unexpectedly incomplete")
	}
	// Run only a fixed, harmless PowerShell statement; no package manager or
	// installation command is loaded. This checks loader access while pinned.
	cmd := exec.Command(filepath.Join(root, "PowerShell", "pwsh.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write('runtime-ready')")
	output, err := cmd.CombinedOutput()
	if err != nil || string(output) != "runtime-ready" {
		t.Fatalf("pinned runtime failed to start: %v %s", err, output)
	}
	module := filepath.Join(root, "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1")
	cmd = exec.Command(filepath.Join(root, "PowerShell", "pwsh.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Import-Module -Name $env:RAGENT_TEST_MODULE -Force -ErrorAction Stop; if (Get-Command Find-WinGetPackage -ErrorAction Stop) { [Console]::Write('module-ready') }")
	cmd.Env = append(os.Environ(), "RAGENT_TEST_MODULE="+module)
	output, err = cmd.CombinedOutput()
	if err != nil || string(output) != "module-ready" {
		t.Fatalf("pinned module failed to load: %v %s", err, output)
	}
}
