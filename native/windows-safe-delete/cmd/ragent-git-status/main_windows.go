//go:build windows

// This non-elevated executor is not an approval authority. The caller must
// independently authorize the Git image, its dependencies and the workspace.
// Disabling fsmonitor does not disable repository-configured clean filters;
// those can execute while status checks modified files. This executor alone
// must not be used as evidence that a status request is safe to auto-allow.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	safedelete "ragent/windows-safe-delete"
)

type request struct {
	SchemaVersion int             `json:"schemaVersion"`
	Executable    string          `json:"executable"`
	SHA256        string          `json:"sha256"`
	Cwd           string          `json:"cwd"`
	Args          []string        `json:"args"`
	Dependencies  []dependency    `json:"dependencies,omitempty"`
	Runtime       *runtimeRequest `json:"runtime,omitempty"`
}

type dependency struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type runtimeRequest struct {
	Root         string `json:"root"`
	ManifestPath string `json:"manifestPath"`
	SHA256       string `json:"sha256"`
}

type runtimeManifestEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type runtimeManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Files         []runtimeManifestEntry `json:"files"`
}

// The production function cannot be configured by a request. Tests can
// substitute it only inside this package; its return value is held until exit.
var openRuntimeLease = func(root string, files []safedelete.RuntimeManifestFile) (io.Closer, error) {
	return safedelete.OpenRuntimeManifestLease(root, files)
}

func readRuntimeManifest(input *runtimeRequest, executable string, executableHash [sha256.Size]byte, dependencies []dependency) ([]safedelete.RuntimeManifestFile, error) {
	if input == nil || !filepath.IsAbs(input.Root) || len(filepath.VolumeName(input.Root)) != 2 ||
		filepath.Clean(input.Root) == filepath.VolumeName(input.Root)+string(filepath.Separator) ||
		!filepath.IsAbs(input.ManifestPath) || len(filepath.VolumeName(input.ManifestPath)) != 2 {
		return nil, errors.New("invalid runtime manifest location")
	}
	expected, err := decodeDigest(input.SHA256)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(input.ManifestPath)
	if err != nil {
		return nil, errors.New("runtime manifest unavailable")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, 4*1024*1024+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(data) == 0 || len(data) > 4*1024*1024 {
		return nil, errors.New("invalid runtime manifest")
	}
	actual := sha256.Sum256(data)
	if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
		return nil, errors.New("runtime manifest digest mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var doc runtimeManifest
	if decoder.Decode(&doc) != nil || decoder.Decode(new(any)) != io.EOF || doc.SchemaVersion != 1 || len(doc.Files) == 0 || len(doc.Files) > 10000 {
		return nil, errors.New("invalid runtime manifest")
	}
	files := make([]safedelete.RuntimeManifestFile, 0, len(doc.Files))
	byPath := make(map[string][sha256.Size]byte, len(doc.Files))
	for _, entry := range doc.Files {
		digest, err := decodeDigest(entry.SHA256)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(filepath.ToSlash(entry.Path))
		if _, exists := byPath[key]; exists {
			return nil, errors.New("duplicate runtime manifest path")
		}
		byPath[key] = digest
		files = append(files, safedelete.RuntimeManifestFile{Path: entry.Path, Size: entry.Size, SHA256: digest})
	}
	contains := func(name string, digest [sha256.Size]byte) bool {
		rel, err := filepath.Rel(filepath.Clean(input.Root), filepath.Clean(name))
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return false
		}
		actual, ok := byPath[strings.ToLower(filepath.ToSlash(rel))]
		return ok && subtle.ConstantTimeCompare(actual[:], digest[:]) == 1
	}
	if !contains(executable, executableHash) {
		return nil, errors.New("Git image missing from runtime manifest")
	}
	for _, dep := range dependencies {
		digest, err := decodeDigest(dep.SHA256)
		if err != nil || !contains(dep.Path, digest) {
			return nil, errors.New("Git dependency missing from runtime manifest")
		}
	}
	return files, nil
}

func decodeDigest(value string) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || value != strings.ToLower(value) {
		return digest, errors.New("invalid executable digest")
	}
	copy(digest[:], decoded)
	return digest, nil
}

var statusOptions = map[string]bool{
	"--short": true, "--branch": true, "--long": true, "--porcelain": true,
	"--porcelain=v1": true, "--porcelain=v2": true, "--show-stash": true,
	"--no-renames": true, "--renames": true, "--ahead-behind": true, "--no-ahead-behind": true,
	"--untracked-files": true, "--untracked-files=no": true, "--untracked-files=normal": true, "--untracked-files=all": true,
	"--ignored": true, "--ignored=no": true, "--ignored=traditional": true, "--ignored=matching": true,
	"-u": true, "-uno": true, "-unormal": true, "-uall": true,
}

func validStatusArgs(args []string) bool {
	if len(args) < 1 || len(args) > 64 || args[0] != "status" {
		return false
	}
	for _, arg := range args[1:] {
		if statusOptions[arg] {
			continue
		}
		if len(arg) < 2 || arg[0] != '-' {
			return false
		}
		for _, c := range arg[1:] {
			if c != 's' && c != 'b' && c != 'z' {
				return false
			}
		}
	}
	return true
}

func safeEnvironment(env []string) ([]string, error) {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, errors.New("invalid process environment")
		}
		upper := strings.ToUpper(name)
		if strings.HasPrefix(upper, "GIT_") {
			// These two settings do not select code or additional file paths;
			// the executor supplies its own lock setting below.
			if upper == "GIT_CONFIG_NOSYSTEM" {
				out = append(out, entry)
				continue
			}
			if upper == "GIT_OPTIONAL_LOCKS" || upper == "GIT_PAGER" {
				continue
			}
			return nil, errors.New("Git environment overrides require review")
		}
		out = append(out, entry)
	}
	return append(out, "GIT_OPTIONAL_LOCKS=0"), nil
}

func run(args []string, stdout, stderr io.Writer) (int, error) {
	// Keep the encoded argument below Windows' process command-line limit.
	if len(args) != 2 || args[0] != "--request" || len(args[1]) > 30000 {
		return 0, errors.New("invalid request")
	}
	data, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil {
		return 0, errors.New("invalid request encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.SchemaVersion != 1 ||
		!strings.EqualFold(filepath.Base(input.Executable), "git.exe") || !validStatusArgs(input.Args) || len(input.Dependencies) > 256 {
		return 0, errors.New("invalid Git status request")
	}
	if !filepath.IsAbs(input.Cwd) || len(filepath.VolumeName(input.Cwd)) != 2 {
		return 0, errors.New("invalid working directory")
	}
	actual, err := os.Getwd()
	if err != nil || !strings.EqualFold(filepath.Clean(actual), filepath.Clean(input.Cwd)) {
		return 0, errors.New("working directory mismatch")
	}
	digest, err := decodeDigest(input.SHA256)
	if err != nil {
		return 0, err
	}
	env, err := safeEnvironment(os.Environ())
	if err != nil {
		return 0, err
	}
	if input.Runtime != nil {
		files, err := readRuntimeManifest(input.Runtime, input.Executable, digest, input.Dependencies)
		if err != nil {
			return 0, err
		}
		lease, err := openRuntimeLease(input.Runtime.Root, files)
		if err != nil || lease == nil {
			return 0, errors.New("Git runtime lease unavailable")
		}
		defer lease.Close()
	}
	pin, err := safedelete.OpenPinnedExecutablePath(input.Executable, digest)
	if err != nil {
		return 0, errors.New("Git executable identity unavailable")
	}
	defer pin.Close()
	// Callers must establish a complete dependency set and trust its digests.
	// Pinning only this supplied set is deliberately not authorization.
	seen := map[string]bool{strings.ToLower(filepath.Clean(input.Executable)): true}
	var dependencies []*safedelete.PinnedExecutablePath
	defer func() {
		for i := len(dependencies) - 1; i >= 0; i-- {
			_ = dependencies[i].Close()
		}
	}()
	for _, dep := range input.Dependencies {
		key := strings.ToLower(filepath.Clean(dep.Path))
		if seen[key] {
			return 0, errors.New("duplicate executable dependency")
		}
		seen[key] = true
		depDigest, err := decodeDigest(dep.SHA256)
		if err != nil {
			return 0, err
		}
		depPin, err := safedelete.OpenPinnedDependencyPath(dep.Path, depDigest)
		if err != nil {
			return 0, errors.New("Git dependency identity unavailable")
		}
		dependencies = append(dependencies, depPin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	commandArgs := append([]string{"--no-pager", "-c", "core.fsmonitor=false", "--no-optional-locks"}, input.Args...)
	cmd := exec.CommandContext(ctx, pin.Path(), commandArgs...)
	cmd.Dir = input.Cwd
	cmd.Env = env
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode(), nil
		}
		return 0, errors.New("Git status execution failed")
	}
	return 0, nil
}

func main() {
	code, err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}
