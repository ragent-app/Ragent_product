package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	stateSchemaVersion = 3
	maxStateFileBytes  = 16 * 1024 * 1024
	maxStoredRequests  = 10000
	maxPendingPageSize = 16
)

var errStateInvalid = errors.New("APB_STATE_INVALID")

type requestRecord struct {
	Request   brokerRequest          `json:"request"`
	Digest    string                 `json:"digest"`
	Status    requestStatus          `json:"status"`
	Code      string                 `json:"code,omitempty"`
	Challenge *brokerChallenge       `json:"challenge,omitempty"`
	Result    *brokerOperationResult `json:"result,omitempty"`
	Legacy    bool                   `json:"legacy,omitempty"`
	CreatedAt time.Time              `json:"createdAt"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

type auditEntry struct {
	Sequence  uint64    `json:"sequence"`
	Timestamp time.Time `json:"timestamp"`
	Event     string    `json:"event"`
	RequestID string    `json:"requestId,omitempty"`
	Code      string    `json:"code,omitempty"`
	Digest    string    `json:"digest,omitempty"`
	Previous  string    `json:"previousHash,omitempty"`
	Hash      string    `json:"hash"`
}

type persistedBrokerState struct {
	SchemaVersion     int                                `json:"schemaVersion"`
	InstallationID    string                             `json:"installationId"`
	PolicyGeneration  uint64                             `json:"policyGeneration"`
	BrokerPrivateKey  string                             `json:"brokerPrivateKey"`
	BrokerPublicKey   string                             `json:"brokerPublicKey"`
	TargetFingerprint string                             `json:"targetFingerprint,omitempty"`
	OwnerID           string                             `json:"ownerId,omitempty"`
	Devices           map[string]brokerDevice            `json:"devices"`
	Enrollments       map[string]pendingDeviceEnrollment `json:"enrollments"`
	Requests          map[string]requestRecord           `json:"requests"`
	AutoInstalls      map[string]autoInstallRecord       `json:"autoInstalls,omitempty"`
	OwnerInstalls     map[string]ownerInstallRecord      `json:"ownerInstalls,omitempty"`
	ServiceControls   map[string]serviceControlRecord    `json:"serviceControls,omitempty"`
	AutoInstallSigner *autoInstallSigner                 `json:"autoInstallSigner,omitempty"`
	Audit             []auditEntry                       `json:"audit"`
}

type brokerStore struct {
	path  string
	mu    sync.Mutex
	state persistedBrokerState
}

// openBrokerStore must only be called after the Windows service has verified
// that the parent directory is fixed, non-reparse, and writable only by the
// Broker service, LocalSystem, and local administrators.
func openBrokerStore(path string) (*brokerStore, error) {
	if path == "" || filepath.Clean(path) != path {
		return nil, errStateInvalid
	}
	store := &brokerStore{path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		installationID, err := randomID()
		if err != nil {
			return nil, fmt.Errorf("create broker installation identity: %w", err)
		}
		privateKey, publicKey, err := createBrokerSigningKey()
		if err != nil {
			return nil, fmt.Errorf("create Broker signing identity: %w", err)
		}
		store.state = persistedBrokerState{
			SchemaVersion:    stateSchemaVersion,
			InstallationID:   installationID,
			PolicyGeneration: 1,
			BrokerPrivateKey: privateKey,
			BrokerPublicKey:  publicKey,
			Devices:          make(map[string]brokerDevice),
			Enrollments:      make(map[string]pendingDeviceEnrollment),
			Requests:         make(map[string]requestRecord),
			Audit:            make([]auditEntry, 0),
		}
		fingerprint, err := brokerPublicKeyFingerprint(publicKey)
		if err != nil {
			return nil, err
		}
		if err := store.appendAudit(&store.state, "broker.initialized", "", "", fingerprint); err != nil {
			return nil, err
		}
		if err := writeStateFile(path, store.state); err != nil {
			return nil, fmt.Errorf("persist initial broker state: %w", err)
		}
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read broker state: %w", err)
	}
	if len(data) == 0 || len(data) > maxStateFileBytes {
		return nil, errStateInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&store.state); err != nil {
		return nil, errStateInvalid
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errStateInvalid
	}
	if store.state.SchemaVersion == 1 || store.state.SchemaVersion == 2 {
		if err := migrateBrokerState(&store.state); err != nil {
			return nil, err
		}
		if err := writeStateFile(path, store.state); err != nil {
			return nil, fmt.Errorf("persist migrated broker state: %w", err)
		}
	} else if err := validateState(store.state); err != nil {
		return nil, err
	}
	if recovered, err := recoverInterruptedExecutions(&store.state, time.Now().UTC()); err != nil {
		return nil, err
	} else if recovered {
		if err := validateState(store.state); err != nil {
			return nil, err
		}
		if err := writeStateFile(path, store.state); err != nil {
			return nil, fmt.Errorf("persist interrupted execution recovery: %w", err)
		}
	}
	return store, nil
}

func recoverInterruptedExecutions(state *persistedBrokerState, now time.Time) (bool, error) {
	if state == nil {
		return false, errStateInvalid
	}
	recovered := false
	for requestID, record := range state.Requests {
		var next requestStatus
		var code string
		event := ""
		switch record.Status {
		case statusAuthorized:
			next, code, event = statusExpired, "EXECUTION_NOT_STARTED", "request.expired"
		case statusExecuting:
			next, code, event = statusUnknown, "EXECUTION_OUTCOME_UNKNOWN", "request.unknown"
		default:
			continue
		}
		record.Status = next
		record.Code = code
		record.Challenge = nil
		record.UpdatedAt = now.UTC()
		state.Requests[requestID] = record
		if err := appendAuditState(state, event, requestID, code, record.Digest); err != nil {
			return false, err
		}
		recovered = true
	}
	for nonce, record := range state.AutoInstalls {
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, "EXECUTION_OUTCOME_UNKNOWN", now.UTC()
		state.AutoInstalls[nonce] = record
		if err := appendAuditState(state, "auto_install.unknown", record.Grant.RequestID, record.Code, record.Digest); err != nil {
			return false, err
		}
		recovered = true
	}
	msiRecovered, err := markInterruptedMSIInstalls(state, "EXECUTION_OUTCOME_UNKNOWN")
	if err != nil {
		return false, err
	}
	recovered = recovered || msiRecovered
	for nonce, record := range state.OwnerInstalls {
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, "EXECUTION_OUTCOME_UNKNOWN", now.UTC()
		state.OwnerInstalls[nonce] = record
		if err := appendAuditState(state, "owner_install.unknown", record.Grant.RequestID, record.Code, record.Digest); err != nil {
			return false, err
		}
		recovered = true
	}
	for nonce, record := range state.ServiceControls {
		if record.Status == statusAwaitingDevice && now.UnixMilli() >= 0 && uint64(now.UnixMilli()) >= record.Grant.ExpiresMS {
			record.Status, record.Code, record.UpdatedAt = statusExpired, "DECISION_EXPIRED", now.UTC()
			state.ServiceControls[nonce] = record
			if err := appendAuditState(state, "service_control.expired", record.Grant.RequestID, record.Code, record.Digest); err != nil {
				return false, err
			}
			recovered = true
			continue
		}
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, "EXECUTION_OUTCOME_UNKNOWN", now.UTC()
		state.ServiceControls[nonce] = record
		if err := appendAuditState(state, "service_control.unknown", record.Grant.RequestID, record.Code, record.Digest); err != nil {
			return false, err
		}
		recovered = true
	}
	return recovered, nil
}

func brokerPublicKeyFingerprint(publicKey string) (string, error) {
	_, der, err := decodeDevicePublicKey(publicKey)
	if err != nil {
		return "", errStateInvalid
	}
	digest := sha256.Sum256(der)
	return fmt.Sprintf("%x", digest[:]), nil
}

func (s *brokerStore) BrokerPublicKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.BrokerPublicKey
}

func (s *brokerStore) SignEnrollmentChallenge(challenge brokerEnrollmentChallenge) (string, error) {
	message, err := brokerEnrollmentSignatureBytes(challenge)
	if err != nil {
		return "", err
	}
	return s.signBrokerMessage(message)
}

func (s *brokerStore) SignApprovalChallenge(challenge brokerChallenge) (string, error) {
	message, err := brokerSignatureBytes(challenge)
	if err != nil {
		return "", err
	}
	return s.signBrokerMessage(message)
}

func (s *brokerStore) signBrokerMessage(message []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	privateKey, err := base64.StdEncoding.DecodeString(s.state.BrokerPrivateKey)
	if err != nil {
		return "", errStateInvalid
	}
	return signBrokerMessage(privateKey, message)
}

func (s *brokerStore) RecordProposal(request brokerRequest, now time.Time) (requestRecord, bool, error) {
	digest, err := requestDigest(request)
	if err != nil {
		return requestRecord{}, false, err
	}
	var result requestRecord
	duplicate := false
	err = s.transact(func(next *persistedBrokerState) error {
		if msiRequestIDExists(next, request.RequestID) {
			return errRequestConflict
		}
		for _, automatic := range next.AutoInstalls {
			if automatic.Grant.RequestID == request.RequestID {
				return errRequestConflict
			}
		}
		for _, automatic := range next.OwnerInstalls {
			if automatic.Grant.RequestID == request.RequestID {
				return errRequestConflict
			}
		}
		for _, control := range next.ServiceControls {
			if control.Grant.RequestID == request.RequestID {
				return errRequestConflict
			}
		}
		if existing, ok := next.Requests[request.RequestID]; ok {
			if existing.Digest != digest {
				return errRequestConflict
			}
			result = existing
			duplicate = true
			return nil
		}
		if len(next.Requests) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = requestRecord{Request: request, Digest: digest, Status: statusProposed, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		next.Requests[request.RequestID] = result
		return s.appendAudit(next, "request.proposed", request.RequestID, "", digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) BeginEnrollment(ownerID, deviceID, publicKey string, now time.Time) (brokerEnrollmentChallenge, error) {
	if !validOwnerID(ownerID) || validateDeviceIDAndKey(deviceID, publicKey) != nil {
		return brokerEnrollmentChallenge{}, errEnrollmentInvalid
	}
	if _, _, err := decodeDevicePublicKey(publicKey); err != nil {
		return brokerEnrollmentChallenge{}, errEnrollmentInvalid
	}
	enrollmentID, err := randomID()
	if err != nil {
		return brokerEnrollmentChallenge{}, err
	}
	nonce, err := randomID()
	if err != nil {
		return brokerEnrollmentChallenge{}, err
	}
	now = now.UTC()
	var result brokerEnrollmentChallenge
	err = s.transact(func(next *persistedBrokerState) error {
		if next.OwnerID != "" && next.OwnerID != ownerID {
			return errOwnerChangeRequiresReset
		}
		if _, exists := next.Devices[deviceID]; exists {
			return errDeviceAlreadyEnrolled
		}
		for _, pending := range next.Enrollments {
			if pending.DeviceID == deviceID {
				if pending.Challenge.ExpiresAt.After(now) && pending.OwnerID == ownerID {
					result = pending.Challenge
					return nil
				}
				delete(next.Enrollments, pending.Challenge.EnrollmentID)
			}
		}
		if len(next.Enrollments) >= maxPendingEnrollments {
			return errors.New("APB_ENROLLMENT_CAPACITY_REACHED")
		}
		challenge := brokerEnrollmentChallenge{
			EnrollmentID:         enrollmentID,
			BrokerInstallationID: next.InstallationID,
			PolicyGeneration:     next.PolicyGeneration,
			OwnerID:              ownerID,
			DeviceID:             deviceID,
			PublicKeyFingerprint: deviceID,
			Nonce:                nonce,
			CreatedAt:            now,
			ExpiresAt:            now.Add(deviceEnrollmentLifetime),
		}
		challenge.VerificationCode, err = enrollmentCode(challenge)
		if err != nil {
			return err
		}
		next.Enrollments[challenge.EnrollmentID] = pendingDeviceEnrollment{
			OwnerID: ownerID, DeviceID: deviceID, PublicKey: publicKey, Challenge: challenge,
		}
		if err := s.appendAudit(next, "device.enrollment_proposed", "", "", hashEnrollmentChallenge(challenge)); err != nil {
			return err
		}
		result = challenge
		return nil
	})
	return result, err
}

func (s *brokerStore) CompleteEnrollment(enrollmentID, verificationCode, signature string, now time.Time) (brokerDevice, error) {
	var result brokerDevice
	var outcome error
	err := s.transact(func(next *persistedBrokerState) error {
		pending, ok := next.Enrollments[enrollmentID]
		if !ok {
			outcome = errEnrollmentNotFound
			return nil
		}
		challenge := pending.Challenge
		if !challenge.ExpiresAt.After(now.UTC()) || challenge.PolicyGeneration != next.PolicyGeneration {
			delete(next.Enrollments, enrollmentID)
			if err := s.appendAudit(next, "device.enrollment_expired", "", "ENROLLMENT_EXPIRED", hashEnrollmentChallenge(challenge)); err != nil {
				return err
			}
			outcome = errEnrollmentExpired
			return nil
		}
		if verificationCode != challenge.VerificationCode {
			if err := s.appendAudit(next, "device.enrollment_rejected", "", "ENROLLMENT_CODE_MISMATCH", hashEnrollmentChallenge(challenge)); err != nil {
				return err
			}
			outcome = errEnrollmentCodeMismatch
			return nil
		}
		message, err := enrollmentSigningBytes(challenge)
		if err != nil || verifyDeviceSignature(pending.PublicKey, signature, message) != nil {
			if err := s.appendAudit(next, "device.enrollment_rejected", "", "ENROLLMENT_SIGNATURE_INVALID", hashEnrollmentChallenge(challenge)); err != nil {
				return err
			}
			outcome = errEnrollmentSignature
			return nil
		}
		if next.OwnerID != "" && next.OwnerID != pending.OwnerID {
			delete(next.Enrollments, enrollmentID)
			outcome = errOwnerChangeRequiresReset
			return s.appendAudit(next, "device.enrollment_rejected", "", "OWNER_CHANGE_REQUIRES_RESET", hashEnrollmentChallenge(challenge))
		}
		if _, exists := next.Devices[pending.DeviceID]; exists || len(next.Devices) >= maxBrokerDevices || next.PolicyGeneration == ^uint64(0) {
			return errStateInvalid
		}
		next.OwnerID = pending.OwnerID
		next.PolicyGeneration++
		result = brokerDevice{DeviceID: pending.DeviceID, OwnerID: pending.OwnerID, PublicKey: pending.PublicKey, AddedAt: now.UTC()}
		next.Devices[pending.DeviceID] = result
		delete(next.Enrollments, enrollmentID)
		return s.appendAudit(next, "device.enrolled", "", "", hashEnrollmentChallenge(challenge))
	})
	if err != nil {
		return brokerDevice{}, err
	}
	if outcome != nil {
		return brokerDevice{}, outcome
	}
	return result, nil
}

// PendingEnrollment returns only the live, current-generation challenge bound
// to the requested device key. The Owner Host may relay this signed challenge
// to that device, but cannot create an enrollment or alter its contents.
func (s *brokerStore) PendingEnrollment(deviceID string, now time.Time) (brokerEnrollmentChallenge, error) {
	if len(deviceID) != 64 || !isLowerHex(deviceID) {
		return brokerEnrollmentChallenge{}, errEnrollmentInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pending := range s.state.Enrollments {
		if pending.DeviceID != deviceID {
			continue
		}
		challenge := pending.Challenge
		if challenge.PolicyGeneration != s.state.PolicyGeneration || !challenge.ExpiresAt.After(now.UTC()) {
			return brokerEnrollmentChallenge{}, errEnrollmentExpired
		}
		return challenge, nil
	}
	return brokerEnrollmentChallenge{}, errEnrollmentNotFound
}

func (s *brokerStore) RevokeDevice(deviceID string, now time.Time) error {
	if len(deviceID) != 64 || !isLowerHex(deviceID) {
		return errEnrollmentInvalid
	}
	return s.transact(func(next *persistedBrokerState) error {
		if _, ok := next.Devices[deviceID]; !ok {
			return errDeviceNotEnrolled
		}
		if next.PolicyGeneration == ^uint64(0) {
			return errStateInvalid
		}
		delete(next.Devices, deviceID)
		next.PolicyGeneration++
		next.Enrollments = make(map[string]pendingDeviceEnrollment)
		if err := expireOutstandingApprovals(next, "DEVICE_REVOKED", now.UTC()); err != nil {
			return err
		}
		return s.appendAudit(next, "device.revoked", "", "", "")
	})
}

func (s *brokerStore) ResetOwner(now time.Time) error {
	return s.transact(func(next *persistedBrokerState) error {
		if next.PolicyGeneration == ^uint64(0) {
			return errStateInvalid
		}
		next.PolicyGeneration++
		next.OwnerID = ""
		next.AutoInstallSigner = nil
		next.TargetFingerprint = ""
		next.Devices = make(map[string]brokerDevice)
		next.Enrollments = make(map[string]pendingDeviceEnrollment)
		if err := expireOutstandingApprovals(next, "OWNER_RESET", now.UTC()); err != nil {
			return err
		}
		return s.appendAudit(next, "owner.reset", "", "", "")
	})
}

func (s *brokerStore) ConfigureTarget(fingerprint string, now time.Time) error {
	if !isSHA256Hex(fingerprint) {
		return errInvalidRequest
	}
	return s.transact(func(next *persistedBrokerState) error {
		if next.PolicyGeneration == ^uint64(0) {
			return errStateInvalid
		}
		next.PolicyGeneration++
		next.TargetFingerprint = fingerprint
		next.Enrollments = make(map[string]pendingDeviceEnrollment)
		if err := expireOutstandingApprovals(next, "TARGET_POLICY_CHANGED", now.UTC()); err != nil {
			return err
		}
		return s.appendAudit(next, "target.configured", "", "TARGET_CONFIGURED", fingerprint)
	})
}

func (s *brokerStore) CompleteExecution(requestID string, status requestStatus, code, detail string, now time.Time) (requestRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return requestRecord{}, errStateInvalid
	}
	var result requestRecord
	err := s.transact(func(next *persistedBrokerState) error {
		record, ok := next.Requests[requestID]
		if !ok || record.Status != statusExecuting || !canTransition(record.Status, status) || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status = status
		record.Code = code
		record.UpdatedAt = now.UTC()
		if status == statusSucceeded {
			record.Result = &brokerOperationResult{Operation: record.Request.Operation, TargetID: record.Request.TargetID, Detail: detail}
		}
		next.Requests[requestID] = record
		if err := s.appendAudit(next, "request."+string(status), requestID, code, record.Digest); err != nil {
			return err
		}
		result = record
		return nil
	})
	return result, err
}

func (s *brokerStore) AwaitDeviceApproval(requestID, targetFingerprint string, now time.Time) (requestRecord, error) {
	nonce, err := randomID()
	if err != nil {
		return requestRecord{}, err
	}
	var result requestRecord
	err = s.transact(func(next *persistedBrokerState) error {
		record, ok := next.Requests[requestID]
		if !ok {
			return errStateInvalid
		}
		if record.Status != statusProposed {
			result = record
			return nil
		}
		if next.OwnerID == "" || len(next.Devices) == 0 {
			return errDeviceNotEnrolled
		}
		challenge := brokerChallenge{
			BrokerInstallationID: next.InstallationID,
			OwnerID:              next.OwnerID,
			PolicyGeneration:     next.PolicyGeneration,
			RequestID:            requestID,
			Operation:            record.Request.Operation,
			TargetID:             record.Request.TargetID,
			TargetFingerprint:    targetFingerprint,
			SessionID:            record.Request.SessionID,
			RunID:                record.Request.RunID,
			TurnID:               record.Request.TurnID,
			ActionID:             record.Request.ActionID,
			Nonce:                nonce,
			CreatedAt:            now.UTC(),
			ExpiresAt:            now.UTC().Add(requestApprovalLifetime),
		}
		if _, err := approvalSigningBytes(challenge, "approve"); err != nil {
			return err
		}
		record.Status = statusAwaitingDevice
		record.Code = ""
		record.Challenge = &challenge
		record.UpdatedAt = now.UTC()
		next.Requests[requestID] = record
		if err := s.appendAudit(next, "request.awaiting_device", requestID, "", record.Digest); err != nil {
			return err
		}
		result = record
		return nil
	})
	return result, err
}

func (s *brokerStore) ApplySignedDecision(request brokerRequest, now time.Time) (requestRecord, error) {
	if request.Type != "decision" || validateRequest(request) != nil {
		return requestRecord{}, errInvalidRequest
	}
	var result requestRecord
	var outcome error
	err := s.transact(func(next *persistedBrokerState) error {
		record, ok := next.Requests[request.RequestID]
		if !ok {
			outcome = errors.New("APB_REQUEST_NOT_FOUND")
			return nil
		}
		if record.Status != statusAwaitingDevice || record.Challenge == nil {
			outcome = errDecisionConsumed
			result = record
			return nil
		}
		challenge := *record.Challenge
		if !challenge.ExpiresAt.After(now.UTC()) || challenge.PolicyGeneration != next.PolicyGeneration || challenge.OwnerID != next.OwnerID {
			transitionRecord(next, &record, statusExpired, "DECISION_EXPIRED", now.UTC())
			if err := s.appendAudit(next, "request.expired", request.RequestID, record.Code, record.Digest); err != nil {
				return err
			}
			result = record
			outcome = errDecisionExpired
			return nil
		}
		device, ok := next.Devices[request.DeviceID]
		if !ok || device.OwnerID != next.OwnerID || request.DeviceID != device.DeviceID {
			if err := s.appendAudit(next, "request.signature_rejected", request.RequestID, "DEVICE_NOT_ENROLLED", record.Digest); err != nil {
				return err
			}
			outcome = errDeviceNotEnrolled
			return nil
		}
		message, err := approvalSigningBytes(challenge, request.Choice)
		if err != nil || verifyDeviceSignature(device.PublicKey, request.Signature, message) != nil {
			if err := s.appendAudit(next, "request.signature_rejected", request.RequestID, "SIGNATURE_INVALID", record.Digest); err != nil {
				return err
			}
			outcome = errDecisionSignature
			return nil
		}
		status := statusDenied
		code := "DEVICE_DENIED"
		if request.Choice == "approve" {
			status = statusAuthorized
			code = "DEVICE_APPROVED"
		}
		transitionRecord(next, &record, status, code, now.UTC())
		if err := s.appendAudit(next, "request."+string(status), request.RequestID, code, record.Digest); err != nil {
			return err
		}
		result = record
		return nil
	})
	if err != nil {
		return requestRecord{}, err
	}
	if outcome != nil {
		return result, outcome
	}
	return result, nil
}

func transitionRecord(state *persistedBrokerState, record *requestRecord, status requestStatus, code string, now time.Time) {
	record.Status = status
	record.Code = code
	record.UpdatedAt = now.UTC()
	state.Requests[record.Request.RequestID] = *record
}

func expireOutstandingApprovals(state *persistedBrokerState, code string, now time.Time) error {
	for id, record := range state.Requests {
		switch record.Status {
		case statusProposed, statusAwaitingDevice, statusAuthorized:
			transitionRecord(state, &record, statusExpired, code, now)
			if err := appendAuditState(state, "request.expired", id, code, record.Digest); err != nil {
				return err
			}
		case statusExecuting:
			transitionRecord(state, &record, statusUnknown, code, now)
			if err := appendAuditState(state, "request.unknown", id, code, record.Digest); err != nil {
				return err
			}
		}
	}
	for nonce, record := range state.AutoInstalls {
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, code, now.UTC()
		state.AutoInstalls[nonce] = record
		if err := appendAuditState(state, "auto_install.unknown", record.Grant.RequestID, code, record.Digest); err != nil {
			return err
		}
	}
	if _, err := markInterruptedMSIInstalls(state, code); err != nil {
		return err
	}
	for nonce, record := range state.OwnerInstalls {
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, code, now.UTC()
		state.OwnerInstalls[nonce] = record
		if err := appendAuditState(state, "owner_install.unknown", record.Grant.RequestID, code, record.Digest); err != nil {
			return err
		}
	}
	for nonce, record := range state.ServiceControls {
		if record.Status == statusAwaitingDevice {
			record.Status, record.Code, record.UpdatedAt = statusExpired, code, now.UTC()
			state.ServiceControls[nonce] = record
			if err := appendAuditState(state, "service_control.expired", record.Grant.RequestID, code, record.Digest); err != nil {
				return err
			}
			continue
		}
		if record.Status != statusExecuting {
			continue
		}
		record.Status, record.Code, record.UpdatedAt = statusUnknown, code, now.UTC()
		state.ServiceControls[nonce] = record
		if err := appendAuditState(state, "service_control.unknown", record.Grant.RequestID, code, record.Digest); err != nil {
			return err
		}
	}
	return nil
}

func appendAuditState(state *persistedBrokerState, event, requestID, code, digest string) error {
	entry := auditEntry{Sequence: uint64(len(state.Audit) + 1), Timestamp: time.Now().UTC(), Event: event, RequestID: requestID, Code: code, Digest: digest}
	if len(state.Audit) > 0 {
		entry.Previous = state.Audit[len(state.Audit)-1].Hash
	}
	entry.Hash = auditHash(entry)
	state.Audit = append(state.Audit, entry)
	return nil
}

func hashEnrollmentChallenge(challenge brokerEnrollmentChallenge) string {
	encoded, err := enrollmentSigningBytes(challenge)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *brokerStore) Transition(requestID string, nextStatus requestStatus, code string, now time.Time) (requestRecord, error) {
	var result requestRecord
	err := s.transact(func(next *persistedBrokerState) error {
		record, ok := next.Requests[requestID]
		if !ok || !canTransition(record.Status, nextStatus) || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status = nextStatus
		record.Code = code
		record.UpdatedAt = now.UTC()
		next.Requests[requestID] = record
		if err := s.appendAudit(next, "request."+string(nextStatus), requestID, code, record.Digest); err != nil {
			return err
		}
		result = record
		return nil
	})
	return result, err
}

func (s *brokerStore) GetRequest(requestID string) (requestRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.state.Requests[requestID]
	return record, ok
}

// GetRequestStatus makes an elapsed device challenge durable before returning
// its status. A pending-list read only hides elapsed challenges; callers that
// poll one request need the same terminal result and audit after a restart.
func (s *brokerStore) GetRequestStatus(requestID string, now time.Time) (requestRecord, bool, error) {
	record, ok := s.GetRequest(requestID)
	if !ok || record.Status != statusAwaitingDevice || record.Challenge == nil || record.Challenge.ExpiresAt.After(now.UTC()) {
		return record, ok, nil
	}
	err := s.transact(func(next *persistedBrokerState) error {
		current, found := next.Requests[requestID]
		if !found || current.Status != statusAwaitingDevice || current.Challenge == nil || current.Challenge.ExpiresAt.After(now.UTC()) {
			return nil
		}
		transitionRecord(next, &current, statusExpired, "DECISION_EXPIRED", now.UTC())
		return s.appendAudit(next, "request.expired", requestID, current.Code, current.Digest)
	})
	if err != nil {
		return requestRecord{}, false, err
	}
	record, ok = s.GetRequest(requestID)
	return record, ok, nil
}

// PendingRequests exposes only live challenges for the currently enrolled
// device. The Host can relay these records, but cannot turn them into a
// decision without the device's registered signing key.
func (s *brokerStore) PendingRequests(deviceID, cursor string, now time.Time) ([]requestRecord, string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.state.Devices[deviceID]
	if !ok || device.OwnerID == "" || device.OwnerID != s.state.OwnerID {
		return nil, "", false, errDeviceNotEnrolled
	}
	ordered := make([]requestRecord, 0, len(s.state.Requests))
	for _, record := range s.state.Requests {
		ordered = append(ordered, record)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].Request.RequestID < ordered[j].Request.RequestID
		}
		return ordered[i].CreatedAt.Before(ordered[j].CreatedAt)
	})
	start := 0
	if cursor != "" {
		cursorRecord, found := s.state.Requests[cursor]
		if !found || cursorRecord.Challenge == nil || cursorRecord.Challenge.OwnerID != device.OwnerID {
			return nil, "", false, errStateInvalid
		}
		for i, record := range ordered {
			if record.Request.RequestID == cursor {
				start = i + 1
				break
			}
		}
	}
	requests := make([]requestRecord, 0, maxPendingPageSize+1)
	for _, record := range ordered[start:] {
		challenge := record.Challenge
		if record.Status != statusAwaitingDevice || challenge == nil ||
			challenge.OwnerID != device.OwnerID || challenge.PolicyGeneration != s.state.PolicyGeneration ||
			!challenge.ExpiresAt.After(now) {
			continue
		}
		requests = append(requests, record)
		if len(requests) > maxPendingPageSize {
			break
		}
	}
	hasMore := len(requests) > maxPendingPageSize
	if hasMore {
		requests = requests[:maxPendingPageSize]
	}
	nextCursor := ""
	if hasMore && len(requests) > 0 {
		nextCursor = requests[len(requests)-1].Request.RequestID
	}
	return requests, nextCursor, hasMore, nil
}

func (s *brokerStore) Snapshot() persistedBrokerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	encoded, _ := json.Marshal(s.state)
	var copy persistedBrokerState
	_ = json.Unmarshal(encoded, &copy)
	return copy
}

func (s *brokerStore) transact(apply func(*persistedBrokerState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	encoded, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	var next persistedBrokerState
	if err := json.Unmarshal(encoded, &next); err != nil {
		return err
	}
	if err := apply(&next); err != nil {
		return err
	}
	if err := validateState(next); err != nil {
		return err
	}
	encoded, err = json.Marshal(next)
	if err != nil {
		return err
	}
	if len(encoded) > maxStateFileBytes {
		return errors.New("APB_STATE_CAPACITY_REACHED")
	}
	if err := writeStateBytes(s.path, encoded); err != nil {
		return fmt.Errorf("persist broker state: %w", err)
	}
	s.state = next
	return nil
}

func (s *brokerStore) appendAudit(state *persistedBrokerState, event, requestID, code, digest string) error {
	if event == "" || !validAuditCode(code) || (requestID != "" && !validRequestID(requestID)) || (digest != "" && !isSHA256Hex(digest)) {
		return errStateInvalid
	}
	entry := auditEntry{
		Sequence:  uint64(len(state.Audit) + 1),
		Timestamp: time.Now().UTC(),
		Event:     event,
		RequestID: requestID,
		Code:      code,
		Digest:    digest,
	}
	if len(state.Audit) > 0 {
		entry.Previous = state.Audit[len(state.Audit)-1].Hash
	}
	entry.Hash = auditHash(entry)
	state.Audit = append(state.Audit, entry)
	return nil
}

func canTransition(current, next requestStatus) bool {
	switch current {
	case statusProposed:
		return next == statusAwaitingDevice || next == statusDenied || next == statusExpired
	case statusAwaitingDevice:
		return next == statusAuthorized || next == statusDenied || next == statusExpired
	case statusAuthorized:
		return next == statusExecuting || next == statusDenied || next == statusExpired
	case statusExecuting:
		return next == statusSucceeded || next == statusFailed || next == statusUnknown
	default:
		return false
	}
}

func validateState(state persistedBrokerState) error {
	if state.SchemaVersion != stateSchemaVersion || !validRequestID(state.InstallationID) || state.PolicyGeneration == 0 ||
		validateBrokerSigningKey(state.BrokerPrivateKey, state.BrokerPublicKey) != nil ||
		(state.TargetFingerprint != "" && !isSHA256Hex(state.TargetFingerprint)) ||
		(state.OwnerID != "" && !validOwnerID(state.OwnerID)) || state.Devices == nil || len(state.Devices) > maxBrokerDevices ||
		state.Enrollments == nil || len(state.Enrollments) > maxPendingEnrollments || state.Requests == nil || len(state.Requests) > maxStoredRequests || len(state.Audit) == 0 {
		return errStateInvalid
	}
	if state.OwnerID == "" && len(state.Devices) != 0 {
		return errStateInvalid
	}
	for id, device := range state.Devices {
		if id != device.DeviceID || device.OwnerID != state.OwnerID || !device.AddedAt.Equal(device.AddedAt.UTC()) || validateDeviceIDAndKey(id, device.PublicKey) != nil {
			return errStateInvalid
		}
	}
	for id, enrollment := range state.Enrollments {
		if id != enrollment.Challenge.EnrollmentID || enrollment.OwnerID != enrollment.Challenge.OwnerID || enrollment.DeviceID != enrollment.Challenge.DeviceID ||
			validateDeviceIDAndKey(enrollment.DeviceID, enrollment.PublicKey) != nil || validateEnrollmentChallenge(enrollment.Challenge) != nil ||
			enrollment.Challenge.BrokerInstallationID != state.InstallationID || enrollment.Challenge.PolicyGeneration != state.PolicyGeneration {
			return errStateInvalid
		}
	}
	previous := ""
	for index, entry := range state.Audit {
		if entry.Sequence != uint64(index+1) || !entry.Timestamp.Equal(entry.Timestamp.UTC()) || entry.Event == "" || !validAuditCode(entry.Code) || entry.Previous != previous || !isSHA256Hex(entry.Hash) || auditHash(entry) != entry.Hash {
			return errStateInvalid
		}
		if entry.RequestID != "" && !validRequestID(entry.RequestID) {
			return errStateInvalid
		}
		if entry.Digest != "" && !isSHA256Hex(entry.Digest) {
			return errStateInvalid
		}
		previous = entry.Hash
	}
	for id, record := range state.Requests {
		if !validRequestID(id) || id != record.Request.RequestID || !isSHA256Hex(record.Digest) || !requestStatusValid(record.Status) || !record.CreatedAt.Equal(record.CreatedAt.UTC()) || !record.UpdatedAt.Equal(record.UpdatedAt.UTC()) {
			return errStateInvalid
		}
		if record.Legacy {
			if record.Status == statusProposed || record.Status == statusAwaitingDevice || record.Status == statusAuthorized || record.Status == statusExecuting || record.Challenge != nil {
				return errStateInvalid
			}
		} else {
			digest, err := requestDigest(record.Request)
			if err != nil || digest != record.Digest {
				return errStateInvalid
			}
		}
		if record.Status == statusAwaitingDevice && (record.Challenge == nil || record.Legacy) {
			return errStateInvalid
		}
		if record.Challenge != nil {
			challenge := record.Challenge
			if !validOwnerID(challenge.OwnerID) || challenge.BrokerInstallationID != state.InstallationID || challenge.RequestID != id || challenge.Operation != record.Request.Operation ||
				challenge.TargetID != record.Request.TargetID || challenge.SessionID != record.Request.SessionID || challenge.RunID != record.Request.RunID ||
				challenge.TurnID != record.Request.TurnID || challenge.ActionID != record.Request.ActionID ||
				approvalChallengeValidate(*challenge) != nil {
				return errStateInvalid
			}
		}
		if record.Result != nil && (record.Status != statusSucceeded || record.Result.Operation != record.Request.Operation ||
			record.Result.TargetID != record.Request.TargetID || len(record.Result.Detail) > 128) {
			return errStateInvalid
		}
	}
	if len(state.AutoInstalls) > maxStoredRequests {
		return errStateInvalid
	}
	if state.AutoInstallSigner != nil {
		if !validRequestID(state.AutoInstallSigner.KeyID) {
			return errStateInvalid
		}
		if _, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey); err != nil {
			return errStateInvalid
		}
	}
	autoRequests := make(map[string]bool, len(state.AutoInstalls))
	for nonce, record := range state.AutoInstalls {
		message, err := autoInstallSigningBytes(record.Grant)
		if err != nil || nonce != record.Grant.Nonce || !autoInstallNoncePattern.MatchString(nonce) ||
			!validRequestID(record.Grant.RequestID) || autoRequests[record.Grant.RequestID] ||
			!isSHA256Hex(record.Digest) || record.Digest != fmt.Sprintf("%x", sha256.Sum256(message)) ||
			!(record.Status == statusExecuting || record.Status == statusSucceeded || record.Status == statusFailed || record.Status == statusUnknown) ||
			!validAuditCode(record.Code) || !record.CreatedAt.Equal(record.CreatedAt.UTC()) || !record.UpdatedAt.Equal(record.UpdatedAt.UTC()) {
			return errStateInvalid
		}
		autoRequests[record.Grant.RequestID] = true
	}
	msiRecords, err := msiInstallRecords(&state)
	if err != nil || len(msiRecords) > maxStoredRequests {
		return errStateInvalid
	}
	for _, record := range msiRecords {
		if autoRequests[record.Grant.RequestID] || state.Requests[record.Grant.RequestID].Request.RequestID != "" {
			return errStateInvalid
		}
		autoRequests[record.Grant.RequestID] = true
	}
	if len(state.OwnerInstalls) > maxStoredRequests {
		return errStateInvalid
	}
	for nonce, record := range state.OwnerInstalls {
		message, err := ownerInstallGrantBytes(record.Grant)
		if err != nil || nonce != record.Grant.Nonce || !ownerGrantNonce.MatchString(nonce) || !validRequestID(record.Grant.RequestID) ||
			autoRequests[record.Grant.RequestID] || state.Requests[record.Grant.RequestID].Request.RequestID != "" ||
			!isSHA256Hex(record.Digest) || record.Digest != fmt.Sprintf("%x", sha256.Sum256(message)) ||
			!(record.Status == statusExecuting || record.Status == statusSucceeded || record.Status == statusFailed || record.Status == statusUnknown) ||
			!validAuditCode(record.Code) || !record.CreatedAt.Equal(record.CreatedAt.UTC()) || !record.UpdatedAt.Equal(record.UpdatedAt.UTC()) {
			return errStateInvalid
		}
		autoRequests[record.Grant.RequestID] = true
	}
	if len(state.ServiceControls) > maxStoredRequests {
		return errStateInvalid
	}
	for nonce, record := range state.ServiceControls {
		message := serviceControlSigningBytes(record.Grant)
		signature, signatureErr := base64.RawURLEncoding.DecodeString(record.Signature)
		if nonce != record.Grant.Nonce || !ownerGrantNonce.MatchString(nonce) || !validRequestID(record.Grant.RequestID) ||
			signatureErr != nil || len(signature) != ed25519.SignatureSize ||
			autoRequests[record.Grant.RequestID] || state.Requests[record.Grant.RequestID].Request.RequestID != "" ||
			!isSHA256Hex(record.Digest) || record.Digest != fmt.Sprintf("%x", sha256.Sum256(message)) ||
			!(record.Status == statusAwaitingDevice || record.Status == statusDenied || record.Status == statusExpired || record.Status == statusExecuting || record.Status == statusSucceeded || record.Status == statusFailed || record.Status == statusUnknown) ||
			!validAuditCode(record.Code) || !record.CreatedAt.Equal(record.CreatedAt.UTC()) || !record.UpdatedAt.Equal(record.UpdatedAt.UTC()) {
			return errStateInvalid
		}
		autoRequests[record.Grant.RequestID] = true
	}
	return nil
}

func approvalChallengeValidate(challenge brokerChallenge) error {
	if challenge.PolicyGeneration == 0 || !validRequestID(challenge.BrokerInstallationID) || !validRequestID(challenge.RequestID) ||
		challenge.Operation != "service.restart" || !validRequestID(challenge.TargetID) || !validRequestID(challenge.SessionID) ||
		!validRequestID(challenge.RunID) || !validRequestID(challenge.TurnID) || !validRequestID(challenge.ActionID) || !validRequestID(challenge.Nonce) ||
		!challenge.CreatedAt.Equal(challenge.CreatedAt.UTC()) || !challenge.ExpiresAt.Equal(challenge.ExpiresAt.UTC()) || !challenge.ExpiresAt.After(challenge.CreatedAt) ||
		challenge.ExpiresAt.Sub(challenge.CreatedAt) > requestApprovalLifetime {
		return errInvalidRequest
	}
	return nil
}

func migrateBrokerState(state *persistedBrokerState) error {
	if state == nil || (state.SchemaVersion != 1 && state.SchemaVersion != 2) || len(state.Requests) > maxStoredRequests || len(state.Audit) == 0 || len(state.Audit) > maxStoredRequests*4 {
		return errStateInvalid
	}
	previousVersion := state.SchemaVersion
	state.SchemaVersion = stateSchemaVersion
	if state.PolicyGeneration == 0 || state.PolicyGeneration == ^uint64(0) {
		return errStateInvalid
	}
	state.PolicyGeneration++
	state.OwnerID = ""
	state.TargetFingerprint = ""
	state.Devices = make(map[string]brokerDevice)
	state.Enrollments = make(map[string]pendingDeviceEnrollment)
	if state.Requests == nil {
		state.Requests = make(map[string]requestRecord)
	}
	privateKey, publicKey, err := createBrokerSigningKey()
	if err != nil {
		return fmt.Errorf("rotate Broker signing identity during migration: %w", err)
	}
	state.BrokerPrivateKey = privateKey
	state.BrokerPublicKey = publicKey
	now := time.Now().UTC()
	for id, record := range state.Requests {
		switch record.Status {
		case statusProposed, statusAwaitingDevice, statusAuthorized:
			record.Status = statusExpired
			record.Code = "MIGRATION_AUTHORIZATION_REVOKED"
			record.UpdatedAt = now
			record.Challenge = nil
			state.Requests[id] = record
			if err := appendAuditState(state, "request.expired", id, record.Code, record.Digest); err != nil {
				return err
			}
		case statusExecuting:
			record.Status = statusUnknown
			record.Code = "MIGRATION_EXECUTION_UNKNOWN"
			record.UpdatedAt = now
			record.Challenge = nil
			state.Requests[id] = record
			if err := appendAuditState(state, "request.unknown", id, record.Code, record.Digest); err != nil {
				return err
			}
		}
		record.Legacy = true
		record.Challenge = nil
		state.Requests[id] = record
	}
	fingerprint, err := brokerPublicKeyFingerprint(publicKey)
	if err != nil {
		return err
	}
	if err := appendAuditState(state, "broker.identity_rotated", "", "SCHEMA_V3_IDENTITY", fingerprint); err != nil {
		return err
	}
	if err := appendAuditState(state, "broker.state_migrated", "", fmt.Sprintf("SCHEMA_V%d_TO_V3", previousVersion), ""); err != nil {
		return err
	}
	return validateState(*state)
}

func requestStatusValid(status requestStatus) bool {
	switch status {
	case statusProposed, statusAwaitingDevice, statusAuthorized, statusExecuting, statusSucceeded, statusDenied, statusExpired, statusFailed, statusUnknown:
		return true
	default:
		return false
	}
}

func validAuditCode(code string) bool {
	if code == "" {
		return true
	}
	if len(code) > 96 {
		return false
	}
	for _, char := range code {
		if (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '_' && char != '.' && char != '-' {
			return false
		}
	}
	return true
}

func auditHash(entry auditEntry) string {
	entry.Hash = ""
	encoded, _ := json.Marshal(entry)
	sum := sha256.Sum256(append([]byte("Ragent Broker Audit v1\x00"), encoded...))
	return hex.EncodeToString(sum[:])
}

func isSHA256Hex(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == value
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func writeStateFile(path string, state persistedBrokerState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > maxStateFileBytes {
		return errors.New("APB_STATE_CAPACITY_REACHED")
	}
	return writeStateBytes(path, data)
}

func writeStateBytes(path string, data []byte) error {
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".apb-state-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, path); err != nil {
		return err
	}
	return nil
}
