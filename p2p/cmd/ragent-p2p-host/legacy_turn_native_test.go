package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

// Exercise the real JSONL executable with the environment supplied by the old
// Node agent. The TURN listener and relay allocations stay on loopback.
func TestNativeLegacyTurnEnvironment(t *testing.T) {
	binary := os.Getenv("RAGENT_TEST_P2P_HOST_BINARY")
	if binary == "" {
		t.Skip("RAGENT_TEST_P2P_HOST_BINARY is not set")
	}
	listener, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	const username, realm, password = "legacy-fixture", "ragent.test", "loopback-fixture"
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(request *turn.RequestAttributes) (string, []byte, bool) {
			if request.Username != username {
				return "", nil, false
			}
			return username, turn.GenerateAuthKey(username, realm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1",
			},
		}},
	})
	if err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	defer server.Close()
	configured, err := json.Marshal([]iceServerConfig{{
		URLs:     []string{"turn:" + listener.LocalAddr().String() + "?transport=udp"},
		Username: username, Credential: password,
	}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, binary)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "RAGENT_P2P_") {
			child.Env = append(child.Env, entry)
		}
	}
	child.Env = append(child.Env, "RAGENT_P2P_ICE_SERVERS_JSON="+string(configured),
		"RAGENT_P2P_LOCAL_BASE_URL=http://127.0.0.1:1")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = input.Close()
		_ = child.Process.Kill()
		_ = child.Wait()
	}()
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if _, err = peer.CreateDataChannel("legacy-fixture", nil); err != nil {
		t.Fatal(err)
	}
	offer, err := peer.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = peer.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(controlMessage{Type: "offer", SDP: offer.SDP})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fmt.Fprintln(input, string(encoded)); err != nil {
		t.Fatal(err)
	}
	messages := make(chan controlMessage, 32)
	go func() {
		defer close(messages)
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			var message controlMessage
			if json.Unmarshal(scanner.Bytes(), &message) == nil {
				select {
				case messages <- message:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	total, relay := 0, 0
	for {
		select {
		case message, ok := <-messages:
			if !ok {
				t.Fatal("native child closed before completing ICE")
			}
			if message.Type == "candidate" {
				total++
				if strings.Contains(message.Candidate, " typ relay ") {
					relay++
				}
			}
			if message.Type == "ice_complete" {
				if relay == 0 || relay != total {
					t.Fatalf("legacy native route: relay=%d total=%d", relay, total)
				}
				t.Logf("legacy native TURN configuration: relay=%d total=%d", relay, total)
				return
			}
		case <-ctx.Done():
			t.Fatalf("native ICE timed out: relay=%d total=%d", relay, total)
		}
	}
}
