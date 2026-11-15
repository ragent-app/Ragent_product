//go:build windows

// This non-elevated helper is intended to run only after the sidecar validates
// a run-bound request. It never accepts shell source or an arbitrary executable.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	safedelete "ragent/windows-safe-delete"
)

type request struct {
	SchemaVersion   int      `json:"schemaVersion"`
	Workspace       string   `json:"workspace"`
	Relative        string   `json:"relative"`
	Relatives       []string `json:"relatives,omitempty"`
	FilesOnly       []bool   `json:"filesOnly,omitempty"`
	Target          string   `json:"target,omitempty"`
	TargetFromCwd   bool     `json:"targetFromCwd,omitempty"`
	ExpectedCwd     string   `json:"expectedCwd,omitempty"`
	ContentsOnly    bool     `json:"contentsOnly"`
	Force           bool     `json:"force"`
	RequestKey      string   `json:"requestKey"`
	OriginalCommand string   `json:"originalCommand,omitempty"`
}

var requestKey = regexp.MustCompile(`^gate:[a-f0-9]{64}$`)

func run(args []string) (int, error) {
	if len(args) != 2 || args[0] != "--request" || len(args[1]) > 32768 {
		return 0, errors.New("invalid request envelope")
	}
	bytesIn, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(bytesIn) != args[1] {
		return 0, errors.New("invalid request encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(bytesIn))
	decoder.DisallowUnknownFields()
	var input request
	if err = decoder.Decode(&input); err != nil {
		return 0, errors.New("invalid request data")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return 0, errors.New("invalid trailing request data")
	}
	if input.SchemaVersion != 1 || len(input.Workspace) > 32767 || len(input.Relative) > 32767 || len(input.ExpectedCwd) > 32767 || len(input.OriginalCommand) > 8192 || !requestKey.MatchString(input.RequestKey) {
		return 0, errors.New("invalid request fields")
	}
	if len(input.Relatives) > 0 {
		if len(input.Relatives) > 32 || input.Relative != "" || input.Target != "" || input.TargetFromCwd || input.ContentsOnly {
			return 0, errors.New("invalid multiple-target request")
		}
		if input.ExpectedCwd != "" {
			cwd, cwdErr := os.Getwd()
			if cwdErr != nil || !filepath.IsAbs(input.ExpectedCwd) || !strings.EqualFold(filepath.Clean(cwd), filepath.Clean(input.ExpectedCwd)) {
				return 0, errors.New("working directory differs from approved context")
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		forest, captureErr := safedelete.CaptureForestWithFileChecks(ctx, input.Workspace, input.Relatives, input.FilesOnly)
		if captureErr != nil {
			return 0, fmt.Errorf("target validation failed: %w", captureErr)
		}
		return forest.CommitWithOptions(ctx, input.Force)
	}
	if len(input.FilesOnly) > 0 {
		return 0, errors.New("file checks require multiple targets")
	}
	if input.TargetFromCwd {
		if input.Relative != "" || input.Target == "" || len(input.Target) > 8192 || !filepath.IsAbs(input.ExpectedCwd) {
			return 0, errors.New("invalid working-directory target")
		}
		cwd, cwdErr := os.Getwd()
		if cwdErr != nil {
			return 0, errors.New("working directory unavailable")
		}
		if !strings.EqualFold(filepath.Clean(cwd), filepath.Clean(input.ExpectedCwd)) {
			return 0, errors.New("working directory differs from approved context")
		}
		target := input.Target
		if !filepath.IsAbs(target) {
			target = filepath.Join(cwd, target)
		}
		input.Relative, err = filepath.Rel(input.Workspace, target)
		if err != nil {
			return 0, errors.New("target is outside workspace")
		}
	} else if input.Target != "" || input.ExpectedCwd != "" || input.Relative == "" {
		return 0, errors.New("invalid relative target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	tree, err := safedelete.CaptureTree(ctx, input.Workspace, input.Relative, input.ContentsOnly)
	if err != nil {
		return 0, fmt.Errorf("target validation failed: %w", err)
	}
	return tree.CommitWithOptions(ctx, input.Force)
}

func main() {
	count, err := run(os.Args[1:])
	result := struct {
		OK      bool   `json:"ok"`
		Deleted int    `json:"deleted"`
		Error   string `json:"error,omitempty"`
	}{OK: err == nil, Deleted: count}
	if err != nil {
		result.Error = err.Error()
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
	if err != nil {
		os.Exit(1)
	}
}
