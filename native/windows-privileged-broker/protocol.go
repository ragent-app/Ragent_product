package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

const (
	protocolVersion     = 2
	maxIPCFrame         = 64 * 1024
	maxRequestID        = 128
	firstBrokerTargetID = "Ragent-Broker-QA-Target"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

type brokerRequest struct {
	Version          int                        `json:"version"`
	Type             string                     `json:"type"`
	RequestID        string                     `json:"requestId,omitempty"`
	Cursor           string                     `json:"cursor,omitempty"`
	SessionID        string                     `json:"sessionId,omitempty"`
	RunID            string                     `json:"runId,omitempty"`
	TurnID           string                     `json:"turnId,omitempty"`
	ActionID         string                     `json:"actionId,omitempty"`
	Operation        string                     `json:"operation,omitempty"`
	TargetID         string                     `json:"targetId,omitempty"`
	OwnerID          string                     `json:"ownerId,omitempty"`
	DeviceID         string                     `json:"deviceId,omitempty"`
	PublicKey        string                     `json:"publicKey,omitempty"`
	EnrollmentID     string                     `json:"enrollmentId,omitempty"`
	VerificationCode string                     `json:"verificationCode,omitempty"`
	Choice           string                     `json:"choice,omitempty"`
	Signature        string                     `json:"signature,omitempty"`
	DeviceSignature  string                     `json:"deviceSignature,omitempty"`
	MSIInspect       *msiInspectRequest         `json:"msiInspect,omitempty"`
	MSIInstall       *msiInstallGrant           `json:"msiInstall,omitempty"`
	AutoInstall      *autoInstallGrant          `json:"autoInstall,omitempty"`
	OwnerInstall     *ownerInstallGrant         `json:"ownerInstall,omitempty"`
	AutoInspect      *autoInstallInspectRequest `json:"autoInspect,omitempty"`
	ServiceInspect   *serviceInspectRequest     `json:"serviceInspect,omitempty"`
	ServiceControl   *serviceControlGrant       `json:"serviceControl,omitempty"`
}

type msiInspectRequest struct {
	ArtifactPath   string `json:"artifactPath"`
	ArtifactSHA256 string `json:"artifactSha256"`
}
type msiInspectFacts struct {
	ArtifactPath    string `json:"artifactPath"`
	ArtifactSHA256  string `json:"artifactSha256"`
	PublisherSHA256 string `json:"publisherSha256"`
}

type serviceInspectRequest struct {
	ServiceName string `json:"serviceName"`
}
type serviceInspectFacts struct {
	ServiceName    string `json:"serviceName"`
	DefinitionHash string `json:"definitionHash"`
}

type autoInstallInspectRequest struct {
	PackageID      string `json:"packageId"`
	PackageVersion string `json:"packageVersion"`
}

type ownerInstallIdentity struct {
	InstanceID string `json:"instanceId"`
	OwnerSID   string `json:"ownerSid"`
}

type brokerResponse struct {
	Version             int                        `json:"version"`
	Type                string                     `json:"type"`
	RequestID           string                     `json:"requestId,omitempty"`
	DeviceID            string                     `json:"deviceId,omitempty"`
	BrokerPublicKey     string                     `json:"brokerPublicKey,omitempty"`
	BrokerSignature     string                     `json:"brokerSignature,omitempty"`
	Status              requestStatus              `json:"status,omitempty"`
	Code                string                     `json:"code,omitempty"`
	InstallationID      string                     `json:"installationId,omitempty"`
	PolicyGeneration    uint64                     `json:"policyGeneration,omitempty"`
	ExecutionEnabled    bool                       `json:"executionEnabled"`
	AutoInstallReady    bool                       `json:"autoInstallReady"`
	ServiceControlReady bool                       `json:"serviceControlReady"`
	AutoInstallKeyID    string                     `json:"autoInstallKeyId,omitempty"`
	MSIInstallReady     bool                       `json:"msiInstallReady"`
	MSIFacts            *msiInspectFacts           `json:"msiFacts,omitempty"`
	MSIBinding          string                     `json:"msiBinding,omitempty"`
	MSIDigest           string                     `json:"msiDigest,omitempty"`
	AutoInstall         *autoInstallGrant          `json:"autoInstall,omitempty"`
	OwnerInstall        *ownerInstallGrant         `json:"ownerInstall,omitempty"`
	OwnerIdentity       *ownerInstallIdentity      `json:"ownerIdentity,omitempty"`
	SelectedInstaller   *selectedInstallerFacts    `json:"selectedInstaller,omitempty"`
	ServiceFacts        *serviceInspectFacts       `json:"serviceFacts,omitempty"`
	ServiceControl      *serviceControlGrant       `json:"serviceControl,omitempty"`
	ServicePending      []servicePendingApproval   `json:"servicePending,omitempty"`
	Challenge           *brokerChallenge           `json:"challenge,omitempty"`
	EnrollmentChallenge *brokerEnrollmentChallenge `json:"enrollmentChallenge,omitempty"`
	Result              *brokerOperationResult     `json:"result,omitempty"`
	PendingRequests     []brokerPendingRequest     `json:"pendingRequests,omitempty"`
	NextCursor          string                     `json:"nextCursor,omitempty"`
	HasMore             bool                       `json:"hasMore"`
}

type servicePendingApproval struct {
	Grant           serviceControlGrant `json:"grant"`
	BrokerPublicKey string              `json:"brokerPublicKey"`
	BrokerSignature string              `json:"brokerSignature"`
}

type brokerPendingRequest struct {
	RequestID       string           `json:"requestId"`
	Status          requestStatus    `json:"status"`
	Challenge       *brokerChallenge `json:"challenge"`
	BrokerPublicKey string           `json:"brokerPublicKey"`
	BrokerSignature string           `json:"brokerSignature"`
}

type brokerChallenge struct {
	BrokerInstallationID string    `json:"brokerInstallationId"`
	OwnerID              string    `json:"ownerId"`
	PolicyGeneration     uint64    `json:"policyGeneration"`
	RequestID            string    `json:"requestId"`
	Operation            string    `json:"operation"`
	TargetID             string    `json:"targetId"`
	TargetFingerprint    string    `json:"targetFingerprint"`
	SessionID            string    `json:"sessionId"`
	RunID                string    `json:"runId"`
	TurnID               string    `json:"turnId"`
	ActionID             string    `json:"actionId"`
	Nonce                string    `json:"nonce"`
	CreatedAt            time.Time `json:"createdAt"`
	ExpiresAt            time.Time `json:"expiresAt"`
}

type brokerOperationResult struct {
	Operation string `json:"operation"`
	TargetID  string `json:"targetId"`
	Detail    string `json:"detail,omitempty"`
}

type requestStatus string

const (
	statusProposed       requestStatus = "proposed"
	statusAwaitingDevice requestStatus = "awaiting_device"
	statusAuthorized     requestStatus = "authorized"
	statusExecuting      requestStatus = "executing"
	statusSucceeded      requestStatus = "succeeded"
	statusDenied         requestStatus = "denied"
	statusExpired        requestStatus = "expired"
	statusFailed         requestStatus = "failed"
	statusUnknown        requestStatus = "unknown"
)

var (
	errUnsupportedProtocol = errors.New("APB_PROTOCOL_UNSUPPORTED")
	errInvalidRequest      = errors.New("APB_REQUEST_INVALID")
	errRequestConflict     = errors.New("APB_REQUEST_ID_CONFLICT")
)

func decodeBrokerRequest(payload []byte) (brokerRequest, error) {
	var request brokerRequest
	if len(payload) == 0 || len(payload) > maxIPCFrame {
		return request, errInvalidRequest
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return brokerRequest{}, errInvalidRequest
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return brokerRequest{}, errInvalidRequest
	}
	if request.Version != protocolVersion {
		return brokerRequest{}, errUnsupportedProtocol
	}
	if err := validateRequest(request); err != nil {
		return brokerRequest{}, err
	}
	return request, nil
}

func validateRequest(request brokerRequest) error {
	if request.Type != "msi_install.inspect" && request.MSIInspect != nil {
		return errInvalidRequest
	}
	if request.Type != "msi_install.execute" && request.MSIInstall != nil {
		return errInvalidRequest
	}
	if request.Type != "service.execute" && request.Type != "service.deny" && request.Type != "service.approve" && request.DeviceSignature != "" {
		return errInvalidRequest
	}
	if request.Type != "service.execute" && request.Type != "service.review" && request.Type != "service.propose" && request.ServiceControl != nil {
		return errInvalidRequest
	}
	if request.Type != "service.inspect" && request.ServiceInspect != nil {
		return errInvalidRequest
	}
	if request.Type != "owner_install.execute" && request.OwnerInstall != nil {
		return errInvalidRequest
	}
	if request.Type != "auto_install.execute" && request.AutoInstall != nil {
		return errInvalidRequest
	}
	if request.Type != "auto_install.inspect" && request.AutoInspect != nil {
		return errInvalidRequest
	}
	switch request.Type {
	case "health":
		if hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "status":
		if !validRequestID(request.RequestID) || hasFieldsExceptRequestID(request) {
			return errInvalidRequest
		}
	case "pending":
		if len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) ||
			(request.Cursor != "" && !validRequestID(request.Cursor)) || hasFieldsExceptPending(request) {
			return errInvalidRequest
		}
	case "enrollment.pending":
		if len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || hasFieldsExceptDeviceID(request) {
			return errInvalidRequest
		}
	case "propose":
		if !validRequestID(request.RequestID) || !validRequestID(request.SessionID) || !validRequestID(request.RunID) || !validRequestID(request.TurnID) || !validRequestID(request.ActionID) {
			return errInvalidRequest
		}
		if request.Operation != "service.restart" || request.TargetID != firstBrokerTargetID {
			return errInvalidRequest
		}
		if request.Cursor != "" || request.OwnerID != "" || request.DeviceID != "" || request.PublicKey != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" || request.Signature != "" {
			return errInvalidRequest
		}
	case "decision":
		if !validRequestID(request.RequestID) || len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || (request.Choice != "approve" && request.Choice != "deny") ||
			len(request.Signature) == 0 || len(request.Signature) > 1024 || request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" ||
			request.Operation != "" || request.TargetID != "" || request.OwnerID != "" || request.PublicKey != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Cursor != "" {
			return errInvalidRequest
		}
	case "enrollment.begin":
		if !validOwnerID(request.OwnerID) || len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || validateDeviceIDAndKey(request.DeviceID, request.PublicKey) != nil ||
			request.RequestID != "" || request.Cursor != "" || request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" || request.TargetID != "" ||
			request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" || request.Signature != "" {
			return errInvalidRequest
		}
	case "enrollment.complete":
		if !validRequestID(request.EnrollmentID) || len(request.VerificationCode) != 8 || !isDigits(request.VerificationCode) || len(request.Signature) == 0 || len(request.Signature) > 1024 ||
			request.RequestID != "" || request.Cursor != "" || request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" || request.TargetID != "" ||
			request.OwnerID != "" || request.DeviceID != "" || request.PublicKey != "" || request.Choice != "" {
			return errInvalidRequest
		}
	case "device.revoke":
		if len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || request.RequestID != "" || request.Cursor != "" || request.SessionID != "" || request.RunID != "" || request.TurnID != "" ||
			request.ActionID != "" || request.Operation != "" || request.TargetID != "" || request.OwnerID != "" || request.PublicKey != "" || request.EnrollmentID != "" ||
			request.VerificationCode != "" || request.Choice != "" || request.Signature != "" {
			return errInvalidRequest
		}
	case "owner.reset":
		if hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "target.configure":
		if hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "auto_signer.configure":
		if !validRequestID(request.TargetID) || request.PublicKey == "" || request.RequestID != "" || request.Cursor != "" ||
			request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" ||
			request.OwnerID != "" || request.DeviceID != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" || request.Signature != "" {
			return errInvalidRequest
		}
		if _, err := parseAutoInstallPublicKey(request.PublicKey); err != nil {
			return errInvalidRequest
		}
	case "msi_install.inspect":
		if request.MSIInspect == nil || !validMSIArtifactPath(request.MSIInspect.ArtifactPath) || !msiDigestPattern.MatchString(request.MSIInspect.ArtifactSHA256) || hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "msi_install.execute":
		if request.MSIInstall == nil || request.Signature == "" || len(request.Signature) > 1024 {
			return errInvalidRequest
		}
		copy := request
		copy.Signature = ""
		if hasNonHealthFields(copy) {
			return errInvalidRequest
		}
	case "auto_install.execute":
		if request.AutoInstall == nil || request.Signature == "" || len(request.Signature) > 1024 || request.RequestID != "" || request.Cursor != "" ||
			request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" || request.TargetID != "" ||
			request.OwnerID != "" || request.DeviceID != "" || request.PublicKey != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" {
			return errInvalidRequest
		}
	case "owner_install.execute":
		if request.OwnerInstall == nil || request.Signature == "" || len(request.Signature) > 1024 || request.RequestID != "" || request.Cursor != "" ||
			request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" || request.TargetID != "" ||
			request.OwnerID != "" || request.DeviceID != "" || request.PublicKey != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" {
			return errInvalidRequest
		}
	case "owner_install.identity":
		if hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "auto_install.inspect":
		if request.AutoInspect == nil || !autoInstallPackagePattern.MatchString(request.AutoInspect.PackageID) ||
			!autoInstallVersionPattern.MatchString(request.AutoInspect.PackageVersion) || hasNonHealthFields(request) || request.AutoInstall != nil {
			return errInvalidRequest
		}
	case "service.inspect":
		if request.ServiceInspect == nil || !validServiceControlName(request.ServiceInspect.ServiceName) || hasNonHealthFields(request) {
			return errInvalidRequest
		}
	case "service.deny", "service.approve":
		if !validRequestID(request.RequestID) || len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || request.DeviceSignature == "" || len(request.DeviceSignature) > 1024 {
			return errInvalidRequest
		}
		copy := request
		copy.RequestID, copy.DeviceID = "", ""
		if hasNonHealthFields(copy) {
			return errInvalidRequest
		}
	case "service.execute":
		if request.ServiceControl == nil || request.Signature == "" || len(request.Signature) > 1024 ||
			len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || request.DeviceSignature == "" || len(request.DeviceSignature) > 1024 {
			return errInvalidRequest
		}
		copy := request
		copy.Signature = ""
		copy.DeviceID = ""
		if hasNonHealthFields(copy) {
			return errInvalidRequest
		}
	case "service.review":
		if request.ServiceControl == nil || request.Signature == "" || len(request.Signature) > 1024 || len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) {
			return errInvalidRequest
		}
		copy := request
		copy.Signature = ""
		copy.DeviceID = ""
		if hasNonHealthFields(copy) {
			return errInvalidRequest
		}
	case "service.propose":
		if request.ServiceControl == nil || request.Signature == "" || len(request.Signature) > 1024 {
			return errInvalidRequest
		}
		copy := request
		copy.Signature = ""
		if hasNonHealthFields(copy) {
			return errInvalidRequest
		}
	case "service.pending":
		if len(request.DeviceID) != 64 || !isLowerHex(request.DeviceID) || (request.Cursor != "" && !validRequestID(request.Cursor)) || hasFieldsExceptPending(request) {
			return errInvalidRequest
		}
	default:
		return errInvalidRequest
	}
	return nil
}

func hasNonHealthFields(request brokerRequest) bool {
	return request.RequestID != "" || request.Cursor != "" || request.SessionID != "" || request.RunID != "" || request.TurnID != "" || request.ActionID != "" || request.Operation != "" || request.TargetID != "" ||
		request.OwnerID != "" || request.DeviceID != "" || request.PublicKey != "" || request.EnrollmentID != "" || request.VerificationCode != "" || request.Choice != "" || request.Signature != ""
}

func hasFieldsExceptRequestID(request brokerRequest) bool {
	request.RequestID = ""
	return hasNonHealthFields(request)
}

func hasFieldsExceptDeviceID(request brokerRequest) bool {
	request.DeviceID = ""
	return hasNonHealthFields(request)
}

func hasFieldsExceptPending(request brokerRequest) bool {
	request.DeviceID = ""
	request.Cursor = ""
	return hasNonHealthFields(request)
}

func validRequestID(value string) bool {
	return len(value) <= maxRequestID && requestIDPattern.MatchString(value)
}

func requestDigest(request brokerRequest) (string, error) {
	if err := validateRequest(request); err != nil || request.Type != "propose" {
		return "", errInvalidRequest
	}
	canonical := brokerRequest{
		Version:   request.Version,
		Type:      "propose",
		RequestID: request.RequestID,
		SessionID: request.SessionID,
		RunID:     request.RunID,
		TurnID:    request.TurnID,
		ActionID:  request.ActionID,
		Operation: request.Operation,
		TargetID:  request.TargetID,
	}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("encode request: %w", err)
	}
	sum := sha256.Sum256(append([]byte("Ragent Broker Propose v2\x00"), encoded...))
	return hex.EncodeToString(sum[:]), nil
}

func newResponse(responseType string) brokerResponse {
	return brokerResponse{Version: protocolVersion, Type: responseType}
}
