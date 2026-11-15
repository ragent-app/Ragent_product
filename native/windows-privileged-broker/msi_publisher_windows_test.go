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

func TestMSIPublisherRejectsUnsignedAndReleasedPins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unsigned.msi")
	data := []byte("unsigned fixture")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	pins, err := pinWindowsMSIArtifact(path, hex.EncodeToString(hash[:]))
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if verifyPinnedMSIPublisher(pins, strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted unsigned MSI")
	}
	pins.Close()
	if verifyPinnedMSIPublisher(pins, strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted released pins")
	}
}

func TestMSIPublisherSignedFixture(t *testing.T) {
	source := os.Getenv("RAGENT_TEST_SIGNED_MSI")
	publisher := os.Getenv("RAGENT_TEST_SIGNED_MSI_PUBLISHER_SHA256")
	if source == "" || publisher == "" {
		t.Skip("signed MSI fixture not configured")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "signed.msi")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	pins, err := pinWindowsMSIArtifact(path, hex.EncodeToString(hash[:]))
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if err := verifyPinnedMSIPublisher(pins, publisher); err != nil {
		t.Fatal(err)
	}
	if err := verifyPinnedMSIEmbeddedMedia(pins); err != nil {
		t.Fatal(err)
	}
	if verifyPinnedMSIPublisher(pins, strings.Repeat("0", 64)) == nil {
		t.Fatal("accepted a different publisher")
	}
	pins.Close()
	if len(data) < 4096 {
		t.Fatal("signed fixture is unexpectedly small")
	}
	// Corrupt the signed compound-file header, not arbitrary slack space.
	data[0] ^= 0xff
	tampered := filepath.Join(t.TempDir(), "tampered.msi")
	if err := os.WriteFile(tampered, data, 0600); err != nil {
		t.Fatal(err)
	}
	tamperedHash := sha256.Sum256(data)
	tamperedPins, err := pinWindowsMSIArtifact(tampered, hex.EncodeToString(tamperedHash[:]))
	if err != nil {
		t.Fatal(err)
	}
	defer tamperedPins.Close()
	if verifyPinnedMSIPublisher(tamperedPins, publisher) == nil {
		t.Fatal("accepted a tampered signed MSI")
	}
}
