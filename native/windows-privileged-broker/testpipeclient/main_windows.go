//go:build windows

// This test-only service submits one fixed request through the Broker's
// restricted ControlPlane pipe and exits. It is not part of the shipped EXE.
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

const (
	requestPipe     = `\\.\pipe\Ragent.PrivilegedBroker.Request.v2`
	clientPipeMask  = 0x0012019B
	maxFrameBytes   = 64 * 1024
	brokerBinary    = `C:\Program Files\Ragent\Broker\Ragent.PrivilegedBroker.exe`
	brokerStateFile = `C:\ProgramData\Ragent-PrivilegedBroker\state.json`
)

var serviceName = "Ragent-ControlPlane"

type proposal struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
	RunID     string `json:"runId"`
	TurnID    string `json:"turnId"`
	ActionID  string `json:"actionId"`
	Operation string `json:"operation"`
	TargetID  string `json:"targetId"`
}

type response struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Status    string `json:"status"`
	Code      string `json:"code"`
}

type probeService struct{}

func (probeService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	if len(args) != 1 || args[0] != serviceName {
		return false, 87
	}
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	if err := submitOneProposal(); err != nil {
		if serviceName == "Ragent-RunnerSupervisor" && errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			if err := assertProtectedBoundary(); err == nil {
				return false, 0
			}
		}
		fmt.Fprintln(os.Stderr, "APB_TEST_CLIENT_REFUSED")
		return false, 1
	}
	return false, 0
}

func assertProtectedBoundary() error {
	if err := assertFileWriteRefused(brokerStateFile); err != nil {
		return err
	}
	if err := assertFileWriteRefused(brokerBinary); err != nil {
		return err
	}
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseServiceHandle(manager)
	name, err := windows.UTF16PtrFromString("Ragent-PrivilegedBroker")
	if err != nil {
		return err
	}
	service, err := windows.OpenService(manager, name, windows.SERVICE_CHANGE_CONFIG)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = windows.CloseServiceHandle(service)
	return errors.New("APB_TEST_BROKER_SERVICE_CONFIG_WRITABLE")
}

func assertFileWriteRefused(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil
	}
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		return nil
	}
	if err != nil {
		return err
	}
	_ = windows.CloseHandle(handle)
	return errors.New("APB_TEST_STATE_WRITE_ALLOWED")
}

func submitOneProposal() error {
	name, err := windows.UTF16PtrFromString(requestPipe)
	if err != nil {
		return err
	}
	var pipe windows.Handle
	for attempt := 0; attempt < 50; attempt++ {
		pipe, err = windows.CreateFile(name, clientPipeMask, 0, nil, windows.OPEN_EXISTING,
			windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pipe)

	request := proposal{
		Version:   2,
		Type:      "propose",
		RequestID: "qa-request-1",
		SessionID: "qa-session-1",
		RunID:     "qa-run-1",
		TurnID:    "qa-turn-1",
		ActionID:  "qa-action-1",
		Operation: "service.restart",
		TargetID:  "Ragent-Broker-QA-Target",
	}
	payload, err := json.Marshal(request)
	if err != nil || len(payload) == 0 || len(payload) > maxFrameBytes {
		return fmt.Errorf("invalid test request")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if err := writeAll(pipe, header[:]); err != nil {
		return err
	}
	if err := writeAll(pipe, payload); err != nil {
		return err
	}
	var responseHeader [4]byte
	if err := readAll(pipe, responseHeader[:]); err != nil {
		return err
	}
	responseLength := binary.LittleEndian.Uint32(responseHeader[:])
	if responseLength == 0 || responseLength > maxFrameBytes {
		return fmt.Errorf("invalid test response frame")
	}
	responsePayload := make([]byte, int(responseLength))
	if err := readAll(pipe, responsePayload); err != nil {
		return err
	}
	var result response
	if err := json.Unmarshal(responsePayload, &result); err != nil {
		return err
	}
	if result.Version != 2 || result.Type != "result" || result.RequestID != request.RequestID || result.Status != "denied" || result.Code != "BROKER_TARGET_NOT_CONFIGURED" {
		return fmt.Errorf("unexpected Broker response")
	}
	return nil
}

func writeAll(handle windows.Handle, data []byte) error {
	for offset := 0; offset < len(data); {
		var written uint32
		if err := windows.WriteFile(handle, data[offset:], &written, nil); err != nil {
			return err
		}
		if written == 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += int(written)
	}
	return nil
}

func readAll(handle windows.Handle, data []byte) error {
	for offset := 0; offset < len(data); {
		var read uint32
		if err := windows.ReadFile(handle, data[offset:], &read, nil); err != nil {
			return err
		}
		if read == 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += int(read)
	}
	return nil
}

func main() {
	if (serviceName != "Ragent-ControlPlane" && serviceName != "Ragent-RunnerSupervisor") || len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "APB_TEST_CLIENT_ARGUMENTS_REFUSED")
		os.Exit(2)
	}
	if err := svc.Run(serviceName, probeService{}); err != nil {
		fmt.Fprintln(os.Stderr, "APB_TEST_CLIENT_SCM_REFUSED")
		os.Exit(1)
	}
}
