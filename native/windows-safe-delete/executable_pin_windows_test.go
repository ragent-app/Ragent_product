//go:build windows

package safedelete

import (
	"crypto/sha256"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPinnedExecutablePreventsReplacementAndRequiresDigest(t *testing.T) {
	root := t.TempDir()
	image := filepath.Join(root, "程序 fixture.exe")
	if err := os.WriteFile(image, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("original"))
	for _, invalid := range []string{"git.exe", image + ":stream.exe", filepath.Join(root, "document.txt")} {
		if p, err := OpenPinnedExecutable(invalid, digest); err == nil {
			p.Close()
			t.Fatalf("invalid executable path accepted: %q", invalid)
		}
	}
	if _, err := OpenPinnedExecutable(image, sha256.Sum256([]byte("wrong"))); err == nil {
		t.Fatal("wrong digest accepted")
	}
	pin, err := OpenPinnedExecutable(image, digest)
	if err != nil {
		t.Fatal(err)
	}
	if pin.Path() != image {
		t.Fatal("pinned wrong path")
	}
	if err := os.WriteFile(image, []byte("replacement"), 0600); err == nil {
		t.Fatal("pinned executable was overwritten")
	}
	if err := os.Rename(image, image+".old"); err == nil {
		t.Fatal("pinned executable was renamed")
	}
	if err := os.Remove(image); err == nil {
		t.Fatal("pinned executable was deleted")
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image, []byte("replacement"), 0600); err != nil {
		t.Fatalf("pin not released: %v", err)
	}
	link := filepath.Join(root, "linked.exe")
	if err := os.Link(image, link); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if p, err := OpenPinnedExecutable(image, sha256.Sum256([]byte("replacement"))); err == nil {
		p.Close()
		t.Fatal("hard-linked executable accepted")
	}
}

// Another hard-link name may be removed even while the opened name is pinned.
// Verify the distinction before using any path-binding primitive.
func TestPinnedHardLinkNameAndAlias(t *testing.T) {
	root := t.TempDir()
	image := filepath.Join(root, "git.exe")
	alias := filepath.Join(root, "other.exe")
	if err := os.WriteFile(image, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(image, alias); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	name, err := windows.UTF16PtrFromString(image)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(h), image)
	if file == nil {
		windows.CloseHandle(h)
		t.Fatal("invalid handle")
	}
	defer file.Close()
	if err := os.Remove(alias); err == nil {
		if err := os.WriteFile(alias, []byte("replacement"), 0600); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Logf("filesystem also prevented alias unlink: %v", err)
	}
	if err := os.Remove(image); err == nil {
		t.Fatal("opened executable name could be unlinked")
	}
	pinned, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	named, err := os.ReadFile(image)
	if err != nil {
		t.Fatal(err)
	}
	if string(pinned) != "original" || string(named) != "original" {
		t.Fatal("opened name no longer referred to the pinned bytes")
	}
}

func TestPinnedExecutablePathProtectsHardlinkAndAncestorNames(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "程序目录")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	image, alias := filepath.Join(dir, "git.exe"), filepath.Join(dir, "alias.exe")
	if err := os.WriteFile(image, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(image, alias); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	lease, err := OpenPinnedExecutablePath(image, sha256.Sum256([]byte("original")))
	if err != nil {
		t.Fatal(err)
	}
	if lease.Path() != image {
		t.Fatal("pinned wrong image")
	}
	if err := os.Remove(image); err == nil {
		lease.Close()
		t.Fatal("pinned image name could be removed")
	}
	if err := os.Rename(dir, dir+"-moved"); err == nil {
		lease.Close()
		t.Fatal("pinned ancestor could be renamed")
	}
	if err := os.WriteFile(alias, []byte("changed"), 0600); err == nil {
		lease.Close()
		t.Fatal("alias could change pinned bytes")
	}
	if err := os.WriteFile(filepath.Join(dir, "ordinary.txt"), []byte("ok"), 0600); err != nil {
		lease.Close()
		t.Fatalf("ordinary child write was blocked: %v", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if lease.Path() != "" {
		t.Fatal("closed lease still exposes a path")
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir, dir+"-moved"); err != nil {
		t.Fatalf("ancestor remained locked: %v", err)
	}
}

func TestPinnedExecutablePathRejectsReparseAndReleasesOnFailure(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "real")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(dir, "git.exe")
	if err := os.WriteFile(image, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if p, err := OpenPinnedExecutablePath(image, sha256.Sum256([]byte("wrong"))); err == nil {
		p.Close()
		t.Fatal("wrong digest accepted")
	}
	moved := dir + "-moved"
	if err := os.Rename(dir, moved); err != nil {
		t.Fatalf("failed lease retained ancestor handle: %v", err)
	}
	if err := os.Rename(moved, dir); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	createTestReparsePoint(t, dir, link)
	if p, err := OpenPinnedExecutablePath(filepath.Join(link, "git.exe"), sha256.Sum256([]byte("fixture"))); err == nil {
		p.Close()
		t.Fatal("reparse ancestor accepted")
	}
}

func TestPinnedDependencyPathProtectsDLL(t *testing.T) {
	root := t.TempDir()
	name := filepath.Join(root, "依赖 file.dll")
	if err := os.WriteFile(name, []byte("fixture DLL"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("fixture DLL"))
	if p, err := OpenPinnedExecutablePath(name, digest); err == nil {
		p.Close()
		t.Fatal("DLL accepted as main executable")
	}
	lease, err := OpenPinnedDependencyPath(name, digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("changed"), 0600); err == nil {
		lease.Close()
		t.Fatal("pinned DLL could be overwritten")
	}
	if err := os.Rename(name, name+".old"); err == nil {
		lease.Close()
		t.Fatal("pinned DLL could be renamed")
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("changed"), 0600); err != nil {
		t.Fatalf("DLL remained locked: %v", err)
	}
	if p, err := OpenPinnedDependencyPath(filepath.Join(root, "file.txt"), digest); err == nil {
		p.Close()
		t.Fatal("unexpected dependency type accepted")
	}
}

func TestPinnedExecutableRemainsLaunchable(t *testing.T) {
	image, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(image)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := OpenPinnedExecutable(image, sha256.Sum256(data))
	if err != nil {
		t.Fatal(err)
	}
	defer pin.Close()
	marker := filepath.Join(t.TempDir(), "child.txt")
	child := exec.Command(pin.Path(), "-test.run=^TestPinnedExecutableChild$")
	child.Env = append(os.Environ(), "RAGENT_PIN_TEST_MARKER="+marker)
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("pinned image failed to launch: %v: %s", err, out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("pinned child did not run")
	}
}

func TestPinnedExecutableChild(t *testing.T) {
	marker := os.Getenv("RAGENT_PIN_TEST_MARKER")
	if marker == "" {
		t.Skip("child fixture")
	}
	if err := os.WriteFile(marker, []byte("ran"), 0600); err != nil {
		t.Fatal(err)
	}
}
