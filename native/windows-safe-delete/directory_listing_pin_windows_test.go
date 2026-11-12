//go:build windows

package safedelete

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestPinnedListingReadsNamesWithoutFollowingLinks(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "ordinary")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"visible.md", "hidden.md"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	hidden, err := windows.UTF16PtrFromString(filepath.Join(dir, "hidden.md"))
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(hidden, windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatal(err)
	}
	defer windows.SetFileAttributes(hidden, windows.FILE_ATTRIBUTE_NORMAL)
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "not-followed.md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(dir, "junction.md")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, outside).CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v: %s", err, output)
	}
	lease, err := OpenPinnedListingDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := os.Rename(dir, dir+"-moved"); err == nil {
		t.Fatal("pinned directory was renamed")
	}
	visible, err := lease.Names(false)
	if err != nil {
		t.Fatal(err)
	}
	all, err := lease.Names(true)
	if err != nil {
		t.Fatal(err)
	}
	toMap := func(entries []ListingName) map[string]bool {
		m := make(map[string]bool, len(entries))
		for _, item := range entries {
			m[item.Name] = item.Directory
		}
		return m
	}
	visibleMap, allMap := toMap(visible), toMap(all)
	if _, ok := visibleMap["hidden.md"]; ok {
		t.Fatal("hidden entry leaked into normal listing")
	}
	if _, ok := allMap["hidden.md"]; !ok {
		t.Fatal("force listing missed hidden entry")
	}
	if _, ok := visibleMap["visible.md"]; !ok {
		t.Fatal("ordinary file missing")
	}
	if !visibleMap["junction.md"] {
		t.Fatal("directory link missing")
	}
	if _, ok := allMap["not-followed.md"]; ok {
		t.Fatal("listing followed a directory link")
	}
	if err := os.WriteFile(filepath.Join(dir, "late.md"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	again, err := lease.Names(true)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := toMap(again)["late.md"]; !ok {
		t.Fatal("test incorrectly froze directory membership")
	}
	if pin, err := OpenPinnedListingDirectory(junction); err == nil {
		pin.Close()
		t.Fatal("accepted junction directory")
	}
}
