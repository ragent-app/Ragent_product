package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestAutoInstallGrantBindsEveryFieldAndExpires(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	grant := autoInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: "broker-1", PolicyGeneration: 1, RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "0123456789abcdefghijklmn", PackageID: "Vendor.Application", VersionID: "1.2.3", Source: "winget", InstallScope: "machine", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := autoInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, message))
	if err := verifyAutoInstallGrant(grant, signature, pub, now); err != nil {
		t.Fatal(err)
	}
	changed := grant
	changed.PackageID = "Other.Package"
	if verifyAutoInstallGrant(changed, signature, pub, now) == nil {
		t.Fatal("changed package accepted")
	}
	changed = grant
	changed.VersionID = "--override"
	if verifyAutoInstallGrant(changed, signature, pub, now) == nil {
		t.Fatal("invalid version accepted")
	}
	changed = grant
	changed.Source = "other"
	if verifyAutoInstallGrant(changed, signature, pub, now) == nil {
		t.Fatal("unknown source accepted")
	}
	changed = grant
	changed.SelectedInstaller = &selectedInstallerFacts{ID: grant.PackageID, Version: grant.VersionID, Source: "winget", Scope: "System", Elevation: "ElevationRequired", Type: "Msi", NestedType: "Unknown", Architecture: "X64", Locale: "en-US"}
	if !validSelectedInstaller(changed) {
		t.Fatal("valid selected installer was not recognized")
	}
	for _, mutate := range []func(*selectedInstallerFacts){
		func(f *selectedInstallerFacts) { f.ID = "Other.App" },
		func(f *selectedInstallerFacts) { f.Version = "9.9" },
		func(f *selectedInstallerFacts) { f.Scope = "User" },
		func(f *selectedInstallerFacts) { f.Elevation = "ElevationProhibited" },
		func(f *selectedInstallerFacts) { f.Locale = "../escape" },
		func(f *selectedInstallerFacts) { f.Type = "unexpected" },
	} {
		candidate := *changed.SelectedInstaller
		mutate(&candidate)
		candidateGrant := changed
		candidateGrant.SelectedInstaller = &candidate
		if validSelectedInstaller(candidateGrant) {
			t.Fatal("mismatched selected installer accepted")
		}
	}
	selectedMessage, err := autoInstallSigningBytes(changed)
	if err != nil {
		t.Fatal(err)
	}
	selectedSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, selectedMessage))
	if err := verifyAutoInstallGrant(changed, selectedSignature, pub, now); err != nil {
		t.Fatalf("valid selected installer was rejected: %v", err)
	}
	modified := *changed.SelectedInstaller
	modified.Architecture = "Arm64"
	changed.SelectedInstaller = &modified
	if verifyAutoInstallGrant(changed, selectedSignature, pub, now) == nil {
		t.Fatal("signed selection mutation accepted")
	}
	for _, scope := range []string{"", "user"} {
		changed = grant
		changed.InstallScope = scope
		changedMessage, err := autoInstallSigningBytes(changed)
		if err != nil {
			t.Fatal(err)
		}
		changedSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, changedMessage))
		if verifyAutoInstallGrant(changed, changedSignature, pub, now) == nil {
			t.Fatalf("unsupported scope %q accepted", scope)
		}
	}
	if verifyAutoInstallGrant(grant, signature, pub, now.Add(time.Minute)) == nil {
		t.Fatal("expired grant accepted")
	}
	if verifyAutoInstallGrant(grant, signature, ed25519.PublicKey(make([]byte, 32)), now) == nil {
		t.Fatal("untrusted key accepted")
	}
}

func TestAutomaticSignerDoesNotRequireSeparatePhoneEnrollment(t *testing.T) {
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
	if err := store.ConfigureAutoInstallSigner("instance-1", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	if state.OwnerID != "" || len(state.Devices) != 0 {
		t.Fatal("unexpected separate phone enrollment")
	}
	grant := autoInstallGrant{Version: 1, KeyID: "instance-1", BrokerInstallationID: state.InstallationID, PolicyGeneration: state.PolicyGeneration, RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "0123456789abcdefghijklmn", PackageID: "Vendor.App", VersionID: "1.2.3", Source: "winget", InstallScope: "machine", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := autoInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	if _, _, err := store.ClaimAutoInstall(grant, signature, now); err != nil {
		t.Fatalf("admin-bound automatic signer was refused: %v", err)
	}
	if err := store.ResetOwner(now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ClaimAutoInstall(grant, signature, now); err == nil {
		t.Fatal("owner reset did not revoke the signer")
	}
}

func TestAutoInstallClaimIsDurableAndSingleUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	devicePrivate, devicePublic, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-1", deviceID, devicePublic, now)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode, signApprovalMessage(t, devicePrivate, challenge), now); err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureAutoInstallSigner("key-1", base64.RawURLEncoding.EncodeToString(publicDER), now); err != nil {
		t.Fatal(err)
	}
	snapshot := store.Snapshot()
	grant := autoInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: snapshot.InstallationID, PolicyGeneration: snapshot.PolicyGeneration, RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "0123456789abcdefghijklmn", PackageID: "Vendor.App", VersionID: "1.2.3", Source: "winget", InstallScope: "machine", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, _ := autoInstallSigningBytes(grant)
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, message))
	var wg sync.WaitGroup
	results := make(chan bool, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, duplicate, err := store.ClaimAutoInstall(grant, signature, now)
			results <- duplicate
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	duplicates := 0
	for duplicate := range results {
		if duplicate {
			duplicates++
		}
	}
	if duplicates != 1 {
		t.Fatalf("expected exactly one duplicate, got %d", duplicates)
	}
	conflicting := grant
	conflicting.Nonce = "abcdefghijklmn0123456789"
	conflictingBytes, _ := autoInstallSigningBytes(conflicting)
	conflictingSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, conflictingBytes))
	if _, _, err := store.ClaimAutoInstall(conflicting, conflictingSignature, now); err != errRequestConflict {
		t.Fatalf("same request with a new nonce must conflict: %v", err)
	}
	otherBroker := grant
	otherBroker.BrokerInstallationID = "other-broker"
	otherBytes, _ := autoInstallSigningBytes(otherBroker)
	otherSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, otherBytes))
	if _, _, err := store.ClaimAutoInstall(otherBroker, otherSignature, now); err != errAutoInstallGrant {
		t.Fatalf("grant for another broker must be refused: %v", err)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Snapshot().AutoInstalls[grant.Nonce].Status; got != statusUnknown {
		t.Fatalf("interrupted install must remain unknown, got %s", got)
	}
	_, duplicate, err := reopened.ClaimAutoInstall(grant, signature, now)
	if err != nil || !duplicate {
		t.Fatalf("recovered claim must never execute twice: duplicate=%t error=%v", duplicate, err)
	}
	if err := reopened.ResetOwner(now); err != nil {
		t.Fatal(err)
	}
	if reopened.Snapshot().AutoInstallSigner != nil {
		t.Fatal("owner reset must remove the trusted signer")
	}
	if _, _, err := reopened.ClaimAutoInstall(grant, signature, now); err != errAutoInstallGrant {
		t.Fatalf("owner reset must invalidate grants: %v", err)
	}
}

func TestAutoInstallSigningBytesInteroperable(t *testing.T) {
	grant := autoInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: "broker-1", PolicyGeneration: 1, RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "0123456789abcdefghijklmn", PackageID: "Vendor.Application", VersionID: "1.2.3", Source: "winget", InstallScope: "machine", IssuedMS: 1000, ExpiresMS: 2000}
	actual, err := autoInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	want := "Ragent Windows auto install v1\x00" + `{"version":1,"keyId":"key-1","brokerInstallationId":"broker-1","policyGeneration":1,"requestId":"request-1","sessionId":"session-1","runId":"run-1","turnId":"turn-1","actionId":"action-1","nonce":"0123456789abcdefghijklmn","packageId":"Vendor.Application","packageVersion":"1.2.3","source":"winget","installScope":"machine","issuedMs":1000,"expiresMs":2000}`
	if string(actual) != want {
		t.Fatalf("unexpected signing bytes: %q", actual)
	}
	grant.SelectedInstaller = &selectedInstallerFacts{ID: grant.PackageID, Version: grant.VersionID, Source: "winget", Scope: "System", Elevation: "ElevationRequired", Type: "Msi", NestedType: "Unknown", Architecture: "X64", Locale: "en-US"}
	actual, err = autoInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	want = "Ragent Windows auto install v1\x00" + `{"version":1,"keyId":"key-1","brokerInstallationId":"broker-1","policyGeneration":1,"requestId":"request-1","sessionId":"session-1","runId":"run-1","turnId":"turn-1","actionId":"action-1","nonce":"0123456789abcdefghijklmn","packageId":"Vendor.Application","packageVersion":"1.2.3","source":"winget","installScope":"machine","selectedInstaller":{"id":"Vendor.Application","version":"1.2.3","source":"winget","scope":"System","elevation":"ElevationRequired","type":"Msi","nestedType":"Unknown","architecture":"X64","locale":"en-US"},"issuedMs":1000,"expiresMs":2000}`
	if string(actual) != want {
		t.Fatalf("unexpected selected signing bytes: %q", actual)
	}
}
