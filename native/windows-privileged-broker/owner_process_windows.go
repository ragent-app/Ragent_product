//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

type ownerInspectionOutput struct{ buffer bytes.Buffer }

func (output *ownerInspectionOutput) Write(p []byte) (int, error) {
	if len(p) > 64*1024-output.buffer.Len() {
		return 0, errors.New("owner inspection output too large")
	}
	return output.buffer.Write(p)
}

func runOwnerCommand(ctx context.Context, token windows.Token, executable string, args, env []string, cwd string, stdout io.Writer) error {
	if ctx == nil || token == 0 || !filepath.IsAbs(executable) || !filepath.IsAbs(cwd) || env == nil {
		return errOwnerSessionUnavailable
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(token), HideWindow: true}
	cmd.Stdout, cmd.Stderr = stdout, io.Discard
	// SCM initializes SeAssignPrimaryTokenPrivilege and SeIncreaseQuotaPrivilege
	// as disabled (0x0) on LocalSystem services; enable them only during Start.
	var err error
	if isLocalSystemProcess() {
		err = withSystemThreadPrivileges([]string{"SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege"}, cmd.Start)
	} else {
		err = cmd.Start()
	}
	if err != nil {
		return err
	}
	return cmd.Wait()
}

// Runs only the fixed metadata inspection program under the verified owner.
func runOwnerInspection(ctx context.Context, token windows.Token, executable string, args, env []string, cwd string) ([]byte, error) {
	var output ownerInspectionOutput
	if err := runOwnerCommand(ctx, token, executable, args, env, cwd, &output); err != nil {
		return nil, err
	}
	return output.buffer.Bytes(), nil
}

// runOwnerProcess is a private execution primitive. Its caller must validate
// authorization, pin the executable and construct the environment first; it
// never resolves an executable using PATH or inherits the service environment.
// Cancellation after a process was started leaves the operation outcome unknown.
func runOwnerProcess(ctx context.Context, token windows.Token, executable string, args, env []string, cwd string) (int, error) {
	err := runOwnerCommand(ctx, token, executable, args, env, cwd, io.Discard)
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), err
	}
	if errors.Is(err, errOwnerSessionUnavailable) {
		return -1, err
	}
	return -1, err
}
