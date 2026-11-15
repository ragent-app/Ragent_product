package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"time"
)

// This envelope is not an executable command: it binds a single exact package
// to a run, installation, owner and policy generation. The persisted signer,
// broker generation and protected installation policy are supplied by the
// broker, never by the incoming request.
type ownerInstallGrant struct {
	Version              int    `json:"version"`
	KeyID                string `json:"keyId"`
	BrokerInstallationID string `json:"brokerInstallationId"`
	PolicyGeneration     uint64 `json:"policyGeneration"`
	InstanceID           string `json:"instanceId"`
	OwnerSID             string `json:"ownerSid"`
	RequestID            string `json:"requestId"`
	SessionID            string `json:"sessionId"`
	RunID                string `json:"runId"`
	TurnID               string `json:"turnId"`
	ActionID             string `json:"actionId"`
	Nonce                string `json:"nonce"`
	PackageID            string `json:"packageId"`
	PackageVersion       string `json:"packageVersion"`
	Source               string `json:"source"`
	InstallScope         string `json:"installScope"`
	IssuedMS             int64  `json:"issuedMs"`
	ExpiresMS            int64  `json:"expiresMs"`
}

var ownerGrantID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
var ownerGrantNonce = regexp.MustCompile(`^[A-Za-z0-9_-]{24,128}$`)
var ownerGrantPackage = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
var ownerGrantVersion = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$`)

func ownerInstallGrantBytes(grant ownerInstallGrant) ([]byte, error) {
	data, err := json.Marshal(grant)
	if err != nil {
		return nil, errOwnerSessionUnavailable
	}
	return append([]byte("Ragent Windows owner auto install v1\x00"), data...), nil
}

func verifyOwnerInstallGrant(grant ownerInstallGrant, signature string, publicKey ed25519.PublicKey,
	keyID, brokerInstallationID string, generation uint64, policy ownerInstallPolicy, now time.Time) error {
	for _, id := range []string{grant.KeyID, grant.BrokerInstallationID, grant.RequestID, grant.SessionID, grant.RunID, grant.TurnID, grant.ActionID} {
		if !ownerGrantID.MatchString(id) {
			return errOwnerSessionUnavailable
		}
	}
	if grant.Version != 1 || grant.KeyID != keyID || keyID != policy.InstanceID || grant.BrokerInstallationID != brokerInstallationID || generation == 0 || grant.PolicyGeneration != generation ||
		grant.InstanceID != policy.InstanceID || grant.OwnerSID != policy.OwnerSID || !ownerPolicyInstance.MatchString(policy.InstanceID) || !ownerPolicyAccountSID.MatchString(policy.OwnerSID) ||
		!ownerGrantNonce.MatchString(grant.Nonce) || !ownerGrantPackage.MatchString(grant.PackageID) || !ownerGrantVersion.MatchString(grant.PackageVersion) ||
		grant.Source != "winget" || (grant.InstallScope != "user" && grant.InstallScope != "default") || grant.IssuedMS <= 0 || grant.ExpiresMS <= grant.IssuedMS ||
		grant.ExpiresMS-grant.IssuedMS > 60000 || grant.IssuedMS > now.UnixMilli() || grant.ExpiresMS <= now.UnixMilli() || len(publicKey) != ed25519.PublicKeySize {
		return errOwnerSessionUnavailable
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errOwnerSessionUnavailable
	}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil || !ed25519.Verify(publicKey, message, sig) {
		return errOwnerSessionUnavailable
	}
	return nil
}
