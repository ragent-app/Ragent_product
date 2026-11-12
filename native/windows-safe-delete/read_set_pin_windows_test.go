//go:build windows

package safedelete

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedReadSetIsAtomicAndPreservesOrder(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.txt")
	second := filepath.Join(root, "second.txt")
	for _, name := range []string{first, second} {
		if err := os.WriteFile(name, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256.Sum256([]byte("fixture"))
	bad := []ReadTarget{{Path: first, SHA256: digest}, {Path: second, SHA256: sha256.Sum256([]byte("wrong"))}}
	if set, err := OpenPinnedReadSet(bad); err == nil {
		set.Close()
		t.Fatal("changed second target was accepted")
	}
	if err := os.WriteFile(first, []byte("fixture"), 0600); err != nil {
		t.Fatalf("partial failure retained first handle: %v", err)
	}
	if set, err := OpenPinnedReadSet([]ReadTarget{{Path: first, SHA256: digest}, {Path: strings.ToUpper(first), SHA256: digest}}); err == nil {
		set.Close()
		t.Fatal("duplicate target accepted")
	}
	set, err := OpenPinnedReadSet([]ReadTarget{{Path: first, SHA256: digest}, {Path: second, SHA256: digest}})
	if err != nil {
		t.Fatal(err)
	}
	paths := set.Paths()
	if len(paths) != 2 || paths[0] != first || paths[1] != second {
		t.Fatal("target order changed")
	}
	paths[0] = "changed"
	if set.Paths()[0] != first {
		t.Fatal("returned paths modified the lease")
	}
	for _, name := range []string{first, second} {
		if err := os.WriteFile(name, []byte("changed"), 0600); err == nil {
			t.Fatal("pinned set allowed overwrite")
		}
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if len(set.Paths()) != 0 {
		t.Fatal("closed set still exposes targets")
	}
	if err := os.WriteFile(first, []byte("changed"), 0600); err != nil {
		t.Fatalf("file remained locked: %v", err)
	}
}

func TestPinnedReadSetRejectsInvalidCounts(t *testing.T) {
	for _, targets := range [][]ReadTarget{nil, make([]ReadTarget, 129)} {
		if set, err := OpenPinnedReadSet(targets); err == nil {
			set.Close()
			t.Fatal("invalid count accepted")
		}
	}
}
