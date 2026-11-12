package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const maxRequestBodyBytes = 25 << 20
const maxResponseBodyBytes = 8 << 20

type controlMessage struct {
	Type          string  `json:"type"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

type iceServerConfig struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type httpRequest struct {
	ID                   string            `json:"id"`
	Type                 string            `json:"type"`
	Method               string            `json:"method"`
	Path                 string            `json:"path"`
	Headers              map[string]string `json:"headers"`
	BodyBase64           string            `json:"bodyBase64"`
	AcceptResponseStream bool              `json:"acceptResponseStream,omitempty"`
}

type browserGrantPublicKey struct {
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

type browserGrant struct {
	Version            int                   `json:"version"`
	Iss                string                `json:"iss"`
	Kid                string                `json:"kid"`
	Aud                string                `json:"aud"`
	Sub                string                `json:"sub"`
	AccountID          string                `json:"accountId"`
	InstanceID         string                `json:"instanceId"`
	ClientID           string                `json:"clientId"`
	ConnectionID       string                `json:"connectionId"`
	EphemeralPublicKey browserGrantPublicKey `json:"ephemeralPublicKey"`
	Permissions        []string              `json:"permissions"`
	JTI                string                `json:"jti"`
	NBF                int64                 `json:"nbf"`
	EXP                int64                 `json:"exp"`
}

type browserPrincipal struct {
	AccountID    string
	InstanceID   string
	ClientID     string
	ConnectionID string
	GrantJTI     string
	Permissions  []string
}

type browserAuthConfig struct {
	issuer     string
	instanceID string
	publicKeys map[string]ed25519.PublicKey
	mu         sync.Mutex
	replayed   map[string]int64
}

type browserAuthSession struct {
	mu         sync.Mutex
	phase      string
	grantToken string
	grant      *browserGrant
	nonce      string
	principal  *browserPrincipal
	timer      *time.Timer
}

type browserAuthMessage struct {
	Type            string `json:"type"`
	Version         int    `json:"version"`
	ConnectionGrant string `json:"connectionGrant"`
	Proof           struct {
		Algorithm string `json:"algorithm"`
		Signature string `json:"signature"`
	} `json:"proof"`
}

func decodeBrowserAuthMessage(data []byte, isString bool, phase string) (browserAuthMessage, error) {
	var message browserAuthMessage
	if !isString {
		if phase != "AUTHENTICATED" {
			return message, errors.New("binary message before authentication")
		}
		return message, nil
	}
	err := json.Unmarshal(data, &message)
	return message, err
}

const browserAuthTimeout = 10 * time.Second
const browserAuthReplayLimit = 4096

func loadBrowserAuthConfig() (*browserAuthConfig, error) {
	if os.Getenv("AGENTOC_P2P_BROWSER_AUTH_REQUIRED") != "1" {
		return nil, nil
	}
	publicKeys := map[string]ed25519.PublicKey{}
	if encoded := os.Getenv("AGENTOC_P2P_BROWSER_GRANT_TRUSTED_KEYS_JSON"); encoded != "" {
		var keySet map[string]string
		if err := json.Unmarshal([]byte(encoded), &keySet); err != nil {
			return nil, fmt.Errorf("browser grant trusted key set is invalid")
		}
		for keyID, value := range keySet {
			block, _ := pem.Decode([]byte(value))
			if block == nil {
				return nil, fmt.Errorf("browser grant trusted key %s is invalid", keyID)
			}
			parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
			if err != nil {
				return nil, fmt.Errorf("browser grant trusted key %s is invalid: %w", keyID, err)
			}
			key, ok := parsed.(ed25519.PublicKey)
			if !ok {
				return nil, fmt.Errorf("browser grant trusted key %s must be Ed25519", keyID)
			}
			publicKeys[keyID] = key
		}
	} else {
		block, _ := pem.Decode([]byte(os.Getenv("AGENTOC_P2P_BROWSER_GRANT_PUBLIC_KEY_PEM")))
		if block == nil {
			return nil, fmt.Errorf("browser grant public key is missing")
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("browser grant public key is invalid: %w", err)
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, fmt.Errorf("browser grant issuer key must be Ed25519")
		}
		keyID := os.Getenv("AGENTOC_P2P_BROWSER_GRANT_KEY_ID")
		if keyID == "" {
			return nil, fmt.Errorf("browser grant key id is required")
		}
		publicKeys[keyID] = key
	}
	if len(publicKeys) == 0 {
		return nil, fmt.Errorf("browser grant trusted key set is empty")
	}
	config := &browserAuthConfig{
		issuer:     os.Getenv("AGENTOC_P2P_BROWSER_GRANT_ISSUER"),
		instanceID: os.Getenv("AGENTOC_P2P_BROWSER_INSTANCE_ID"),
		publicKeys: publicKeys,
		replayed:   map[string]int64{},
	}
	if config.issuer == "" || config.instanceID == "" {
		return nil, fmt.Errorf("browser auth issuer and instance id are required")
	}
	return config, nil
}

func canonicalPayload(value any) ([]byte, error) {
	// encoding/json sorts map keys recursively. The browser grant issuer uses
	// the same lexicographic canonical object ordering.
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(output.Bytes(), []byte{'\n'}), nil
}

func verifyBrowserGrantToken(token string, config *browserAuthConfig) (*browserGrant, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "bca1" {
		return nil, fmt.Errorf("malformed browser connection grant")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("grant payload encoding is invalid")
	}
	var raw map[string]any
	if err := json.Unmarshal(payloadBytes, &raw); err != nil {
		return nil, fmt.Errorf("grant payload is invalid")
	}
	canonical, err := canonicalPayload(raw)
	if err != nil || !bytes.Equal(canonical, payloadBytes) {
		return nil, fmt.Errorf("grant payload is not canonical")
	}
	var grant browserGrant
	if err := json.Unmarshal(payloadBytes, &grant); err != nil {
		return nil, fmt.Errorf("grant claims are invalid")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	publicKey, ok := config.publicKeys[grant.Kid]
	if err != nil || !ok || !ed25519.Verify(publicKey, []byte("agentoc-browser-connection-grant-v1\n"+parts[1]), signature) {
		return nil, fmt.Errorf("grant signature invalid")
	}
	now := time.Now().UnixMilli()
	if grant.Version != 1 || grant.Iss != config.issuer || grant.Aud != "instance:"+config.instanceID ||
		grant.InstanceID != config.instanceID {
		return nil, fmt.Errorf("grant binding invalid")
	}
	if grant.AccountID == "" || grant.ClientID == "" || grant.ConnectionID == "" || grant.JTI == "" ||
		grant.Sub != "account:"+grant.AccountID || len(grant.Permissions) == 0 {
		return nil, fmt.Errorf("grant claims incomplete")
	}
	if grant.EphemeralPublicKey.Kty != "EC" || grant.EphemeralPublicKey.Alg != "P-256" ||
		grant.EphemeralPublicKey.Crv != "P-256" || grant.EphemeralPublicKey.X == "" || grant.EphemeralPublicKey.Y == "" {
		return nil, fmt.Errorf("grant ephemeral key invalid")
	}
	if grant.NBF > now {
		return nil, fmt.Errorf("grant not yet valid")
	}
	if grant.EXP <= now || grant.EXP <= grant.NBF {
		return nil, fmt.Errorf("grant expired")
	}
	return &grant, nil
}

func (config *browserAuthConfig) consumeGrant(jti string, expiresAt int64) bool {
	now := time.Now().UnixMilli()
	config.mu.Lock()
	defer config.mu.Unlock()
	for key, expiry := range config.replayed {
		if expiry <= now {
			delete(config.replayed, key)
		}
	}
	if _, exists := config.replayed[jti]; exists || expiresAt <= now {
		return false
	}
	for len(config.replayed) >= browserAuthReplayLimit {
		for oldest := range config.replayed {
			delete(config.replayed, oldest)
			break
		}
	}
	config.replayed[jti] = expiresAt
	return true
}

func verifyBrowserProof(grant *browserGrant, nonce, encodedSignature string) error {
	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil || len(signature) != 64 {
		return fmt.Errorf("browser proof encoding invalid")
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(grant.EphemeralPublicKey.X)
	if err != nil {
		return fmt.Errorf("browser proof public key invalid")
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(grant.EphemeralPublicKey.Y)
	if err != nil {
		return fmt.Errorf("browser proof public key invalid")
	}
	if len(xBytes) != 32 || len(yBytes) != 32 {
		return fmt.Errorf("browser proof public key invalid")
	}
	publicX, publicY := elliptic.Unmarshal(elliptic.P256(), append([]byte{4}, append(xBytes, yBytes...)...))
	if publicX == nil || publicY == nil {
		return fmt.Errorf("browser proof public key invalid")
	}
	publicKey := ecdsa.PublicKey{Curve: elliptic.P256(), X: publicX, Y: publicY}
	hash := sha256.Sum256([]byte(strings.Join([]string{
		"agentoc-browser-auth-v1", grant.ConnectionID, grant.InstanceID, grant.JTI, nonce,
	}, "\n")))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(&publicKey, hash[:], r, s) {
		return fmt.Errorf("browser proof rejected")
	}
	return nil
}

func hashGrantJTI(jti string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(jti)))[:12]
}

func (config *browserAuthConfig) authenticateInit(token string) (*browserGrant, string, error) {
	grant, err := verifyBrowserGrantToken(token, config)
	if err != nil {
		return nil, "", err
	}
	nonceBytes := make([]byte, 24)
	if _, err := cryptorand.Read(nonceBytes); err != nil {
		return nil, "", fmt.Errorf("challenge nonce generation failed")
	}
	return grant, base64.RawURLEncoding.EncodeToString(nonceBytes), nil
}

func (config *browserAuthConfig) authenticateProof(grant *browserGrant, nonce, signature string) (*browserPrincipal, error) {
	if err := verifyBrowserProof(grant, nonce, signature); err != nil {
		return nil, err
	}
	if !config.consumeGrant(grant.JTI, grant.EXP) {
		return nil, fmt.Errorf("grant replayed")
	}
	permissions := append([]string(nil), grant.Permissions...)
	return &browserPrincipal{
		AccountID: grant.AccountID, InstanceID: grant.InstanceID, ClientID: grant.ClientID,
		ConnectionID: grant.ConnectionID, GrantJTI: grant.JTI, Permissions: permissions,
	}, nil
}

func browserAuthMustGate(phase, messageType string) bool {
	return phase != "AUTHENTICATED" && (messageType == "http_request" ||
		strings.HasPrefix(messageType, "http_request_stream_"))
}

type httpResponse struct {
	ID         string            `json:"id"`
	Type       string            `json:"type"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers,omitempty"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
	Error      string            `json:"error,omitempty"`
}

var outputMu sync.Mutex

func emit(value any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	encoded, _ := json.Marshal(value)
	fmt.Println(string(encoded))
}

// peerConnectionConfiguration makes the network boundary explicit. Account
// device bootstraps are TURN-only: offering host or reflexive candidates on
// just one side lets ICE select a route the Android client is forbidden to
// use. Local/developer callers can explicitly select the all-candidate policy.
func peerConnectionConfiguration(iceServers []webrtc.ICEServer, relayOnly bool) webrtc.Configuration {
	config := webrtc.Configuration{ICEServers: iceServers}
	if relayOnly {
		config.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	return config
}

// Older agents supply a TURN-only server list but do not forward the policy
// flag. Keep those connections on TURN as well. An explicit 0 preserves the
// local/developer caller's all-candidate choice; an absent STUN configuration
// keeps its previous behavior.
func relayOnlyPolicy(iceServers []webrtc.ICEServer, flag string) (bool, error) {
	if flag == "1" {
		return true, nil
	}
	if flag == "0" {
		return false, nil
	}
	if flag != "" {
		return false, fmt.Errorf("AGENTOC_P2P_RELAY_ONLY is invalid")
	}
	hasURL := false
	for _, server := range iceServers {
		for _, value := range server.URLs {
			hasURL = true
			value = strings.ToLower(strings.TrimSpace(value))
			if !strings.HasPrefix(value, "turn:") && !strings.HasPrefix(value, "turns:") {
				return false, nil
			}
		}
	}
	return hasURL, nil
}

// Deterministic DataChannel fault injection (env-gated, off by default). These
// simulate packet loss / high latency on the WebRTC DataChannel path from the
// client's perspective: a dropped request is never answered (client times out);
// a delayed response arrives late.
type faultConfig struct {
	dropRate   float64 // [0,1] probabilistic drop rate
	dropFirstN int64   // deterministically drop the first N requests
	delayMs    int     // delay each response by this many ms
}

var (
	fault     = parseFaultConfig()
	dropCount atomic.Int64
)

func parseFaultConfig() faultConfig {
	cfg := faultConfig{}
	if v := os.Getenv("AGENTOC_P2P_FAULT_DROP_RATE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 && f <= 1 {
			cfg.dropRate = f
		}
	}
	if v := os.Getenv("AGENTOC_P2P_FAULT_DROP_FIRST_N"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			cfg.dropFirstN = n
		}
	}
	if v := os.Getenv("AGENTOC_P2P_FAULT_DELAY_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.delayMs = n
		}
	}
	return cfg
}

// shouldDrop reports whether this inbound request should be dropped (simulating
// DataChannel packet loss). Thread-safe via atomic counter.
func (f *faultConfig) shouldDrop() bool {
	if f.dropFirstN > 0 {
		n := dropCount.Add(1)
		if n <= f.dropFirstN {
			return true
		}
	}
	if f.dropRate > 0 && rand.Float64() < f.dropRate {
		return true
	}
	return false
}

func proxyRequest(localBase string, request httpRequest, principals ...*browserPrincipal) httpResponse {
	return proxyRequestBody(localBase, request, nil, -1, principals...)
}

func proxyRequestBody(localBase string, request httpRequest, streamedBody io.Reader, streamedLength int64,
	principals ...*browserPrincipal) httpResponse {
	var principal *browserPrincipal
	if len(principals) > 0 {
		principal = principals[0]
	}
	method := strings.ToUpper(strings.TrimSpace(request.Method))
	if method == "" {
		method = http.MethodGet
	}
	path := request.Path
	if !strings.HasPrefix(path, "/") {
		return httpResponse{ID: request.ID, Type: "http_response", Error: "invalid path"}
	}
	var body io.Reader
	contentLength := int64(-1)
	if streamedBody != nil {
		if streamedLength < 0 || streamedLength > maxRequestBodyBytes {
			return httpResponse{ID: request.ID, Type: "http_response", Error: "invalid streamed request body"}
		}
		body = streamedBody
		contentLength = streamedLength
	} else {
		decoded, err := base64.StdEncoding.DecodeString(request.BodyBase64)
		if err != nil || len(decoded) > maxRequestBodyBytes {
			return httpResponse{ID: request.ID, Type: "http_response", Error: "invalid request body"}
		}
		body = bytes.NewReader(decoded)
		contentLength = int64(len(decoded))
	}
	req, err := http.NewRequest(method, strings.TrimRight(localBase, "/")+path, body)
	if err != nil {
		return httpResponse{ID: request.ID, Type: "http_response", Error: err.Error()}
	}
	req.ContentLength = contentLength
	for key, value := range request.Headers {
		lower := strings.ToLower(key)
		if lower == "host" || lower == "connection" || lower == "upgrade" ||
			(principal != nil && (lower == "authorization" || strings.HasPrefix(lower, "x-agentoc-browser-"))) {
			continue
		}
		req.Header.Set(key, value)
	}
	if principal != nil {
		req.Header.Set("X-AgentoC-Browser-Principal", "browser")
		req.Header.Set("X-AgentoC-Browser-Account-Id", principal.AccountID)
		req.Header.Set("X-AgentoC-Browser-Instance-Id", principal.InstanceID)
		req.Header.Set("X-AgentoC-Browser-Client-Id", principal.ClientID)
		req.Header.Set("X-AgentoC-Browser-Connection-Id", principal.ConnectionID)
		req.Header.Set("X-AgentoC-Browser-Grant-Jti", principal.GrantJTI)
		req.Header.Set("X-AgentoC-Browser-Permissions", strings.Join(principal.Permissions, ","))
	}
	isUploadChunk := method == http.MethodPatch && strings.HasPrefix(path, "/api/assets/fasset_") && strings.HasSuffix(path, "/upload")
	isUploadCheckpoint := method == http.MethodGet && strings.HasPrefix(path, "/api/assets/fasset_") && strings.HasSuffix(path, "/upload-checkpoint")
	timeout := 60 * time.Second
	if isUploadChunk {
		// Exceed the control server's 150-second chunk deadline while staying
		// below the carrier's 180-second deadline, leaving time for a response.
		timeout = 165 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(req)
	if err != nil {
		if isUploadChunk || isUploadCheckpoint {
			if errors.Is(err, context.DeadlineExceeded) {
				return httpResponse{ID: request.ID, Type: "http_response", Error: "asset_upload_local_timeout"}
			}
			return httpResponse{ID: request.ID, Type: "http_response", Error: "asset_upload_local_transport"}
		}
		return httpResponse{ID: request.ID, Type: "http_response", Error: err.Error()}
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxResponseBodyBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil || len(responseBody) > maxResponseBodyBytes {
		return httpResponse{ID: request.ID, Type: "http_response", Error: "response body too large"}
	}
	headers := map[string]string{}
	for key, values := range response.Header {
		if len(values) > 0 {
			headers[key] = values[0]
		}
	}
	return httpResponse{ID: request.ID, Type: "http_response", Status: response.StatusCode, Headers: headers, BodyBase64: base64.StdEncoding.EncodeToString(responseBody)}
}

func main() {
	localBase := os.Getenv("AGENTOC_P2P_LOCAL_BASE_URL")
	if localBase == "" {
		localBase = "http://127.0.0.1:7690"
	}
	stunURL := os.Getenv("AGENTOC_P2P_STUN_URL")
	if stunURL == "" {
		stunURL = "stun:stun.l.google.com:19302"
	}

	iceServers := []webrtc.ICEServer{{URLs: []string{stunURL}}}
	if encoded := os.Getenv("AGENTOC_P2P_ICE_SERVERS_JSON"); encoded != "" {
		var configured []iceServerConfig
		if err := json.Unmarshal([]byte(encoded), &configured); err != nil || len(configured) == 0 {
			panic("AGENTOC_P2P_ICE_SERVERS_JSON is invalid")
		}
		iceServers = make([]webrtc.ICEServer, 0, len(configured))
		for _, server := range configured {
			if len(server.URLs) == 0 {
				panic("configured ICE server has no URLs")
			}
			iceServers = append(iceServers, webrtc.ICEServer{URLs: server.URLs, Username: server.Username, Credential: server.Credential})
		}
	}
	// Current agents forward the policy explicitly. Legacy agents already
	// supply the broker's TURN-only list, which also requires relay-only ICE.
	relayOnly, err := relayOnlyPolicy(iceServers, os.Getenv("AGENTOC_P2P_RELAY_ONLY"))
	if err != nil {
		panic(err)
	}
	config := peerConnectionConfiguration(iceServers, relayOnly)
	browserAuth, err := loadBrowserAuthConfig()
	if err != nil {
		panic(err)
	}
	// A mobile app restart creates a new SDP offer. A Pion PeerConnection is
	// deliberately single-negotiation in this host: it cannot safely accept a
	// new remote offer after its previous data channel has closed. Keep the
	// current peer replaceable so reconnecting the app never leaves the host
	// adding fresh ICE candidates to a stale, closed connection.
	var peer *webrtc.PeerConnection
	var peerGeneration atomic.Uint64
	createPeer := func() (*webrtc.PeerConnection, error) {
		createdPeer, err := webrtc.NewPeerConnection(config)
		if err != nil {
			return nil, err
		}
		generation := peerGeneration.Add(1)
		isCurrentPeer := func() bool { return peerGeneration.Load() == generation }
		var activeChannels atomic.Int32

		createdPeer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			if !isCurrentPeer() {
				return
			}
			if candidate == nil {
				emit(controlMessage{Type: "ice_complete"})
				return
			}
			value := candidate.ToJSON()
			emit(controlMessage{Type: "candidate", Candidate: value.Candidate, SDPMid: value.SDPMid, SDPMLineIndex: value.SDPMLineIndex})
		})
		createdPeer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			if isCurrentPeer() {
				emit(map[string]any{"type": "state", "state": state.String()})
			}
		})
		createdPeer.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
			if isCurrentPeer() {
				fmt.Fprintf(os.Stderr, "[p2p-host] ice_connection_state=%s\n", state.String())
			}
		})
		createdPeer.OnDataChannel(func(channel *webrtc.DataChannel) {
			if !isCurrentPeer() {
				_ = channel.Close()
				return
			}
			// Bound per-peer stream assemblers even when a peer opens channels
			// with arbitrary labels. Two channels are normally used; extra slots
			// allow a bulk channel to reconnect while its predecessor closes.
			if activeChannels.Add(1) > 4 {
				activeChannels.Add(-1)
				_ = channel.Close()
				return
			}
			authSession := &browserAuthSession{phase: "AUTHENTICATING"}
			streamAssembler := newRequestStreamAssembler()
			bodyStreamAssembler := newRequestBodyStreamAssembler()
			responseSender := newResponseSender(channel, isCurrentPeer)
			channel.OnClose(func() { streamAssembler.close(); bodyStreamAssembler.close(); activeChannels.Add(-1) })
			if browserAuth != nil {
				fmt.Fprintf(os.Stderr, "browser_auth event=datachannel_open state=AUTHENTICATING\n")
				authSession.timer = time.AfterFunc(browserAuthTimeout, func() {
					if !isCurrentPeer() {
						return
					}
					authSession.mu.Lock()
					defer authSession.mu.Unlock()
					if authSession.phase != "AUTHENTICATED" {
						fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=auth_timeout\n")
						_ = channel.Close()
					}
				})
			}
			channel.OnOpen(func() {
				if !isCurrentPeer() {
					return
				}
				emit(map[string]any{"type": "datachannel_open"})
				fmt.Fprintf(os.Stderr, "[p2p-host] datachannel_open label=%s\n", channel.Label())
				ready := map[string]any{"type": "server_ready", "version": 1,
					"features": []string{"http_request_stream_v1", "http_request_stream_v2", "http_request_binary_chunks_v3", "http_response_stream_v1", "http_bulk_channel_v1"}}
				if browserAuth != nil {
					ready["auth"] = "client_auth_v1"
					fmt.Fprintf(os.Stderr, "browser_auth event=auth_challenge_sent state=AUTHENTICATING\n")
				}
				encoded, _ := json.Marshal(ready)
				_ = channel.SendText(string(encoded))
			})
			channel.OnMessage(func(message webrtc.DataChannelMessage) {
				if !isCurrentPeer() {
					return
				}
				fmt.Fprintf(os.Stderr, "[p2p-host] datachannel_message bytes=%d binary=%t\n", len(message.Data), message.IsString == false)
				var frameType struct {
					Type string `json:"type"`
				}
				_ = json.Unmarshal(message.Data, &frameType)
				streamRequestID := ""
				if browserAuth != nil {
					authSession.mu.Lock()
					defer authSession.mu.Unlock()
					authMessage, err := decodeBrowserAuthMessage(message.Data, message.IsString, authSession.phase)
					if err != nil {
						fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=malformed_message\n")
						_ = channel.Close()
						return
					}
					if authSession.phase != "AUTHENTICATED" {
						if browserAuthMustGate(authSession.phase, authMessage.Type) {
							fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=http_before_auth\n")
							_ = channel.Close()
							return
						}
						switch authMessage.Type {
						case "client_auth_init_v1":
							if authMessage.Version != 1 || authMessage.ConnectionGrant == "" || authSession.grant != nil {
								fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=unsupported_or_duplicate_init\n")
								_ = channel.Close()
								return
							}
							grant, nonce, err := browserAuth.authenticateInit(authMessage.ConnectionGrant)
							if err != nil {
								fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=%s\n", err.Error())
								_ = channel.Close()
								return
							}
							authSession.grantToken, authSession.grant, authSession.nonce = authMessage.ConnectionGrant, grant, nonce
							challenge := map[string]any{"type": "server_challenge", "version": 1, "connectionId": grant.ConnectionID, "instanceId": grant.InstanceID, "grantJti": grant.JTI, "serverNonce": nonce}
							encoded, _ := json.Marshal(challenge)
							_ = channel.SendText(string(encoded))
							fmt.Fprintf(os.Stderr, "browser_auth event=auth_challenge_sent connectionId=%s grantJtiPrefix=%s\n", grant.ConnectionID, hashGrantJTI(grant.JTI))
							return
						case "client_auth_v1":
							if authMessage.Version != 1 || authSession.grant == nil || authMessage.ConnectionGrant != authSession.grantToken || authMessage.Proof.Algorithm != "ES256" {
								fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=unsupported_auth_version\n")
								_ = channel.Close()
								return
							}
							principal, err := browserAuth.authenticateProof(authSession.grant, authSession.nonce, authMessage.Proof.Signature)
							if err != nil {
								fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=%s\n", err.Error())
								_ = channel.Close()
								return
							}
							authSession.principal, authSession.phase = principal, "AUTHENTICATED"
							if authSession.timer != nil {
								authSession.timer.Stop()
							}
							_ = channel.SendText(`{"type":"auth_ok","version":1,"principal":{"type":"browser","scope":"remote.read.health"}}`)
							fmt.Fprintf(os.Stderr, "browser_auth event=browser_authenticated connectionId=%s grantJtiPrefix=%s\n", principal.ConnectionID, hashGrantJTI(principal.GrantJTI))
							return
						default:
							fmt.Fprintf(os.Stderr, "browser_auth event=auth_rejected reason=http_before_auth_or_unknown_message\n")
							_ = channel.Close()
							return
						}
					}
				}
				if !message.IsString {
					id, err := bodyStreamAssembler.addBinary(message.Data)
					if err != nil && id != "" {
						encoded, _ := json.Marshal(httpResponse{ID: id, Type: "http_response", Error: "invalid request stream chunk"})
						_ = channel.SendText(string(encoded))
					}
					return
				}
				switch frameType.Type {
				case "http_request_stream_v2_init":
					var frame httpRequestStreamV2Init
					if err := json.Unmarshal(message.Data, &frame); err != nil {
						return
					}
					if err := bodyStreamAssembler.begin(frame); err != nil {
						encoded, _ := json.Marshal(httpResponse{ID: frame.ID, Type: "http_response", Error: "invalid request stream metadata"})
						_ = channel.SendText(string(encoded))
					}
					return
				case "http_request_stream_v2_chunk":
					var frame httpRequestStreamV2Chunk
					if err := json.Unmarshal(message.Data, &frame); err != nil {
						return
					}
					if err := bodyStreamAssembler.add(frame); err != nil {
						encoded, _ := json.Marshal(httpResponse{ID: frame.ID, Type: "http_response", Error: "invalid request stream chunk"})
						_ = channel.SendText(string(encoded))
					}
					return
				case "http_request_stream_v2_abort":
					var frame struct {
						ID string `json:"id"`
					}
					if json.Unmarshal(message.Data, &frame) == nil {
						bodyStreamAssembler.abort(frame.ID)
					}
					return
				case "http_request_stream_v2_end":
					var frame httpRequestStreamV2End
					if err := json.Unmarshal(message.Data, &frame); err != nil {
						return
					}
					request, body, length, err := bodyStreamAssembler.finish(frame)
					if err != nil {
						encoded, _ := json.Marshal(httpResponse{ID: frame.ID, Type: "http_response", Error: "request stream verification failed"})
						_ = channel.SendText(string(encoded))
						return
					}
					if fault.shouldDrop() {
						_ = body.Close()
						return
					}
					go func() {
						defer body.Close()
						var principal *browserPrincipal
						if browserAuth != nil {
							authSession.mu.Lock()
							principal = authSession.principal
							authSession.mu.Unlock()
						}
						response := proxyRequestBody(localBase, request, body, length, principal)
						if fault.delayMs > 0 {
							time.Sleep(time.Duration(fault.delayMs) * time.Millisecond)
						}
						if isCurrentPeer() {
							if err := responseSender.send(request, response); err != nil {
								fmt.Fprintf(os.Stderr, "[p2p-host] response_send_failed category=stream_or_channel\n")
							}
						}
					}()
					return
				}
				if frameType.Type == "http_request_stream_v1" {
					var frame httpRequestStreamFrame
					if err := json.Unmarshal(message.Data, &frame); err != nil {
						return
					}
					payload, complete, err := streamAssembler.add(frame)
					if err != nil {
						encoded, _ := json.Marshal(httpResponse{ID: frame.ID, Type: "http_response", Error: "invalid request stream"})
						_ = channel.SendText(string(encoded))
						return
					}
					if !complete {
						return
					}
					streamRequestID = frame.ID
					message.Data = payload
				}
				var request httpRequest
				if err := json.Unmarshal(message.Data, &request); err != nil || request.Type != "http_request" || request.ID == "" {
					fmt.Fprintf(os.Stderr, "[p2p-host] datachannel_message_decode_failed err=%v type=%s id=%s\n", err, request.Type, request.ID)
					return
				}
				if streamRequestID != "" && request.ID != streamRequestID {
					encoded, _ := json.Marshal(httpResponse{ID: streamRequestID, Type: "http_response", Error: "request stream identity mismatch"})
					_ = channel.SendText(string(encoded))
					return
				}
				fmt.Fprintf(os.Stderr, "[p2p-host] http_request id=%s method=%s path=%s\n", request.ID, request.Method, request.Path)
				if fault.shouldDrop() {
					// Simulate DataChannel packet loss: the request is never answered.
					return
				}
				go func() {
					var principal *browserPrincipal
					if browserAuth != nil {
						authSession.mu.Lock()
						principal = authSession.principal
						authSession.mu.Unlock()
					}
					response := proxyRequest(localBase, request, principal)
					fmt.Fprintf(os.Stderr, "[p2p-host] http_response id=%s status=%d error=%s\n", response.ID, response.Status, response.Error)
					if fault.delayMs > 0 {
						time.Sleep(time.Duration(fault.delayMs) * time.Millisecond)
					}
					if isCurrentPeer() {
						if err := responseSender.send(request, response); err != nil {
							fmt.Fprintf(os.Stderr, "[p2p-host] response_send_failed category=stream_or_channel\n")
						}
					}
				}()
			})
		})
		return createdPeer, nil
	}
	defer func() {
		peerGeneration.Add(1)
		if peer != nil {
			_ = peer.Close()
		}
	}()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	for scanner.Scan() {
		var message controlMessage
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		switch message.Type {
		case "offer":
			// A new offer always starts a new P2P session. Incrementing the
			// generation before closing the old peer prevents delayed callbacks
			// (notably stale ICE candidates) from being sent to the new mobile
			// session.
			nextPeer, err := createPeer()
			if err != nil {
				fmt.Fprintf(os.Stderr, "[p2p-host] peer rebuild failed err=%v\n", err)
				continue
			}
			previousPeer := peer
			peer = nextPeer
			if previousPeer != nil {
				_ = previousPeer.Close()
			}
			if peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: message.SDP}) != nil {
				_ = peer.Close()
				peer = nil
				peerGeneration.Add(1)
				continue
			}
			answer, err := peer.CreateAnswer(nil)
			if err != nil {
				continue
			}
			if peer.SetLocalDescription(answer) != nil {
				continue
			}
			emit(controlMessage{Type: "answer", SDP: answer.SDP})
		case "candidate":
			if peer != nil {
				if err := peer.AddICECandidate(webrtc.ICECandidateInit{Candidate: message.Candidate, SDPMid: message.SDPMid, SDPMLineIndex: message.SDPMLineIndex}); err != nil {
					fmt.Fprintf(os.Stderr, "[p2p-host] AddICECandidate error: %v\n", err)
				}
			}
		}
	}
}
