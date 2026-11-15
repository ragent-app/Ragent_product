package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// This uses only local ICE candidates and exercises real SCTP DataChannels.
func TestLargeNegotiatedResponseOverDataChannel(t *testing.T) {
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
	response := httpResponse{ID: "live_request", Type: "http_response", Status: 200, BodyBase64: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("response-data"), 40000))}
	want, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 128)
	sendDone := make(chan error, 1)
	smallDone := make(chan error, 1)
	firstChunkSeen := make(chan struct{})
	host.OnDataChannel(func(ch *webrtc.DataChannel) {
		ch.OnOpen(func() {
			sender := newResponseSender(ch, func() bool { return true })
			go func() {
				sendDone <- sender.send(httpRequest{AcceptResponseStream: true}, response)
			}()
			go func() {
				<-firstChunkSeen
				smallDone <- sender.send(httpRequest{AcceptResponseStream: true}, httpResponse{
					ID: "interactive_request", Type: "http_response", Status: 200, BodyBase64: "b2s=",
				})
			}()
		})
	})
	dc, err := client.CreateDataChannel("ragent-http", nil)
	if err != nil {
		t.Fatal(err)
	}
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { received <- append([]byte(nil), msg.Data...) })
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
	var result []byte
	index := 0
	gotInteractive := false
	timeout := time.After(25 * time.Second)
	for len(result) < len(want) || !gotInteractive {
		select {
		case raw := <-received:
			var envelope struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(raw, &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Type == "http_response" {
				var interactive httpResponse
				if err := json.Unmarshal(raw, &interactive); err != nil {
					t.Fatal(err)
				}
				if gotInteractive || interactive.ID != "interactive_request" || interactive.Status != 200 || interactive.BodyBase64 != "b2s=" {
					t.Fatal("interactive response was misrouted or changed")
				}
				gotInteractive = true
				continue
			}
			var frame httpResponseStreamFrame
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.ID != response.ID || frame.Type != "http_response_stream_v1" || frame.Index != index || frame.TotalBytes != len(want) {
				t.Fatal("invalid response frame")
			}
			data, err := base64.StdEncoding.DecodeString(frame.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			result = append(result, data...)
			index++
			if index == 1 {
				close(firstChunkSeen)
			}
		case <-timeout:
			t.Fatal("large response timed out")
		}
	}
	select {
	case err := <-smallDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("interactive response sender did not finish")
	}
	select {
	case err := <-sendDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("response sender did not finish")
	}
	if !bytes.Equal(result, want) {
		t.Fatal(fmt.Sprintf("large response changed: got %d want %d", len(result), len(want)))
	}
}
