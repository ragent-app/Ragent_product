package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	maxBrokerDevices         = 32
	maxPendingEnrollments    = 16
	maxOwnerIDBytes          = 128
	maxDevicePublicKeyBytes  = 1024
	maxDeviceSignatureBytes  = 256
	requestApprovalLifetime  = 2 * time.Minute
	deviceEnrollmentLifetime = 5 * time.Minute
	requestApprovalDomain    = "Ragent Broker Device Decision v1\x00"
	deviceEnrollmentDomain   = "Ragent Broker Device Enrollment v1\x00"
	brokerEnrollmentDomain   = "Ragent Broker Signed Enrollment Challenge v1\x00"
	brokerApprovalDomain     = "Ragent Broker Signed Approval Challenge v1\x00"
)

var ownerIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:@-]{1,128}$`)

var (
	errEnrollmentInvalid        = errors.New("APB_ENROLLMENT_INVALID")
	errOwnerChangeRequiresReset = errors.New("APB_OWNER_CHANGE_REQUIRES_RESET")
	errDeviceAlreadyEnrolled    = errors.New("APB_DEVICE_ALREADY_ENROLLED")
	errEnrollmentExpired        = errors.New("APB_ENROLLMENT_EXPIRED")
	errEnrollmentCodeMismatch   = errors.New("APB_ENROLLMENT_CODE_MISMATCH")
	errEnrollmentSignature      = errors.New("APB_ENROLLMENT_SIGNATURE_INVALID")
	errEnrollmentNotFound       = errors.New("APB_ENROLLMENT_NOT_FOUND")
	errDeviceNotEnrolled        = errors.New("APB_DEVICE_NOT_ENROLLED")
	errDecisionExpired          = errors.New("APB_DECISION_EXPIRED")
	errDecisionConsumed         = errors.New("APB_DECISION_CONSUMED")
	errDecisionSignature        = errors.New("APB_DECISION_SIGNATURE_INVALID")
)

type brokerDevice struct {
	DeviceID  string    `json:"deviceId"`
	OwnerID   string    `json:"ownerId"`
	PublicKey string    `json:"publicKey"`
	AddedAt   time.Time `json:"addedAt"`
}

type pendingDeviceEnrollment struct {
	OwnerID   string                    `json:"ownerId"`
	DeviceID  string                    `json:"deviceId"`
	PublicKey string                    `json:"publicKey"`
	Challenge brokerEnrollmentChallenge `json:"challenge"`
}

type brokerEnrollmentChallenge struct {
	EnrollmentID         string    `json:"enrollmentId"`
	BrokerInstallationID string    `json:"brokerInstallationId"`
	PolicyGeneration     uint64    `json:"policyGeneration"`
	OwnerID              string    `json:"ownerId"`
	DeviceID             string    `json:"deviceId"`
	PublicKeyFingerprint string    `json:"publicKeyFingerprint"`
	Nonce                string    `json:"nonce"`
	VerificationCode     string    `json:"verificationCode"`
	CreatedAt            time.Time `json:"createdAt"`
	ExpiresAt            time.Time `json:"expiresAt"`
}

func validOwnerID(value string) bool {
	return len(value) <= maxOwnerIDBytes && ownerIDPattern.MatchString(value)
}

func decodeDevicePublicKey(encoded string) (*ecdsa.PublicKey, []byte, error) {
	if len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(maxDevicePublicKeyBytes) {
		return nil, nil, errEnrollmentInvalid
	}
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(der) == 0 || len(der) > maxDevicePublicKeyBytes {
		return nil, nil, errEnrollmentInvalid
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, nil, errEnrollmentInvalid
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() || key.X == nil || key.Y == nil || !key.Curve.IsOnCurve(key.X, key.Y) {
		return nil, nil, errEnrollmentInvalid
	}
	canonical, err := x509.MarshalPKIXPublicKey(key)
	if err != nil || string(canonical) != string(der) {
		return nil, nil, errEnrollmentInvalid
	}
	return key, der, nil
}

func deviceIDForPublicKey(encoded string) (string, error) {
	_, der, err := decodeDevicePublicKey(encoded)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:]), nil
}

func validateDeviceIDAndKey(deviceID, publicKey string) error {
	expected, err := deviceIDForPublicKey(publicKey)
	if err != nil || deviceID != expected {
		return errEnrollmentInvalid
	}
	return nil
}

func enrollmentSigningBytes(challenge brokerEnrollmentChallenge) ([]byte, error) {
	if err := validateEnrollmentChallenge(challenge); err != nil {
		return nil, err
	}
	return encodeSigningFields(deviceEnrollmentDomain, challenge.BrokerInstallationID, challenge.OwnerID,
		challenge.DeviceID, challenge.PublicKeyFingerprint, challenge.Nonce, challenge.VerificationCode,
		challenge.EnrollmentID, challenge.PolicyGeneration, challenge.CreatedAt, challenge.ExpiresAt), nil
}

func approvalSigningBytes(challenge brokerChallenge, choice string) ([]byte, error) {
	if (choice != "approve" && choice != "deny") || !validRequestID(challenge.RequestID) || !validOwnerID(challenge.OwnerID) ||
		!validRequestID(challenge.BrokerInstallationID) || challenge.PolicyGeneration == 0 || challenge.Operation != "service.restart" ||
		challenge.TargetID != firstBrokerTargetID || !isSHA256Hex(challenge.TargetFingerprint) || !validRequestID(challenge.SessionID) || !validRequestID(challenge.RunID) ||
		!validRequestID(challenge.TurnID) || !validRequestID(challenge.ActionID) || !validRequestID(challenge.Nonce) ||
		!challenge.CreatedAt.Equal(challenge.CreatedAt.UTC()) || !challenge.ExpiresAt.Equal(challenge.ExpiresAt.UTC()) ||
		!challenge.ExpiresAt.After(challenge.CreatedAt) || challenge.ExpiresAt.Sub(challenge.CreatedAt) > requestApprovalLifetime {
		return nil, errInvalidRequest
	}
	return encodeSigningFields(requestApprovalDomain, challenge.BrokerInstallationID, challenge.OwnerID,
		challenge.RequestID, challenge.Operation, challenge.TargetID, challenge.TargetFingerprint,
		challenge.SessionID, challenge.RunID, challenge.TurnID, challenge.ActionID, challenge.Nonce,
		choice, challenge.PolicyGeneration, challenge.CreatedAt, challenge.ExpiresAt), nil
}

func verifyDeviceSignature(publicKey, signature string, message []byte) error {
	key, _, err := decodeDevicePublicKey(publicKey)
	if err != nil || len(signature) == 0 || len(signature) > base64.StdEncoding.EncodedLen(maxDeviceSignatureBytes) {
		return errDecisionSignature
	}
	encoded, err := base64.StdEncoding.DecodeString(signature)
	digest := sha256.Sum256(message)
	if err != nil || len(encoded) == 0 || len(encoded) > maxDeviceSignatureBytes || !ecdsa.VerifyASN1(key, digest[:], encoded) {
		return errDecisionSignature
	}
	return nil
}

func createBrokerSigningKey() (string, string, error) {
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return "", "", err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(privateDER), base64.StdEncoding.EncodeToString(publicDER), nil
}

func brokerSignatureBytes(challenge brokerChallenge) ([]byte, error) {
	if _, err := approvalSigningBytes(challenge, "approve"); err != nil {
		return nil, err
	}
	return encodeSigningFields(brokerApprovalDomain, challenge.BrokerInstallationID, challenge.OwnerID,
		challenge.RequestID, challenge.Operation, challenge.TargetID, challenge.TargetFingerprint,
		challenge.SessionID, challenge.RunID, challenge.TurnID, challenge.ActionID, challenge.Nonce,
		challenge.PolicyGeneration, challenge.CreatedAt, challenge.ExpiresAt), nil
}

func brokerEnrollmentSignatureBytes(challenge brokerEnrollmentChallenge) ([]byte, error) {
	if err := validateEnrollmentChallenge(challenge); err != nil {
		return nil, err
	}
	return encodeSigningFields(brokerEnrollmentDomain, challenge.BrokerInstallationID, challenge.OwnerID,
		challenge.DeviceID, challenge.PublicKeyFingerprint, challenge.Nonce, challenge.VerificationCode,
		challenge.EnrollmentID, challenge.PolicyGeneration, challenge.CreatedAt, challenge.ExpiresAt), nil
}

func signBrokerMessage(privateKey, message []byte) (string, error) {
	parsed, err := x509.ParsePKCS8PrivateKey(privateKey)
	if err != nil {
		return "", errEnrollmentInvalid
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() || key.X == nil || key.Y == nil || !key.Curve.IsOnCurve(key.X, key.Y) {
		return "", errEnrollmentInvalid
	}
	digest := sha256.Sum256(message)
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(signature), nil
}

func verifyBrokerSignature(publicKey, signature string, message []byte) error {
	key, _, err := decodeDevicePublicKey(publicKey)
	if err != nil || len(signature) == 0 || len(signature) > base64.StdEncoding.EncodedLen(maxDeviceSignatureBytes) {
		return errDecisionSignature
	}
	encoded, err := base64.StdEncoding.DecodeString(signature)
	digest := sha256.Sum256(message)
	if err != nil || len(encoded) == 0 || len(encoded) > maxDeviceSignatureBytes || !ecdsa.VerifyASN1(key, digest[:], encoded) {
		return errDecisionSignature
	}
	return nil
}

func validateBrokerSigningKey(privateEncoded, publicEncoded string) error {
	privateDER, err := base64.StdEncoding.DecodeString(privateEncoded)
	if err != nil || len(privateDER) == 0 || len(privateDER) > 4096 {
		return errStateInvalid
	}
	publicDER, err := base64.StdEncoding.DecodeString(publicEncoded)
	if err != nil || len(publicDER) == 0 || len(publicDER) > maxDevicePublicKeyBytes {
		return errStateInvalid
	}
	parsedPrivate, err := x509.ParsePKCS8PrivateKey(privateDER)
	if err != nil {
		return errStateInvalid
	}
	private, ok := parsedPrivate.(*ecdsa.PrivateKey)
	if !ok || private.Curve != elliptic.P256() || private.X == nil || private.Y == nil || !private.Curve.IsOnCurve(private.X, private.Y) {
		return errStateInvalid
	}
	parsedPublic, err := x509.ParsePKIXPublicKey(publicDER)
	if err != nil {
		return errStateInvalid
	}
	public, ok := parsedPublic.(*ecdsa.PublicKey)
	if !ok || public.Curve != elliptic.P256() || public.X == nil || public.Y == nil ||
		public.X.Cmp(private.X) != 0 || public.Y.Cmp(private.Y) != 0 {
		return errStateInvalid
	}
	canonicalPrivate, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil || string(canonicalPrivate) != string(privateDER) {
		return errStateInvalid
	}
	canonicalPublic, err := x509.MarshalPKIXPublicKey(public)
	if err != nil || string(canonicalPublic) != string(publicDER) {
		return errStateInvalid
	}
	return nil
}

func validateEnrollmentChallenge(challenge brokerEnrollmentChallenge) error {
	if !validRequestID(challenge.EnrollmentID) || !validRequestID(challenge.BrokerInstallationID) || challenge.PolicyGeneration == 0 ||
		!validOwnerID(challenge.OwnerID) || len(challenge.DeviceID) != 64 || !isLowerHex(challenge.DeviceID) ||
		len(challenge.PublicKeyFingerprint) != 64 || !isLowerHex(challenge.PublicKeyFingerprint) || challenge.PublicKeyFingerprint != challenge.DeviceID ||
		!validRequestID(challenge.Nonce) || len(challenge.VerificationCode) != 8 || !isDigits(challenge.VerificationCode) ||
		!challenge.CreatedAt.Equal(challenge.CreatedAt.UTC()) || !challenge.ExpiresAt.Equal(challenge.ExpiresAt.UTC()) ||
		!challenge.ExpiresAt.After(challenge.CreatedAt) || challenge.ExpiresAt.Sub(challenge.CreatedAt) > deviceEnrollmentLifetime {
		return errEnrollmentInvalid
	}
	return nil
}

func enrollmentCode(challenge brokerEnrollmentChallenge) (string, error) {
	challenge.VerificationCode = "00000000"
	bytes, err := encodeEnrollmentCodeInput(challenge)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(bytes)
	value := binary.BigEndian.Uint32(digest[:4]) % 100000000
	return fmt.Sprintf("%08d", value), nil
}

func encodeEnrollmentCodeInput(challenge brokerEnrollmentChallenge) ([]byte, error) {
	// The displayed comparison code excludes itself from its own derivation.
	if !validRequestID(challenge.EnrollmentID) || !validRequestID(challenge.BrokerInstallationID) || !validOwnerID(challenge.OwnerID) ||
		len(challenge.DeviceID) != 64 || !isLowerHex(challenge.DeviceID) || challenge.PolicyGeneration == 0 ||
		!validRequestID(challenge.Nonce) || !challenge.CreatedAt.Equal(challenge.CreatedAt.UTC()) || !challenge.ExpiresAt.Equal(challenge.ExpiresAt.UTC()) {
		return nil, errEnrollmentInvalid
	}
	return encodeSigningFields("Ragent Broker Enrollment Code v1\x00", challenge.BrokerInstallationID,
		challenge.OwnerID, challenge.DeviceID, challenge.Nonce, challenge.EnrollmentID,
		challenge.PolicyGeneration, challenge.CreatedAt, challenge.ExpiresAt), nil
}

func encodeSigningFields(domain string, stringsToEncode ...any) []byte {
	result := make([]byte, 0, 512)
	result = append(result, []byte(domain)...)
	for _, value := range stringsToEncode {
		switch field := value.(type) {
		case string:
			result = appendLengthPrefixed(result, []byte(field))
		case uint64:
			var encoded [8]byte
			binary.BigEndian.PutUint64(encoded[:], field)
			result = append(result, encoded[:]...)
		case time.Time:
			var encoded [12]byte
			binary.BigEndian.PutUint64(encoded[:8], uint64(field.Unix()))
			binary.BigEndian.PutUint32(encoded[8:], uint32(field.Nanosecond()))
			result = append(result, encoded[:]...)
		default:
			panic("unsupported broker signing field")
		}
	}
	return result
}

func appendLengthPrefixed(dst, field []byte) []byte {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(field)))
	dst = append(dst, length[:]...)
	return append(dst, field...)
}

func isLowerHex(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
