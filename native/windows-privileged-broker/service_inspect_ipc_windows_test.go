//go:build windows

package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestServiceInspectionThroughNamedPipe(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	suffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	base := `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.` + suffix
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, base+".Health", base+".Request")
	if err != nil {
		t.Fatal(err)
	}
	server.serviceInspector = func(name string) (string, error) {
		if name != "Example Service" {
			t.Fatal("wrong service")
		}
		return strings.Repeat("a", 64), nil
	}
	done := make(chan error, 1)
	go func() { done <- server.Run(context.Background()) }()
	t.Cleanup(func() {
		server.Stop()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server failed to stop")
		}
	})
	request := brokerRequest{Version: protocolVersion, Type: "service.inspect", ServiceInspect: &serviceInspectRequest{ServiceName: "Example Service"}}
	result := exchangeTestPipeRequest(t, base+".Request", request)
	if result.Type != "service_inspection" || result.ServiceFacts == nil || result.ServiceFacts.ServiceName != "Example Service" || result.ServiceFacts.DefinitionHash != strings.Repeat("a", 64) {
		t.Fatalf("invalid inspection: %+v", result)
	}
	result = exchangeTestPipeRequest(t, base+".Health", request)
	if result.Code != "HEALTH_PIPE_READ_ONLY" {
		t.Fatalf("health pipe admitted inspection: %+v", result)
	}
	request.ServiceInspect.ServiceName = "bad*"
	raw, _ := json.Marshal(request)
	if _, err := decodeBrokerRequest(raw); err == nil {
		t.Fatal("invalid service name accepted")
	}
	request.ServiceInspect.ServiceName = "Example Service"
	request.RequestID = "extra"
	raw, _ = json.Marshal(request)
	if _, err := decodeBrokerRequest(raw); err == nil {
		t.Fatal("extraneous fields accepted")
	}
}
