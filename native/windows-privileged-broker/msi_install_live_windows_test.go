//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This opt-in test exercises the production installer with a disposable,
// unsigned per-user MSI whose payload is confined to the test directory.
func TestMSIInstallRealLocalFixture(t *testing.T) {
	path := os.Getenv("RAGENT_QA_DISPOSABLE_MSI")
	marker := os.Getenv("RAGENT_QA_DISPOSABLE_MARKER")
	if path == "" || marker == "" {
		t.Skip("disposable local fixture not configured")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("fixture marker already exists")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd := exec.Command(filepath.Join(system, "msiexec.exe"), "/x", path, "/qn", "/norestart")
		cmd.Env = os.Environ()
		if output, e := cmd.CombinedOutput(); e != nil {
			t.Errorf("fixture uninstall: %v %s", e, output)
		}
		if _, e := os.Stat(marker); !os.IsNotExist(e) {
			t.Errorf("fixture marker remains after uninstall: %v", e)
		}
	}()
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err = store.ConfigureAutoInstallSigner("key-1", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	grant := msiInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: state.InstallationID, PolicyGeneration: state.PolicyGeneration, RequestID: "qa-request", SessionID: "qa-session", RunID: "qa-run", TurnID: "qa-turn", ActionID: "qa-action", Nonce: "0123456789abcdefghijklmn", ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(digest[:]), PublisherSHA256: unsignedMSIPublisher, IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	bytes, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "msi_install.execute", MSIInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, bytes))}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	suffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	healthName := `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.` + suffix + `.Health.v1`
	requestName := `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.` + suffix + `.Request.v1`
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, healthName, requestName)
	if err != nil {
		t.Fatal(err)
	}
	server.msiInstaller = windowsMSIInstaller{paths: func() (string, string, string, error) { return root, system, os.TempDir(), nil }}
	runResult := make(chan error, 1)
	go func() { runResult <- server.Run(context.Background()) }()
	defer func() {
		server.Stop()
		select {
		case e := <-runResult:
			if e != nil {
				t.Error(e)
			}
		case <-time.After(3 * time.Second):
			t.Error("broker did not stop")
		}
	}()
	inspection := exchangeTestPipeRequest(t, requestName, brokerRequest{Version: protocolVersion, Type: "msi_install.inspect", MSIInspect: &msiInspectRequest{ArtifactPath: path, ArtifactSHA256: grant.ArtifactSHA256}})
	if inspection.MSIFacts == nil || inspection.MSIFacts.PublisherSHA256 != unsignedMSIPublisher {
		t.Fatalf("inspection: %+v", inspection)
	}
	first := exchangeTestPipeRequest(t, requestName, request)
	if first.Status != statusExecuting {
		t.Fatalf("claim: %+v", first)
	}
	var result brokerResponse
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		result = exchangeTestPipeRequest(t, requestName, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID})
		if result.Status != statusExecuting {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.Status != statusSucceeded {
		t.Fatalf("installer result: %+v", result)
	}
	markerData, err := os.ReadFile(marker)
	if err != nil || string(markerData) != "Ragent disposable installer QA\r\n" {
		t.Fatalf("installed marker: %q %v", markerData, err)
	}
	if replay := exchangeTestPipeRequest(t, requestName, request); replay.Status != statusSucceeded {
		t.Fatalf("replay: %+v", replay)
	}
}
func TestMSIInstallGrantJSONMatchesControlPlane(t *testing.T) {
	grant := msiInstallGrant{Version: 1, KeyID: "key", BrokerInstallationID: "broker", PolicyGeneration: 1, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwx", ArtifactPath: `G:\A & B\测试.msi`, ArtifactSHA256: strings.Repeat("a", 64), PublisherSHA256: strings.Repeat("b", 64), IssuedMS: 1000, ExpiresMS: 2000}
	payload, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != "dfeee1d3ff0b93af8de9c44a4b7d861e8ad8212359f0bcf574b279b2d5ca7bcb" {
		t.Fatalf("cross-language grant mismatch: %x", digest)
	}
}
