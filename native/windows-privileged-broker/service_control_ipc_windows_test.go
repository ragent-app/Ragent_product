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
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestServiceControlPipeRequiresSignatureAndRunsOnce(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
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
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.ConfigureAutoInstallSigner("key", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	deviceKey, deviceID := enrollServiceTestDevice(t, store, now)
	suffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	base := `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.` + suffix
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, base+".Health", base+".Request")
	if err != nil {
		t.Fatal(err)
	}
	if server.serviceController == nil {
		t.Fatal("production Windows service controller was not configured")
	}
	server.serviceController = nil
	snap := store.Snapshot()
	grant := serviceControlGrant{Version: 1, KeyID: "key", BrokerInstallationID: snap.InstallationID, PolicyGeneration: snap.PolicyGeneration,
		RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwx",
		ServiceName: "测试服务", Action: "restart-service", DefinitionHash: strings.Repeat("a", 64), Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
	request := brokerRequest{Version: protocolVersion, Type: "service.execute", ServiceControl: &grant,
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, serviceControlSigningBytes(grant))),
		DeviceID:  deviceID, DeviceSignature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(grant))}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if response := server.handleRequest(raw, false); response.Code != "SERVICE_CONTROL_UNAVAILABLE" {
		t.Fatalf("production controller was enabled: %+v", response)
	}
	healthRequest, err := json.Marshal(brokerRequest{Version: protocolVersion, Type: "health"})
	if err != nil {
		t.Fatal(err)
	}
	if health := server.handleRequest(healthRequest, true); health.ServiceControlReady {
		t.Fatal("disabled service controller advertised as ready")
	}
	release := make(chan struct{})
	var calls atomic.Int32
	server.serviceController = func(ctx context.Context, action serviceControlRequest) serviceControlOutcome {
		calls.Add(1)
		if action.Name != grant.ServiceName || action.Action != grant.Action || action.DefinitionHash != grant.DefinitionHash {
			t.Error("wrong action")
		}
		select {
		case <-release:
			return serviceControlOutcome{Status: statusSucceeded, Code: "SERVICE_CONTROL_SUCCEEDED"}
		case <-ctx.Done():
			return serviceControlOutcome{Status: statusUnknown, Code: "SERVICE_CONTROL_CANCELLED"}
		}
	}
	server.serviceInspector = func(name string) (string, error) {
		if name != grant.ServiceName {
			t.Error("wrong inspection target")
		}
		return grant.DefinitionHash, nil
	}
	if health := server.handleRequest(healthRequest, true); !health.ServiceControlReady || health.AutoInstallKeyID != "key" {
		t.Fatalf("service readiness or signer missing: %+v", health)
	}
	done := make(chan error, 1)
	go func() { done <- server.Run(context.Background()) }()
	t.Cleanup(func() {
		server.Stop()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server did not stop")
		}
	})
	proposal := request
	proposal.Type = "service.propose"
	proposal.DeviceID = ""
	proposal.DeviceSignature = ""
	for i := 0; i < 2; i++ {
		if got := exchangeTestPipeRequest(t, base+".Request", proposal); got.Status != statusAwaitingDevice {
			t.Fatalf("proposal: %+v", got)
		}
	}
	deniedGrant := grant
	deniedGrant.RequestID, deniedGrant.Nonce = "request-denied", "zyxwvutsrqponmlkjihgfedc"
	deniedProposal := proposal
	deniedProposal.ServiceControl = &deniedGrant
	deniedProposal.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, serviceControlSigningBytes(deniedGrant)))
	if got := exchangeTestPipeRequest(t, base+".Request", deniedProposal); got.Status != statusAwaitingDevice {
		t.Fatalf("denial proposal: %+v", got)
	}
	denial := brokerRequest{Version: protocolVersion, Type: "service.deny", RequestID: deniedGrant.RequestID, DeviceID: deviceID, DeviceSignature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(deniedGrant))}
	if got := exchangeTestPipeRequest(t, base+".Request", denial); got.Code != "SERVICE_CONTROL_AUTHORIZATION_DENIED" {
		t.Fatalf("approval replayed as denial: %+v", got)
	}
	denial.DeviceSignature = signApprovalMessage(t, deviceKey, serviceControlOwnerDenialSigningBytes(deniedGrant))
	for i := 0; i < 2; i++ {
		if got := exchangeTestPipeRequest(t, base+".Request", denial); got.Status != statusDenied {
			t.Fatalf("denial: %+v", got)
		}
	}
	deniedApproval := denial
	deniedApproval.Type = "service.approve"
	deniedApproval.DeviceSignature = signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(deniedGrant))
	if got := exchangeTestPipeRequest(t, base+".Request", deniedApproval); got.Status != statusDenied {
		t.Fatalf("denied request executed: %+v", got)
	}
	if calls.Load() != 0 {
		t.Fatal("denial ran service controller")
	}
	pending := exchangeTestPipeRequest(t, base+".Request", brokerRequest{Version: protocolVersion, Type: "service.pending", DeviceID: deviceID})
	if pending.Type != "service_pending" || len(pending.ServicePending) != 1 || verifyBrokerSignature(pending.ServicePending[0].BrokerPublicKey, pending.ServicePending[0].BrokerSignature, serviceControlBrokerSigningBytes(grant)) != nil {
		t.Fatalf("pending approval invalid: %+v", pending)
	}
	bad := request
	bad.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	if got := exchangeTestPipeRequest(t, base+".Request", bad); got.Code != "SERVICE_CONTROL_AUTHORIZATION_DENIED" {
		t.Fatalf("bad signature: %+v", got)
	}
	reviewRequest := request
	reviewRequest.Type = "service.review"
	reviewRequest.DeviceSignature = ""
	review := exchangeTestPipeRequest(t, base+".Request", reviewRequest)
	if review.Type != "service_review" || review.ServiceControl == nil || verifyBrokerSignature(review.BrokerPublicKey, review.BrokerSignature, serviceControlBrokerSigningBytes(grant)) != nil {
		t.Fatalf("review attestation invalid: %+v", review)
	}
	changed := reviewRequest
	changedGrant := grant
	changedGrant.DefinitionHash = strings.Repeat("b", 64)
	changed.ServiceControl = &changedGrant
	if got := exchangeTestPipeRequest(t, base+".Request", changed); got.Code != "SERVICE_TARGET_CHANGED" {
		t.Fatalf("stale review accepted: %+v", got)
	}
	badOwner := request
	badOwner.DeviceSignature = base64.StdEncoding.EncodeToString([]byte("invalid"))
	if got := exchangeTestPipeRequest(t, base+".Request", badOwner); got.Code != "SERVICE_CONTROL_AUTHORIZATION_DENIED" {
		t.Fatalf("bad owner proof: %+v", got)
	}
	deviceApproval := brokerRequest{Version: protocolVersion, Type: "service.approve", RequestID: grant.RequestID, DeviceID: deviceID, DeviceSignature: request.DeviceSignature}
	for i := 0; i < 2; i++ {
		if got := exchangeTestPipeRequest(t, base+".Request", deviceApproval); got.Status != statusExecuting {
			t.Fatalf("claim %d: %+v", i, got)
		}
	}
	close(release)
	var status brokerResponse
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status = exchangeTestPipeRequest(t, base+".Request", brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID})
		if status.Status != statusExecuting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 || status.Status != statusSucceeded || status.ServiceControl == nil || status.ServiceControl.ServiceName != grant.ServiceName {
		t.Fatalf("calls=%d status=%+v", calls.Load(), status)
	}
}
