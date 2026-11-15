//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestOwnerInstallIPCClaimsOnceAndReportsStatus(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	policy := ownerInstallPolicy{Version: 1, InstanceID: "inst_0123456789abcdef0123456789abcdef", OwnerSID: "S-1-5-21-1-2-3-1001", Port: 7690}
	if err := store.ConfigureAutoInstallSigner(policy.InstanceID, base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	grant := ownerInstallGrant{Version: 1, KeyID: policy.InstanceID, BrokerInstallationID: store.state.InstallationID, PolicyGeneration: store.state.PolicyGeneration,
		InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action",
		Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App", PackageVersion: "1.2.3", Source: "winget", InstallScope: "user", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "owner_install.execute", OwnerInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := &brokerIPCServer{store: store, ownerPolicy: func() (ownerInstallPolicy, error) { return policy, nil }, ownerAvailable: func(string) bool { return true },
		ownerInstaller: func(_ context.Context, sid, id, version, scope string) ownerInstallResult {
			calls.Add(1)
			if sid != policy.OwnerSID || id != grant.PackageID || version != grant.PackageVersion || scope != grant.InstallScope {
				t.Error("wrong execution binding")
			}
			return ownerInstallResult{Status: "succeeded", Code: "OWNER_INSTALL_SUCCEEDED"}
		}}
	identityRequest, _ := json.Marshal(brokerRequest{Version: protocolVersion, Type: "owner_install.identity"})
	identity := server.handleRequest(identityRequest, false)
	if identity.Type != "owner_install_identity" || identity.OwnerIdentity == nil || identity.OwnerIdentity.InstanceID != policy.InstanceID || identity.OwnerIdentity.OwnerSID != policy.OwnerSID {
		t.Fatalf("invalid policy identity: %+v", identity)
	}
	first := server.handleRequest(payload, false)
	second := server.handleRequest(payload, false)
	if first.Status != statusExecuting || second.Type == "error" {
		t.Fatalf("claim response: %+v %+v", first, second)
	}
	server.workers.Wait()
	statusPayload, _ := json.Marshal(brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID})
	status := server.handleRequest(statusPayload, false)
	if calls.Load() != 1 || status.Status != statusSucceeded || status.OwnerInstall == nil || status.OwnerInstall.Nonce != grant.Nonce {
		t.Fatalf("unexpected outcome: %d %+v", calls.Load(), status)
	}
	bad := request
	modified := grant
	modified.PackageID = "Other.App"
	bad.OwnerInstall = &modified
	badPayload, _ := json.Marshal(bad)
	if response := server.handleRequest(badPayload, false); response.Code != "OWNER_INSTALL_AUTHORIZATION_DENIED" {
		t.Fatalf("modified signature accepted: %+v", response)
	}
}

func TestOwnerInstallRealNamedPipe(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	policy := ownerInstallPolicy{InstanceID: "inst_0123456789abcdef0123456789abcdef", OwnerSID: "S-1-5-21-1-2-3-1001"}
	if err := store.ConfigureAutoInstallSigner(policy.InstanceID, base64.RawURLEncoding.EncodeToString(der), now); err != nil {
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
	release := make(chan struct{})
	var calls atomic.Int32
	server.ownerPolicy = func() (ownerInstallPolicy, error) { return policy, nil }
	server.ownerAvailable = func(string) bool { return true }
	server.ownerInstaller = func(ctx context.Context, sid, id, version, scope string) ownerInstallResult {
		calls.Add(1)
		if sid != policy.OwnerSID || id != "Vendor.App" || version != "1.2.3" || scope != "user" {
			return ownerInstallResult{Status: "failed", Code: "OWNER_INSTALL_INVALID"}
		}
		select {
		case <-release:
			return ownerInstallResult{Status: "succeeded", Code: "OWNER_INSTALL_SUCCEEDED"}
		case <-ctx.Done():
			return ownerInstallResult{Status: "unknown", Code: "OWNER_INSTALL_OUTCOME_UNKNOWN"}
		}
	}
	runResult := make(chan error, 1)
	go func() { runResult <- server.Run(context.Background()) }()
	t.Cleanup(func() {
		server.Stop()
		select {
		case err := <-runResult:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server did not stop")
		}
	})
	identity := exchangeTestPipeRequest(t, requestName, brokerRequest{Version: protocolVersion, Type: "owner_install.identity"})
	if identity.OwnerIdentity == nil || identity.OwnerIdentity.OwnerSID != policy.OwnerSID {
		t.Fatalf("identity mismatch: %+v", identity)
	}
	snapshot := store.Snapshot()
	grant := ownerInstallGrant{Version: 1, KeyID: policy.InstanceID, BrokerInstallationID: snapshot.InstallationID, PolicyGeneration: snapshot.PolicyGeneration,
		InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID, RequestID: "pipe-owner", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action",
		Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App", PackageVersion: "1.2.3", Source: "winget", InstallScope: "user", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "owner_install.execute", OwnerInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))}
	for i := 0; i < 2; i++ {
		if result := exchangeTestPipeRequest(t, requestName, request); result.Status != statusExecuting {
			t.Fatalf("submission %d: %+v", i, result)
		}
	}
	close(release)
	deadline := time.Now().Add(3 * time.Second)
	var status brokerResponse
	for time.Now().Before(deadline) {
		status = exchangeTestPipeRequest(t, requestName, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID})
		if status.Status != statusExecuting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 || status.Status != statusSucceeded || status.OwnerInstall == nil || status.OwnerInstall.Nonce != grant.Nonce {
		t.Fatalf("unexpected pipe result: calls=%d status=%+v", calls.Load(), status)
	}
}
