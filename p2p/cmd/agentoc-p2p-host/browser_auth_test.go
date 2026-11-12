package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testGrantToken(t *testing.T, issuer ed25519.PrivateKey, payload map[string]any) string {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	payloadSegment := base64.RawURLEncoding.EncodeToString(payloadBytes)
	signature := ed25519.Sign(issuer, []byte("agentoc-browser-connection-grant-v1\n"+payloadSegment))
	return "bca1." + payloadSegment + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func TestBrowserGrantAuthGateVerifiesBoundProofAndConsumesOnce(t *testing.T) {
	public, issuer, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ephemeral, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	x := ephemeral.PublicKey.X.FillBytes(make([]byte, 32))
	y := ephemeral.PublicKey.Y.FillBytes(make([]byte, 32))
	now := time.Now().UnixMilli()
	payload := map[string]any{
		"accountId": "acct_a", "aud": "instance:ins_a", "clientId": "browser_a", "connectionId": "conn_a",
		"ephemeralPublicKey": map[string]any{
			"alg": "P-256", "crv": "P-256", "kty": "EC",
			"x": base64.RawURLEncoding.EncodeToString(x), "y": base64.RawURLEncoding.EncodeToString(y),
		},
		"exp": now + 60_000, "iss": "https://issuer.test", "jti": "bcg_test_1", "kid": "fixture",
		"nbf": now - 1, "permissions": []string{"remote.read.health"}, "sub": "account:acct_a", "version": 1,
		"instanceId": "ins_a",
	}
	token := testGrantToken(t, issuer, payload)
	config := &browserAuthConfig{issuer: "https://issuer.test", instanceID: "ins_a", publicKeys: map[string]ed25519.PublicKey{"fixture": public}, replayed: map[string]int64{}}
	grant, nonce, err := config.authenticateInit(token)
	if err != nil {
		t.Fatal(err)
	}
	challenge := strings.Join([]string{"agentoc-browser-auth-v1", grant.ConnectionID, grant.InstanceID, grant.JTI, nonce}, "\n")
	hash := sha256.Sum256([]byte(challenge))
	r, s, err := ecdsa.Sign(rand.Reader, ephemeral, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	principal, err := config.authenticateProof(grant, nonce, base64.RawURLEncoding.EncodeToString(signature))
	if err != nil {
		t.Fatal(err)
	}
	if principal.ClientID != "browser_a" || principal.Permissions[0] != "remote.read.health" {
		t.Fatalf("unexpected principal: %#v", principal)
	}
	if _, err := config.authenticateProof(grant, nonce, base64.RawURLEncoding.EncodeToString(signature)); err == nil || err.Error() != "grant replayed" {
		t.Fatalf("expected grant replay rejection, got %v", err)
	}
	if err := verifyBrowserProof(grant, nonce+"-new", base64.RawURLEncoding.EncodeToString(signature)); err == nil {
		t.Fatal("proof from an old challenge must fail for a new nonce")
	}
	wrongEphemeral, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wrongHash := sha256.Sum256([]byte(challenge))
	wrongR, wrongS, err := ecdsa.Sign(rand.Reader, wrongEphemeral, wrongHash[:])
	if err != nil {
		t.Fatal(err)
	}
	wrongSignature := append(wrongR.FillBytes(make([]byte, 32)), wrongS.FillBytes(make([]byte, 32))...)
	if err := verifyBrowserProof(grant, nonce, base64.RawURLEncoding.EncodeToString(wrongSignature)); err == nil {
		t.Fatal("proof from a different ephemeral key must fail")
	}
}

func TestBrowserGrantVerifierRejectsTamperAndWrongKeyType(t *testing.T) {
	public, issuer, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	payload := map[string]any{
		"version": 1, "iss": "issuer", "kid": "fixture", "aud": "instance:ins", "sub": "account:acct",
		"accountId": "acct", "instanceId": "ins", "clientId": "browser", "connectionId": "conn", "jti": "jti",
		"ephemeralPublicKey": map[string]any{"kty": "EC", "alg": "P-256", "crv": "P-256", "x": "AA", "y": "AA"},
		"permissions":        []string{"remote.read.health"}, "nbf": now - 1, "exp": now + 60_000,
	}
	token := testGrantToken(t, issuer, payload)
	config := &browserAuthConfig{issuer: "issuer", instanceID: "ins", publicKeys: map[string]ed25519.PublicKey{"fixture": public}, replayed: map[string]int64{}}
	parts := strings.Split(token, ".")
	var decoded map[string]any
	if err := json.Unmarshal(mustBase64(parts[1]), &decoded); err != nil {
		t.Fatal(err)
	}
	decoded["permissions"] = []string{}
	tamperedPayload, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	tampered := "bca1." + base64.RawURLEncoding.EncodeToString(tamperedPayload) + "." + parts[2]
	if _, err := verifyBrowserGrantToken(tampered, config); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected tampered signature rejection, got %v", err)
	}
}

func TestBrowserAuthGateRejectsHTTPBeforeAuthentication(t *testing.T) {
	for _, messageType := range []string{
		"http_request",
		"http_request_stream_v1",
		"http_request_stream_v2_init",
		"http_request_stream_v2_chunk",
		"http_request_stream_v2_end",
		"http_request_stream_v2_abort",
	} {
		if !browserAuthMustGate("AUTHENTICATING", messageType) {
			t.Errorf("%s must be rejected while authenticating", messageType)
		}
		if !browserAuthMustGate("NEW", messageType) {
			t.Errorf("%s must be rejected before authentication starts", messageType)
		}
		if browserAuthMustGate("AUTHENTICATED", messageType) {
			t.Errorf("authenticated browser should be allowed to use %s", messageType)
		}
	}
	if browserAuthMustGate("AUTHENTICATING", "client_auth_v1") {
		t.Fatal("auth messages must reach the auth state machine")
	}
}

func TestBrowserAuthBinaryFramesRequireAuthentication(t *testing.T) {
	binary := []byte{'A', 'G', 'B', '3', 0xff}
	for _, phase := range []string{"NEW", "AUTHENTICATING"} {
		if _, err := decodeBrowserAuthMessage(binary, false, phase); err == nil {
			t.Fatalf("binary frame must be rejected in %s", phase)
		}
	}
	if _, err := decodeBrowserAuthMessage(binary, false, "AUTHENTICATED"); err != nil {
		t.Fatalf("authenticated binary frame must reach the stream assembler: %v", err)
	}
	msg, err := decodeBrowserAuthMessage([]byte(`{"type":"client_auth_init_v1","version":1}`), true, "AUTHENTICATING")
	if err != nil || msg.Type != "client_auth_init_v1" || msg.Version != 1 {
		t.Fatalf("authentication JSON was not decoded: %#v, %v", msg, err)
	}
	if _, err := decodeBrowserAuthMessage(binary, true, "AUTHENTICATED"); err == nil {
		t.Fatal("malformed text frame must still be rejected")
	}
}

func mustBase64(value string) []byte {
	decoded, _ := base64.RawURLEncoding.DecodeString(value)
	return decoded
}
