package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
	"regexp"
	"sync"
	"time"
)

const (
	maxBodyStreamBytes     = 25 << 20
	maxBodyStreamAggregate = 64 << 20
	maxBodyStreamChunk     = 24 << 10
	maxBodyStreamCount     = 2
	bodyStreamIdleTimeout  = 2 * time.Minute
)

var bodyStreamRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var boundedAssetChunkPath = regexp.MustCompile(`^/api/assets/fasset_[a-f0-9]{24}/upload$`)

type httpRequestStreamV2Init struct {
	Type                 string            `json:"type"`
	ID                   string            `json:"id"`
	Method               string            `json:"method"`
	Path                 string            `json:"path"`
	Headers              map[string]string `json:"headers"`
	TotalBytes           int64             `json:"totalBytes"`
	SHA256               string            `json:"sha256"`
	AcceptResponseStream bool              `json:"acceptResponseStream,omitempty"`
}

type httpRequestStreamV2Chunk struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Index      int    `json:"index"`
	DataBase64 string `json:"dataBase64"`
}

type httpRequestStreamV2End struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	ChunkCount int    `json:"chunkCount"`
	TotalBytes int64  `json:"totalBytes"`
	SHA256     string `json:"sha256"`
}

type requestBodyStreamState struct {
	request httpRequest
	total   int64
	digest  string
	written int64
	next    int
	file    *os.File
	buffer  *bytes.Buffer
	path    string
	hasher  hash.Hash
	timer   *time.Timer
}

// A finished body owns its staging resource until the local HTTP request is
// complete. Small asset chunks stay in bounded memory; larger/general streams
// retain the existing private-file staging behavior.
type requestStreamBody struct {
	reader io.Reader
	file   *os.File
	path   string
}

func (b *requestStreamBody) Read(p []byte) (int, error) { return b.reader.Read(p) }
func (b *requestStreamBody) Name() string               { return b.path }
func (b *requestStreamBody) Close() error {
	if b.file == nil {
		return nil
	}
	err := b.file.Close()
	_ = os.Remove(b.path)
	return err
}

type requestBodyStreamAssembler struct {
	mu            sync.Mutex
	streams       map[string]*requestBodyStreamState
	reservedBytes int64
	closed        bool
}

func newRequestBodyStreamAssembler() *requestBodyStreamAssembler {
	return &requestBodyStreamAssembler{streams: make(map[string]*requestBodyStreamState)}
}

func (a *requestBodyStreamAssembler) begin(frame httpRequestStreamV2Init) error {
	if frame.Type != "http_request_stream_v2_init" || !bodyStreamRequestID.MatchString(frame.ID) ||
		frame.Method == "" || len(frame.Method) > 16 || frame.Path == "" || len(frame.Path) > 4096 ||
		frame.TotalBytes <= 0 || frame.TotalBytes > maxBodyStreamBytes {
		return errors.New("invalid request stream metadata")
	}
	digest, err := hex.DecodeString(frame.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("invalid request stream digest")
	}
	if len(frame.Headers) > 64 {
		return errors.New("too many request headers")
	}
	headerBytes := 0
	for key, value := range frame.Headers {
		headerBytes += len(key) + len(value)
		if key == "" || len(key) > 256 || len(value) > 8<<10 || headerBytes > 32<<10 {
			return errors.New("request headers exceed limits")
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || len(a.streams) >= maxBodyStreamCount || a.reservedBytes+frame.TotalBytes > maxBodyStreamAggregate {
		return errors.New("request stream capacity exceeded")
	}
	if _, exists := a.streams[frame.ID]; exists {
		return errors.New("duplicate request stream id")
	}
	state := &requestBodyStreamState{
		request: httpRequest{ID: frame.ID, Type: "http_request", Method: frame.Method,
			Path: frame.Path, Headers: frame.Headers, AcceptResponseStream: frame.AcceptResponseStream},
		total: frame.TotalBytes, digest: frame.SHA256, hasher: sha256.New(),
	}
	if frame.Method == "PATCH" && boundedAssetChunkPath.MatchString(frame.Path) && frame.TotalBytes <= 1<<20 {
		state.buffer = bytes.NewBuffer(make([]byte, 0, int(frame.TotalBytes)))
	} else {
		file, err := os.CreateTemp("", "agentoc-p2p-body-*")
		if err != nil {
			return errors.New("request stream storage unavailable")
		}
		state.file, state.path = file, file.Name()
	}
	a.streams[frame.ID] = state
	a.reservedBytes += frame.TotalBytes
	state.timer = time.AfterFunc(bodyStreamIdleTimeout, func() { a.discard(frame.ID, state) })
	return nil
}

func (a *requestBodyStreamAssembler) add(frame httpRequestStreamV2Chunk) error {
	if frame.Type != "http_request_stream_v2_chunk" || !bodyStreamRequestID.MatchString(frame.ID) || frame.Index < 0 {
		return errors.New("invalid request stream chunk")
	}
	chunk, err := base64.StdEncoding.DecodeString(frame.DataBase64)
	if err != nil || len(chunk) == 0 || len(chunk) > maxBodyStreamChunk {
		return errors.New("invalid request stream chunk encoding or size")
	}
	return a.addBytes(frame.ID, frame.Index, chunk)
}

// Binary v3 carries the same ordered body chunks as v2 without Base64. The
// metadata and end frames remain v2 JSON, so the existing limits, digest and
// cleanup rules apply to both encodings.
func (a *requestBodyStreamAssembler) addBinary(frame []byte) (string, error) {
	if len(frame) < 10 || string(frame[:4]) != "AGB3" {
		return "", errors.New("invalid binary request stream frame")
	}
	idLen := int(frame[4])
	headerLen := 5 + idLen + 4
	if idLen < 1 || idLen > 128 || len(frame) <= headerLen {
		return "", errors.New("invalid binary request stream frame bounds")
	}
	id := string(frame[5 : 5+idLen])
	index := binary.BigEndian.Uint32(frame[5+idLen : headerLen])
	chunk := frame[headerLen:]
	if !bodyStreamRequestID.MatchString(id) || len(chunk) > maxBodyStreamChunk || index > 1<<30 {
		return "", errors.New("invalid binary request stream chunk")
	}
	return id, a.addBytes(id, int(index), chunk)
}

func (a *requestBodyStreamAssembler) addBytes(id string, index int, chunk []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state := a.streams[id]
	if state == nil {
		return errors.New("request stream is not open")
	}
	remaining := state.total - state.written
	if index != state.next || remaining <= 0 || int64(len(chunk)) > remaining {
		a.discardLocked(id, state)
		return errors.New("request stream chunk order or size mismatch")
	}
	var writer io.Writer = state.file
	if state.buffer != nil {
		writer = state.buffer
	}
	if _, err := writer.Write(chunk); err != nil {
		a.discardLocked(id, state)
		return errors.New("request stream storage write failed")
	}
	_, _ = state.hasher.Write(chunk)
	state.written += int64(len(chunk))
	state.next++
	state.timer.Reset(bodyStreamIdleTimeout)
	return nil
}

func (a *requestBodyStreamAssembler) finish(frame httpRequestStreamV2End) (httpRequest, *requestStreamBody, int64, error) {
	if frame.Type != "http_request_stream_v2_end" || !bodyStreamRequestID.MatchString(frame.ID) || frame.ChunkCount < 1 {
		return httpRequest{}, nil, 0, errors.New("invalid request stream end")
	}
	a.mu.Lock()
	state := a.streams[frame.ID]
	if state == nil {
		a.mu.Unlock()
		return httpRequest{}, nil, 0, errors.New("request stream is not open")
	}
	actual := hex.EncodeToString(state.hasher.Sum(nil))
	if frame.ChunkCount != state.next || frame.TotalBytes != state.total || frame.TotalBytes != state.written ||
		frame.SHA256 != state.digest || actual != state.digest {
		a.discardLocked(frame.ID, state)
		a.mu.Unlock()
		return httpRequest{}, nil, 0, errors.New("request stream digest or length mismatch")
	}
	delete(a.streams, frame.ID)
	a.reservedBytes -= state.total
	state.timer.Stop()
	if state.buffer != nil {
		body := &requestStreamBody{reader: bytes.NewReader(state.buffer.Bytes())}
		a.mu.Unlock()
		return state.request, body, state.total, nil
	}
	if _, err := state.file.Seek(0, io.SeekStart); err != nil {
		a.mu.Unlock()
		a.cleanup(state)
		return httpRequest{}, nil, 0, errors.New("request stream storage rewind failed")
	}
	a.mu.Unlock()
	return state.request, &requestStreamBody{reader: state.file, file: state.file, path: state.path}, state.total, nil
}

func (a *requestBodyStreamAssembler) abort(id string) {
	a.mu.Lock()
	state := a.streams[id]
	if state != nil {
		a.discardLocked(id, state)
	}
	a.mu.Unlock()
}

func (a *requestBodyStreamAssembler) discard(id string, expected *requestBodyStreamState) {
	a.mu.Lock()
	a.discardLocked(id, expected)
	a.mu.Unlock()
}

func (a *requestBodyStreamAssembler) discardLocked(id string, state *requestBodyStreamState) {
	if a.streams[id] != state {
		return
	}
	delete(a.streams, id)
	a.reservedBytes -= state.total
	if state.timer != nil {
		state.timer.Stop()
	}
	a.cleanup(state)
}

func (a *requestBodyStreamAssembler) cleanup(state *requestBodyStreamState) {
	if state.file != nil {
		_ = state.file.Close()
	}
	if state.path != "" {
		_ = os.Remove(state.path)
	}
}

func (a *requestBodyStreamAssembler) close() {
	a.mu.Lock()
	a.closed = true
	for id, state := range a.streams {
		a.discardLocked(id, state)
	}
	a.mu.Unlock()
}
