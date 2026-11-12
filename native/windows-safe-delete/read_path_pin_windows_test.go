//go:build windows

package safedelete

import (
	"bytes"
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPinnedReadPathProtectsOutsideFileAndAncestors(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	outside := filepath.Join(root, "outside")
	for _, dir := range []string{workspace, outside} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	name := filepath.Join(outside, "搜索 fixture.txt")
	content := []byte("ordinary fixture")
	if err := os.WriteFile(name, content, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	for _, invalid := range []string{"relative.txt", name + ":stream"} {
		if pin, err := OpenPinnedReadPath(invalid, digest); err == nil {
			pin.Close()
			t.Fatalf("invalid path accepted: %q", invalid)
		}
	}
	if pin, err := OpenPinnedReadPath(name, sha256.Sum256([]byte("different"))); err == nil {
		pin.Close()
		t.Fatal("wrong digest accepted")
	}
	if err := os.Rename(outside, outside+"-moved"); err != nil {
		t.Fatalf("failed verification retained an ancestor handle: %v", err)
	}
	if err := os.Rename(outside+"-moved", outside); err != nil {
		t.Fatal(err)
	}
	pin, err := OpenPinnedReadPath(name, digest)
	if err != nil {
		t.Fatal(err)
	}
	if pin.Path() != name {
		t.Fatal("wrong file was pinned")
	}
	if data, err := os.ReadFile(name); err != nil || string(data) != string(content) {
		t.Fatalf("normal read failed: %v", err)
	}
	if err := os.WriteFile(name, []byte("changed"), 0600); err == nil {
		t.Fatal("pinned file was overwritten")
	}
	if err := os.Rename(name, name+".old"); err == nil {
		t.Fatal("pinned file was renamed")
	}
	if err := os.Remove(name); err == nil {
		t.Fatal("pinned file was deleted")
	}
	if err := os.Rename(outside, outside+"-moved"); err == nil {
		t.Fatal("pinned parent was renamed")
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("changed"), 0600); err != nil {
		t.Fatalf("file remained pinned after close: %v", err)
	}
	if pin, err := OpenPinnedReadPath(name, digest); err == nil {
		pin.Close()
		t.Fatal("replacement after approval accepted")
	}
}

func TestPinnedReadPathRejectsAliases(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "fixture.txt")
	content := []byte("fixture")
	if err := os.WriteFile(name, content, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	alias := filepath.Join(root, "alias.txt")
	if err := os.Link(name, alias); err == nil {
		if pin, err := OpenPinnedReadPath(name, digest); err == nil {
			pin.Close()
			t.Fatal("hard-linked file accepted")
		}
		if err := os.Remove(alias); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Logf("hard link creation unavailable: %v", err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(name, link); err == nil {
		if pin, err := OpenPinnedReadPath(link, digest); err == nil {
			pin.Close()
			t.Fatal("reparse-point file accepted")
		}
	} else {
		t.Logf("symbolic link creation unavailable: %v", err)
	}
}

func TestPinnedReadPathRejectsJunctionAncestor(t *testing.T) {
	root := t.TempDir()
	realDir := filepath.Join(root, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "fixture.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(root, "junction")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, realDir).CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v: %s", err, output)
	}
	if pin, err := OpenPinnedReadPath(filepath.Join(junction, "fixture.txt"), sha256.Sum256([]byte("fixture"))); err == nil {
		pin.Close()
		t.Fatal("reparse-point ancestor accepted")
	}
}

func TestPinnedReadPathRemainsReadableByPowerShell(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "fixture.txt")
	content := []byte("visible-fixture\n")
	if err := os.WriteFile(name, content, 0600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "search.ps1")
	if err := os.WriteFile(script, []byte("param([string]$Target)\nSelect-String -LiteralPath $Target -Pattern 'visible-fixture'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	pin, err := OpenPinnedReadPath(name, sha256.Sum256(content))
	if err != nil {
		t.Fatal(err)
	}
	defer pin.Close()
	shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	output, err := exec.Command(shell, "-NoProfile", "-NonInteractive", "-File", script, name).CombinedOutput()
	if err != nil || !bytes.Contains(output, []byte("visible-fixture")) {
		t.Fatalf("PowerShell search failed while pinned: %v: %s", err, output)
	}
}
