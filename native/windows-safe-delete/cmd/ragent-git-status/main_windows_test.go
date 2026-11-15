//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	safedelete "ragent/windows-safe-delete"
)

type fixtureLease struct{ closed *bool }

func (f fixtureLease) Close() error { *f.closed = true; return nil }

func encodeRequest(t *testing.T, r request) []string {
	t.Helper()
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return []string{"--request", base64.RawURLEncoding.EncodeToString(data)}
}

func TestStatusExecutorUsesPinnedGitAndSuppressesFsmonitor(t *testing.T) {
	var git string
	var digest [sha256.Size]byte
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, "git.exe")
		image, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		candidateDigest := sha256.Sum256(image)
		pin, err := safedelete.OpenPinnedExecutablePath(candidate, candidateDigest)
		if err != nil {
			continue
		}
		pin.Close()
		git, digest = candidate, candidateDigest
		break
	}
	if git == "" {
		t.Skip("no independently pinnable Git for Windows on PATH")
	}
	t.Logf("Git fixture executable: %s", git)
	root := t.TempDir()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(old)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command(git, args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Git fixture failed: %v: %s", err, out)
		}
	}
	gitRun("init", "-q")
	if err := os.WriteFile(filepath.Join(root, "ordinary.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun("add", "ordinary.txt")
	hook := filepath.Join(root, "fixture-monitor.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf invoked > fsmonitor-ran\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	gitRun("config", "core.fsmonitor", "./fixture-monitor.sh")
	gitRun("status", "--short")
	marker := filepath.Join(root, "fsmonitor-ran")
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("fixture did not execute fsmonitor")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	// Demonstrate that a workspace git.exe cannot replace the absolute image.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "git.exe"), shadow, 0700); err != nil {
		t.Fatal(err)
	}
	r := request{SchemaVersion: 1, Executable: git, SHA256: hex.EncodeToString(digest[:]), Cwd: root, Args: []string{"status", "--short"}}
	// Discover the installed Git's own exec directory, without assuming a
	// drive letter or a mingw/ucrt layout. Pin its real Git executable too.
	execPathCmd := exec.Command(git, "--exec-path")
	execPathCmd.Dir = root
	execPathOutput, err := execPathCmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	coreDir := filepath.FromSlash(strings.TrimSpace(string(execPathOutput)))
	core := filepath.Join(coreDir, "git.exe")
	coreBytes, err := os.ReadFile(core)
	if err != nil {
		t.Fatalf("installed Git core unavailable: %v", err)
	}
	coreDigest := sha256.Sum256(coreBytes)
	r.Dependencies = []dependency{{Path: core, SHA256: hex.EncodeToString(coreDigest[:])}}
	// Some distributions start the same hard-linked image through a second
	// bin path. A pin of the git-core alias alone does not bind that name.
	binGit := filepath.Join(filepath.Dir(filepath.Dir(coreDir)), "bin", "git.exe")
	if !strings.EqualFold(binGit, git) && !strings.EqualFold(binGit, core) {
		if image, err := os.ReadFile(binGit); err == nil {
			binDigest := sha256.Sum256(image)
			r.Dependencies = append(r.Dependencies, dependency{Path: binGit, SHA256: hex.EncodeToString(binDigest[:])})
		}
	}
	if dlls, err := filepath.Glob(filepath.Join(filepath.Dir(binGit), "*.dll")); err == nil && len(dlls) > 0 {
		dllBytes, err := os.ReadFile(dlls[0])
		if err != nil {
			t.Fatal(err)
		}
		dllDigest := sha256.Sum256(dllBytes)
		r.Dependencies = append(r.Dependencies, dependency{Path: dlls[0], SHA256: hex.EncodeToString(dllDigest[:])})
	}
	t.Logf("Pinned %d Git dependencies", len(r.Dependencies))
	var out, stderr bytes.Buffer
	code, err := run(encodeRequest(t, r), &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("status failed: code=%d err=%v stderr=%s", code, err, stderr.String())
	}
	if !strings.Contains(out.String(), "ordinary.txt") {
		t.Fatalf("unexpected status output: %s", out.String())
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("fsmonitor ran during controlled status")
	}
	t.Run("manifest lease wiring", func(t *testing.T) {
		runtimeRoot := filepath.Dir(git)
		entries, err := os.ReadDir(runtimeRoot)
		if err != nil {
			t.Fatal(err)
		}
		doc := runtimeManifest{SchemaVersion: 1}
		for _, entry := range entries {
			if entry.IsDir() {
				t.Skip("fixture expects a flat Git command directory")
			}
			data, err := os.ReadFile(filepath.Join(runtimeRoot, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			doc.Files = append(doc.Files, runtimeManifestEntry{Path: entry.Name(), Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])})
		}
		data, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		manifestPath := filepath.Join(root, "runtime-manifest.json")
		if err := os.WriteFile(manifestPath, data, 0600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		candidate := r
		candidate.Dependencies = nil // This test checks wiring, not dependency completeness.
		candidate.Runtime = &runtimeRequest{Root: runtimeRoot, ManifestPath: manifestPath, SHA256: hex.EncodeToString(sum[:])}
		oldOpen := openRuntimeLease
		defer func() { openRuntimeLease = oldOpen }()
		called, closed := false, false
		openRuntimeLease = func(root string, files []safedelete.RuntimeManifestFile) (io.Closer, error) {
			called = true
			if err := safedelete.VerifyRuntimeManifestContent(root, files); err != nil {
				return nil, err
			}
			return fixtureLease{closed: &closed}, nil
		}
		var result, details bytes.Buffer
		code, err := run(encodeRequest(t, candidate), &result, &details)
		if err != nil || code != 0 || !called || !closed || !strings.Contains(result.String(), "ordinary.txt") {
			t.Fatalf("manifest wiring failed: code=%d err=%v called=%v closed=%v stderr=%s", code, err, called, closed, details.String())
		}
		openRuntimeLease = func(string, []safedelete.RuntimeManifestFile) (io.Closer, error) {
			return nil, errors.New("untrusted fixture")
		}
		result.Reset()
		if _, err := run(encodeRequest(t, candidate), &result, &details); err == nil || result.Len() != 0 {
			t.Fatal("failed runtime lease allowed execution")
		}
	})
	out.Reset()
	r.Dependencies[0].SHA256 = strings.Repeat("0", 64)
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil || out.Len() != 0 {
		t.Fatal("unverified core executable was run")
	}
	if len(r.Dependencies) >= 3 {
		r.Dependencies[0].SHA256 = hex.EncodeToString(coreDigest[:])
		r.Dependencies[len(r.Dependencies)-1].SHA256 = strings.Repeat("0", 64)
		if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil || out.Len() != 0 {
			t.Fatal("unverified DLL was accepted")
		}
	}
	r.Dependencies = []dependency{{Path: git, SHA256: hex.EncodeToString(digest[:])}}
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("duplicate executable accepted")
	}
	r.Dependencies = nil
	r.SHA256 = strings.Repeat("0", 64)
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("wrong digest accepted")
	}
	r.SHA256 = hex.EncodeToString(digest[:])
	r.Cwd = filepath.Join(root, "other")
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("wrong cwd accepted")
	}
	r.Cwd = root
	r.Args = []string{"status", "--help"}
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("unsafe option accepted")
	}
	r.Args = []string{"status"}
	t.Setenv("GIT_CONFIG_COUNT", "1")
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("environment override accepted")
	}
}

func TestStatusOptionsAndEnvironmentFailClosed(t *testing.T) {
	for _, args := range [][]string{{"status"}, {"status", "-sb"}, {"status", "--porcelain=v1", "-uno"}} {
		if !validStatusArgs(args) {
			t.Fatalf("valid args rejected: %q", args)
		}
	}
	for _, args := range [][]string{{}, {"status", "--help"}, {"-c", "core.fsmonitor=evil", "status"}, {"status", "--", "."}, {"status", ";"}} {
		if validStatusArgs(args) {
			t.Fatalf("unsafe args accepted: %q", args)
		}
	}
	if _, err := safeEnvironment([]string{"PATH=x", "Git_Config_Parameters=evil"}); err == nil {
		t.Fatal("case-insensitive override accepted")
	}
	if _, err := safeEnvironment([]string{"PATH=x", "GIT_CONFIG_NOSYSTEM=1"}); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeManifestDigestAndMembership(t *testing.T) {
	root := t.TempDir()
	manifestDir := t.TempDir()
	gitPath := filepath.Join(root, "bin", "git.exe")
	dllPath := filepath.Join(root, "bin", "依赖.dll")
	gitHash := sha256.Sum256([]byte("git"))
	dllHash := sha256.Sum256([]byte("dll"))
	doc := runtimeManifest{SchemaVersion: 1, Files: []runtimeManifestEntry{
		{Path: "bin/git.exe", Size: 3, SHA256: hex.EncodeToString(gitHash[:])},
		{Path: "bin/依赖.dll", Size: 3, SHA256: hex.EncodeToString(dllHash[:])},
	}}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(manifestDir, "manifest.json")
	if err := os.WriteFile(manifestPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	runtime := &runtimeRequest{Root: root, ManifestPath: manifestPath, SHA256: hex.EncodeToString(digest[:])}
	deps := []dependency{{Path: dllPath, SHA256: hex.EncodeToString(dllHash[:])}}
	files, err := readRuntimeManifest(runtime, gitPath, gitHash, deps)
	if err != nil || len(files) != 2 {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	bad := *runtime
	bad.SHA256 = strings.Repeat("0", 64)
	if _, err := readRuntimeManifest(&bad, gitPath, gitHash, deps); err == nil {
		t.Fatal("wrong manifest digest accepted")
	}
	if _, err := readRuntimeManifest(runtime, filepath.Join(manifestDir, "git.exe"), gitHash, deps); err == nil {
		t.Fatal("executable outside runtime accepted")
	}
	wrongDeps := []dependency{{Path: dllPath, SHA256: strings.Repeat("0", 64)}}
	if _, err := readRuntimeManifest(runtime, gitPath, gitHash, wrongDeps); err == nil {
		t.Fatal("dependency digest mismatch accepted")
	}
	if _, err := readRuntimeManifest(runtime, gitPath, sha256.Sum256([]byte("other")), deps); err == nil {
		t.Fatal("executable digest mismatch accepted")
	}
}
