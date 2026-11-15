//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareWindowsMSIInstallRejectsUnsigned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.msi")
	data := []byte("unsigned fixture")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	grant := msiInstallGrant{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(hash[:]), PublisherSHA256: strings.Repeat("a", 64)}
	if prepared, err := prepareWindowsMSIInstall(grant); err == nil {
		prepared.Close()
		t.Fatal("accepted unsigned MSI")
	}
	if err := os.WriteFile(path, []byte("after refusal"), 0600); err != nil {
		t.Fatalf("pins not released after refusal: %v", err)
	}
}

func TestPrepareWindowsMSIInstallSignedFixture(t *testing.T) {
	source, publisher := os.Getenv("RAGENT_TEST_SIGNED_MSI"), os.Getenv("RAGENT_TEST_SIGNED_MSI_PUBLISHER_SHA256")
	if source == "" || publisher == "" {
		t.Skip("signed MSI fixture not configured")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "fixture.msi")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	grant := msiInstallGrant{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(hash[:]), PublisherSHA256: publisher}
	prepared, err := prepareWindowsMSIInstall(grant)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Close()
	if !filepath.IsAbs(prepared.executable) || !strings.EqualFold(filepath.Base(prepared.executable), "msiexec.exe") ||
		len(prepared.arguments) != 4 || prepared.arguments[0] != "/i" || prepared.arguments[1] != path || prepared.arguments[2] != "/qn" || prepared.arguments[3] != "/norestart" {
		t.Fatalf("unexpected installer invocation: %q %q", prepared.executable, prepared.arguments)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0600); err == nil {
		t.Fatal("prepared MSI was writable")
	}
	prepared.Close()
	if err := os.WriteFile(path, []byte("after release"), 0600); err != nil {
		t.Fatalf("pins not released: %v", err)
	}
}
