package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestPeerConnectionConfigurationRelayOnly(t *testing.T) {
	servers := []webrtc.ICEServer{{URLs: []string{"turn:turn.example.test:3478?transport=udp"}}}

	relayOnly := peerConnectionConfiguration(servers, true)
	if relayOnly.ICETransportPolicy != webrtc.ICETransportPolicyRelay {
		t.Fatalf("relay-only configuration has policy %q", relayOnly.ICETransportPolicy.String())
	}
	if len(relayOnly.ICEServers) != 1 || relayOnly.ICEServers[0].URLs[0] != servers[0].URLs[0] {
		t.Fatalf("relay-only configuration lost the configured TURN server: %#v", relayOnly.ICEServers)
	}

	local := peerConnectionConfiguration(servers, false)
	if local.ICETransportPolicy != webrtc.ICETransportPolicyAll {
		t.Fatalf("local configuration unexpectedly has policy %q", local.ICETransportPolicy.String())
	}
}

func TestLegacyTurnPolicy(t *testing.T) {
	turn := []webrtc.ICEServer{{URLs: []string{"turn:127.0.0.1:3478?transport=udp", "turns:127.0.0.1:5349"}}}
	stun := []webrtc.ICEServer{{URLs: []string{"stun:127.0.0.1:3478"}}}
	for _, test := range []struct {
		name    string
		servers []webrtc.ICEServer
		flag    string
		want    bool
	}{
		{"legacy-turn-list", turn, "", true},
		{"explicit-local-turn", turn, "0", false},
		{"explicit-device-turn", turn, "1", true},
		{"legacy-local-stun", stun, "", false},
		{"legacy-mixed-local", append(stun, turn...), "", false},
		{"legacy-empty", nil, "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual, err := relayOnlyPolicy(test.servers, test.flag)
			if err != nil || actual != test.want {
				t.Fatalf("relay policy = %v, %v; want %v", actual, err, test.want)
			}
		})
	}
	if _, err := relayOnlyPolicy(turn, "invalid"); err == nil {
		t.Fatal("invalid policy must not silently enable direct candidates")
	}
}

// TestLiveTurnRelayProbe is an opt-in production acceptance probe. The caller
// injects a freshly issued ICE-server JSON array only through the process
// environment; this test deliberately reports candidate counts, never URLs,
// addresses, usernames, or credentials. It is skipped in normal unit runs.
func TestLiveTurnRelayProbe(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("RAGENT_TURN_PROBE_ICE_SERVERS_JSON"))
	if raw == "" {
		t.Skip("RAGENT_TURN_PROBE_ICE_SERVERS_JSON is not set")
	}
	var configured []iceServerConfig
	if err := json.Unmarshal([]byte(raw), &configured); err != nil || len(configured) == 0 {
		t.Fatal("live TURN probe received invalid ICE configuration")
	}
	iceServers := make([]webrtc.ICEServer, 0, len(configured))
	for _, server := range configured {
		if len(server.URLs) == 0 || strings.TrimSpace(server.Username) == "" || strings.TrimSpace(server.Credential) == "" {
			t.Fatal("live TURN probe received incomplete ICE configuration")
		}
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs: server.URLs, Username: server.Username, Credential: server.Credential,
		})
	}

	peer, err := webrtc.NewPeerConnection(peerConnectionConfiguration(iceServers, true))
	if err != nil {
		t.Fatalf("live TURN probe could not create a relay-only peer: %v", err)
	}
	defer peer.Close()
	if _, err = peer.CreateDataChannel("turn-probe", nil); err != nil {
		t.Fatalf("live TURN probe could not create a data channel: %v", err)
	}

	candidates := make(chan string, 16)
	gatheringComplete := make(chan struct{})
	var completeOnce sync.Once
	peer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			completeOnce.Do(func() { close(gatheringComplete) })
			return
		}
		candidates <- candidate.ToJSON().Candidate
	})
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("live TURN probe could not create an offer: %v", err)
	}
	if err = peer.SetLocalDescription(offer); err != nil {
		t.Fatalf("live TURN probe could not set its local offer: %v", err)
	}
	select {
	case <-gatheringComplete:
	case <-time.After(20 * time.Second):
		t.Fatal("live TURN probe timed out waiting for ICE gathering")
	}
	close(candidates)
	total := 0
	relay := 0
	for candidate := range candidates {
		total++
		if strings.Contains(strings.ToLower(candidate), " typ relay ") {
			relay++
		}
	}
	if total == 0 || relay != total {
		t.Fatalf("live TURN probe failed: relay_candidates=%d total_candidates=%d", relay, total)
	}
	t.Logf("live TURN probe succeeded: relay_candidates=%d", relay)
}

func TestProxyRequestPreservesBinaryBody(t *testing.T) {
	expected := []byte{0, 1, 2, 0xff}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != string(expected) {
			t.Fatalf("unexpected body: %v", body)
		}
		response.Header().Set("X-P2P-Test", "ok")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte("accepted"))
	}))
	defer server.Close()

	result := proxyRequest(server.URL, httpRequest{
		ID:         "request-1",
		Type:       "http_request",
		Method:     http.MethodPost,
		Path:       "/upload",
		BodyBase64: base64.StdEncoding.EncodeToString(expected),
	})
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if result.Status != http.StatusCreated {
		t.Fatalf("unexpected status: %d", result.Status)
	}
	if result.Headers["X-P2p-Test"] != "ok" {
		t.Fatalf("unexpected headers: %#v", result.Headers)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.BodyBase64)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != "accepted" {
		t.Fatalf("unexpected response body: %q", decoded)
	}
}

func TestProxyRequestAcceptsUploadAboveLegacyEightMiBLimit(t *testing.T) {
	want := bytes.Repeat([]byte{0x5a}, 9<<20)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if len(body) != len(want) || !bytes.Equal(body, want) {
			t.Fatalf("request body mismatch: got %d bytes, want %d", len(body), len(want))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	result := proxyRequest(server.URL, httpRequest{
		ID: "large_upload_1", Type: "http_request", Method: http.MethodPost,
		Path: "/upload", BodyBase64: base64.StdEncoding.EncodeToString(want),
	})
	if result.Error != "" || result.Status != http.StatusNoContent {
		t.Fatalf("large request failed: status=%d error=%q", result.Status, result.Error)
	}
}

func TestProxyRequestBodyStreamsBinaryBodyWithDeclaredLength(t *testing.T) {
	want := bytes.Repeat([]byte{0x6b}, 9<<20)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.ContentLength != int64(len(want)) {
			t.Errorf("unexpected content length: got %d want %d", request.ContentLength, len(want))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(body, want) {
			t.Errorf("streamed request body did not match: got %d bytes, want %d", len(body), len(want))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	request := httpRequest{ID: "streamed_upload_1", Type: "http_request", Method: http.MethodPost,
		Path: "/upload", Headers: map[string]string{"Content-Type": "application/octet-stream"}}
	result := proxyRequestBody(server.URL, request, bytes.NewReader(want), int64(len(want)))
	if result.Error != "" || result.Status != http.StatusNoContent {
		t.Fatalf("streamed request failed: status=%d error=%q", result.Status, result.Error)
	}
}

func TestProxyRequestRejectsBodyAboveTwentyFiveMiBLimit(t *testing.T) {
	tooLarge := bytes.Repeat([]byte{0x2a}, maxRequestBodyBytes+1)
	result := proxyRequest("http://127.0.0.1:1", httpRequest{
		ID: "oversized_upload_1", Type: "http_request", Method: http.MethodPost,
		Path: "/upload", BodyBase64: base64.StdEncoding.EncodeToString(tooLarge),
	})
	if result.Error != "invalid request body" {
		t.Fatalf("oversized body was not rejected: %#v", result)
	}
}
