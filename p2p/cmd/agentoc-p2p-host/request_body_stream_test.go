package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"io"
	"os"
	"testing"
)

func binaryBodyFrame(id string, index uint32, body []byte) []byte {
	frame := append([]byte("AGB3"), byte(len(id)))
	frame = append(frame, []byte(id)...)
	frame = binary.BigEndian.AppendUint32(frame, index)
	return append(frame, body...)
}

func TestBinaryBodyStreamPreservesBytesAndRejectsOutOfOrder(t *testing.T) {
	a := newRequestBodyStreamAssembler()
	defer a.close()
	body := []byte{0, 1, 2, 0xff, 0x80, 0x7f}
	digest := initBodyStreamForTest(t, a, "binary-test", body)
	if id, err := a.addBinary(binaryBodyFrame("binary-test", 0, body)); err != nil || id != "binary-test" {
		t.Fatalf("binary chunk failed: id=%q err=%v", id, err)
	}
	_, file, _, err := a.finish(httpRequestStreamV2End{Type: "http_request_stream_v2_end", ID: "binary-test",
		ChunkCount: 1, TotalBytes: int64(len(body)), SHA256: digest})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
	actual, err := io.ReadAll(file)
	if err != nil || string(actual) != string(body) {
		t.Fatalf("binary content differs: %v", err)
	}
	initBodyStreamForTest(t, a, "bad-order", body)
	if _, err := a.addBinary(binaryBodyFrame("bad-order", 1, body)); err == nil {
		t.Fatal("accepted out-of-order binary chunk")
	}
	if _, exists := a.streams["bad-order"]; exists {
		t.Fatal("invalid stream was not discarded")
	}
	if _, err := a.addBinary([]byte("bad")); err == nil {
		t.Fatal("accepted malformed binary frame")
	}
}

func TestAssetChunksUseBoundedMemoryAndStillVerifyDigest(t *testing.T) {
	a := newRequestBodyStreamAssembler()
	defer a.close()
	body := []byte{0, 0xff, 3, 4}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	err := a.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: "asset",
		Method: "PATCH", Path: "/api/assets/fasset_0123456789abcdef01234567/upload",
		TotalBytes: int64(len(body)), SHA256: digest})
	if err != nil {
		t.Fatal(err)
	}
	if a.streams["asset"].file != nil || a.streams["asset"].buffer == nil {
		t.Fatal("bounded asset chunk unexpectedly used a temporary file")
	}
	if _, err := a.addBinary(binaryBodyFrame("asset", 0, body)); err != nil {
		t.Fatal(err)
	}
	_, result, _, err := a.finish(httpRequestStreamV2End{Type: "http_request_stream_v2_end", ID: "asset",
		ChunkCount: 1, TotalBytes: int64(len(body)), SHA256: digest})
	if err != nil {
		t.Fatal(err)
	}
	defer result.Close()
	actual, err := io.ReadAll(result)
	if err != nil || string(actual) != string(body) {
		t.Fatalf("asset body differs: %v", err)
	}
}

func initBodyStreamForTest(t *testing.T, assembler *requestBodyStreamAssembler, id string, body []byte) string {
	t.Helper()
	digest := sha256.Sum256(body)
	encodedDigest := hex.EncodeToString(digest[:])
	err := assembler.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: id,
		Method: "POST", Path: "/api/test", Headers: map[string]string{"Content-Type": "application/octet-stream"},
		TotalBytes: int64(len(body)), SHA256: encodedDigest})
	if err != nil {
		t.Fatal(err)
	}
	return encodedDigest
}

func TestRequestBodyStreamReassemblesToPrivateFileAndVerifiesDigest(t *testing.T) {
	assembler := newRequestBodyStreamAssembler()
	body := make([]byte, maxBodyStreamChunk+19)
	for index := range body {
		body[index] = byte(index % 251)
	}
	digest := initBodyStreamForTest(t, assembler, "req1", body)
	if err := assembler.add(httpRequestStreamV2Chunk{Type: "http_request_stream_v2_chunk", ID: "req1", Index: 0,
		DataBase64: base64.StdEncoding.EncodeToString(body[:maxBodyStreamChunk])}); err != nil {
		t.Fatal(err)
	}
	if err := assembler.add(httpRequestStreamV2Chunk{Type: "http_request_stream_v2_chunk", ID: "req1", Index: 1,
		DataBase64: base64.StdEncoding.EncodeToString(body[maxBodyStreamChunk:])}); err != nil {
		t.Fatal(err)
	}
	request, file, length, err := assembler.finish(httpRequestStreamV2End{Type: "http_request_stream_v2_end", ID: "req1",
		ChunkCount: 2, TotalBytes: int64(len(body)), SHA256: digest})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
	actual, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if request.Method != "POST" || request.Path != "/api/test" || length != int64(len(body)) || string(actual) != string(body) {
		t.Fatal("request metadata or streamed file did not match the source")
	}
	if assembler.reservedBytes != 0 || len(assembler.streams) != 0 {
		t.Fatal("finished stream retained its reservation")
	}
}

func TestRequestBodyStreamRejectsBadOrderAndDigestAndCleansFiles(t *testing.T) {
	assembler := newRequestBodyStreamAssembler()
	body := []byte("verified upload")
	digest := initBodyStreamForTest(t, assembler, "req2", body)
	state := assembler.streams["req2"]
	if err := assembler.add(httpRequestStreamV2Chunk{Type: "http_request_stream_v2_chunk", ID: "req2", Index: 1,
		DataBase64: base64.StdEncoding.EncodeToString(body)}); err == nil {
		t.Fatal("out-of-order chunk was accepted")
	}
	if _, ok := assembler.streams["req2"]; ok || assembler.reservedBytes != 0 {
		t.Fatal("invalid chunk retained stream state")
	}
	if _, err := os.Stat(state.path); !os.IsNotExist(err) {
		t.Fatalf("invalid stream file was not removed: %v", err)
	}

	digest = initBodyStreamForTest(t, assembler, "req3", body)
	if err := assembler.add(httpRequestStreamV2Chunk{Type: "http_request_stream_v2_chunk", ID: "req3", Index: 0,
		DataBase64: base64.StdEncoding.EncodeToString(body)}); err != nil {
		t.Fatal(err)
	}
	state = assembler.streams["req3"]
	if _, _, _, err := assembler.finish(httpRequestStreamV2End{Type: "http_request_stream_v2_end", ID: "req3",
		ChunkCount: 1, TotalBytes: int64(len(body)), SHA256: "0" + digest[1:]}); err == nil {
		t.Fatal("wrong final digest was accepted")
	}
	if _, err := os.Stat(state.path); !os.IsNotExist(err) {
		t.Fatalf("digest failure file was not removed: %v", err)
	}
	assembler.close()
}

func TestRequestBodyStreamEnforcesPerRequestAndConcurrentBounds(t *testing.T) {
	assembler := newRequestBodyStreamAssembler()
	digest := sha256.Sum256([]byte("x"))
	if err := assembler.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: "req4", Method: "POST",
		Path: "/api/test", TotalBytes: maxBodyStreamBytes + 1, SHA256: hex.EncodeToString(digest[:])}); err == nil {
		t.Fatal("oversized stream was accepted")
	}
	if err := assembler.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: "req5", Method: "POST",
		Path: "/api/test", TotalBytes: 1, SHA256: hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	if err := assembler.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: "req6", Method: "POST",
		Path: "/api/test", TotalBytes: 1, SHA256: hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	if err := assembler.begin(httpRequestStreamV2Init{Type: "http_request_stream_v2_init", ID: "req7", Method: "POST",
		Path: "/api/test", TotalBytes: 1, SHA256: hex.EncodeToString(digest[:])}); err == nil {
		t.Fatal("concurrent stream capacity was exceeded")
	}
	assembler.close()
}
