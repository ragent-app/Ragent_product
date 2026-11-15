package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

// A policy-issued grant binds one MSI and its observed signature state to one
// exact Run. The zero publisher fingerprint denotes an unsigned package; signed
// packages must match a trusted signer. The broker also requires its configured
// signing key and the current policy generation.
type msiInstallGrant struct {
	Version              int    `json:"version"`
	KeyID                string `json:"keyId"`
	BrokerInstallationID string `json:"brokerInstallationId"`
	PolicyGeneration     uint64 `json:"policyGeneration"`
	RequestID            string `json:"requestId"`
	SessionID            string `json:"sessionId"`
	RunID                string `json:"runId"`
	TurnID               string `json:"turnId"`
	ActionID             string `json:"actionId"`
	Nonce                string `json:"nonce"`
	ArtifactPath         string `json:"artifactPath"`
	ArtifactSHA256       string `json:"artifactSha256"`
	PublisherSHA256      string `json:"publisherSha256"`
	IssuedMS             int64  `json:"issuedMs"`
	ExpiresMS            int64  `json:"expiresMs"`
}

var (
	errMSIInstallGrant  = errors.New("APB_MSI_INSTALL_GRANT_INVALID")
	msiDigestPattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
	msiDrivePathPattern = regexp.MustCompile(`^[A-Za-z]:\\[^:*?"<>|\x00-\x1f]+$`)
)

func validMSIArtifactPath(value string) bool {
	if !msiDrivePathPattern.MatchString(value) || strings.ContainsAny(value, "%/") ||
		!strings.HasSuffix(strings.ToLower(value), ".msi") {
		return false
	}
	for _, part := range strings.Split(value[3:], `\`) {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
	}
	return true
}

func msiInstallSigningBytes(grant msiInstallGrant) ([]byte, error) {
	encoded, err := json.Marshal(grant)
	if err != nil {
		return nil, errMSIInstallGrant
	}
	return append([]byte("Ragent Windows MSI install v1\x00"), encoded...), nil
}

func verifyMSIInstallGrant(grant msiInstallGrant, signature string, key ed25519.PublicKey, now time.Time) error {
	if grant.Version != 1 || !validRequestID(grant.KeyID) || !validRequestID(grant.BrokerInstallationID) || grant.PolicyGeneration == 0 ||
		!validRequestID(grant.RequestID) || !validRequestID(grant.SessionID) || !validRequestID(grant.RunID) || !validRequestID(grant.TurnID) || !validRequestID(grant.ActionID) ||
		!autoInstallNoncePattern.MatchString(grant.Nonce) || !validMSIArtifactPath(grant.ArtifactPath) ||
		!msiDigestPattern.MatchString(grant.ArtifactSHA256) || !msiDigestPattern.MatchString(grant.PublisherSHA256) ||
		grant.IssuedMS <= 0 || grant.ExpiresMS <= grant.IssuedMS || grant.ExpiresMS-grant.IssuedMS > 60000 ||
		grant.IssuedMS > now.UnixMilli() || grant.ExpiresMS <= now.UnixMilli() || len(key) != ed25519.PublicKeySize {
		return errMSIInstallGrant
	}
	encoded, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(encoded) != ed25519.SignatureSize {
		return errMSIInstallGrant
	}
	message, err := msiInstallSigningBytes(grant)
	if err != nil || !ed25519.Verify(key, message, encoded) {
		return errMSIInstallGrant
	}
	return nil
}
