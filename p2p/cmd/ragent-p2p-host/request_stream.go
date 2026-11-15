package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"sync"
	"time"
)

const (
	maxStreamRequestBytes   = 40 << 20
	maxStreamAggregateBytes = 64 << 20
	maxStreamChunkBytes     = 32 << 10
	maxConcurrentStreams    = 2
	streamIdleTimeout       = 2 * time.Minute
)

var streamRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type httpRequestStreamFrame struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Index      int    `json:"index"`
	TotalBytes int    `json:"totalBytes"`
	SHA256     string `json:"sha256"`
	DataBase64 string `json:"dataBase64"`
}

type requestStreamState struct {
	totalBytes int
	sha256     string
	nextIndex  int
	data       []byte
	timer      *time.Timer
}

// requestStreamAssembler bounds temporary in-memory allocations and accepts
// only ordered, fixed-size, digest-checked fragments. The state is scoped to a
// single WebRTC DataChannel and expires when a peer stops sending.
type requestStreamAssembler struct {
	mu            sync.Mutex
	streams       map[string]*requestStreamState
	reservedBytes int
	closed        bool
}

func newRequestStreamAssembler() *requestStreamAssembler {
	return &requestStreamAssembler{streams: make(map[string]*requestStreamState)}
}

// add returns a complete reassembled request only after its declared byte
// count and SHA-256 digest match. Invalid fragments discard that transfer.
func (a *requestStreamAssembler) add(frame httpRequestStreamFrame) (payload []byte, complete bool, err error) {
	if frame.Type != "http_request_stream_v1" || !streamRequestID.MatchString(frame.ID) {
		return nil, false, errors.New("invalid stream frame identity")
	}
	if frame.TotalBytes <= 0 || frame.TotalBytes > maxStreamRequestBytes || frame.Index < 0 {
		return nil, false, errors.New("invalid stream frame bounds")
	}
	if digest, decodeErr := hex.DecodeString(frame.SHA256); decodeErr != nil || len(digest) != sha256.Size {
		return nil, false, errors.New("invalid stream digest")
	}
	chunk, decodeErr := base64.StdEncoding.DecodeString(frame.DataBase64)
	if decodeErr != nil || len(chunk) == 0 || len(chunk) > maxStreamChunkBytes {
		return nil, false, errors.New("invalid stream chunk encoding or size")
	}

	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, false, errors.New("request stream channel is closed")
	}
	state := a.streams[frame.ID]
	if state == nil {
		if frame.Index != 0 {
			a.mu.Unlock()
			return nil, false, errors.New("stream must begin at index zero")
		}
		if len(a.streams) >= maxConcurrentStreams || a.reservedBytes+frame.TotalBytes > maxStreamAggregateBytes {
			a.mu.Unlock()
			return nil, false, errors.New("stream capacity exceeded")
		}
		state = &requestStreamState{
			totalBytes: frame.TotalBytes,
			sha256:     frame.SHA256,
			data:       make([]byte, 0, frame.TotalBytes),
		}
		a.streams[frame.ID] = state
		a.reservedBytes += frame.TotalBytes
		state.timer = time.AfterFunc(streamIdleTimeout, func() { a.expire(frame.ID, state) })
	}
	if state.totalBytes != frame.TotalBytes || state.sha256 != frame.SHA256 || state.nextIndex != frame.Index {
		a.discardLocked(frame.ID, state)
		a.mu.Unlock()
		return nil, false, errors.New("stream metadata or chunk order changed")
	}
	remaining := state.totalBytes - len(state.data)
	expectedChunkBytes := min(maxStreamChunkBytes, remaining)
	if remaining <= 0 || len(chunk) != expectedChunkBytes {
		a.discardLocked(frame.ID, state)
		a.mu.Unlock()
		return nil, false, errors.New("stream chunk has an invalid length")
	}
	state.data = append(state.data, chunk...)
	state.nextIndex++
	state.timer.Reset(streamIdleTimeout)
	if len(state.data) < state.totalBytes {
		a.mu.Unlock()
		return nil, false, nil
	}

	delete(a.streams, frame.ID)
	a.reservedBytes -= state.totalBytes
	state.timer.Stop()
	payload = state.data
	a.mu.Unlock()

	actual := sha256.Sum256(payload)
	if hex.EncodeToString(actual[:]) != frame.SHA256 {
		return nil, false, errors.New("stream digest mismatch")
	}
	return payload, true, nil
}

func (a *requestStreamAssembler) expire(id string, expected *requestStreamState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.discardLocked(id, expected)
}

func (a *requestStreamAssembler) discardLocked(id string, expected *requestStreamState) {
	if a.streams[id] != expected {
		return
	}
	delete(a.streams, id)
	a.reservedBytes -= expected.totalBytes
	if expected.timer != nil {
		expected.timer.Stop()
	}
	expected.data = nil
}

func (a *requestStreamAssembler) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	for id, state := range a.streams {
		a.discardLocked(id, state)
	}
}
