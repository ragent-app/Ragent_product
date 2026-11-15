package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// Exercise two ordered SCTP streams in one PeerConnection, including their
// independent response senders. Both responses must remain on their channel.
func TestBulkAndInteractiveChannelsOverWebRTC(t *testing.T) {
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
	sent := make(chan error, 2)
	host.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			go func() {
				var request httpRequest
				if err := json.Unmarshal(message.Data, &request); err != nil {
					sent <- err
					return
				}
				response := httpResponse{ID: "interactive", Type: "http_response", Status: 200, BodyBase64: "b2s="}
				if channel.Label() == "ragent-http-bulk" {
					response.ID = "history"
					response.BodyBase64 = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("history", 50000)))
				}
				if request.ID != response.ID || request.Type != "http_request" || !request.AcceptResponseStream {
					sent <- fmt.Errorf("request crossed channels or changed")
					return
				}
				sent <- newResponseSender(channel, func() bool { return true }).send(request, response)
			}()
		})
	})
	interactive, err := client.CreateDataChannel("ragent-http", nil)
	if err != nil {
		t.Fatal(err)
	}
	bulk, err := client.CreateDataChannel("ragent-http-bulk", nil)
	if err != nil {
		t.Fatal(err)
	}
	interactiveMessages := make(chan []byte, 8)
	bulkMessages := make(chan []byte, 64)
	interactive.OnMessage(func(msg webrtc.DataChannelMessage) { interactiveMessages <- append([]byte(nil), msg.Data...) })
	bulk.OnMessage(func(msg webrtc.DataChannelMessage) { bulkMessages <- append([]byte(nil), msg.Data...) })
	requestSent := make(chan error, 2)
	interactive.OnOpen(func() {
		requestSent <- interactive.SendText(`{"id":"interactive","type":"http_request","acceptResponseStream":true}`)
	})
	bulk.OnOpen(func() {
		requestSent <- bulk.SendText(`{"id":"history","type":"http_request","acceptResponseStream":true}`)
	})
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
	gather = webrtc.GatheringCompletePromise(host)
	if err = host.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gather:
	case <-time.After(10 * time.Second):
		t.Fatal("host ICE gathering timed out")
	}
	if err = client.SetRemoteDescription(*host.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(25 * time.Second)
	var history []byte
	index := 0
	gotInteractive := false
	for !gotInteractive || len(history) == 0 || !json.Valid(history) {
		select {
		case raw := <-interactiveMessages:
			var response httpResponse
			if json.Unmarshal(raw, &response) != nil || response.ID != "interactive" || response.BodyBase64 != "b2s=" || gotInteractive {
				t.Fatal("interactive response crossed channels or changed")
			}
			gotInteractive = true
		case raw := <-bulkMessages:
			var frame httpResponseStreamFrame
			if json.Unmarshal(raw, &frame) != nil || frame.Type != "http_response_stream_v1" || frame.ID != "history" || frame.Index != index {
				t.Fatal("history response crossed channels or lost ordering")
			}
			chunk, err := base64.StdEncoding.DecodeString(frame.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			history = append(history, chunk...)
			index++
		case <-deadline:
			t.Fatal("independent responses did not complete")
		}
	}
	var result httpResponse
	if json.Unmarshal(history, &result) != nil || result.ID != "history" || result.BodyBase64 != base64.StdEncoding.EncodeToString([]byte(strings.Repeat("history", 50000))) {
		t.Fatal("history response changed")
	}
	for i := 0; i < 2; i++ {
		select {
		case err := <-requestSent:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("request sender did not finish")
		}
		select {
		case err := <-sent:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("sender did not finish")
		}
	}
}
