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
	"strings"
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
	maxBulkBufferedBytes        = 256 << 10
	responseBackpressureTimeout = 30 * time.Second
)

type responseChannel interface {
	SendText(string) error
	BufferedAmount() uint64
	ReadyState() webrtc.DataChannelState
}

type binarySendChannel interface {
	Send([]byte) error
}

type bufferedLowAwareChannel interface {
	SetBufferedAmountLowThreshold(uint64)
	OnBufferedAmountLow(func())
}

// A DataChannel is shared by concurrent request handlers. The backpressure
// check and enqueue must be atomic across all of them, while waiting must not
// hold the lock and block another sender from noticing a closed channel.
type responseSender struct {
	channel responseChannel
	current func() bool
	mu      sync.Mutex
	lowCh   chan struct{}
}

func newResponseSender(channel responseChannel, current func() bool) *responseSender {
	sender := &responseSender{channel: channel, current: current}
	if aware, ok := channel.(bufferedLowAwareChannel); ok {
		lowCh := make(chan struct{}, 1)
		sender.lowCh = lowCh
		aware.SetBufferedAmountLowThreshold(maxBulkBufferedBytes / 2)
		aware.OnBufferedAmountLow(func() {
			select {
			case lowCh <- struct{}{}:
			default:
			}
		})
	}
	return sender
}

func (s *responseSender) waitForBuffer(limit uint64, deadline time.Time, sendFn func() error) error {
	for {
		s.mu.Lock()
		if !s.current() || s.channel.ReadyState() != webrtc.DataChannelStateOpen {
			s.mu.Unlock()
			return errors.New("response channel closed")
		}
		if s.channel.BufferedAmount() <= limit {
			err := sendFn()
			s.mu.Unlock()
			return err
		}
		s.mu.Unlock()
		if time.Now().After(deadline) {
			return errors.New("response channel backpressure timeout")
		}
		if s.lowCh != nil {
			select {
			case <-s.lowCh:
			case <-time.After(15 * time.Millisecond):
			}
		} else {
			time.Sleep(10 * time.Millisecond)
		}
	}
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
	return s.waitForBuffer(limit, deadline, func() error {
		return s.channel.SendText(string(frame))
	})
}

func (s *responseSender) sendBinaryFrame(frame []byte, bulk bool) error {
	binChan, ok := s.channel.(binarySendChannel)
	if !ok {
		return errors.New("channel does not support binary frames")
	}
	deadline := time.Now().Add(responseBackpressureTimeout)
	limit := uint64(maxResponseBufferedBytes)
	if bulk {
		limit = maxBulkBufferedBytes
	}
	return s.waitForBuffer(limit, deadline, func() error {
		return binChan.Send(frame)
	})
}

type httpResponseBinaryHeadFrame struct {
	Type         string            `json:"type"`
	ID           string            `json:"id"`
	Status       int               `json:"status"`
	Headers      map[string]string `json:"headers,omitempty"`
	Error        string            `json:"error,omitempty"`
	TotalBytes   int               `json:"totalBytes"`
	SHA256       string            `json:"sha256"`
	BodyEncoding string            `json:"bodyEncoding"`
}

func isCompressibleP2PContentType(headers map[string]string) bool {
	var contentType string
	for k, v := range headers {
		if strings.EqualFold(k, "Content-Encoding") && strings.TrimSpace(v) != "" {
			return false
		}
		if strings.EqualFold(k, "Content-Type") {
			contentType = strings.ToLower(strings.TrimSpace(strings.SplitN(v, ";", 2)[0]))
		}
	}
	return strings.HasPrefix(contentType, "text/") ||
		contentType == "application/json" ||
		contentType == "application/javascript" ||
		contentType == "application/manifest+json" ||
		contentType == "image/svg+xml"
}

func agr2BinaryChunkFrame(id string, index int, chunk []byte) ([]byte, error) {
	if len(id) == 0 || len(id) > 128 {
		return nil, errors.New("invalid response id for AGR2 frame")
	}
	headerLen := 5 + len(id) + 4
	frame := make([]byte, headerLen+len(chunk))
	copy(frame[:4], "AGR2")
	frame[4] = byte(len(id))
	copy(frame[5:5+len(id)], id)
	binary.BigEndian.PutUint32(frame[5+len(id):headerLen], uint32(index))
	copy(frame[headerLen:], chunk)
	return frame, nil
}

func (s *responseSender) sendBinaryResponse(response httpResponse) error {
	if response.Error != "" {
		payload, err := json.Marshal(response)
		if err != nil {
			return err
		}
		return s.sendFrame(payload)
	}
	wireBody := response.rawBody
	bodyEncoding := "identity"
	if len(wireBody) >= 1024 && isCompressibleP2PContentType(response.Headers) {
		var gzBuf bytes.Buffer
		gz, err := gzip.NewWriterLevel(&gzBuf, gzip.BestSpeed)
		if err == nil {
			_, werr := gz.Write(wireBody)
			cerr := gz.Close()
			if werr == nil && cerr == nil && gzBuf.Len() < len(wireBody) {
				wireBody = gzBuf.Bytes()
				bodyEncoding = "gzip"
			}
		}
	}
	if len(wireBody) > maxResponseStreamBytes {
		body := []byte(`{"code":"P2P_RESPONSE_TOO_LARGE","error":"Response is too large for this client. Update the app to continue."}`)
		fallback, err := json.Marshal(httpResponse{ID: response.ID, Type: "http_response", Status: 413,
			Headers: map[string]string{"Content-Type": "application/json"}, BodyBase64: base64.StdEncoding.EncodeToString(body)})
		if err != nil {
			return err
		}
		return s.sendFrame(fallback)
	}
	digest := sha256.Sum256(wireBody)
	headPayload, err := json.Marshal(httpResponseBinaryHeadFrame{
		Type:         "http_response_binary_v2_head",
		ID:           response.ID,
		Status:       response.Status,
		Headers:      response.Headers,
		TotalBytes:   len(wireBody),
		SHA256:       hex.EncodeToString(digest[:]),
		BodyEncoding: bodyEncoding,
	})
	if err != nil {
		return err
	}
	if err := s.sendFrame(headPayload); err != nil {
		return err
	}
	bulk := len(wireBody) > responseStreamThreshold
	for offset, index := 0, 0; offset < len(wireBody); index++ {
		end := min(offset+responseStreamChunkBytes, len(wireBody))
		chunkFrame, err := agr2BinaryChunkFrame(response.ID, index, wireBody[offset:end])
		if err != nil {
			return err
		}
		if err := s.sendBinaryFrame(chunkFrame, bulk); err != nil {
			return err
		}
		offset = end
	}
	return nil
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

func (s *responseSender) trySendPush(frame []byte) bool {
	if s == nil || len(frame) == 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.current() || s.channel.ReadyState() != webrtc.DataChannelStateOpen {
		return false
	}
	if s.channel.BufferedAmount() > maxResponseBufferedBytes {
		return false
	}
	return s.channel.SendText(string(frame)) == nil
}

func (s *responseSender) send(request httpRequest, response httpResponse) error {
	var err error
	if request.AcceptBinaryResponse {
		if _, ok := s.channel.(binarySendChannel); ok {
			err = s.sendBinaryResponse(response)
		} else {
			if response.BodyBase64 == "" && len(response.rawBody) > 0 {
				response.BodyBase64 = base64.StdEncoding.EncodeToString(response.rawBody)
			}
			err = responseFrames(request, response, s.sendFrame)
		}
	} else {
		err = responseFrames(request, response, s.sendFrame)
	}
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
