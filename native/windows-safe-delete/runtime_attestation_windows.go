//go:build windows

package safedelete

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"path/filepath"
	"strings"
	"time"
)

// RuntimeAttestation binds a manifest to a particular runtime and instance.
// A signature is meaningful only if the issuer independently verified the
// runtime's provenance and dependency closure before signing it.
type RuntimeAttestation struct {
	InstanceID string
	Root       string
	Manifest   [sha256.Size]byte
	IssuedMS   int64
	ExpiresMS  int64
}

// RuntimeAttestationMessage is a domain-separated, length-prefixed encoding;
// it avoids relying on JSON field ordering or ambiguous string concatenation.
func RuntimeAttestationMessage(a RuntimeAttestation) ([]byte, error) {
	if len(a.InstanceID) == 0 || len(a.InstanceID) > 128 || strings.ContainsRune(a.InstanceID, 0) ||
		!filepath.IsAbs(a.Root) || len(filepath.VolumeName(a.Root)) != 2 || len(a.Root) > 32767 ||
		strings.ContainsRune(a.Root, 0) || filepath.Clean(a.Root) != a.Root ||
		a.Root == filepath.VolumeName(a.Root)+string(filepath.Separator) ||
		a.IssuedMS <= 0 || a.ExpiresMS <= a.IssuedMS || a.ExpiresMS-a.IssuedMS > int64((5*time.Minute)/time.Millisecond) {
		return nil, ErrExecutableIdentity
	}
	var b bytes.Buffer
	b.WriteString("Ragent Windows runtime attestation v1\x00")
	for _, value := range []string{a.InstanceID, strings.ToLower(a.Root)} {
		_ = binary.Write(&b, binary.BigEndian, uint32(len(value)))
		b.WriteString(value)
	}
	b.Write(a.Manifest[:])
	_ = binary.Write(&b, binary.BigEndian, a.IssuedMS)
	_ = binary.Write(&b, binary.BigEndian, a.ExpiresMS)
	return b.Bytes(), nil
}

// VerifyRuntimeAttestation requires a trust anchor obtained independently of
// the request. It does not validate the runtime tree, ACLs or dependencies.
func VerifyRuntimeAttestation(a RuntimeAttestation, signature []byte, trustedKey ed25519.PublicKey, expectedInstance, expectedRoot string, manifest []byte, now time.Time) error {
	message, err := RuntimeAttestationMessage(a)
	if err != nil || len(trustedKey) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize ||
		a.InstanceID != expectedInstance || !strings.EqualFold(a.Root, expectedRoot) ||
		a.IssuedMS > now.UnixMilli() || a.ExpiresMS <= now.UnixMilli() || len(manifest) == 0 || len(manifest) > 4*1024*1024 {
		return ErrExecutableIdentity
	}
	digest := sha256.Sum256(manifest)
	if digest != a.Manifest || !ed25519.Verify(trustedKey, message, signature) {
		return ErrExecutableIdentity
	}
	return nil
}
