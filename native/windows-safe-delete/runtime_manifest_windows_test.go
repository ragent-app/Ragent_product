//go:build windows

package safedelete

import (
	"crypto/sha256"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeManifestChecksCompleteUnicodeTree(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "运行 时")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	image, library := filepath.Join(dir, "git.exe"), filepath.Join(dir, "依赖.dll")
	if err := os.WriteFile(image, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(library, []byte("library"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := []RuntimeManifestFile{
		{Path: "运行 时/git.exe", Size: 5, SHA256: sha256.Sum256([]byte("image"))},
		{Path: "运行 时/依赖.dll", Size: 7, SHA256: sha256.Sum256([]byte("library"))},
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(library, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		t.Fatal("modified dependency accepted")
	}
	if err := os.WriteFile(library, []byte("library"), 0600); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(dir, "extra.dll")
	if err := os.WriteFile(extra, []byte("extra"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		t.Fatal("unlisted file accepted")
	}
	if err := os.Remove(extra); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(root, "unlisted-dir")
	if err := os.Mkdir(empty, 0700); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		t.Fatal("unlisted directory accepted")
	}
	if err := os.Remove(empty); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(library); err != nil {
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		t.Fatal("missing dependency accepted")
	}
}

// This opt-in test only reads an existing Git runtime. A manifest computed
// from the same tree is a compatibility fixture, not a trust attestation.
func TestOptionalInstalledGitRuntimeManifest(t *testing.T) {
	root := os.Getenv("RAGENT_QA_GIT_BIN")
	if root == "" {
		t.Skip("no installed Git runtime supplied")
	}
	var manifest []RuntimeManifestFile
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return ErrExecutableIdentity
		}
		file, err := os.Open(name)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, readErr := io.Copy(hash, file)
		closeErr := file.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		var digest [sha256.Size]byte
		copy(digest[:], hash.Sum(nil))
		manifest = append(manifest, RuntimeManifestFile{Path: filepath.ToSlash(rel), Size: info.Size(), SHA256: digest})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err != nil {
		t.Fatal(err)
	}
	t.Logf("read-only Git runtime compatibility: %d files", len(manifest))
}

func TestRuntimeManifestRejectsAmbiguousPathsAndReparse(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "git.exe")
	if err := os.WriteFile(file, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	good := RuntimeManifestFile{Path: "git.exe", Size: 5, SHA256: sha256.Sum256([]byte("image"))}
	for _, bad := range []string{"../git.exe", "/git.exe", "dir\\git.exe", "git.exe:stream", "NUL.exe", "dir./git.exe", "dir /git.exe", "dir//git.exe"} {
		entry := good
		entry.Path = bad
		if err := VerifyRuntimeManifestContent(root, []RuntimeManifestFile{entry}); err == nil {
			t.Fatalf("ambiguous path accepted: %q", bad)
		}
	}
	duplicate := good
	duplicate.Path = "GIT.EXE"
	if err := VerifyRuntimeManifestContent(root, []RuntimeManifestFile{good, duplicate}); err == nil {
		t.Fatal("case-folded duplicate accepted")
	}
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	createTestReparsePoint(t, outside, link)
	if err := VerifyRuntimeManifestContent(root, []RuntimeManifestFile{good}); err == nil {
		t.Fatal("reparse point accepted")
	}
}
