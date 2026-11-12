package main

// A narrowly scoped transport for encrypted instance-to-instance sync. This
// process exchanges SDP and opaque data frames over its parent's pipes; it
// cannot open an HTTP listener or execute a request itself.
import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const syncMaxPayload = 8 << 20
const syncChunkSize = 12 << 10

type syncControl struct {
	Type          string  `json:"type"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
	Data          string  `json:"data,omitempty"`
}

type syncAssembly struct {
	next    uint32
	total   uint32
	data    []byte
	started time.Time
}

func runProviderSyncPeer() error {
	role := os.Getenv("RAGENT_P2P_PROVIDER_ROLE")
	if role != "host" && role != "mobile" {
		return errors.New("invalid peer role")
	}
	var servers []iceServerConfig
	if err := json.Unmarshal([]byte(os.Getenv("AGENTOC_P2P_ICE_SERVERS_JSON")), &servers); err != nil || len(servers) == 0 {
		return errors.New("missing ICE configuration")
	}
	ice := make([]webrtc.ICEServer, 0, len(servers))
	for _, server := range servers {
		if len(server.URLs) == 0 {
			return errors.New("invalid ICE server")
		}
		ice = append(ice, webrtc.ICEServer{URLs: server.URLs, Username: server.Username, Credential: server.Credential})
	}
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
	if err != nil {
		return err
	}
	defer peer.Close()
	var output sync.Mutex
	emitSync := func(value any) {
		output.Lock()
		defer output.Unlock()
		if encoded, err := json.Marshal(value); err == nil {
			fmt.Fprintln(os.Stdout, string(encoded))
		}
	}
	peer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		value := candidate.ToJSON()
		emitSync(syncControl{Type: "candidate", Candidate: value.Candidate, SDPMid: value.SDPMid, SDPMLineIndex: value.SDPMLineIndex})
	})
	var channel *webrtc.DataChannel
	var channelMu, sendMu, assemblyMu sync.Mutex
	assemblies := map[uint64]*syncAssembly{}
	var nextID atomic.Uint64
	attach := func(dc *webrtc.DataChannel) {
		if dc.Label() != "ragent-provider-sync-v1" {
			_ = dc.Close()
			return
		}
		channelMu.Lock()
		if channel != nil {
			channelMu.Unlock()
			_ = dc.Close()
			return
		}
		channel = dc
		channelMu.Unlock()
		dc.OnOpen(func() { emitSync(syncControl{Type: "open"}) })
		dc.OnClose(func() { emitSync(syncControl{Type: "closed"}) })
		dc.OnMessage(func(message webrtc.DataChannelMessage) {
			if message.IsString || len(message.Data) < 16 {
				_ = dc.Close()
				return
			}
			id := binary.BigEndian.Uint64(message.Data[:8])
			index := binary.BigEndian.Uint32(message.Data[8:12])
			total := binary.BigEndian.Uint32(message.Data[12:16])
			chunk := message.Data[16:]
			if total == 0 || total > (syncMaxPayload+syncChunkSize-1)/syncChunkSize || len(chunk) > syncChunkSize || index >= total {
				_ = dc.Close()
				return
			}
			assemblyMu.Lock()
			defer assemblyMu.Unlock()
			for key, value := range assemblies {
				if time.Since(value.started) > time.Minute {
					delete(assemblies, key)
				}
			}
			item := assemblies[id]
			if item == nil {
				if index != 0 || len(assemblies) >= 2 {
					_ = dc.Close()
					return
				}
				item = &syncAssembly{total: total, started: time.Now()}
				assemblies[id] = item
			}
			if item.total != total || item.next != index || len(item.data)+len(chunk) > syncMaxPayload {
				_ = dc.Close()
				return
			}
			item.data = append(item.data, chunk...)
			item.next++
			if item.next == item.total {
				delete(assemblies, id)
				emitSync(syncControl{Type: "data", Data: base64.StdEncoding.EncodeToString(item.data)})
			}
		})
	}
	peer.OnDataChannel(attach)
	if role == "mobile" {
		dc, err := peer.CreateDataChannel("ragent-provider-sync-v1", nil)
		if err != nil {
			return err
		}
		attach(dc)
	}
	var pending []webrtc.ICECandidateInit
	remoteSet := false
	if role == "mobile" {
		offer, err := peer.CreateOffer(nil)
		if err != nil {
			return err
		}
		if err = peer.SetLocalDescription(offer); err != nil {
			return err
		}
		emitSync(syncControl{Type: "offer", SDP: offer.SDP})
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), syncMaxPayload*2)
	for scanner.Scan() {
		var input syncControl
		if json.Unmarshal(scanner.Bytes(), &input) != nil {
			return errors.New("invalid control message")
		}
		switch input.Type {
		case "offer", "answer":
			if remoteSet || (input.Type == "offer") != (role == "host") {
				return errors.New("unexpected peer description")
			}
			sdpType := webrtc.SDPTypeAnswer
			if input.Type == "offer" {
				sdpType = webrtc.SDPTypeOffer
			}
			if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: sdpType, SDP: input.SDP}); err != nil {
				return err
			}
			remoteSet = true
			for _, candidate := range pending {
				if err := peer.AddICECandidate(candidate); err != nil {
					return err
				}
			}
			pending = nil
			if input.Type == "offer" {
				answer, err := peer.CreateAnswer(nil)
				if err != nil {
					return err
				}
				if err = peer.SetLocalDescription(answer); err != nil {
					return err
				}
				emitSync(syncControl{Type: "answer", SDP: answer.SDP})
			}
		case "candidate":
			candidate := webrtc.ICECandidateInit{Candidate: input.Candidate, SDPMid: input.SDPMid, SDPMLineIndex: input.SDPMLineIndex}
			if !remoteSet {
				if len(pending) >= 128 {
					return errors.New("too many ICE candidates")
				}
				pending = append(pending, candidate)
			} else if err := peer.AddICECandidate(candidate); err != nil {
				return err
			}
		case "data":
			payload, err := base64.StdEncoding.DecodeString(input.Data)
			if err != nil || len(payload) == 0 || len(payload) > syncMaxPayload {
				return errors.New("invalid sync data")
			}
			channelMu.Lock()
			dc := channel
			channelMu.Unlock()
			if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
				return errors.New("sync channel is not open")
			}
			sendMu.Lock()
			id := nextID.Add(1)
			total := uint32((len(payload) + syncChunkSize - 1) / syncChunkSize)
			for index := uint32(0); index < total; index++ {
				deadline := time.Now().Add(30 * time.Second)
				for dc.BufferedAmount() > 1<<20 {
					if dc.ReadyState() != webrtc.DataChannelStateOpen || time.Now().After(deadline) {
						sendMu.Unlock()
						return errors.New("sync channel backpressure timeout")
					}
					time.Sleep(10 * time.Millisecond)
				}
				start := int(index) * syncChunkSize
				end := start + syncChunkSize
				if end > len(payload) {
					end = len(payload)
				}
				frame := make([]byte, 16+end-start)
				binary.BigEndian.PutUint64(frame[:8], id)
				binary.BigEndian.PutUint32(frame[8:12], index)
				binary.BigEndian.PutUint32(frame[12:16], total)
				copy(frame[16:], payload[start:end])
				if err := dc.Send(frame); err != nil {
					sendMu.Unlock()
					return err
				}
			}
			sendMu.Unlock()
		default:
			return errors.New("unsupported control message")
		}
	}
	return scanner.Err()
}
