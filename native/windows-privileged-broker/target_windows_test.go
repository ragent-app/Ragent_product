//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestBrokerTargetTransitionAllowsOldStableState(t *testing.T) {
	cases := []struct {
		name    string
		current uint32
		wanted  uint32
		allowed bool
	}{
		{"running before stop transition", windows.SERVICE_RUNNING, windows.SERVICE_STOPPED, true},
		{"stop pending", windows.SERVICE_STOP_PENDING, windows.SERVICE_STOPPED, true},
		{"stopped before start transition", windows.SERVICE_STOPPED, windows.SERVICE_RUNNING, true},
		{"start pending", windows.SERVICE_START_PENDING, windows.SERVICE_RUNNING, true},
		{"start pending while stopping", windows.SERVICE_START_PENDING, windows.SERVICE_STOPPED, false},
		{"stop pending while starting", windows.SERVICE_STOP_PENDING, windows.SERVICE_RUNNING, false},
		{"paused while stopping", windows.SERVICE_PAUSED, windows.SERVICE_STOPPED, false},
		{"paused while starting", windows.SERVICE_PAUSED, windows.SERVICE_RUNNING, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if actual := brokerTargetTransitionPending(test.current, test.wanted); actual != test.allowed {
				t.Fatalf("state %d toward %d: allowed=%t want %t", test.current, test.wanted, actual, test.allowed)
			}
		})
	}
}

func TestBrokerTargetFingerprintBindsEveryCollectedFact(t *testing.T) {
	base := brokerTargetFingerprintInput{
		ServiceName: firstBrokerTargetID, ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
		StartType: windows.SERVICE_DEMAND_START, ErrorControl: windows.SERVICE_ERROR_IGNORE,
		BinaryPathName:   `G:\Program Files\Ragent\BrokerQA\Ragent-Broker-QA-Target.exe`,
		ServiceStartName: `NT AUTHORITY\LocalService`, BinarySHA256: stringsOf('a', 64),
		ServiceSecuritySDDL: "service-sddl", BinarySecuritySDDL: "binary-sddl",
	}
	baseHash := brokerTargetFingerprint(base)
	if len(baseHash) != 64 {
		t.Fatalf("fingerprint is not SHA-256: %q", baseHash)
	}
	if baseHash != brokerTargetFingerprint(base) {
		t.Fatal("same collected facts produced different target fingerprints")
	}
	mutations := []struct {
		name string
		edit func(*brokerTargetFingerprintInput)
	}{
		{"service name", func(v *brokerTargetFingerprintInput) { v.ServiceName += "x" }},
		{"service type", func(v *brokerTargetFingerprintInput) { v.ServiceType++ }},
		{"start type", func(v *brokerTargetFingerprintInput) { v.StartType++ }},
		{"error control", func(v *brokerTargetFingerprintInput) { v.ErrorControl++ }},
		{"image path", func(v *brokerTargetFingerprintInput) { v.BinaryPathName += " " }},
		{"load group", func(v *brokerTargetFingerprintInput) { v.LoadOrderGroup = "group" }},
		{"dependencies", func(v *brokerTargetFingerprintInput) { v.Dependencies = []string{"other-service"} }},
		{"service account", func(v *brokerTargetFingerprintInput) { v.ServiceStartName = "LocalSystem" }},
		{"display name", func(v *brokerTargetFingerprintInput) { v.DisplayName = "changed" }},
		{"description", func(v *brokerTargetFingerprintInput) { v.Description = "changed" }},
		{"service SID type", func(v *brokerTargetFingerprintInput) { v.ServiceSIDType++ }},
		{"delayed start", func(v *brokerTargetFingerprintInput) { v.DelayedAutoStart = true }},
		{"binary hash", func(v *brokerTargetFingerprintInput) { v.BinarySHA256 = stringsOf('b', 64) }},
		{"service ACL", func(v *brokerTargetFingerprintInput) { v.ServiceSecuritySDDL = "changed" }},
		{"file ACL", func(v *brokerTargetFingerprintInput) { v.BinarySecuritySDDL = "changed" }},
		{"recovery action", func(v *brokerTargetFingerprintInput) { v.RecoveryActions = []int{1} }},
		{"recovery command", func(v *brokerTargetFingerprintInput) { v.RecoveryCommand = "command" }},
		{"non-crash recovery", func(v *brokerTargetFingerprintInput) { v.RecoveryOnNonCrash = true }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			changed := base
			changed.Dependencies = append([]string(nil), base.Dependencies...)
			changed.RecoveryActions = append([]int(nil), base.RecoveryActions...)
			mutation.edit(&changed)
			if changedHash := brokerTargetFingerprint(changed); changedHash == baseHash {
				t.Fatalf("target fingerprint did not bind %s", mutation.name)
			}
		})
	}
}

func TestBrokerTargetConfigAcceptsOnlyFixedServiceShape(t *testing.T) {
	base := mgr.Config{
		ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:        windows.SERVICE_DEMAND_START,
		ErrorControl:     windows.SERVICE_ERROR_IGNORE,
		ServiceStartName: `NT AUTHORITY\LocalService`,
	}
	if !validBrokerTargetConfig(base) {
		t.Fatal("fixed LocalService own-process demand-start configuration was rejected")
	}
	mutations := []struct {
		name string
		edit func(*mgr.Config)
	}{
		{"shared process", func(v *mgr.Config) { v.ServiceType = windows.SERVICE_WIN32_SHARE_PROCESS }},
		{"automatic start", func(v *mgr.Config) { v.StartType = windows.SERVICE_AUTO_START }},
		{"critical error handling", func(v *mgr.Config) { v.ErrorControl = windows.SERVICE_ERROR_CRITICAL }},
		{"load group", func(v *mgr.Config) { v.LoadOrderGroup = "group" }},
		{"tagged service", func(v *mgr.Config) { v.TagId = 1 }},
		{"dependency", func(v *mgr.Config) { v.Dependencies = []string{"other-service"} }},
		{"LocalSystem account", func(v *mgr.Config) { v.ServiceStartName = "LocalSystem" }},
		{"delayed automatic start", func(v *mgr.Config) { v.DelayedAutoStart = true }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			changed := base
			mutation.edit(&changed)
			if validBrokerTargetConfig(changed) {
				t.Fatalf("unsafe %s target config was accepted", mutation.name)
			}
		})
	}
}

func TestBrokerSignedApprovalRestartsFixedLocalSCMService(t *testing.T) {
	if os.Getenv("RAGENT_BROKER_RUN_LOCAL_SCM_TARGET_TEST") != "1" {
		t.Skip("set RAGENT_BROKER_RUN_LOCAL_SCM_TARGET_TEST=1 in an elevated local Windows session")
	}
	token := windows.GetCurrentProcessToken()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	isAdmin, err := token.IsMember(admins)
	if err != nil || !isAdmin {
		t.Fatalf("local SCM target test requires an elevated administrator token: member=%t error=%v", isAdmin, err)
	}

	root := filepath.Clean(os.Getenv("RAGENT_BROKER_LOCAL_TARGET_ROOT"))
	if root == "." || !filepath.IsAbs(root) || !strings.EqualFold(filepath.Base(root), "BrokerQA") ||
		!strings.EqualFold(filepath.Base(filepath.Dir(root)), "Ragent") ||
		!strings.EqualFold(filepath.Base(filepath.Dir(filepath.Dir(root))), "Program Files") {
		t.Fatalf("refusing target root outside Program Files\\Ragent\\BrokerQA: %q", root)
	}
	if _, err := os.Lstat(root); err == nil {
		t.Fatalf("refusing pre-existing target root: %s", root)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("inspect target root: %v", err)
	}

	parent := filepath.Dir(root)
	createdParent := false
	if _, err := os.Lstat(parent); errors.Is(err, os.ErrNotExist) {
		createdParent = true
	} else if err != nil {
		t.Fatalf("inspect target parent: %v", err)
	}
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatalf("create isolated target directory: %v", err)
	}
	targetBinary := filepath.Join(root, targetExecutableName)
	targetCreated := false
	var service *mgr.Service
	var manager *mgr.Mgr
	var lastTargetProcessID uint32
	cleanup := func() {
		if service != nil {
			if status, queryErr := service.Query(); queryErr == nil && status.State != svc.Stopped {
				lastTargetProcessID = status.ProcessId
				if _, stopErr := service.Control(svc.Stop); stopErr != nil && !errors.Is(stopErr, windows.ERROR_SERVICE_NOT_ACTIVE) {
					t.Errorf("stop local QA target during cleanup: %v", stopErr)
				}
				if waitErr := waitForFixtureServiceState(service, svc.Stopped); waitErr != nil {
					t.Errorf("wait for local QA target to stop during cleanup: %v", waitErr)
				}
			}
			if lastTargetProcessID != 0 {
				if waitErr := waitForFixtureProcessExit(lastTargetProcessID, 10*time.Second); waitErr != nil {
					t.Errorf("wait for local QA target process to exit during cleanup: %v", waitErr)
				}
			}
			if deleteErr := service.Delete(); deleteErr != nil && !errors.Is(deleteErr, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
				t.Errorf("delete local QA target service: %v", deleteErr)
			}
			_ = service.Close()
			service = nil
			if manager != nil {
				deadline := time.Now().Add(10 * time.Second)
				for time.Now().Before(deadline) {
					current, openErr := manager.OpenService(firstBrokerTargetID)
					if errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
						break
					}
					if openErr != nil {
						t.Errorf("verify local QA target service removal: %v", openErr)
						break
					}
					_ = current.Close()
					time.Sleep(100 * time.Millisecond)
				}
				if current, openErr := manager.OpenService(firstBrokerTargetID); openErr == nil {
					_ = current.Close()
					t.Errorf("local QA target service registration remained after cleanup")
				} else if !errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
					t.Errorf("verify final local QA target service removal: %v", openErr)
				}
			}
		}
		if manager != nil {
			_ = manager.Disconnect()
			manager = nil
		}
		if targetCreated {
			var removeErr error
			deadline := time.Now().Add(10 * time.Second)
			for time.Now().Before(deadline) {
				removeErr = os.Remove(targetBinary)
				if removeErr == nil || errors.Is(removeErr, os.ErrNotExist) {
					removeErr = nil
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
			if removeErr != nil {
				t.Errorf("remove local QA target executable: %v", removeErr)
			}
		}
		if err := os.Remove(root); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Errorf("remove local QA target directory: %v", err)
		}
		if createdParent {
			if err := os.Remove(parent); err != nil && !errors.Is(err, os.ErrNotExist) {
				t.Errorf("remove empty local QA target parent: %v", err)
			}
		}
	}
	t.Cleanup(cleanup)
	if createdParent {
		setLocalTargetOwner(t, parent, true)
	}
	setLocalTargetOwner(t, root, true)

	manager, err = mgr.Connect()
	if err != nil {
		t.Fatalf("connect to SCM: %v", err)
	}
	if existing, openErr := manager.OpenService(firstBrokerTargetID); openErr == nil {
		_ = existing.Close()
		t.Fatalf("refusing pre-existing target service %s", firstBrokerTargetID)
	} else if !errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Fatalf("inspect target service registration: %v", openErr)
	}

	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-o", targetBinary, "./targetfixture")
	if output, buildErr := build.CombinedOutput(); buildErr != nil {
		t.Fatalf("build inert QA target fixture: %v\n%s", buildErr, output)
	}
	targetCreated = true
	if _, err := os.Stat(targetBinary); err != nil {
		t.Fatalf("built QA target is missing: %v", err)
	}
	setLocalTargetOwner(t, targetBinary, false)
	service, err = manager.CreateService(firstBrokerTargetID, targetBinary, mgr.Config{
		ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:        windows.SERVICE_DEMAND_START,
		ErrorControl:     windows.SERVICE_ERROR_IGNORE,
		ServiceStartName: `NT AUTHORITY\LocalService`,
		DisplayName:      "Ragent Broker QA Target",
	})
	if err != nil {
		t.Fatalf("register isolated LocalService QA target: %v", err)
	}
	if err := service.Start(); err != nil {
		t.Fatalf("start isolated QA target: %v", err)
	}
	if err := waitForFixtureServiceState(service, svc.Running); err != nil {
		t.Fatalf("wait for QA target startup: %v", err)
	}
	before, err := service.Query()
	if err != nil || before.State != svc.Running || before.ProcessId == 0 {
		t.Fatalf("QA target was not running before approval: status=%+v error=%v", before, err)
	}
	lastTargetProcessID = before.ProcessId

	controller := windowsBrokerTargetController{}
	fingerprint, err := controller.Fingerprint()
	if err != nil || !isSHA256Hex(fingerprint) {
		t.Fatalf("protected SCM target fingerprint refused: fingerprint=%q error=%v", fingerprint, err)
	}
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := &brokerIPCServer{store: store, target: controller}
	configured := server.handleAdminRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "target.configure"}))
	if configured.Code != "TARGET_CONFIGURED" || configured.Result == nil || configured.Result.Detail != fingerprint {
		t.Fatalf("real target configuration failed: %+v", configured)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment := server.handleAdminRequest(mustJSON(t, brokerRequest{
		Version: protocolVersion, Type: "enrollment.begin", OwnerID: "local-scm-owner",
		DeviceID: deviceID, PublicKey: publicKey,
	}))
	if enrollment.EnrollmentChallenge == nil || enrollment.BrokerSignature == "" {
		t.Fatalf("signed enrollment challenge missing: %+v", enrollment)
	}
	deviceEnrollmentBytes, err := enrollmentSigningBytes(*enrollment.EnrollmentChallenge)
	if err != nil {
		t.Fatal(err)
	}
	brokerEnrollmentBytes, err := brokerEnrollmentSignatureBytes(*enrollment.EnrollmentChallenge)
	if err != nil || verifyBrokerSignature(enrollment.BrokerPublicKey, enrollment.BrokerSignature, brokerEnrollmentBytes) != nil {
		t.Fatalf("Broker enrollment attestation did not verify: %v", err)
	}
	expectedCode, codeErr := enrollmentCode(*enrollment.EnrollmentChallenge)
	if codeErr != nil || enrollment.EnrollmentChallenge.VerificationCode != expectedCode {
		t.Fatal("Broker enrollment comparison code did not verify")
	}
	if response := server.handleAdminRequest(mustJSON(t, brokerRequest{
		Version: protocolVersion, Type: "enrollment.complete", EnrollmentID: enrollment.EnrollmentChallenge.EnrollmentID,
		VerificationCode: enrollment.EnrollmentChallenge.VerificationCode,
		Signature:        signApprovalMessage(t, private, deviceEnrollmentBytes),
	})); response.Code != "DEVICE_ENROLLED" {
		t.Fatalf("device enrollment failed: %+v", response)
	}

	proposal := validProposal()
	challengeResponse := server.handleRequest(mustJSON(t, proposal), false)
	if challengeResponse.Status != statusAwaitingDevice || challengeResponse.Challenge == nil || challengeResponse.BrokerSignature == "" {
		t.Fatalf("real target did not produce a device approval challenge: %+v", challengeResponse)
	}
	challengeBytes, err := brokerSignatureBytes(*challengeResponse.Challenge)
	if err != nil || verifyBrokerSignature(challengeResponse.BrokerPublicKey, challengeResponse.BrokerSignature, challengeBytes) != nil {
		t.Fatalf("Broker approval challenge attestation did not verify: %v", err)
	}
	decisionBytes, err := approvalSigningBytes(*challengeResponse.Challenge, "approve")
	if err != nil {
		t.Fatal(err)
	}
	decision := brokerRequest{
		Version: protocolVersion, Type: "decision", RequestID: proposal.RequestID,
		DeviceID: deviceID, Choice: "approve", Signature: signApprovalMessage(t, private, decisionBytes),
	}
	result := server.handleRequest(mustJSON(t, decision), false)
	if result.Status != statusSucceeded || result.Code != "SERVICE_RESTARTED" || result.Result == nil || result.Result.Detail != "restarted" {
		t.Fatalf("signed approval did not complete real SCM restart: %+v", result)
	}
	if err := waitForFixtureServiceState(service, svc.Running); err != nil {
		t.Fatalf("QA target did not return to running: %v", err)
	}
	after, err := service.Query()
	if err != nil || after.ProcessId == 0 || after.ProcessId == before.ProcessId {
		t.Fatalf("approval did not replace the SCM target process: before=%+v after=%+v error=%v", before, after, err)
	}
	lastTargetProcessID = after.ProcessId
	if status := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: proposal.RequestID}), false); status.Status != statusSucceeded || status.Result == nil {
		t.Fatalf("durable real-restart result was not available: %+v", status)
	}
	if replay := server.handleRequest(mustJSON(t, decision), false); replay.Code != "DECISION_CONSUMED" {
		t.Fatalf("approval replay was not refused: %+v", replay)
	}
	if stable, queryErr := service.Query(); queryErr != nil || stable.ProcessId != after.ProcessId {
		t.Fatalf("approval replay restarted the target again: before=%+v after=%+v current=%+v error=%v", after, after, stable, queryErr)
	}
	if newFingerprint, err := controller.Fingerprint(); err != nil || newFingerprint != fingerprint {
		t.Fatalf("target fingerprint changed during approved restart: before=%s after=%s error=%v", fingerprint, newFingerprint, err)
	}
}

func setLocalTargetOwner(t *testing.T, path string, directory bool) {
	t.Helper()
	icacls := filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe")
	command := exec.Command(icacls, path, "/setowner", "*S-1-5-32-544")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("set protected QA target owner: %v\n%s", err, output)
	}
	var grant string
	if directory {
		grant = "*S-1-5-19:(OI)(CI)(RX)"
	} else {
		grant = "*S-1-5-19:RX"
	}
	command = exec.Command(icacls, path, "/grant", grant)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("set protected QA target owner: %v\n%s", err, output)
	}
}

func waitForFixtureServiceState(service *mgr.Service, wanted svc.State) error {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == wanted {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for service state %d", wanted)
}

func waitForFixtureProcessExit(processID uint32, timeout time.Duration) error {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, processID)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	result, err := windows.WaitForSingleObject(process, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("process %d did not exit before timeout", processID)
	}
	return nil
}

func stringsOf(char byte, length int) string {
	value := make([]byte, length)
	for index := range value {
		value[index] = char
	}
	return string(value)
}
