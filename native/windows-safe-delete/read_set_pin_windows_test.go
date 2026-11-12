//go:build windows

package safedelete

import (
	"bufio"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
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

func TestInheritedReadHandlesChild(t *testing.T) {
	if os.Getenv("AGENTOC_QA_INHERITED_READ_CHILD") != "1" {
		return
	}
	fmt.Fprintln(os.Stdout, "READY")
	if _, err := bufio.NewReader(os.Stdin).ReadByte(); err != nil {
		t.Fatal(err)
	}
}

func TestInheritedReadHandlesKeepFilesPinned(t *testing.T) {
	file := filepath.Join(t.TempDir(), "target.txt")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	set, err := OpenPinnedReadSet([]ReadTarget{{Path: file, SHA256: sha256.Sum256([]byte("fixture"))}})
	if err != nil {
		t.Fatal(err)
	}
	defer set.Close()
	lease, err := set.DuplicateForChild()
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestInheritedReadHandlesChild$")
	cmd.Env = append(os.Environ(), "AGENTOC_QA_INHERITED_READ_CHILD=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, AdditionalInheritedHandles: lease.Handles()}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if ready, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || strings.TrimSpace(ready) != "READY" {
		t.Fatalf("child failed to start: %q %v", ready, err)
	}
	if err := set.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err == nil {
		t.Fatal("child did not retain file lock")
	}
	if err := os.Rename(file, file+".renamed"); err == nil {
		t.Fatal("child did not retain path lock")
	}
	if _, err := stdin.Write([]byte{'x'}); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err != nil {
		t.Fatalf("child exit did not release lock: %v", err)
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
