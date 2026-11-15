package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func validProposal() brokerRequest {
	return brokerRequest{
		Version:   protocolVersion,
		Type:      "propose",
		RequestID: "req-1",
		SessionID: "session-1",
		RunID:     "run-1",
		TurnID:    "turn-1",
		ActionID:  "action-1",
		Operation: "service.restart",
		TargetID:  firstBrokerTargetID,
	}
}

func TestDecodeBrokerRequestRequiresVersionedStructuredOperation(t *testing.T) {
	encoded, err := json.Marshal(validProposal())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBrokerRequest(encoded); err != nil {
		t.Fatalf("valid proposal was rejected: %v", err)
	}
	for name, payload := range map[string][]byte{
		"unknown field":                 []byte(`{"version":2,"type":"propose","operation":"service.restart","targetId":"Ragent-Broker-QA-Target","requestId":"r","sessionId":"s","runId":"run","turnId":"t","actionId":"a","command":"powershell"}`),
		"self-asserted caller identity": []byte(`{"version":2,"type":"propose","operation":"service.restart","targetId":"Ragent-Broker-QA-Target","requestId":"r","sessionId":"s","runId":"run","turnId":"t","actionId":"a","serviceSid":"S-1-5-80-1-2-3-4-5","approved":true}`),
		"shell operation":               []byte(`{"version":2,"type":"propose","operation":"shell.exec","targetId":"Ragent-Broker-QA-Target","requestId":"r","sessionId":"s","runId":"run","turnId":"t","actionId":"a"}`),
		"unsupported version":           []byte(`{"version":1,"type":"health"}`),
		"extra JSON value":              []byte(`{"version":1,"type":"health"} {}`),
		"missing correlation":           []byte(`{"version":2,"type":"propose","operation":"service.restart","targetId":"Ragent-Broker-QA-Target","requestId":"r"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeBrokerRequest(payload); err == nil {
				t.Fatal("malformed or unbounded request was accepted")
			}
		})
	}
}

func TestDecodeBrokerRequestEnforcesFrameLimit(t *testing.T) {
	if _, err := decodeBrokerRequest([]byte(strings.Repeat("x", maxIPCFrame+1))); err == nil {
		t.Fatal("oversized frame was accepted")
	}
}

func TestDecodePendingRequestBindsOnlyDeviceAndCursor(t *testing.T) {
	request := brokerRequest{Version: protocolVersion, Type: "pending", DeviceID: strings.Repeat("a", 64), Cursor: "req-16"}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBrokerRequest(encoded); err != nil {
		t.Fatalf("valid pending query was rejected: %v", err)
	}
	if _, err := decodeBrokerRequest([]byte(`{"version":2,"type":"pending","deviceId":"` + strings.Repeat("a", 64) + `","approved":true}`)); err == nil {
		t.Fatal("pending query accepted a self-asserted approval field")
	}
}

func TestRequestDigestBindsEveryOperationField(t *testing.T) {
	first, err := requestDigest(validProposal())
	if err != nil {
		t.Fatal(err)
	}
	second, err := requestDigest(validProposal())
	if err != nil || first != second {
		t.Fatalf("request digest is not stable: %q %q %v", first, second, err)
	}
	changed := validProposal()
	changed.ActionID = "different-action"
	third, err := requestDigest(changed)
	if err != nil || first == third {
		t.Fatalf("action change did not change digest: %q %q %v", first, third, err)
	}
}

func TestDecodeBrokerRequestRejectsArbitraryTarget(t *testing.T) {
	request := validProposal()
	request.TargetID = "arbitrary-service"
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeBrokerRequest(encoded); err == nil {
		t.Fatal("arbitrary service target was accepted")
	}
}
