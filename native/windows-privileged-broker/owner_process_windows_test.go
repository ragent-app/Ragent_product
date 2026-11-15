//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestOwnerProcessChild(t *testing.T) {
	if os.Getenv("RAGENT_QA_OWNER_CHILD") != "1" {
		return
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != os.Getenv("RAGENT_QA_OWNER_SID") {
		os.Exit(7)
	}
	if os.Getenv("RAGENT_QA_EXCLUDED") != "" {
		os.Exit(8)
	}
	if os.Getenv("RAGENT_QA_FAIL") == "1" {
		os.Exit(23)
	}
	os.Exit(0)
}

func TestOwnerInspectionChild(t *testing.T) {
	mode := os.Getenv("RAGENT_QA_OWNER_INSPECTION")
	if mode == "" {
		return
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != os.Getenv("RAGENT_QA_OWNER_SID") {
		os.Exit(7)
	}
	if mode == "overflow" {
		_, _ = os.Stdout.WriteString(strings.Repeat("x", 65*1024))
		os.Exit(0)
	}
	_, _ = os.Stdout.WriteString(`{"scope":"User"}`)
	os.Exit(0)
}

func TestOwnerInspectionCurrentToken(t *testing.T) {
	var original, primary windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	if err := windows.DuplicateTokenEx(original, windows.TOKEN_ALL_ACCESS, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	user, err := primary.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	env := []string{"SystemRoot=" + root, "WINDIR=" + root, "RAGENT_QA_OWNER_SID=" + user.User.Sid.String()}
	args := []string{"-test.run=^TestOwnerInspectionChild$"}
	output, err := runOwnerInspection(ctx, primary, executable, args, append(env, "RAGENT_QA_OWNER_INSPECTION=normal"), filepath.Dir(executable))
	if err != nil || string(output) != `{"scope":"User"}` {
		t.Fatalf("unexpected owner inspection: %q %v", output, err)
	}
	if _, err := runOwnerInspection(ctx, primary, executable, args, append(env, "RAGENT_QA_OWNER_INSPECTION=overflow"), filepath.Dir(executable)); err == nil {
		t.Fatal("oversized owner output accepted")
	}
}

func TestOwnerProcessCurrentToken(t *testing.T) {
	t.Setenv("RAGENT_QA_EXCLUDED", "must not be inherited")
	var original, primary windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &original); err != nil {
		t.Fatal(err)
	}
	defer original.Close()
	if err := windows.DuplicateTokenEx(original, windows.TOKEN_ALL_ACCESS, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	user, err := primary.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	env := []string{"SystemRoot=" + root, "WINDIR=" + root, "RAGENT_QA_OWNER_CHILD=1", "RAGENT_QA_OWNER_SID=" + user.User.Sid.String()}
	code, err := runOwnerProcess(ctx, primary, executable, []string{"-test.run=^TestOwnerProcessChild$"}, env, filepath.Dir(executable))
	if err != nil || code != 0 {
		t.Fatalf("owner child failed: exit %d: %v", code, err)
	}
	code, err = runOwnerProcess(ctx, primary, executable, []string{"-test.run=^TestOwnerProcessChild$"}, append(env, "RAGENT_QA_FAIL=1"), filepath.Dir(executable))
	if err == nil || code != 23 {
		t.Fatalf("child failure lost: exit %d: %v", code, err)
	}
	if _, err := runOwnerProcess(ctx, primary, "relative.exe", nil, env, root); err == nil {
		t.Fatal("relative executable accepted")
	}
	if _, err := runOwnerProcess(ctx, primary, executable, nil, nil, root); err == nil {
		t.Fatal("inherited environment accepted")
	}
}
