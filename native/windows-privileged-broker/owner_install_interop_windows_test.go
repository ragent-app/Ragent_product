//go:build windows

package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOwnerGrantNodeGoInterop(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "tests", "test-windows-owner-broker-grant.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "RAGENT_QA_OWNER_GRANT_INTEROP=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Node grant fixture failed: %v: %s", err, output)
	}
	var data string
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "OWNER_GRANT_FIXTURE=") {
			data = strings.TrimPrefix(line, "OWNER_GRANT_FIXTURE=")
		}
	}
	var fixture struct {
		Grant     ownerInstallGrant `json:"grant"`
		Signature string            `json:"signature"`
		PublicKey string            `json:"publicKey"`
	}
	if data == "" || json.Unmarshal([]byte(data), &fixture) != nil {
		t.Fatal("missing Node grant fixture")
	}
	der, err := base64.RawURLEncoding.DecodeString(fixture.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatal(err)
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		t.Fatal("fixture key is not Ed25519")
	}
	policy := ownerInstallPolicy{InstanceID: fixture.Grant.InstanceID, OwnerSID: fixture.Grant.OwnerSID}
	if err := verifyOwnerInstallGrant(fixture.Grant, fixture.Signature, public, fixture.Grant.KeyID,
		fixture.Grant.BrokerInstallationID, fixture.Grant.PolicyGeneration, policy, time.Now()); err != nil {
		t.Fatalf("Go rejected Node signature: %v", err)
	}
}
