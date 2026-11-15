package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func makeRequestStreamFrames(id string, payload []byte) []httpRequestStreamFrame {
	digest := sha256.Sum256(payload)
	frames := make([]httpRequestStreamFrame, 0, (len(payload)+maxStreamChunkBytes-1)/maxStreamChunkBytes)
	for index, offset := 0, 0; offset < len(payload); index, offset = index+1, offset+maxStreamChunkBytes {
		end := min(offset+maxStreamChunkBytes, len(payload))
		frames = append(frames, httpRequestStreamFrame{
			Type: "http_request_stream_v1", ID: id, Index: index, TotalBytes: len(payload),
			SHA256:     hex.EncodeToString(digest[:]),
			DataBase64: base64.StdEncoding.EncodeToString(payload[offset:end]),
		})
	}
	return frames
}

func TestRequestStreamAssemblerReassemblesAndFreesBudget(t *testing.T) {
	want := make([]byte, maxStreamChunkBytes*2+19)
	for i := range want {
		want[i] = byte((i * 31) % 251)
	}
	assembler := newRequestStreamAssembler()
	defer assembler.close()
	frames := makeRequestStreamFrames("request_1", want)
	for index, frame := range frames {
		got, complete, err := assembler.add(frame)
		if err != nil {
			t.Fatalf("add chunk %d: %v", index, err)
		}
		if complete != (index == len(frames)-1) {
			t.Fatalf("chunk %d complete=%v", index, complete)
		}
		if complete && string(got) != string(want) {
			t.Fatal("reassembled payload differs")
		}
	}
	if len(assembler.streams) != 0 || assembler.reservedBytes != 0 {
		t.Fatalf("stream budget was not released: streams=%d bytes=%d", len(assembler.streams), assembler.reservedBytes)
	}
}

func TestRequestStreamAssemblerRejectsWrongOrderAndDigest(t *testing.T) {
	data := []byte("streamed request data")
	frames := makeRequestStreamFrames("request_2", data)
	if len(frames) != 1 {
		t.Fatal("fixture should fit one chunk")
	}
	assembler := newRequestStreamAssembler()
	defer assembler.close()
	frames[0].Index = 1
	if _, _, err := assembler.add(frames[0]); err == nil {
		t.Fatal("nonzero first chunk was accepted")
	}

	large := make([]byte, maxStreamChunkBytes+1)
	frames = makeRequestStreamFrames("request_3", large)
	frames[1].DataBase64 = base64.StdEncoding.EncodeToString([]byte{0xff})
	if _, _, err := assembler.add(frames[0]); err != nil {
		t.Fatal(err)
	}
	if _, _, err := assembler.add(frames[1]); err == nil {
		t.Fatal("digest mismatch was accepted")
	}
	if assembler.reservedBytes != 0 {
		t.Fatalf("failed stream retained reservation: %d", assembler.reservedBytes)
	}
}

func TestRequestStreamAssemblerBoundsAndFrameShape(t *testing.T) {
	assembler := newRequestStreamAssembler()
	defer assembler.close()
	if _, _, err := assembler.add(httpRequestStreamFrame{Type: "http_request_stream_v1", ID: "../bad"}); err == nil {
		t.Fatal("unsafe request id was accepted")
	}
	if _, _, err := assembler.add(httpRequestStreamFrame{Type: "http_request_stream_v1", ID: "r", TotalBytes: maxStreamRequestBytes + 1}); err == nil {
		t.Fatal("oversized stream was accepted")
	}
	if _, err := json.Marshal(httpRequestStreamFrame{Type: "http_request_stream_v1", ID: "r"}); err != nil {
		t.Fatalf("wire DTO did not serialize: %v", err)
	}
	assembler.close()
	if _, _, err := assembler.add(httpRequestStreamFrame{Type: "http_request_stream_v1", ID: "r"}); err == nil {
		t.Fatal("closed assembler accepted a stream")
	}
}
