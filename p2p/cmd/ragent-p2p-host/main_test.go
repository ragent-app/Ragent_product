package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/turn/v5"
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

func TestServerReadyIncludesKeepaliveFeature(t *testing.T) {
	features := serverReadyFeatures()
	if !slices.Contains(features, "dc_keepalive_v1") {
		t.Fatalf("serverReadyFeatures() missing dc_keepalive_v1: %#v", features)
	}
}

func TestServerReadyIncludesHttpBgChannelFeature(t *testing.T) {
	features := serverReadyFeatures()
	if !slices.Contains(features, "http_bg_channel_v1") {
		t.Fatalf("serverReadyFeatures() missing http_bg_channel_v1: %#v", features)
	}
}

func TestHandleKeepalivePing(t *testing.T) {
	var sent []string
	handled, err := handleKeepalivePing([]byte(`{"type":"dc_ping","id":"probe-42"}`), func(msg string) error {
		sent = append(sent, msg)
		return nil
	})
	if err != nil || !handled {
		t.Fatalf("expected handled dc_ping without error, got handled=%v err=%v", handled, err)
	}
	if len(sent) != 1 {
		t.Fatalf("expected 1 pong frame, got %d", len(sent))
	}
	var pong dcKeepaliveFrame
	if err := json.Unmarshal([]byte(sent[0]), &pong); err != nil {
		t.Fatalf("invalid dc_pong JSON: %v", err)
	}
	if pong.Type != "dc_pong" || pong.ID != "probe-42" {
		t.Fatalf("unexpected dc_pong frame: %#v", pong)
	}

	// Empty id must be consumed without hitting HTTP proxy or emitting an empty pong.
	sent = nil
	handled, err = handleKeepalivePing([]byte(`{"type":"dc_ping","id":""}`), func(msg string) error {
		sent = append(sent, msg)
		return nil
	})
	if err != nil || !handled || len(sent) != 0 {
		t.Fatalf("empty dc_ping id should be consumed silently, got handled=%v err=%v sent=%v", handled, err, sent)
	}

	// Non-ping messages fall through cleanly.
	handled, err = handleKeepalivePing([]byte(`{"type":"http_request","id":"r1"}`), func(msg string) error {
		sent = append(sent, msg)
		return nil
	})
	if err != nil || handled || len(sent) != 0 {
		t.Fatalf("non-ping should not be handled by keepalive, got handled=%v err=%v sent=%v", handled, err, sent)
	}
}

func TestKeepalivePingPongOverDataChannel(t *testing.T) {
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	client, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	host, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	httpCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	host.OnDataChannel(func(ch *webrtc.DataChannel) {
		ch.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				if handled, _ := handleKeepalivePing(msg.Data, ch.SendText); handled {
					return
				}
			}
			t.Errorf("unexpected non-keepalive message reached fallback: %s", string(msg.Data))
		})
	})

	dc, err := client.CreateDataChannel("ragent-http", nil)
	if err != nil {
		t.Fatal(err)
	}
	replies := make(chan []byte, 4)
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		replies <- append([]byte(nil), msg.Data...)
	})
	sendErr := make(chan error, 1)
	dc.OnOpen(func() {
		sendErr <- dc.SendText(`{"type":"dc_ping","id":"dc-keepalive-1"}`)
	})

	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherClient := webrtc.GatheringCompletePromise(client)
	if err = client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherClient:
	case <-time.After(10 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	if err = host.SetRemoteDescription(*client.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := host.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherHost := webrtc.GatheringCompletePromise(host)
	if err = host.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherHost:
	case <-time.After(10 * time.Second):
		t.Fatal("host ICE gathering timed out")
	}
	if err = client.SetRemoteDescription(*host.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("dc_ping was not sent")
	}
	select {
	case raw := <-replies:
		var pong dcKeepaliveFrame
		if err := json.Unmarshal(raw, &pong); err != nil {
			t.Fatal(err)
		}
		if pong.Type != "dc_pong" || pong.ID != "dc-keepalive-1" {
			t.Fatalf("unexpected dc_pong reply: %#v", pong)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for dc_pong")
	}
	if httpCalls != 0 {
		t.Fatalf("keepalive ping must not hit local HTTP server, got %d calls", httpCalls)
	}
}

func TestThreeDataChannelsConcurrentAndChannelLimit(t *testing.T) {
	bgWaitStarted := make(chan struct{})
	releaseBgWait := make(chan struct{})
	var closeBgWait sync.Once
	defer closeBgWait.Do(func() { close(releaseBgWait) })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events/wait":
			close(bgWaitStarted)
			<-releaseBgWait
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"events":[{"seq":1}]}`))
		case "/api/runtime/summary":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"summary":"ok"}`))
		case "/api/sessions/history":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"history":"` + strings.Repeat("h", 60000) + `"}`))
		case "/api/projects/prj_1":
			if r.Method != http.MethodDelete {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"deleted":true,"id":"prj_1"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	client, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	host, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	var activeChannels atomic.Int32
	host.OnDataChannel(func(channel *webrtc.DataChannel) {
		attachDataChannel(channel, server.URL, nil, &activeChannels, func() bool { return true }, nil)
	})

	type channelInbox struct {
		dc    *webrtc.DataChannel
		ready chan []string
		msgs  chan []byte
		open  chan struct{}
	}
	openInbox := func(label string) *channelInbox {
		t.Helper()
		dc, err := client.CreateDataChannel(label, nil)
		if err != nil {
			t.Fatal(err)
		}
		inbox := &channelInbox{
			dc:    dc,
			ready: make(chan []string, 1),
			msgs:  make(chan []byte, 64),
			open:  make(chan struct{}),
		}
		var openOnce sync.Once
		dc.OnOpen(func() { openOnce.Do(func() { close(inbox.open) }) })
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			var envelope struct {
				Type     string   `json:"type"`
				Features []string `json:"features"`
			}
			if json.Unmarshal(msg.Data, &envelope) == nil && envelope.Type == "server_ready" {
				inbox.ready <- envelope.Features
				return
			}
			inbox.msgs <- append([]byte(nil), msg.Data...)
		})
		return inbox
	}

	interactive := openInbox("ragent-http")
	bulk := openInbox("ragent-http-bulk")
	bg := openInbox("ragent-http-bg")
	extra1 := openInbox("extra-4")
	extra2 := openInbox("extra-5")
	extra3 := openInbox("extra-6")

	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherClient := webrtc.GatheringCompletePromise(client)
	if err = client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherClient:
	case <-time.After(10 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	if err = host.SetRemoteDescription(*client.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := host.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherHost := webrtc.GatheringCompletePromise(host)
	if err = host.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherHost:
	case <-time.After(10 * time.Second):
		t.Fatal("host ICE gathering timed out")
	}
	if err = client.SetRemoteDescription(*host.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	for name, inbox := range map[string]*channelInbox{
		"ragent-http":      interactive,
		"ragent-http-bulk": bulk,
		"ragent-http-bg":   bg,
		"extra-4":          extra1,
		"extra-5":          extra2,
		"extra-6":          extra3,
	} {
		select {
		case <-inbox.open:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not open", name)
		}
		select {
		case features := <-inbox.ready:
			if !slices.Contains(features, "http_bg_channel_v1") {
				t.Fatalf("%s server_ready missing http_bg_channel_v1: %#v", name, features)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not receive server_ready", name)
		}
	}
	if got := activeChannels.Load(); got != maxActiveDataChannels {
		t.Fatalf("activeChannels = %d, want %d", got, maxActiveDataChannels)
	}

	// Opening a 7th DataChannel must exceed maxActiveDataChannels (6) and be closed cleanly.
	rejectedDC, err := client.CreateDataChannel("extra-7-rejected", nil)
	if err != nil {
		t.Fatal(err)
	}
	rejectedClosed := make(chan struct{})
	var rejectedCloseOnce sync.Once
	rejectedDC.OnClose(func() { rejectedCloseOnce.Do(func() { close(rejectedClosed) }) })
	select {
	case <-rejectedClosed:
	case <-time.After(10 * time.Second):
		t.Fatal("7th DataChannel was not closed by activeChannels limit")
	}
	if got := activeChannels.Load(); got != maxActiveDataChannels {
		t.Fatalf("activeChannels after 7th channel rejection = %d, want %d", got, maxActiveDataChannels)
	}

	// Start a blocking long-poll on ragent-http-bg first.
	if err := bg.dc.SendText(`{"id":"bg-wait","type":"http_request","method":"GET","path":"/events/wait?liveOnly=1"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-bgWaitStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("background long-poll request never reached HTTP server")
	}

	// While ragent-http-bg has a blocked request, concurrent interactive, bulk, and a second bg request must finish.
	if err := interactive.dc.SendText(`{"id":"int-del","type":"http_request","method":"DELETE","path":"/api/projects/prj_1"}`); err != nil {
		t.Fatal(err)
	}
	if err := bulk.dc.SendText(`{"id":"bulk-hist","type":"http_request","method":"GET","path":"/api/sessions/history","acceptResponseStream":true}`); err != nil {
		t.Fatal(err)
	}
	if err := bg.dc.SendText(`{"id":"bg-summary","type":"http_request","method":"GET","path":"/api/runtime/summary"}`); err != nil {
		t.Fatal(err)
	}

	readHTTPResponse := func(ch <-chan []byte) httpResponse {
		t.Helper()
		var streamBuf []byte
		nextIdx := 0
		deadline := time.After(15 * time.Second)
		for {
			select {
			case raw := <-ch:
				var envelope struct {
					Type string `json:"type"`
				}
				if err := json.Unmarshal(raw, &envelope); err != nil {
					t.Fatal(err)
				}
				if envelope.Type == "http_response" {
					var resp httpResponse
					if err := json.Unmarshal(raw, &resp); err != nil {
						t.Fatal(err)
					}
					return resp
				}
				var frame httpResponseStreamFrame
				if err := json.Unmarshal(raw, &frame); err != nil {
					t.Fatal(err)
				}
				if frame.Index != nextIdx {
					t.Fatalf("out-of-order response stream frame: got %d want %d", frame.Index, nextIdx)
				}
				chunk, err := base64.StdEncoding.DecodeString(frame.DataBase64)
				if err != nil {
					t.Fatal(err)
				}
				streamBuf = append(streamBuf, chunk...)
				nextIdx++
				if len(streamBuf) == frame.TotalBytes {
					var resp httpResponse
					if err := json.Unmarshal(streamBuf, &resp); err != nil {
						t.Fatal(err)
					}
					return resp
				}
			case <-deadline:
				t.Fatal("timed out waiting for HTTP response over DataChannel")
			}
		}
	}

	intResp := readHTTPResponse(interactive.msgs)
	if intResp.ID != "int-del" || intResp.Status != http.StatusOK {
		t.Fatalf("unexpected interactive response: %#v", intResp)
	}
	bulkResp := readHTTPResponse(bulk.msgs)
	if bulkResp.ID != "bulk-hist" || bulkResp.Status != http.StatusOK {
		t.Fatalf("unexpected bulk response: %#v", bulkResp)
	}
	bgSummaryResp := readHTTPResponse(bg.msgs)
	if bgSummaryResp.ID != "bg-summary" || bgSummaryResp.Status != http.StatusOK {
		t.Fatalf("unexpected bg summary response: %#v", bgSummaryResp)
	}

	// Now unblock /events/wait and verify it finishes on ragent-http-bg.
	closeBgWait.Do(func() { close(releaseBgWait) })
	bgWaitResp := readHTTPResponse(bg.msgs)
	if bgWaitResp.ID != "bg-wait" || bgWaitResp.Status != http.StatusOK {
		t.Fatalf("unexpected bg long-poll response: %#v", bgWaitResp)
	}
}

type stubPushChannel struct {
	readyState     webrtc.DataChannelState
	bufferedAmount uint64
	sent           []string
}

func (c *stubPushChannel) SendText(s string) error {
	c.sent = append(c.sent, s)
	return nil
}

func (c *stubPushChannel) BufferedAmount() uint64 {
	return c.bufferedAmount
}

func (c *stubPushChannel) ReadyState() webrtc.DataChannelState {
	return c.readyState
}

func TestServerReadyPushInvalidationFeatureAndBrowserAuthExclusion(t *testing.T) {
	features := serverReadyFeatures()
	if !slices.Contains(features, "dc_push_invalidation_v1") {
		t.Fatalf("serverReadyFeatures() missing dc_push_invalidation_v1: %#v", features)
	}
	trustedFeatures := serverReadyFeatures(nil)
	if !slices.Contains(trustedFeatures, "dc_push_invalidation_v1") {
		t.Fatalf("serverReadyFeatures(nil) missing dc_push_invalidation_v1: %#v", trustedFeatures)
	}
	browserFeatures := serverReadyFeatures(&browserAuthConfig{})
	if slices.Contains(browserFeatures, "dc_push_invalidation_v1") {
		t.Fatalf("serverReadyFeatures(browserAuth) must not advertise dc_push_invalidation_v1: %#v", browserFeatures)
	}
}

func TestPushInvalidationBackpressureAndBrowserAuthGating(t *testing.T) {
	ch := &stubPushChannel{
		readyState:     webrtc.DataChannelStateOpen,
		bufferedAmount: maxResponseBufferedBytes + 1,
	}
	sender := newResponseSender(ch, func() bool { return true })
	if sender.trySendPush([]byte(`{"type":"dc_push_v1","payload":{"type":"sessions_invalidated"}}`)) {
		t.Fatal("trySendPush must drop when BufferedAmount exceeds maxResponseBufferedBytes")
	}
	if len(ch.sent) != 0 {
		t.Fatalf("expected no frames sent under backpressure, got %d", len(ch.sent))
	}

	ch.bufferedAmount = maxResponseBufferedBytes
	ch.readyState = webrtc.DataChannelStateClosed
	if sender.trySendPush([]byte(`{"type":"dc_push_v1","payload":{"type":"sessions_invalidated"}}`)) {
		t.Fatal("trySendPush must drop when channel is closed")
	}

	ch.readyState = webrtc.DataChannelStateOpen
	if !sender.trySendPush([]byte(`{"type":"dc_push_v1","payload":{"type":"sessions_invalidated"}}`)) {
		t.Fatal("trySendPush should send when open and within buffer limit")
	}
	if len(ch.sent) != 1 {
		t.Fatalf("expected 1 pushed frame, got %d", len(ch.sent))
	}

	// Browser-authenticated channels must never negotiate push invalidation.
	state := newPeerPushState(func() bool { return true })
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	dc, err := pc.CreateDataChannel("ragent-http", nil)
	if err != nil {
		t.Fatal(err)
	}
	state.attachPrimary(dc, sender)
	handled := state.handleClientReady(dc, &browserAuthConfig{}, []byte(`{"type":"client_ready","version":1,"features":["dc_push_invalidation_v1"]}`))
	if !handled {
		t.Fatal("expected client_ready frame to be recognized")
	}
	if state.isPushNegotiated() {
		t.Fatal("browserAuth must block dc_push_invalidation_v1 negotiation")
	}
	if state.sendPushInvalidation(json.RawMessage(`{"type":"sessions_invalidated"}`)) {
		t.Fatal("sendPushInvalidation must return false when not negotiated")
	}
}

func TestPushInvalidationNegotiationAndDeliveryOverDataChannel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	client, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	host, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()

	var current atomic.Bool
	current.Store(true)
	isCurrent := func() bool { return current.Load() }
	var activeChannels atomic.Int32
	pushState := newPeerPushState(isCurrent)
	events := make(chan map[string]any, 16)
	host.OnDataChannel(func(channel *webrtc.DataChannel) {
		attachDataChannel(channel, server.URL, nil, &activeChannels, isCurrent, func(ev any) {
			if m, ok := ev.(map[string]any); ok {
				events <- m
			}
		}, pushState)
	})

	type testChannel struct {
		dc    *webrtc.DataChannel
		open  chan struct{}
		ready chan []string
		msgs  chan []byte
	}
	openChan := func(label string) *testChannel {
		t.Helper()
		dc, err := client.CreateDataChannel(label, nil)
		if err != nil {
			t.Fatal(err)
		}
		tc := &testChannel{
			dc:    dc,
			open:  make(chan struct{}),
			ready: make(chan []string, 1),
			msgs:  make(chan []byte, 16),
		}
		var once sync.Once
		dc.OnOpen(func() { once.Do(func() { close(tc.open) }) })
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			var env struct {
				Type     string   `json:"type"`
				Features []string `json:"features"`
			}
			if json.Unmarshal(msg.Data, &env) == nil && env.Type == "server_ready" {
				tc.ready <- env.Features
				return
			}
			tc.msgs <- append([]byte(nil), msg.Data...)
		})
		return tc
	}

	primary := openChan("ragent-http")
	bg := openChan("ragent-http-bg")

	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(client)
	if err = client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(10 * time.Second):
		t.Fatal("client ICE gathering timed out")
	}
	if err = host.SetRemoteDescription(*client.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := host.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherHost := webrtc.GatheringCompletePromise(host)
	if err = host.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherHost:
	case <-time.After(10 * time.Second):
		t.Fatal("host ICE gathering timed out")
	}
	if err = client.SetRemoteDescription(*host.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	for name, tc := range map[string]*testChannel{"ragent-http": primary, "ragent-http-bg": bg} {
		select {
		case <-tc.open:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not open", name)
		}
		select {
		case feats := <-tc.ready:
			if !slices.Contains(feats, "dc_push_invalidation_v1") {
				t.Fatalf("%s missing dc_push_invalidation_v1: %#v", name, feats)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s did not receive server_ready", name)
		}
	}

	// Before client_ready, push_invalidation must NOT be delivered.
	if pushState.sendPushInvalidation(json.RawMessage(`{"type":"session_invalidated","sessionId":"s-pre"}`)) {
		t.Fatal("push_invalidation must not send before client_ready")
	}

	// Sending client_ready on ragent-http-bg must NOT negotiate push invalidation.
	if err := bg.dc.SendText(`{"type":"client_ready","version":1,"features":["dc_push_invalidation_v1"]}`); err != nil {
		t.Fatal(err)
	}
	if err := bg.dc.SendText(`{"id":"sync-bg","type":"http_request","method":"GET","path":"/sync"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-bg.msgs:
	case <-time.After(5 * time.Second):
		t.Fatal("sync request on bg timed out")
	}
	if pushState.isPushNegotiated() || pushState.sendPushInvalidation(json.RawMessage(`{"type":"sessions_invalidated"}`)) {
		t.Fatal("client_ready on ragent-http-bg must not enable push invalidation")
	}

	// Sending client_ready without dc_push_invalidation_v1 on ragent-http must NOT negotiate push invalidation.
	if err := primary.dc.SendText(`{"type":"client_ready","version":1,"features":["dc_keepalive_v1"]}`); err != nil {
		t.Fatal(err)
	}
	if err := primary.dc.SendText(`{"id":"sync-no-feat","type":"http_request","method":"GET","path":"/sync"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case <-primary.msgs:
	case <-time.After(5 * time.Second):
		t.Fatal("sync request on primary timed out")
	}
	if pushState.isPushNegotiated() || pushState.sendPushInvalidation(json.RawMessage(`{"type":"sessions_invalidated"}`)) {
		t.Fatal("client_ready without dc_push_invalidation_v1 must not enable push invalidation")
	}

	// Sending valid client_ready on ragent-http enables dc_push_v1 delivery.
	if err := primary.dc.SendText(`{"type":"client_ready","version":1,"features":["dc_push_invalidation_v1"]}`); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !pushState.isPushNegotiated() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !pushState.isPushNegotiated() {
		t.Fatal("client_ready on ragent-http did not negotiate push invalidation")
	}
	if !pushState.sendPushInvalidation(json.RawMessage(`{"type":"session_invalidated","sessionId":"s1","latestSeq":42}`)) {
		t.Fatal("expected sendPushInvalidation to succeed after client_ready")
	}

	select {
	case raw := <-primary.msgs:
		var push struct {
			Type    string `json:"type"`
			Payload struct {
				Type      string `json:"type"`
				SessionID string `json:"sessionId"`
				LatestSeq int    `json:"latestSeq"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &push); err != nil {
			t.Fatalf("failed to parse dc_push_v1: %v", err)
		}
		if push.Type != "dc_push_v1" || push.Payload.Type != "session_invalidated" ||
			push.Payload.SessionID != "s1" || push.Payload.LatestSeq != 42 {
			t.Fatalf("unexpected dc_push_v1 frame: %#v", push)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for dc_push_v1 on ragent-http")
	}

	// Verify datachannel_close events and non-delivery once closed.
	_ = primary.dc.Close()
	_ = bg.dc.Close()
	sawZeroActive := false
	closeDeadline := time.After(5 * time.Second)
	for !sawZeroActive {
		select {
		case ev := <-events:
			if ev["type"] == "datachannel_close" {
				if n, ok := ev["activeChannels"].(int32); ok && n == 0 {
					sawZeroActive = true
				}
			}
		case <-closeDeadline:
			t.Fatal("timed out waiting for datachannel_close activeChannels=0")
		}
	}
	if pushState.sendPushInvalidation(json.RawMessage(`{"type":"projects_invalidated"}`)) {
		t.Fatal("sendPushInvalidation must return false after primary channel closes")
	}
}

func TestDirectIcePolicyAndBrowserAuthEnforcement(t *testing.T) {
	turnOnlyServers := []webrtc.ICEServer{{
		URLs:       []string{"turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"},
		Username:   "u",
		Credential: "p",
	}}
	stunServers := []webrtc.ICEServer{{URLs: []string{"stun:127.0.0.1:3478"}}}
	browserCfg := &browserAuthConfig{issuer: "https://issuer.test", instanceID: "ins_1"}

	for _, tc := range []struct {
		name        string
		servers     []webrtc.ICEServer
		flag        string
		browserAuth *browserAuthConfig
		wantRelay   bool
		wantPolicy  webrtc.ICETransportPolicy
		wantErr     bool
	}{
		{
			name:        "owner_trusted_device_flag_0_with_turn_uses_all",
			servers:     turnOnlyServers,
			flag:        "0",
			browserAuth: nil,
			wantRelay:   false,
			wantPolicy:  webrtc.ICETransportPolicyAll,
		},
		{
			name:        "explicit_flag_1_with_turn_forces_relay",
			servers:     turnOnlyServers,
			flag:        "1",
			browserAuth: nil,
			wantRelay:   true,
			wantPolicy:  webrtc.ICETransportPolicyRelay,
		},
		{
			name:        "browser_auth_with_flag_0_forces_relay",
			servers:     turnOnlyServers,
			flag:        "0",
			browserAuth: browserCfg,
			wantRelay:   true,
			wantPolicy:  webrtc.ICETransportPolicyRelay,
		},
		{
			name:        "browser_auth_with_empty_flag_and_stun_forces_relay",
			servers:     stunServers,
			flag:        "",
			browserAuth: browserCfg,
			wantRelay:   true,
			wantPolicy:  webrtc.ICETransportPolicyRelay,
		},
		{
			name:        "browser_auth_with_nil_servers_forces_relay",
			servers:     nil,
			flag:        "0",
			browserAuth: browserCfg,
			wantRelay:   true,
			wantPolicy:  webrtc.ICETransportPolicyRelay,
		},
		{
			name:        "browser_auth_with_invalid_flag_errors",
			servers:     turnOnlyServers,
			flag:        "invalid",
			browserAuth: browserCfg,
			wantErr:     true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			relayOnly, err := relayOnlyPolicy(tc.servers, tc.flag, tc.browserAuth)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for invalid RAGENT_P2P_RELAY_ONLY, got relayOnly=%v", relayOnly)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if relayOnly != tc.wantRelay {
				t.Fatalf("relayOnly = %v; want %v", relayOnly, tc.wantRelay)
			}
			cfg := peerConnectionConfiguration(tc.servers, relayOnly)
			if cfg.ICETransportPolicy != tc.wantPolicy {
				t.Fatalf("ICETransportPolicy = %q; want %q", cfg.ICETransportPolicy.String(), tc.wantPolicy.String())
			}
		})
	}
}

func TestDirectIceAllWithTurnServerGathersHostAndRelayCandidates(t *testing.T) {
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	const username, realm, password = "direct-ice-user", "ragent.test", "direct-ice-pass"
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(request *turn.RequestAttributes) (string, []byte, bool) {
			if request.Username != username {
				return "", nil, false
			}
			return username, turn.GenerateAuthKey(username, realm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"),
				Address:      "127.0.0.1",
			},
		}},
	})
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	defer server.Close()

	turnServers := []webrtc.ICEServer{{
		URLs:       []string{"turn:" + listener.LocalAddr().String() + "?transport=udp"},
		Username:   username,
		Credential: password,
	}}

	gather := func(flag string, browserAuth *browserAuthConfig) (hostCount, relayCount int) {
		relayOnly, err := relayOnlyPolicy(turnServers, flag, browserAuth)
		if err != nil {
			t.Fatal(err)
		}
		var settings webrtc.SettingEngine
		settings.SetIncludeLoopbackCandidate(true)
		api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
		pc, err := api.NewPeerConnection(peerConnectionConfiguration(turnServers, relayOnly))
		if err != nil {
			t.Fatal(err)
		}
		defer pc.Close()
		if _, err := pc.CreateDataChannel("probe", nil); err != nil {
			t.Fatal(err)
		}
		candidates := make(chan string, 32)
		done := make(chan struct{})
		var once sync.Once
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				once.Do(func() { close(done) })
				return
			}
			candidates <- c.ToJSON().Candidate
		})
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := pc.SetLocalDescription(offer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("ICE gathering timed out")
		}
		close(candidates)
		for cand := range candidates {
			lower := strings.ToLower(cand)
			if strings.Contains(lower, " typ host ") {
				hostCount++
			}
			if strings.Contains(lower, " typ relay ") {
				relayCount++
			}
		}
		return hostCount, relayCount
	}

	hostAll, relayAll := gather("0", nil)
	if hostAll == 0 || relayAll == 0 {
		t.Fatalf("expected both host and relay candidates when RAGENT_P2P_RELAY_ONLY=0 and browserAuth==nil; got host=%d relay=%d", hostAll, relayAll)
	}

	hostRelayFlag, relayRelayFlag := gather("1", nil)
	if hostRelayFlag != 0 || relayRelayFlag == 0 {
		t.Fatalf("expected only relay candidates when RAGENT_P2P_RELAY_ONLY=1; got host=%d relay=%d", hostRelayFlag, relayRelayFlag)
	}

	hostBrowser, relayBrowser := gather("0", &browserAuthConfig{issuer: "https://issuer.test", instanceID: "ins_1"})
	if hostBrowser != 0 || relayBrowser == 0 {
		t.Fatalf("expected only relay candidates when browserAuth!=nil even with flag=0; got host=%d relay=%d", hostBrowser, relayBrowser)
	}
}
