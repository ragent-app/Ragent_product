package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestResponseFramesNegotiationAndReassembly(t *testing.T) {
	for _, size := range []int{1024, 200000, 300000, 1049000} {
		original := httpResponse{ID: "request_1", Type: "http_response", Status: 200, BodyBase64: strings.Repeat("A", size)}
		want, err := json.Marshal(original)
		if err != nil {
			t.Fatal(err)
		}
		var frames [][]byte
		err = responseFrames(httpRequest{AcceptResponseStream: true}, original, func(frame []byte) error {
			frames = append(frames, append([]byte(nil), frame...))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(want) <= responseStreamThreshold {
			if len(frames) != 1 || !bytes.Equal(frames[0], want) {
				t.Fatal("small response changed")
			}
			continue
		}
		var got []byte
		for i, encoded := range frames {
			if len(encoded) >= responseStreamThreshold {
				t.Fatalf("oversize frame %d", len(encoded))
			}
			var frame httpResponseStreamFrame
			if err := json.Unmarshal(encoded, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.Type != "http_response_stream_v1" || frame.ID != original.ID || frame.Index != i || frame.TotalBytes != len(want) {
				t.Fatalf("invalid frame: %+v", frame)
			}
			chunk, err := base64.StdEncoding.DecodeString(frame.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(want)
			if frame.SHA256 != hex.EncodeToString(digest[:]) {
				t.Fatal("digest differs")
			}
			got = append(got, chunk...)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("reassembly mismatch for size %d", size)
		}
	}
}

type concurrentResponseChannel struct {
	mu       sync.Mutex
	buffered uint64
	peak     uint64
	checks   int
	gate     chan struct{}
}

func (c *concurrentResponseChannel) BufferedAmount() uint64 {
	c.mu.Lock()
	value := c.buffered
	c.checks++
	c.mu.Unlock()
	<-c.gate
	return value
}
func (c *concurrentResponseChannel) ReadyState() webrtc.DataChannelState {
	return webrtc.DataChannelStateOpen
}
func (c *concurrentResponseChannel) SendText(frame string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buffered += uint64(len(frame))
	if c.buffered > c.peak {
		c.peak = c.buffered
	}
	return nil
}

func TestConcurrentResponsesRespectSharedBackpressure(t *testing.T) {
	const count = 8
	channel := &concurrentResponseChannel{gate: make(chan struct{})}
	sender := newResponseSender(channel, func() bool { return true })
	start := make(chan struct{})
	done := make(chan error, count)
	for i := 0; i < count; i++ {
		go func() {
			<-start
			done <- sender.send(httpRequest{}, httpResponse{ID: "fixture", Type: "http_response", Status: 200, BodyBase64: strings.Repeat("A", 180_000)})
		}()
	}
	close(start)
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		channel.mu.Lock()
		checks := channel.checks
		channel.mu.Unlock()
		if checks >= count {
			break
		}
		time.Sleep(time.Millisecond)
	}
	close(channel.gate)
	stopDrain := make(chan struct{})
	defer close(stopDrain)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				channel.mu.Lock()
				channel.buffered = 0
				channel.mu.Unlock()
			case <-stopDrain:
				return
			}
		}
	}()
	for i := 0; i < count; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("responses did not complete")
		}
	}
	channel.mu.Lock()
	peak := channel.peak
	channel.mu.Unlock()
	if peak > maxResponseBufferedBytes+maxLegacyResponseFrame {
		t.Fatalf("concurrent sends exceeded the shared buffer bound: peak=%d", peak)
	}
}

func TestBackpressuredResponseStopsWhenPeerChanges(t *testing.T) {
	channel := &concurrentResponseChannel{gate: make(chan struct{}), buffered: maxResponseBufferedBytes + 1}
	close(channel.gate)
	var current atomic.Bool
	current.Store(true)
	sender := newResponseSender(channel, current.Load)
	done := make(chan error, 1)
	go func() { done <- sender.sendFrame([]byte("fixture")) }()
	time.Sleep(30 * time.Millisecond)
	current.Store(false)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("stale peer accepted a response")
		}
	case <-time.After(time.Second):
		t.Fatal("backpressured sender did not stop after peer changed")
	}
}

func TestInteractiveResponseCanPassWaitingBulk(t *testing.T) {
	channel := &concurrentResponseChannel{gate: make(chan struct{}), buffered: maxBulkBufferedBytes + 1}
	close(channel.gate)
	var current atomic.Bool
	current.Store(true)
	sender := newResponseSender(channel, current.Load)
	bulkDone := make(chan error, 1)
	go func() { bulkDone <- sender.sendFrame([]byte(`{"type":"http_response_stream_v1","id":"bulk"}`)) }()
	defer current.Store(false)
	deadline := time.Now().Add(time.Second)
	for {
		channel.mu.Lock()
		checks := channel.checks
		channel.mu.Unlock()
		if checks > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("bulk sender did not start")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-bulkDone:
		t.Fatal("bulk should wait while the channel already has queued data")
	default:
	}
	if err := sender.sendFrame([]byte(`{"type":"http_response","id":"interactive"}`)); err != nil {
		t.Fatalf("interactive response blocked: %v", err)
	}
	channel.mu.Lock()
	channel.buffered = 0
	channel.mu.Unlock()
	select {
	case err := <-bulkDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bulk response did not resume after the channel drained")
	}
}

func TestResponseFramesLegacyAndSendFailure(t *testing.T) {
	medium := httpResponse{ID: "legacy", Type: "http_response", Status: 200, BodyBase64: strings.Repeat("A", 200000)}
	var frames [][]byte
	send := func(frame []byte) error { frames = append(frames, append([]byte(nil), frame...)); return nil }
	if err := responseFrames(httpRequest{}, medium, send); err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatal("legacy medium response must remain a single frame")
	}
	frames = nil
	large := medium
	large.BodyBase64 = strings.Repeat("A", 300000)
	if err := responseFrames(httpRequest{}, large, send); err != nil {
		t.Fatal(err)
	}
	var response httpResponse
	if len(frames) != 1 || json.Unmarshal(frames[0], &response) != nil || response.Status != 413 || response.ID != large.ID {
		t.Fatal("legacy oversized response must fail explicitly")
	}
	sentinel := errors.New("closed")
	if err := responseFrames(httpRequest{AcceptResponseStream: true}, large, func([]byte) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal("send failure was discarded")
	}
}

type responseTestChannel struct {
	frames []string
	calls  int
	failAt int
	state  webrtc.DataChannelState
}

func (c *responseTestChannel) SendText(frame string) error {
	c.calls++
	if c.calls == c.failAt {
		return errors.New("synthetic send error")
	}
	c.frames = append(c.frames, frame)
	return nil
}
func (c *responseTestChannel) BufferedAmount() uint64              { return 0 }
func (c *responseTestChannel) ReadyState() webrtc.DataChannelState { return c.state }

func TestSendHTTPResponseFailureOffersExplicitRetry(t *testing.T) {
	c := &responseTestChannel{failAt: 2, state: webrtc.DataChannelStateOpen}
	response := httpResponse{ID: "request", Type: "http_response", Status: 200, BodyBase64: strings.Repeat("A", 300000)}
	err := newResponseSender(c, func() bool { return true }).send(httpRequest{AcceptResponseStream: true}, response)
	if err == nil || len(c.frames) != 2 {
		t.Fatalf("expected one chunk, a send error and a fallback; calls=%d", c.calls)
	}
	var fallback httpResponse
	if json.Unmarshal([]byte(c.frames[1]), &fallback) != nil || fallback.ID != response.ID || fallback.Status != 503 {
		t.Fatal("failed transfer did not return explicit retry response")
	}
}

type binaryResponseTestChannel struct {
	mu           sync.Mutex
	textFrames   []string
	binaryFrames [][]byte
	buffered     uint64
	lowThreshold uint64
	onLow        func()
	state        webrtc.DataChannelState
}

func (c *binaryResponseTestChannel) SendText(frame string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.textFrames = append(c.textFrames, frame)
	return nil
}

func (c *binaryResponseTestChannel) Send(frame []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.binaryFrames = append(c.binaryFrames, append([]byte(nil), frame...))
	return nil
}

func (c *binaryResponseTestChannel) BufferedAmount() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buffered
}

func (c *binaryResponseTestChannel) ReadyState() webrtc.DataChannelState {
	return c.state
}

func (c *binaryResponseTestChannel) SetBufferedAmountLowThreshold(threshold uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lowThreshold = threshold
}

func (c *binaryResponseTestChannel) OnBufferedAmountLow(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onLow = fn
}

func TestAgr2BinaryGzipResponseAndReassembly(t *testing.T) {
	rawJson := []byte(`{"sessions":[` + strings.Repeat(`{"id":"s1","title":"hello world"},`, 80) + `{"id":"s2","title":"end"}]}`)
	ch := &binaryResponseTestChannel{state: webrtc.DataChannelStateOpen}
	sender := newResponseSender(ch, func() bool { return true })
	req := httpRequest{ID: "req_agr2_gz", Type: "http_request", AcceptResponseStream: true, AcceptBinaryResponse: true}
	resp := httpResponse{
		ID:      req.ID,
		Type:    "http_response",
		Status:  200,
		Headers: map[string]string{"Content-Type": "application/json"},
		rawBody: rawJson,
	}
	if err := sender.send(req, resp); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	if len(ch.textFrames) != 1 {
		t.Fatalf("expected 1 head frame, got %d", len(ch.textFrames))
	}
	var head httpResponseBinaryHeadFrame
	if err := json.Unmarshal([]byte(ch.textFrames[0]), &head); err != nil {
		t.Fatal(err)
	}
	if head.Type != "http_response_binary_v2_head" || head.BodyEncoding != "gzip" || head.TotalBytes >= len(rawJson) {
		t.Fatalf("unexpected head frame: %+v (raw=%d)", head, len(rawJson))
	}
	var wire []byte
	for i, bin := range ch.binaryFrames {
		if len(bin) < 10 || string(bin[:4]) != "AGR2" {
			t.Fatalf("invalid magic at %d", i)
		}
		idLen := int(bin[4])
		id := string(bin[5 : 5+idLen])
		idx := int(binary.BigEndian.Uint32(bin[5+idLen : 9+idLen]))
		if id != req.ID || idx != i {
			t.Fatalf("unexpected header id=%s idx=%d", id, idx)
		}
		wire = append(wire, bin[9+idLen:]...)
	}
	if len(wire) != head.TotalBytes {
		t.Fatalf("wire len=%d want=%d", len(wire), head.TotalBytes)
	}
	sum := sha256.Sum256(wire)
	if hex.EncodeToString(sum[:]) != head.SHA256 {
		t.Fatal("sha256 mismatch")
	}
	gz, err := gzip.NewReader(bytes.NewReader(wire))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(gz)
	_ = gz.Close()
	if err != nil || !bytes.Equal(decoded, rawJson) {
		t.Fatalf("decompressed mismatch: err=%v", err)
	}
}

func TestAgr2EmptyBodyAndLowWaterWakeup(t *testing.T) {
	ch := &binaryResponseTestChannel{
		state:    webrtc.DataChannelStateOpen,
		buffered: maxResponseBufferedBytes + 100,
	}
	sender := newResponseSender(ch, func() bool { return true })
	if ch.lowThreshold != maxBulkBufferedBytes/2 {
		t.Fatalf("expected low-water threshold %d, got %d", maxBulkBufferedBytes/2, ch.lowThreshold)
	}
	done := make(chan error, 1)
	go func() {
		done <- sender.send(
			httpRequest{ID: "req_empty", Type: "http_request", AcceptBinaryResponse: true},
			httpResponse{ID: "req_empty", Type: "http_response", Status: 204, rawBody: nil},
		)
	}()
	time.Sleep(25 * time.Millisecond)
	ch.mu.Lock()
	ch.buffered = 0
	cb := ch.onLow
	ch.mu.Unlock()
	if cb != nil {
		cb()
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("sender did not wake on OnBufferedAmountLow")
	}
	if len(ch.textFrames) != 1 || len(ch.binaryFrames) != 0 {
		t.Fatalf("empty body should send 1 head and 0 binary chunks: text=%d bin=%d", len(ch.textFrames), len(ch.binaryFrames))
	}
}
