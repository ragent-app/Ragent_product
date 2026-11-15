package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// autoInstallGrant is an exact short-lived operation, never a command line.
// The service supplies the trusted key separately; a request cannot choose it.
type autoInstallGrant struct {
	Version              int                     `json:"version"`
	KeyID                string                  `json:"keyId"`
	BrokerInstallationID string                  `json:"brokerInstallationId"`
	PolicyGeneration     uint64                  `json:"policyGeneration"`
	RequestID            string                  `json:"requestId"`
	SessionID            string                  `json:"sessionId"`
	RunID                string                  `json:"runId"`
	TurnID               string                  `json:"turnId"`
	ActionID             string                  `json:"actionId"`
	Nonce                string                  `json:"nonce"`
	PackageID            string                  `json:"packageId"`
	VersionID            string                  `json:"packageVersion"`
	Source               string                  `json:"source"`
	InstallScope         string                  `json:"installScope"`
	SelectedInstaller    *selectedInstallerFacts `json:"selectedInstaller,omitempty"`
	IssuedMS             int64                   `json:"issuedMs"`
	ExpiresMS            int64                   `json:"expiresMs"`
}

// Optional exact metadata is signed with the grant. It is not itself proof of
// installer-file identity and cannot enable execution until the native runner
// revalidates it in the same installation context.
type selectedInstallerFacts struct {
	ID           string `json:"id"`
	Version      string `json:"version"`
	Source       string `json:"source"`
	Scope        string `json:"scope"`
	Elevation    string `json:"elevation"`
	Type         string `json:"type"`
	NestedType   string `json:"nestedType"`
	Architecture string `json:"architecture"`
	Locale       string `json:"locale"`
}

type autoInstallRecord struct {
	Grant     autoInstallGrant `json:"grant"`
	Digest    string           `json:"digest"`
	Status    requestStatus    `json:"status"`
	Code      string           `json:"code"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
}

type autoInstallSigner struct {
	KeyID     string `json:"keyId"`
	PublicKey string `json:"publicKey"`
}

func parseAutoInstallPublicKey(encoded string) (ed25519.PublicKey, error) {
	der, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(der) > 256 {
		return nil, errAutoInstallGrant
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, errAutoInstallGrant
	}
	publicKey, ok := key.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, errAutoInstallGrant
	}
	return publicKey, nil
}

// Only the administrative pipe may configure the trusted signing key.
func (s *brokerStore) ConfigureAutoInstallSigner(keyID, encoded string, now time.Time) error {
	if !validRequestID(keyID) {
		return errAutoInstallGrant
	}
	if _, err := parseAutoInstallPublicKey(encoded); err != nil {
		return err
	}
	return s.transact(func(state *persistedBrokerState) error {
		if state.PolicyGeneration == ^uint64(0) {
			return errAutoInstallGrant
		}
		if state.AutoInstallSigner != nil && state.AutoInstallSigner.KeyID == keyID && state.AutoInstallSigner.PublicKey == encoded {
			return nil
		}
		state.PolicyGeneration++
		state.AutoInstallSigner = &autoInstallSigner{KeyID: keyID, PublicKey: encoded}
		state.Enrollments = make(map[string]pendingDeviceEnrollment)
		if err := expireOutstandingApprovals(state, "SIGNER_POLICY_CHANGED", now.UTC()); err != nil {
			return err
		}
		hash := sha256.Sum256([]byte(encoded))
		return s.appendAudit(state, "auto_install.signer_configured", "", "SIGNER_CONFIGURED", fmt.Sprintf("%x", hash))
	})
}

var (
	autoInstallPackagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
	autoInstallVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$`)
	autoInstallNoncePattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{24,128}$`)
	installerLocalePattern    = regexp.MustCompile(`^[A-Za-z0-9-]{0,85}$`)
	errAutoInstallGrant       = errors.New("APB_AUTO_INSTALL_GRANT_INVALID")
)

func validInspectedInstaller(grant autoInstallGrant) bool {
	facts := grant.SelectedInstaller
	return validInstallerFacts(facts, grant.PackageID, grant.VersionID) && facts.Scope == "System"
}

func validInstallerFacts(facts *selectedInstallerFacts, packageID, versionID string) bool {
	if facts == nil || facts.ID != packageID || facts.Version != versionID || facts.Source != "winget" || !installerLocalePattern.MatchString(facts.Locale) {
		return false
	}
	switch facts.Scope {
	case "Unknown", "User", "System":
	default:
		return false
	}
	switch facts.Elevation {
	case "Unknown", "ElevationRequired", "ElevationProhibited", "ElevatesSelf":
	default:
		return false
	}
	validType := func(value string) bool {
		switch value {
		case "Unknown", "Inno", "Wix", "Msi", "Nullsoft", "Zip", "Msix", "Exe", "Burn", "MSStore", "Portable", "Font":
			return true
		}
		return false
	}
	if !validType(facts.Type) || !validType(facts.NestedType) {
		return false
	}
	switch facts.Architecture {
	case "X86", "Arm", "X64", "Neutral", "Arm64", "Unknown", "X86OnArm64":
		return true
	}
	return false
}

func validSelectedInstaller(grant autoInstallGrant) bool {
	return validInspectedInstaller(grant) && grant.SelectedInstaller.Elevation != "ElevationProhibited"
}

func autoInstallSigningBytes(grant autoInstallGrant) ([]byte, error) {
	encoded, err := json.Marshal(grant)
	if err != nil {
		return nil, errAutoInstallGrant
	}
	return append([]byte("Ragent Windows auto install v1\x00"), encoded...), nil
}

func verifyAutoInstallGrant(grant autoInstallGrant, signature string, trustedKey ed25519.PublicKey, now time.Time) error {
	if (grant.SelectedInstaller != nil && !validSelectedInstaller(grant)) || grant.Version != 1 || !validRequestID(grant.KeyID) || !validRequestID(grant.BrokerInstallationID) || grant.PolicyGeneration == 0 || !validRequestID(grant.RequestID) ||
		!validRequestID(grant.SessionID) || !validRequestID(grant.RunID) || !validRequestID(grant.TurnID) || !validRequestID(grant.ActionID) ||
		!autoInstallNoncePattern.MatchString(grant.Nonce) || !autoInstallPackagePattern.MatchString(grant.PackageID) ||
		!autoInstallVersionPattern.MatchString(grant.VersionID) || grant.Source != "winget" || grant.InstallScope != "machine" ||
		grant.IssuedMS <= 0 || grant.ExpiresMS <= grant.IssuedMS || grant.ExpiresMS-grant.IssuedMS > 60000 ||
		grant.IssuedMS > now.UnixMilli() || grant.ExpiresMS <= now.UnixMilli() || len(trustedKey) != ed25519.PublicKeySize {
		return errAutoInstallGrant
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errAutoInstallGrant
	}
	message, err := autoInstallSigningBytes(grant)
	if err != nil || !ed25519.Verify(trustedKey, message, sig) {
		return errAutoInstallGrant
	}
	return nil
}

// Claim before starting a process. Duplicate requests return the durable record
// without starting again. A restarted service turns an in-flight claim into
// unknown, because it cannot infer whether the installer completed.
func (s *brokerStore) ClaimAutoInstall(grant autoInstallGrant, signature string, now time.Time) (autoInstallRecord, bool, error) {
	message, err := autoInstallSigningBytes(grant)
	if err != nil {
		return autoInstallRecord{}, false, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(message))
	var result autoInstallRecord
	duplicate := false
	err = s.transact(func(state *persistedBrokerState) error {
		if grant.BrokerInstallationID != state.InstallationID || grant.PolicyGeneration != state.PolicyGeneration || state.AutoInstallSigner == nil || state.AutoInstallSigner.KeyID != grant.KeyID {
			return errAutoInstallGrant
		}
		publicKey, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey)
		if err != nil || verifyAutoInstallGrant(grant, signature, publicKey, now) != nil {
			return errAutoInstallGrant
		}
		if state.AutoInstalls == nil {
			state.AutoInstalls = make(map[string]autoInstallRecord)
		}
		if existing, ok := state.AutoInstalls[grant.Nonce]; ok {
			if existing.Digest != digest {
				return errRequestConflict
			}
			result, duplicate = existing, true
			return nil
		}
		if msiRequestIDExists(state, grant.RequestID) {
			return errRequestConflict
		}
		for _, existing := range state.AutoInstalls {
			if existing.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, existing := range state.OwnerInstalls {
			if existing.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, existing := range state.ServiceControls {
			if existing.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		if _, exists := state.Requests[grant.RequestID]; exists {
			return errRequestConflict
		}
		if len(state.AutoInstalls) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = autoInstallRecord{Grant: grant, Digest: digest, Status: statusExecuting, Code: "EXECUTION_STARTED", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state.AutoInstalls[grant.Nonce] = result
		return s.appendAudit(state, "auto_install.executing", grant.RequestID, result.Code, digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) FinishAutoInstall(nonce string, status requestStatus, code string, now time.Time) (autoInstallRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return autoInstallRecord{}, errStateInvalid
	}
	var result autoInstallRecord
	err := s.transact(func(state *persistedBrokerState) error {
		record, found := state.AutoInstalls[nonce]
		if !found || record.Status != statusExecuting || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status, record.Code, record.UpdatedAt = status, code, now.UTC()
		state.AutoInstalls[nonce], result = record, record
		return s.appendAudit(state, "auto_install."+string(status), record.Grant.RequestID, code, record.Digest)
	})
	return result, err
}

func (s *brokerStore) GetAutoInstall(requestID string) (autoInstallRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.state.AutoInstalls {
		if record.Grant.RequestID == requestID {
			return record, true
		}
	}
	return autoInstallRecord{}, false
}
