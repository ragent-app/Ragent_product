//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Opt-in acceptance touches only a fresh randomly named, inert test service.
// Its executable and all build/cache artifacts remain inside the owner workspace.
func TestWindowsServiceControlIsolatedLiveSCM(t *testing.T) {
	if os.Getenv("RAGENT_BROKER_RUN_ISOLATED_SERVICE_TEST") != "1" {
		t.Skip("isolated live SCM test is opt-in")
	}
	if !strings.HasPrefix(strings.ToLower(filepath.Clean(os.TempDir()))+`\`, `g:\ragent\`) {
		t.Fatal("test temporary directory must be under G:\\Ragent")
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if elevated, err := windows.GetCurrentProcessToken().IsMember(admins); err != nil || !elevated {
		t.Fatalf("isolated SCM test requires an administrator: %v", err)
	}
	random, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := "Ragent-QA-Service-" + random
	binary := filepath.Join(t.TempDir(), "inert-service.exe")
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", binary, "./targetfixture")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, output)
	}
	fixtureDir := filepath.Dir(binary)
	setLocalTargetOwner(t, fixtureDir, true)
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	protect := exec.Command(icacls, fixtureDir, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F")
	if output, err := protect.CombinedOutput(); err != nil {
		t.Fatalf("protect fixture directory: %v\n%s", err, output)
	}
	manager, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Disconnect() })
	if existing, err := manager.OpenService(name); err == nil {
		existing.Close()
		t.Fatal("refusing to replace an existing service")
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Fatal(err)
	}
	service, err := manager.CreateService(name, binary, mgr.Config{
		ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: windows.SERVICE_DEMAND_START,
		ErrorControl: windows.SERVICE_ERROR_IGNORE, DisplayName: "Ragent isolated service test",
	}, "--service-name", name)
	if err != nil {
		t.Fatal(err)
	}
	var lastPID uint32
	t.Cleanup(func() {
		if status, err := service.Query(); err == nil && status.State != svc.Stopped {
			_, _ = service.Control(svc.Stop)
			if err := waitForFixtureServiceState(service, svc.Stopped); err != nil {
				t.Errorf("stop fixture: %v", err)
			}
		}
		if lastPID != 0 {
			if err := waitForFixtureProcessExit(lastPID, 10*time.Second); err != nil {
				t.Errorf("wait for fixture exit: %v", err)
			}
		}
		if err := service.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			t.Errorf("delete fixture: %v", err)
		}
		if err := service.Close(); err != nil {
			t.Errorf("close fixture: %v", err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			current, err := manager.OpenService(name)
			if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
				return
			}
			if err != nil {
				t.Errorf("check fixture cleanup: %v", err)
				return
			}
			_ = current.Close()
			time.Sleep(100 * time.Millisecond)
		}
		t.Error("fixture service was not removed")
	})
	registryKey, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\`+name, windows.WRITE_DAC|windows.WRITE_OWNER)
	if err != nil {
		t.Fatal(err)
	}
	registrySD, err := windows.SecurityDescriptorFromString("D:P(A;;KA;;;SY)(A;;KA;;;BA)")
	if err != nil {
		registryKey.Close()
		t.Fatal(err)
	}
	registryDACL, _, err := registrySD.DACL()
	if err != nil {
		registryKey.Close()
		t.Fatal(err)
	}
	if err := windows.SetSecurityInfo(windows.Handle(registryKey), windows.SE_REGISTRY_KEY,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION,
		admins, nil, registryDACL, nil); err != nil {
		registryKey.Close()
		t.Fatal(err)
	}
	_ = registryKey.Close()
	hash, err := inspectWindowsServiceControl(name)
	if err != nil {
		t.Fatalf("inspect fixture: %v", err)
	}
	setRegistryDACL := func(sddl string) {
		t.Helper()
		key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\`+name, windows.WRITE_DAC)
		if err != nil {
			t.Fatal(err)
		}
		defer key.Close()
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetSecurityInfo(windows.Handle(key), windows.SE_REGISTRY_KEY,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
	}
	setRegistryDACL("D:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;0x00000002;;;BU)")
	if target, err := openWindowsServiceControl(name, "start-service"); err == nil {
		_ = target.Close()
		t.Fatal("service with a user-writable registry key was accepted")
	}
	setRegistryDACL("D:P(A;;KA;;;SY)(A;;KA;;;BA)")
	allowUserWrite := exec.Command(icacls, fixtureDir, "/grant:r", "*S-1-5-32-545:(OI)(CI)M")
	if output, err := allowUserWrite.CombinedOutput(); err != nil {
		t.Fatalf("create writable fixture: %v\n%s", err, output)
	}
	if target, err := openWindowsServiceControl(name, "start-service"); err == nil {
		_ = target.Close()
		t.Fatal("service with a user-writable image directory was accepted")
	}
	removeUserWrite := exec.Command(icacls, fixtureDir, "/remove:g", "*S-1-5-32-545")
	if output, err := removeUserWrite.CombinedOutput(); err != nil {
		t.Fatalf("restore fixture protection: %v\n%s", err, output)
	}
	run := func(action string, expected svc.State) {
		t.Helper()
		request := serviceControlRequest{Name: name, Action: action, DefinitionHash: hash}
		outcome := runServiceControl(context.Background(), request, func(target string) (serviceControlTarget, error) {
			return openWindowsServiceControl(target, action)
		})
		if outcome.Status != statusSucceeded {
			t.Fatalf("%s: %+v", action, outcome)
		}
		status, err := service.Query()
		if err != nil || status.State != expected {
			t.Fatalf("%s state: %+v %v", action, status, err)
		}
		if status.ProcessId != 0 {
			lastPID = status.ProcessId
		}
	}
	run("start-service", svc.Running)
	run("restart-service", svc.Running)
	run("stop-service", svc.Stopped)
	refused := runServiceControl(context.Background(), serviceControlRequest{Name: name, Action: "start-service", DefinitionHash: strings.Repeat("0", 64)},
		func(target string) (serviceControlTarget, error) {
			return openWindowsServiceControl(target, "start-service")
		})
	if refused.Status != statusFailed || refused.Code != "SERVICE_TARGET_CHANGED" {
		t.Fatalf("changed target accepted: %+v", refused)
	}

	// Exercise signed proposal and enrolled-device approval through the broker
	// handler and real SCM backend. The elevated process cannot use the
	// ordinary-user pipe; its peer checks are covered by separate pipe tests.
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.ConfigureAutoInstallSigner("test-key", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	deviceKey, deviceID := enrollServiceTestDevice(t, store, now)
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	base := `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.` + random
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, base+".Health", base+".Request")
	if err != nil {
		t.Fatal(err)
	}
	if server.serviceController == nil {
		t.Fatal("production Windows service controller was not configured")
	}
	done := make(chan error, 1)
	go func() { done <- server.Run(context.Background()) }()
	t.Cleanup(func() {
		server.Stop()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("stop test broker: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("test broker did not stop")
		}
	})
	snapshot := store.Snapshot()
	grant := serviceControlGrant{Version: 1, KeyID: "test-key", BrokerInstallationID: snapshot.InstallationID,
		PolicyGeneration: snapshot.PolicyGeneration, RequestID: "live-request", SessionID: "session", RunID: "run", TurnID: "turn",
		ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwxyz012345", ServiceName: name, Action: "start-service",
		DefinitionHash: hash, Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(grant)))
	proposal := brokerRequest{Version: protocolVersion, Type: "service.propose", ServiceControl: &grant, Signature: signature}
	if result := server.handleRequest(mustJSON(t, proposal), false); result.Status != statusAwaitingDevice {
		t.Fatalf("live proposal failed: %+v", result)
	}
	approval := brokerRequest{Version: protocolVersion, Type: "service.approve", RequestID: grant.RequestID, DeviceID: deviceID,
		DeviceSignature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(grant))}
	if result := server.handleRequest(mustJSON(t, approval), false); result.Status != statusExecuting && result.Status != statusSucceeded {
		t.Fatalf("live approval failed: %+v", result)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID}), false)
		if result.Status == statusSucceeded {
			break
		}
		if result.Status != statusExecuting || time.Now().After(deadline) {
			t.Fatalf("live service result: %+v", result)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status, err := service.Query(); err != nil || status.State != svc.Running {
		t.Fatalf("approved service did not start: %+v %v", status, err)
	} else {
		lastPID = status.ProcessId
	}
	if result := server.handleRequest(mustJSON(t, approval), false); result.Status != statusSucceeded {
		t.Fatalf("approval replay changed outcome: %+v", result)
	}
	if crossDir := os.Getenv("RAGENT_BROKER_LIVE_CLIENT_DIR"); crossDir != "" {
		requireLivePipeTestDir(t, crossDir)
		run("stop-service", svc.Stopped)
		phoneID := ""
		if os.Getenv("RAGENT_BROKER_LIVE_ANDROID") == "1" {
			var phone struct {
				DeviceID  string `json:"deviceId"`
				PublicKey string `json:"publicKey"`
			}
			readLivePipeJSON(t, filepath.Join(crossDir, "phone.json"), &phone)
			if err := validateDeviceIDAndKey(phone.DeviceID, phone.PublicKey); err != nil {
				t.Fatal("invalid isolated Android device identity")
			}
			// Start the normal enrollment protocol against a disposable store.
			// The Android test must complete it with its non-exportable key.
			if _, err := store.BeginEnrollment("owner", phone.DeviceID, phone.PublicKey, time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
			phoneID = phone.DeviceID
		}
		crossGrant := grant
		crossGrant.RequestID, crossGrant.Nonce = "cross-process-request", "zyxwvutsrqponmlkjihgfedc123456"
		crossSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(crossGrant)))
		payload := liveServicePipeCase{Pipe: base + ".Request",
			Proposal: brokerRequest{Version: protocolVersion, Type: "service.propose", ServiceControl: &crossGrant, Signature: crossSignature},
			Approval: brokerRequest{Version: protocolVersion, Type: "service.approve", RequestID: crossGrant.RequestID, DeviceID: deviceID,
				DeviceSignature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(crossGrant))}}
		if phoneID != "" {
			payload.Approval.DeviceID, payload.Approval.DeviceSignature = phoneID, ""
		}
		if os.Getenv("RAGENT_BROKER_LIVE_JS_CONTROL_PLANE") == "1" {
			// Fresh test-only keys authorize only this disposable broker and
			// randomly named fixture service; they never come from an install.
			signerDER, err := x509.MarshalPKCS8PrivateKey(private)
			if err != nil {
				t.Fatal(err)
			}
			payload.HealthPipe = base + ".Health"
			payload.TestSignerKey = base64.StdEncoding.EncodeToString(signerDER)
			if phoneID == "" {
				deviceDER, err := x509.MarshalPKCS8PrivateKey(deviceKey)
				if err != nil {
					t.Fatal(err)
				}
				payload.TestDeviceKey = base64.StdEncoding.EncodeToString(deviceDER)
			}
		}
		writeLivePipeJSON(t, filepath.Join(crossDir, "ready.json"), payload)
		if payload.TestSignerKey != "" {
			t.Cleanup(func() {
				payload.TestSignerKey, payload.TestDeviceKey = "", ""
				redacted, err := json.Marshal(payload)
				if err == nil {
					err = os.WriteFile(filepath.Join(crossDir, "ready.json"), redacted, 0600)
				}
				if err != nil {
					t.Errorf("redact disposable fixture keys: %v", err)
				}
			})
		}
		if phoneID != "" {
			deadline := time.Now().Add(45 * time.Second)
			for {
				if _, enrolled := store.Snapshot().Devices[phoneID]; enrolled {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("Android fixture did not complete enrollment")
				}
				time.Sleep(50 * time.Millisecond)
			}
			writeLivePipeJSON(t, filepath.Join(crossDir, "phone-enrolled.json"), map[string]bool{"enrolled": true})
		}
		var result liveServicePipeResult
		readLivePipeJSON(t, filepath.Join(crossDir, "result.json"), &result)
		if !result.Success {
			t.Fatalf("ordinary-user pipe client failed: %s", result.Error)
		}
		if status, err := service.Query(); err != nil || status.State != svc.Running {
			t.Fatalf("ordinary-user pipe approval did not start service: %+v %v", status, err)
		} else {
			lastPID = status.ProcessId
		}
	}
}

type liveServicePipeCase struct {
	Pipe          string        `json:"pipe"`
	Proposal      brokerRequest `json:"proposal"`
	Approval      brokerRequest `json:"approval"`
	HealthPipe    string        `json:"healthPipe,omitempty"`
	TestSignerKey string        `json:"testSignerKey,omitempty"`
	TestDeviceKey string        `json:"testDeviceKey,omitempty"`
}
type liveServicePipeResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

func requireLivePipeTestDir(t *testing.T, dir string) {
	t.Helper()
	absolute, err := filepath.Abs(dir)
	root := strings.ToLower(filepath.Clean(os.TempDir())) + `\`
	if err != nil || !strings.HasPrefix(strings.ToLower(absolute), root) || !strings.HasPrefix(filepath.Base(absolute), "service-qa-") {
		t.Fatal("cross-process fixture directory is outside the task temporary root")
	}
}

func writeLivePipeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatal("fixture response already exists")
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
}

func readLivePipeJSON(t *testing.T, path string, output any) {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil {
			if len(data) > 64*1024 || json.Unmarshal(data, output) != nil {
				t.Fatal("cross-process fixture response is invalid")
			}
			return
		}
		if !errors.Is(err, os.ErrNotExist) || time.Now().After(deadline) {
			t.Fatalf("cross-process fixture response unavailable: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWindowsServiceControlOrdinaryUserPipe(t *testing.T) {
	dir := os.Getenv("RAGENT_BROKER_LIVE_CLIENT_DIR")
	if dir == "" {
		t.Skip("cross-process live pipe test is opt-in")
	}
	requireLivePipeTestDir(t, dir)
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if elevated, err := windows.GetCurrentProcessToken().IsMember(admins); err != nil || elevated {
		t.Fatal("pipe client must use an ordinary non-elevated token")
	}
	success := false
	defer func() {
		result := liveServicePipeResult{Success: success}
		if !success {
			result.Error = "client test failed"
		}
		writeLivePipeJSON(t, filepath.Join(dir, "result.json"), result)
	}()
	var fixture liveServicePipeCase
	readLivePipeJSON(t, filepath.Join(dir, "ready.json"), &fixture)
	if !strings.HasPrefix(fixture.Pipe, `\\.\pipe\Ragent.PrivilegedBroker.LocalTest.`) ||
		fixture.Proposal.ServiceControl == nil || fixture.Approval.RequestID != fixture.Proposal.ServiceControl.RequestID {
		t.Fatal("invalid cross-process service fixture")
	}
	if result := exchangeTestPipeRequest(t, fixture.Pipe, fixture.Proposal); result.Status != statusAwaitingDevice {
		t.Fatalf("ordinary-user proposal failed: %+v", result)
	}
	if result := exchangeTestPipeRequest(t, fixture.Pipe, fixture.Approval); result.Status != statusExecuting && result.Status != statusSucceeded {
		t.Fatalf("ordinary-user approval failed: %+v", result)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		result := exchangeTestPipeRequest(t, fixture.Pipe, brokerRequest{Version: protocolVersion, Type: "status", RequestID: fixture.Approval.RequestID})
		if result.Status == statusSucceeded {
			break
		}
		if result.Status != statusExecuting || time.Now().After(deadline) {
			t.Fatalf("ordinary-user result: %+v", result)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result := exchangeTestPipeRequest(t, fixture.Pipe, fixture.Approval); result.Status != statusSucceeded {
		t.Fatalf("ordinary-user replay changed outcome: %+v", result)
	}
	success = true
}
