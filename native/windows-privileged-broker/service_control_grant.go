package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"time"
)

// This is an exact one-operation authorization, not a shell or arbitrary
// executable. The key, installation identity and policy generation are always
// supplied from the protected broker state, never from the request itself.
type serviceControlGrant struct {
	Version              uint64 `json:"version"`
	KeyID                string `json:"keyId"`
	BrokerInstallationID string `json:"brokerInstallationId"`
	PolicyGeneration     uint64 `json:"policyGeneration"`
	RequestID            string `json:"requestId"`
	SessionID            string `json:"sessionId"`
	RunID                string `json:"runId"`
	TurnID               string `json:"turnId"`
	ActionID             string `json:"actionId"`
	Nonce                string `json:"nonce"`
	ServiceName          string `json:"serviceName"`
	Action               string `json:"action"`
	DefinitionHash       string `json:"definitionHash"`
	Authorization        string `json:"authorization"`
	IssuedMS             uint64 `json:"issuedMs"`
	ExpiresMS            uint64 `json:"expiresMs"`
}

var errServiceControlGrant = errors.New("APB_SERVICE_CONTROL_GRANT_INVALID")

type serviceOwnerProof struct {
	DeviceID  string
	Signature string
}

// A separate enrolled-device signature prevents the control-plane's install
// signing key from claiming an owner approval by itself.
func serviceControlOwnerSigningBytes(grant serviceControlGrant) []byte {
	return append([]byte("Ragent Windows service owner approval v1\x00"), serviceControlSigningBytes(grant)...)
}

func serviceControlOwnerDenialSigningBytes(grant serviceControlGrant) []byte {
	return append([]byte("Ragent Windows service owner denial v1\x00"), serviceControlSigningBytes(grant)...)
}

func serviceControlBrokerSigningBytes(grant serviceControlGrant) []byte {
	return append([]byte("Ragent Windows service review v1\x00"), serviceControlSigningBytes(grant)...)
}

func serviceControlSigningBytes(grant serviceControlGrant) []byte {
	return encodeSigningFields("Ragent Windows service control v1\x00", grant.Version, grant.KeyID, grant.BrokerInstallationID,
		grant.PolicyGeneration, grant.RequestID, grant.SessionID, grant.RunID, grant.TurnID, grant.ActionID, grant.Nonce,
		grant.ServiceName, grant.Action, grant.DefinitionHash, grant.Authorization, grant.IssuedMS, grant.ExpiresMS)
}

func verifyServiceControlGrant(grant serviceControlGrant, signature string, publicKey ed25519.PublicKey,
	keyID, installationID string, generation uint64, now time.Time) error {
	for _, id := range []string{grant.KeyID, grant.BrokerInstallationID, grant.RequestID, grant.SessionID, grant.RunID, grant.TurnID, grant.ActionID} {
		if !validRequestID(id) {
			return errServiceControlGrant
		}
	}
	if grant.Version != 1 || grant.KeyID != keyID || grant.BrokerInstallationID != installationID || generation == 0 || grant.PolicyGeneration != generation ||
		!ownerGrantNonce.MatchString(grant.Nonce) || !validServiceControlName(grant.ServiceName) || !serviceDefinitionHash.MatchString(grant.DefinitionHash) ||
		(grant.Action != "start-service" && grant.Action != "stop-service" && grant.Action != "restart-service") || grant.Authorization != "owner" ||
		grant.IssuedMS == 0 || grant.ExpiresMS <= grant.IssuedMS || grant.ExpiresMS-grant.IssuedMS > 600000 ||
		now.UnixMilli() < 0 || grant.IssuedMS > uint64(now.UnixMilli()) || grant.ExpiresMS <= uint64(now.UnixMilli()) || len(publicKey) != ed25519.PublicKeySize {
		return errServiceControlGrant
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(publicKey, serviceControlSigningBytes(grant), sig) {
		return errServiceControlGrant
	}
	return nil
}
