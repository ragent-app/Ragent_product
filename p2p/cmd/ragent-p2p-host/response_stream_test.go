package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
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
