package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	responseStreamThreshold     = 48 << 10
	maxLegacyResponseFrame      = 240 << 10
	responseStreamChunkBytes    = 24 << 10
	maxResponseStreamBytes      = 12 << 20
	maxResponseBufferedBytes    = 512 << 10
	maxBulkBufferedBytes        = 64 << 10
	responseBackpressureTimeout = 30 * time.Second
)

type responseChannel interface {
	SendText(string) error
	BufferedAmount() uint64
	ReadyState() webrtc.DataChannelState
}

// A DataChannel is shared by concurrent request handlers. The backpressure
// check and enqueue must be atomic across all of them, while waiting must not
// hold the lock and block another sender from noticing a closed channel.
type responseSender struct {
	channel responseChannel
	current func() bool
	mu      sync.Mutex
}

func newResponseSender(channel responseChannel, current func() bool) *responseSender {
	return &responseSender{channel: channel, current: current}
}

func (s *responseSender) sendFrame(frame []byte) error {
	deadline := time.Now().Add(responseBackpressureTimeout)
	// Keep the ordered channel from filling with bulk history before a small
	// interactive response arrives. Legacy large single frames are also bulk.
	bulk := len(frame) > responseStreamThreshold || bytes.HasPrefix(frame, []byte(`{"type":"http_response_stream_v1",`))
	limit := uint64(maxResponseBufferedBytes)
	if bulk {
		limit = maxBulkBufferedBytes
	}
	for {
		s.mu.Lock()
		if !s.current() || s.channel.ReadyState() != webrtc.DataChannelStateOpen {
			s.mu.Unlock()
			return errors.New("response channel closed")
		}
		if s.channel.BufferedAmount() <= limit {
			err := s.channel.SendText(string(frame))
			s.mu.Unlock()
			return err
		}
		s.mu.Unlock()
		if time.Now().After(deadline) {
			return errors.New("response channel backpressure timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type httpResponseStreamFrame struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Index      int    `json:"index"`
	TotalBytes int    `json:"totalBytes"`
	SHA256     string `json:"sha256"`
	DataBase64 string `json:"dataBase64"`
}

// responseFrames retains the legacy single response unless the client opted
// in. A legacy client receives an explicit small error instead of silently
// waiting when its response cannot fit in a DataChannel message.
func responseFrames(request httpRequest, response httpResponse, send func([]byte) error) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(payload) <= responseStreamThreshold || (!request.AcceptResponseStream && len(payload) <= maxLegacyResponseFrame) {
		return send(payload)
	}
	if !request.AcceptResponseStream || len(payload) > maxResponseStreamBytes {
		body := []byte(`{"code":"P2P_RESPONSE_TOO_LARGE","error":"Response is too large for this client. Update the app to continue."}`)
		fallback, err := json.Marshal(httpResponse{ID: response.ID, Type: "http_response", Status: 413,
			Headers: map[string]string{"Content-Type": "application/json"}, BodyBase64: base64.StdEncoding.EncodeToString(body)})
		if err != nil {
			return err
		}
		return send(fallback)
	}
	digest := sha256.Sum256(payload)
	digestHex := hex.EncodeToString(digest[:])
	for offset, index := 0, 0; offset < len(payload); index++ {
		end := min(offset+responseStreamChunkBytes, len(payload))
		frame, err := json.Marshal(httpResponseStreamFrame{
			Type: "http_response_stream_v1", ID: response.ID, Index: index,
			TotalBytes: len(payload), SHA256: digestHex,
			DataBase64: base64.StdEncoding.EncodeToString(payload[offset:end]),
		})
		if err != nil {
			return err
		}
		if err := send(frame); err != nil {
			return err
		}
		offset = end
	}
	return nil
}

func (s *responseSender) send(request httpRequest, response httpResponse) error {
	err := responseFrames(request, response, s.sendFrame)
	if err != nil && s.current() && s.channel.ReadyState() == webrtc.DataChannelStateOpen {
		body := []byte(`{"code":"P2P_RESPONSE_SEND_FAILED","error":"The response could not be delivered. Please retry."}`)
		fallback, marshalErr := json.Marshal(httpResponse{ID: response.ID, Type: "http_response", Status: 503,
			Headers: map[string]string{"Content-Type": "application/json"}, BodyBase64: base64.StdEncoding.EncodeToString(body)})
		if marshalErr == nil {
			// A small error frame remains best-effort even after the normal
			// backpressure deadline; do not wait another full deadline.
			s.mu.Lock()
			if s.current() && s.channel.ReadyState() == webrtc.DataChannelStateOpen {
				_ = s.channel.SendText(string(fallback))
			}
			s.mu.Unlock()
		}
	}
	return err
}
