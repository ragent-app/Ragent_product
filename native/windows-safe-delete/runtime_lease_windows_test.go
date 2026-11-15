//go:build windows

package safedelete

import (
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func runtimeLeaseFixture(t *testing.T) (string, string, []RuntimeManifestFile) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "运行 时")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "git.exe")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := []RuntimeManifestFile{{Path: "运行 时/git.exe", Size: 7, SHA256: sha256.Sum256([]byte("fixture"))}}
	return root, file, manifest
}

func TestRuntimeLeasePinsManifestFilesAndNames(t *testing.T) {
	root, file, manifest := runtimeLeaseFixture(t)
	checked := map[string]bool{}
	lease, err := openRuntimeManifestLease(root, manifest, func(path string, tree bool) error { checked[path] = tree; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !checked[root] || !checked[filepath.Dir(file)] {
		lease.Close()
		t.Fatal("runtime directories not checked")
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err == nil {
		lease.Close()
		t.Fatal("pinned file was overwritten")
	}
	if err := os.Rename(filepath.Dir(file), filepath.Dir(file)+"-moved"); err == nil {
		lease.Close()
		t.Fatal("pinned directory renamed")
	}
	// The test callback deliberately bypasses production ACL checks. A lease
	// alone cannot prevent additions, and the content verifier detects them.
	extra := filepath.Join(root, "extra.dll")
	if err := os.WriteFile(extra, []byte("extra"), 0600); err != nil {
		lease.Close()
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		lease.Close()
		t.Fatal("late extra file not detected")
	}
	if err := os.Remove(extra); err != nil {
		lease.Close()
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err != nil {
		t.Fatalf("file remained locked: %v", err)
	}
}

func TestRuntimeLeaseRefusesUntrustedACLAndReleasesHandles(t *testing.T) {
	root, file, manifest := runtimeLeaseFixture(t)
	if lease, err := openRuntimeManifestLease(root, manifest, nil); err == nil {
		lease.Close()
		t.Fatal("missing ACL verifier accepted")
	}
	if lease, err := openRuntimeManifestLease(root, manifest, func(path string, tree bool) error {
		if path == filepath.Dir(file) {
			return errors.New("untrusted directory")
		}
		return nil
	}); err == nil {
		lease.Close()
		t.Fatal("untrusted directory accepted")
	}
	if err := os.Rename(filepath.Dir(file), filepath.Dir(file)+"-moved"); err != nil {
		t.Fatalf("failed lease retained directory handles: %v", err)
	}
}

func TestProductionRuntimeACLRefusesUserWritableFixture(t *testing.T) {
	root, _, manifest := runtimeLeaseFixture(t)
	if lease, err := OpenRuntimeManifestLease(root, manifest); err == nil {
		lease.Close()
		t.Fatal("user-owned fixture accepted as protected runtime")
	}
}

// Reuses an installed, administrator-controlled flat tool directory without
// modifying it. The generated snapshot tests ACL/lease wiring only; it is not
// an authenticated software provenance manifest.
func TestOptionalProtectedInstalledRuntimeLease(t *testing.T) {
	root := os.Getenv("RAGENT_QA_PROTECTED_RUNTIME")
	if root == "" {
		t.Skip("no protected installed runtime supplied")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var manifest []RuntimeManifestFile
	for _, entry := range entries {
		if entry.IsDir() {
			t.Skip("fixture requires a flat installed runtime")
		}
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() {
			t.Skip("fixture contains nonregular files")
		}
		file, err := os.Open(filepath.Join(root, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.New()
		_, readErr := io.Copy(hash, file)
		closeErr := file.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		var digest [sha256.Size]byte
		copy(digest[:], hash.Sum(nil))
		manifest = append(manifest, RuntimeManifestFile{Path: entry.Name(), Size: info.Size(), SHA256: digest})
	}
	lease, err := OpenRuntimeManifestLease(root, manifest)
	if err != nil {
		for dir := root; ; dir = filepath.Dir(dir) {
			t.Logf("ACL check tree=%v path=%s ok=%v", dir == root, dir, verifyRuntimeACL(dir, dir == root) == nil)
			if filepath.Dir(dir) == dir {
				break
			}
		}
		t.Fatalf("protected installed runtime rejected: %v", err)
	}
	defer lease.Close()
	if err := VerifyRuntimeManifestContent(root, manifest); err != nil {
		t.Fatal(err)
	}
	t.Logf("production ACL and runtime lease held for %d existing files", len(manifest))
}
