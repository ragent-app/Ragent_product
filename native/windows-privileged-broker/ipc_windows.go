//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	healthPipeName       = `\\.\pipe\Ragent.PrivilegedBroker.Health.v2`
	requestPipeName      = `\\.\pipe\Ragent.PrivilegedBroker.Request.v2`
	adminPipeName        = `\\.\pipe\Ragent.PrivilegedBroker.Admin.v2`
	pipeOperationMS      = 5000
	pipeFrameTimeout     = 5000
	maxRequestsPerMinute = 120
	pipeClientAccessMask = 0x0012019B
)

var impersonateNamedPipeClient = windows.NewLazySystemDLL("advapi32.dll").NewProc("ImpersonateNamedPipeClient")

type brokerIPCServer struct {
	store         *brokerStore
	target        brokerTargetController
	autoInstaller autoInstaller
	msiInspector  func(msiInspectRequest) (*msiInspectFacts, error)
	msiInstaller  interface {
		Install(context.Context, msiInstallGrant) (requestStatus, string)
	}
	ownerInstaller   func(context.Context, string, string, string, string) ownerInstallResult
	ownerPolicy      func() (ownerInstallPolicy, error)
	ownerAvailable   func(string) bool
	serviceInspector func(string) (string, error)
	// Production remains nil until the broker can independently verify the
	// owner's approval. A control-plane signature alone is not owner proof.
	serviceController func(context.Context, serviceControlRequest) serviceControlOutcome
	executionCtx      context.Context
	controlPlaneSID   *windows.SID
	testPipeOwner     *windows.SID
	healthPipeName    string
	requestPipeName   string
	adminPipeName     string
	stopEvent         windows.Handle
	healthPipe        windows.Handle
	requestPipe       windows.Handle
	adminPipe         windows.Handle
	stopOnce          sync.Once
	stopCh            chan struct{}
	workers           sync.WaitGroup
	autoMu            sync.Mutex
	autoCancel        map[string]context.CancelFunc
	rateMu            sync.Mutex
	rateWindowStart   time.Time
	rateCount         int
}

type pipeClientFacts struct {
	PID             uint32
	ProcessCreated  uint64
	UserSID         string
	ServiceSID      string
	IsAdministrator bool
}

func newBrokerIPCServer(store *brokerStore) (*brokerIPCServer, error) {
	sid, _, _, err := windows.LookupSID("", `NT SERVICE\Ragent-ControlPlane`)
	if err != nil {
		return nil, fmt.Errorf("resolve ControlPlane service SID: %w", err)
	}
	return newBrokerIPCServerForPipeNamesAndAdmin(store, sid, healthPipeName, requestPipeName, adminPipeName, false)
}

func newBrokerIPCServerForPipeNames(store *brokerStore, controlPlaneSID *windows.SID, healthName, requestName string) (*brokerIPCServer, error) {
	return newBrokerIPCServerForPipeNamesAndAdmin(store, controlPlaneSID, healthName, requestName, requestName+".Admin", true)
}

func newBrokerIPCServerForPipeNamesAndAdmin(store *brokerStore, controlPlaneSID *windows.SID, healthName, requestName, adminName string, localTest bool) (*brokerIPCServer, error) {
	if store == nil || controlPlaneSID == nil || healthName == "" || requestName == "" || healthName == requestName || adminName == healthName || adminName == requestName {
		return nil, errors.New("APB_IPC_CONFIGURATION_INVALID")
	}
	stop, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return nil, fmt.Errorf("create Broker stop event: %w", err)
	}
	server := &brokerIPCServer{
		store:             store,
		target:            windowsBrokerTargetController{},
		serviceInspector:  inspectWindowsServiceControl,
		serviceController: runWindowsServiceControl,
		autoInstaller:     windowsAutoInstaller{},
		msiInstaller:      windowsMSIInstaller{},
		msiInspector:      inspectWindowsMSI,
		ownerInstaller:    runInstalledOwnerInstall,
		ownerPolicy:       readInstalledOwnerPolicy,
		ownerAvailable:    func(sid string) bool { _, err := discoverOwnerSession(sid); return err == nil },
		controlPlaneSID:   controlPlaneSID,
		healthPipeName:    healthName,
		requestPipeName:   requestName,
		adminPipeName:     adminName,
		stopEvent:         stop,
		stopCh:            make(chan struct{}),
	}
	if localTest {
		validTestName := func(name string) bool {
			for _, prefix := range []string{`\\.\pipe\Ragent.PrivilegedBroker.LocalTest.`, `\\.\pipe\Ragent.PrivilegedBroker.IdentityTest.`, `\\.\pipe\Ragent.PrivilegedBroker.RemoteTest.`} {
				if strings.HasPrefix(name, prefix) {
					return true
				}
			}
			return false
		}
		if !validTestName(healthName) || !validTestName(requestName) {
			_ = windows.CloseHandle(stop)
			return nil, errors.New("APB_IPC_TEST_PIPE_NAME_INVALID")
		}
		user, userErr := windows.GetCurrentProcessToken().GetTokenUser()
		if userErr != nil || !user.User.Sid.Equals(controlPlaneSID) {
			_ = windows.CloseHandle(stop)
			return nil, errors.New("APB_IPC_TEST_IDENTITY_INVALID")
		}
		server.testPipeOwner = controlPlaneSID
	}
	server.healthPipe, err = server.createPipe(server.healthPipeName, true, true)
	if err != nil {
		_ = windows.CloseHandle(stop)
		return nil, err
	}
	server.requestPipe, err = server.createPipe(server.requestPipeName, false, true)
	if err != nil {
		_ = windows.CloseHandle(server.healthPipe)
		_ = windows.CloseHandle(stop)
		return nil, err
	}
	server.adminPipe, err = server.createPipe(server.adminPipeName, false, true)
	if err != nil {
		_ = windows.CloseHandle(server.requestPipe)
		_ = windows.CloseHandle(server.healthPipe)
		_ = windows.CloseHandle(stop)
		return nil, err
	}
	return server, nil
}

func (s *brokerIPCServer) Run(ctx context.Context) error {
	executionCtx, cancelExecution := context.WithCancel(ctx)
	defer cancelExecution()
	s.executionCtx = executionCtx
	results := make(chan error, 3)
	s.workers.Add(3)
	go func() {
		defer s.workers.Done()
		results <- s.servePipe(s.healthPipeName, true, s.healthPipe)
	}()
	go func() {
		defer s.workers.Done()
		results <- s.servePipe(s.requestPipeName, false, s.requestPipe)
	}()
	go func() {
		defer s.workers.Done()
		results <- s.serveAdminPipe(s.adminPipeName, s.adminPipe)
	}()

	var firstErr error
	completed := 0
	for completed < 3 {
		select {
		case err := <-results:
			completed++
			if err != nil && firstErr == nil {
				firstErr = err
				s.Stop()
			}
		case <-ctx.Done():
			s.Stop()
			ctx = context.Background()
		}
	}
	// Stop any active inspections or installations before waiting for their
	// connection and execution workers to drain.
	cancelExecution()
	s.workers.Wait()
	_ = windows.CloseHandle(s.stopEvent)
	return firstErr
}

func (s *brokerIPCServer) Stop() {
	s.stopOnce.Do(func() {
		if s.stopCh != nil {
			close(s.stopCh)
		}
		_ = windows.SetEvent(s.stopEvent)
	})
}

func (s *brokerIPCServer) servePipe(name string, health bool, initialPipe windows.Handle) error {
	pipe := initialPipe
	slots := make(chan struct{}, 8)
	for {
		if s.isStopping() {
			_ = windows.CloseHandle(pipe)
			return nil
		}
		if pipe == 0 {
			var err error
			pipe, err = s.createPipe(name, health, false)
			if err != nil {
				return err
			}
		}
		connected, err := waitForPipeClient(pipe, s.stopEvent)
		if err != nil {
			_ = windows.CloseHandle(pipe)
			if errors.Is(err, errIPCStopped) {
				return nil
			}
			if recoverableBrokerPipeConnectError(err) {
				pipe = 0
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return fmt.Errorf("wait for %s client: %w", name, err)
		}
		if connected {
			select {
			case slots <- struct{}{}:
			case <-s.stopCh:
				_ = windows.DisconnectNamedPipe(pipe)
				_ = windows.CloseHandle(pipe)
				return nil
			}
			// Keep the accepted instance open while creating the next listener,
			// so the protected pipe name is never momentarily unowned.
			next, nextErr := s.createPipe(name, health, false)
			if nextErr != nil {
				<-slots
				_ = windows.DisconnectNamedPipe(pipe)
				_ = windows.CloseHandle(pipe)
				return nextErr
			}
			accepted := pipe
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { <-slots }()
				s.serveConnection(accepted, health)
				_ = windows.DisconnectNamedPipe(accepted)
				_ = windows.CloseHandle(accepted)
			}()
			pipe = next
			continue
		}
		_ = windows.CloseHandle(pipe)
		pipe = 0
	}
}

func (s *brokerIPCServer) serveAdminPipe(name string, initialPipe windows.Handle) error {
	pipe := initialPipe
	for {
		if s.isStopping() {
			_ = windows.CloseHandle(pipe)
			return nil
		}
		if pipe == 0 {
			var err error
			pipe, err = s.createPipe(name, false, false)
			if err != nil {
				return err
			}
		}
		connected, err := waitForPipeClient(pipe, s.stopEvent)
		if err != nil {
			_ = windows.CloseHandle(pipe)
			if errors.Is(err, errIPCStopped) {
				return nil
			}
			if recoverableBrokerPipeConnectError(err) {
				pipe = 0
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return fmt.Errorf("wait for %s client: %w", name, err)
		}
		if connected {
			s.serveAdminConnection(pipe)
			_ = windows.DisconnectNamedPipe(pipe)
		}
		_ = windows.CloseHandle(pipe)
		pipe = 0
	}
}

func (s *brokerIPCServer) isStopping() bool {
	state, err := windows.WaitForSingleObject(s.stopEvent, 0)
	return err == nil && state == windows.WAIT_OBJECT_0
}

func (s *brokerIPCServer) createPipe(name string, health, first bool) (windows.Handle, error) {
	// 0x0012019B is read/write without FILE_APPEND_DATA, which aliases
	// FILE_CREATE_PIPE_INSTANCE for named pipes.
	sddl := pipeSecurityDescriptor(s.controlPlaneSID, health)
	if s.testPipeOwner != nil && name != s.adminPipeName {
		sddl += fmt.Sprintf("(A;;GA;;;%s)", s.testPipeOwner.String())
	}
	if name == s.adminPipeName {
		sddl = adminPipeSecurityDescriptor()
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return 0, fmt.Errorf("create %s pipe ACL: %w", name, err)
	}
	sa := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
		InheritHandle:      0,
	}
	flags := uint32(windows.PIPE_ACCESS_DUPLEX | windows.FILE_FLAG_OVERLAPPED)
	if first {
		flags |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
	}
	mode := uint32(windows.PIPE_TYPE_BYTE | windows.PIPE_READMODE_BYTE | windows.PIPE_WAIT | windows.PIPE_REJECT_REMOTE_CLIENTS)
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	pipe, err := windows.CreateNamedPipe(namePointer, flags, mode, 9, maxIPCFrame+4, maxIPCFrame+4, 0, &sa)
	if err != nil {
		return 0, fmt.Errorf("create %s: %w", name, err)
	}
	return pipe, nil
}

func pipeSecurityDescriptor(controlPlaneSID *windows.SID, health bool) string {
	if health {
		return fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x%08X;;;%s)", pipeClientAccessMask, controlPlaneSID.String())
	}
	return fmt.Sprintf("D:P(A;;GA;;;SY)(A;;0x%08X;;;%s)", pipeClientAccessMask, controlPlaneSID.String())
}

func adminPipeSecurityDescriptor() string {
	return "D:P(A;;GA;;;SY)(A;;GA;;;BA)"
}

func allowAdminPipeRequest(userSID string, isAdministrator bool, payload []byte) bool {
	if userSID != "S-1-5-18" {
		return isAdministrator
	}
	request, err := decodeBrokerRequest(payload)
	return err == nil && (request.Type == "owner.reset" || request.Type == "auto_signer.configure")
}

func waitForPipeClient(pipe, stopEvent windows.Handle) (bool, error) {
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(event)
	overlapped := windows.Overlapped{HEvent: event}
	err = windows.ConnectNamedPipe(pipe, &overlapped)
	if errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return true, nil
	}
	if err != nil && !errors.Is(err, windows.ERROR_IO_PENDING) {
		return false, err
	}
	if err == nil {
		return true, nil
	}
	result, waitErr := windows.WaitForMultipleObjects([]windows.Handle{stopEvent, event}, false, windows.INFINITE)
	if waitErr != nil {
		_ = windows.CancelIoEx(pipe, &overlapped)
		_, _ = windows.WaitForSingleObject(event, pipeOperationMS)
		return false, waitErr
	}
	if result == windows.WAIT_OBJECT_0 {
		_ = windows.CancelIoEx(pipe, &overlapped)
		_, _ = windows.WaitForSingleObject(event, pipeOperationMS)
		return false, errIPCStopped
	}
	if result != windows.WAIT_OBJECT_0+1 {
		_ = windows.CancelIoEx(pipe, &overlapped)
		return false, fmt.Errorf("unexpected pipe connect wait result 0x%x", result)
	}
	var transferred uint32
	if err := windows.GetOverlappedResult(pipe, &overlapped, &transferred, false); err != nil {
		return false, err
	}
	return true, nil
}

func recoverableBrokerPipeConnectError(err error) bool {
	return errors.Is(err, windows.ERROR_NO_DATA) ||
		errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) ||
		errors.Is(err, windows.ERROR_OPERATION_ABORTED)
}

var (
	errIPCStopped      = errors.New("APB_IPC_STOPPED")
	errIPCFrameTimeout = errors.New("APB_PIPE_TIMEOUT")
)

func (s *brokerIPCServer) serveConnection(pipe windows.Handle, health bool) {
	allowAdmin := health
	if _, err := getPipeClientFacts(pipe, s.controlPlaneSID, allowAdmin); err != nil {
		return
	}
	frame, err := readPipeFrame(pipe, s.stopEvent)
	if err != nil {
		return
	}
	if !s.allowRequest(time.Now()) {
		_ = s.writeResponse(pipe, newErrorResponse("RATE_LIMITED"))
		return
	}
	response := s.handleRequest(frame, health)
	_ = s.writeResponse(pipe, response)
}

func (s *brokerIPCServer) serveAdminConnection(pipe windows.Handle) {
	facts, err := getPipeClientFacts(pipe, nil, true)
	if err != nil {
		return
	}
	frame, err := readPipeFrame(pipe, s.stopEvent)
	if err != nil {
		return
	}
	if !allowAdminPipeRequest(facts.UserSID, facts.IsAdministrator, frame) {
		return
	}
	if !s.allowRequest(time.Now()) {
		_ = s.writeResponse(pipe, newErrorResponse("RATE_LIMITED"))
		return
	}
	_ = s.writeResponse(pipe, s.handleAdminRequest(frame))
}

func newErrorResponse(code string) brokerResponse {
	response := newResponse("error")
	response.Code = code
	return response
}

func (s *brokerIPCServer) handleAdminRequest(payload []byte) brokerResponse {
	request, err := decodeBrokerRequest(payload)
	if err != nil {
		return newErrorResponse("REQUEST_INVALID")
	}
	// Serialize policy changes with claim/start. An old authorization cannot
	// race a generation change and start after it has been revoked.
	s.autoMu.Lock()
	defer s.autoMu.Unlock()
	beforeGeneration := s.store.Snapshot().PolicyGeneration
	defer func() {
		if s.store.Snapshot().PolicyGeneration != beforeGeneration {
			for _, cancel := range s.autoCancel {
				cancel()
			}
		}
	}()
	response := newResponse("result")
	switch request.Type {
	case "enrollment.begin":
		challenge, err := s.store.BeginEnrollment(request.OwnerID, request.DeviceID, request.PublicKey, time.Now().UTC())
		if err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response.Type = "enrollment_challenge"
		response.EnrollmentChallenge = &challenge
		response.InstallationID = challenge.BrokerInstallationID
		response.PolicyGeneration = challenge.PolicyGeneration
		response.BrokerPublicKey = s.store.BrokerPublicKey()
		response.BrokerSignature, err = s.store.SignEnrollmentChallenge(challenge)
		if err != nil {
			return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
		}
	case "enrollment.complete":
		device, err := s.store.CompleteEnrollment(request.EnrollmentID, request.VerificationCode, request.Signature, time.Now().UTC())
		if err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response.Code = "DEVICE_ENROLLED"
		response.DeviceID = device.DeviceID
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
	case "device.revoke":
		if err := s.store.RevokeDevice(request.DeviceID, time.Now().UTC()); err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response.Code = "DEVICE_REVOKED"
		response.DeviceID = request.DeviceID
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
	case "owner.reset":
		if err := s.store.ResetOwner(time.Now().UTC()); err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response.Code = "OWNER_RESET"
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
	case "target.configure":
		if s.target == nil {
			return newErrorResponse("BROKER_TARGET_NOT_CONFIGURED")
		}
		fingerprint, err := s.target.Fingerprint()
		if err != nil {
			return newErrorResponse(mapTargetError(err))
		}
		if err := s.store.ConfigureTarget(fingerprint, time.Now().UTC()); err != nil {
			return newErrorResponse("BROKER_STORAGE_UNAVAILABLE")
		}
		response.Code = "TARGET_CONFIGURED"
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
		response.Challenge = nil
		response.Result = &brokerOperationResult{Operation: "target.configure", TargetID: firstBrokerTargetID, Detail: fingerprint}
	case "auto_signer.configure":
		if err := s.store.ConfigureAutoInstallSigner(request.TargetID, request.PublicKey, time.Now().UTC()); err != nil {
			return newErrorResponse("AUTO_SIGNER_CONFIGURATION_DENIED")
		}
		response.Code = "AUTO_SIGNER_CONFIGURED"
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
	default:
		return newErrorResponse("ADMIN_OPERATION_REFUSED")
	}
	return response
}

func mapApprovalError(err error) string {
	switch {
	case errors.Is(err, errEnrollmentInvalid):
		return "ENROLLMENT_INVALID"
	case errors.Is(err, errOwnerChangeRequiresReset):
		return "OWNER_CHANGE_REQUIRES_RESET"
	case errors.Is(err, errDeviceAlreadyEnrolled):
		return "DEVICE_ALREADY_ENROLLED"
	case errors.Is(err, errEnrollmentExpired):
		return "ENROLLMENT_EXPIRED"
	case errors.Is(err, errEnrollmentCodeMismatch):
		return "ENROLLMENT_CODE_MISMATCH"
	case errors.Is(err, errEnrollmentSignature):
		return "ENROLLMENT_SIGNATURE_INVALID"
	case errors.Is(err, errEnrollmentNotFound):
		return "ENROLLMENT_NOT_FOUND"
	case errors.Is(err, errDeviceNotEnrolled):
		return "DEVICE_NOT_ENROLLED"
	case errors.Is(err, errDecisionExpired):
		return "DECISION_EXPIRED"
	case errors.Is(err, errDecisionConsumed):
		return "DECISION_CONSUMED"
	case errors.Is(err, errDecisionSignature):
		return "DEVICE_SIGNATURE_INVALID"
	default:
		return "BROKER_STORAGE_UNAVAILABLE"
	}
}

func (s *brokerIPCServer) writeResponse(pipe windows.Handle, response brokerResponse) error {
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) == 0 || len(encoded) > maxIPCFrame {
		return errors.New("APB_RESPONSE_INVALID")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(encoded)))
	deadline := time.Now().Add(time.Duration(pipeFrameTimeout) * time.Millisecond)
	if err := writePipeBytes(pipe, header[:], s.stopEvent, deadline); err != nil {
		return err
	}
	if err := writePipeBytes(pipe, encoded, s.stopEvent, deadline); err != nil {
		return err
	}
	return waitForPipeClientClose(pipe, s.stopEvent, deadline)
}

func waitForPipeClientClose(pipe, stopEvent windows.Handle, deadline time.Time) error {
	var extraClientByte [1]byte
	read, err := transferPipeBytes(pipe, extraClientByte[:], false, stopEvent, deadline)
	if err == nil {
		if read > 0 {
			return errors.New("APB_PIPE_EXTRA_CLIENT_DATA")
		}
		return windows.ERROR_BROKEN_PIPE
	}
	if errors.Is(err, windows.ERROR_BROKEN_PIPE) || errors.Is(err, windows.ERROR_NO_DATA) {
		return nil
	}
	return err
}

func (s *brokerIPCServer) allowRequest(now time.Time) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	if s.rateWindowStart.IsZero() || now.Sub(s.rateWindowStart) >= time.Minute || now.Before(s.rateWindowStart) {
		s.rateWindowStart = now
		s.rateCount = 0
	}
	if s.rateCount >= maxRequestsPerMinute {
		return false
	}
	s.rateCount++
	return true
}

func (s *brokerIPCServer) handleRequest(payload []byte, health bool) brokerResponse {
	request, err := decodeBrokerRequest(payload)
	if err != nil {
		response := newResponse("error")
		switch {
		case errors.Is(err, errUnsupportedProtocol):
			response.Code = "PROTOCOL_UNSUPPORTED"
		default:
			response.Code = "REQUEST_INVALID"
		}
		return response
	}
	if health {
		if request.Type != "health" {
			response := newResponse("error")
			response.Code = "HEALTH_PIPE_READ_ONLY"
			return response
		}
		state := s.store.Snapshot()
		response := newResponse("health")
		response.Code = "BROKER_DISABLED"
		if state.TargetFingerprint != "" && state.OwnerID != "" && len(state.Devices) > 0 {
			response.Code = "BROKER_READY"
			response.ExecutionEnabled = true
		}
		response.InstallationID = state.InstallationID
		response.PolicyGeneration = state.PolicyGeneration
		response.MSIInstallReady = state.AutoInstallSigner != nil && s.msiInstaller != nil && s.msiInspector != nil
		response.ServiceControlReady = state.AutoInstallSigner != nil && state.OwnerID != "" && len(state.Devices) > 0 && s.serviceController != nil && s.serviceInspector != nil
		backendReady := state.AutoInstallSigner != nil && s.autoInstaller != nil
		if availability, ok := s.autoInstaller.(interface{ Available() bool }); backendReady && ok {
			backendReady = availability.Available()
		}
		if backendReady {
			response.AutoInstallReady = true
			response.AutoInstallKeyID = state.AutoInstallSigner.KeyID
		}
		if response.ServiceControlReady || response.MSIInstallReady {
			response.AutoInstallKeyID = state.AutoInstallSigner.KeyID
		}
		return response
	}
	if request.Type == "enrollment.pending" {
		challenge, err := s.store.PendingEnrollment(request.DeviceID, time.Now().UTC())
		if err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response := newResponse("enrollment_challenge")
		response.EnrollmentChallenge = &challenge
		response.InstallationID = challenge.BrokerInstallationID
		response.PolicyGeneration = challenge.PolicyGeneration
		response.BrokerPublicKey = s.store.BrokerPublicKey()
		response.BrokerSignature, err = s.store.SignEnrollmentChallenge(challenge)
		if err != nil {
			return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
		}
		return response
	}
	if request.Type == "enrollment.complete" {
		device, err := s.store.CompleteEnrollment(request.EnrollmentID, request.VerificationCode, request.Signature, time.Now().UTC())
		if err != nil {
			return newErrorResponse(mapApprovalError(err))
		}
		response := newResponse("result")
		response.Code = "DEVICE_ENROLLED"
		response.DeviceID = device.DeviceID
		response.PolicyGeneration = s.store.Snapshot().PolicyGeneration
		return response
	}
	if request.Type == "pending" {
		pending, cursor, hasMore, err := s.store.PendingRequests(request.DeviceID, request.Cursor, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errDeviceNotEnrolled) {
				return newErrorResponse("BROKER_DEVICE_NOT_ENROLLED")
			}
			return newErrorResponse("BROKER_STATE_INVALID")
		}
		response := newResponse("pending")
		response.NextCursor = cursor
		response.HasMore = hasMore
		for _, record := range pending {
			item := brokerPendingRequest{
				RequestID: record.Request.RequestID,
				Status:    record.Status,
				Challenge: record.Challenge,
			}
			attestation := brokerResponse{}
			if err := s.attachApprovalAttestation(&attestation, record.Challenge); err != nil {
				return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
			}
			item.BrokerPublicKey = attestation.BrokerPublicKey
			item.BrokerSignature = attestation.BrokerSignature
			response.PendingRequests = append(response.PendingRequests, item)
		}
		return response
	}
	if request.Type == "status" {
		response := newResponse("result")
		response.RequestID = request.RequestID
		record, ok, err := s.store.GetRequestStatus(request.RequestID, time.Now().UTC())
		if err != nil {
			return newErrorResponse("BROKER_STORAGE_UNAVAILABLE")
		}
		if ok {
			response.Status = record.Status
			response.Code = record.Code
			response.Challenge = record.Challenge
			response.Result = record.Result
			if err := s.attachApprovalAttestation(&response, record.Challenge); err != nil {
				return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
			}
		} else if automatic, found := s.store.GetAutoInstall(request.RequestID); found {
			response.Status = automatic.Status
			response.Code = automatic.Code
			grant := automatic.Grant
			response.AutoInstall = &grant
		} else if msi, found := s.store.GetMSIInstall(request.RequestID); found {
			response.Status, response.Code, response.MSIDigest, response.MSIBinding = msi.Status, msi.Code, msi.Digest, msi.Binding
		} else if owner, found := s.store.GetOwnerInstall(request.RequestID); found {
			response.Status, response.Code = owner.Status, owner.Code
			grant := owner.Grant
			response.OwnerInstall = &grant
		} else {
			control, found, err := s.store.GetServiceControlStatus(request.RequestID, time.Now().UTC())
			if err != nil {
				return newErrorResponse("BROKER_STORAGE_UNAVAILABLE")
			}
			if found {
				response.Status, response.Code = control.Status, control.Code
				grant := control.Grant
				response.ServiceControl = &grant
			} else {
				response.Code = "REQUEST_NOT_FOUND"
			}
		}
		return response
	}
	if request.Type == "service.inspect" {
		if s.serviceInspector == nil {
			return newErrorResponse("SERVICE_INSPECTION_UNAVAILABLE")
		}
		name := request.ServiceInspect.ServiceName
		digest, err := s.serviceInspector(name)
		if err != nil || !serviceDefinitionHash.MatchString(digest) {
			return newErrorResponse("SERVICE_INSPECTION_FAILED")
		}
		response := newResponse("service_inspection")
		response.ServiceFacts = &serviceInspectFacts{ServiceName: name, DefinitionHash: digest}
		return response
	}
	if request.Type == "service.propose" {
		if s.serviceController == nil || s.serviceInspector == nil {
			return newErrorResponse("SERVICE_CONTROL_UNAVAILABLE")
		}
		grant := *request.ServiceControl
		current, err := s.serviceInspector(grant.ServiceName)
		if err != nil || current != grant.DefinitionHash {
			return newErrorResponse("SERVICE_TARGET_CHANGED")
		}
		record, _, err := s.store.ProposeServiceControl(grant, request.Signature, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errRequestConflict) {
				return newErrorResponse("REQUEST_ID_CONFLICT")
			}
			return newErrorResponse("SERVICE_CONTROL_AUTHORIZATION_DENIED")
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code = record.Grant.RequestID, record.Status, record.Code
		return response
	}
	if request.Type == "service.pending" {
		if s.serviceController == nil {
			return newErrorResponse("SERVICE_CONTROL_UNAVAILABLE")
		}
		now := time.Now().UTC()
		records, cursor, more, err := s.store.PendingServiceControls(request.DeviceID, request.Cursor, now)
		if err != nil {
			return newErrorResponse("BROKER_DEVICE_NOT_ENROLLED")
		}
		response := newResponse("service_pending")
		response.NextCursor = cursor
		response.HasMore = more
		for _, record := range records {
			key, sig, err := s.store.AttestServiceControl(record.Grant, record.Signature, request.DeviceID, now)
			if err != nil {
				return newErrorResponse("SERVICE_REVIEW_UNAVAILABLE")
			}
			response.ServicePending = append(response.ServicePending, servicePendingApproval{Grant: record.Grant, BrokerPublicKey: key, BrokerSignature: sig})
		}
		return response
	}
	if request.Type == "service.review" {
		if s.serviceController == nil || s.serviceInspector == nil {
			return newErrorResponse("SERVICE_CONTROL_UNAVAILABLE")
		}
		grant := *request.ServiceControl
		current, err := s.serviceInspector(grant.ServiceName)
		if err != nil || current != grant.DefinitionHash {
			return newErrorResponse("SERVICE_TARGET_CHANGED")
		}
		publicKey, signature, err := s.store.AttestServiceControl(grant, request.Signature, request.DeviceID, time.Now().UTC())
		if err != nil {
			return newErrorResponse("SERVICE_REVIEW_UNAVAILABLE")
		}
		response := newResponse("service_review")
		response.ServiceControl = &grant
		response.BrokerPublicKey = publicKey
		response.BrokerSignature = signature
		return response
	}
	if request.Type == "service.deny" {
		if s.serviceController == nil {
			return newErrorResponse("SERVICE_CONTROL_UNAVAILABLE")
		}
		record, _, err := s.store.DenyServiceControl(request.RequestID, serviceOwnerProof{DeviceID: request.DeviceID, Signature: request.DeviceSignature}, time.Now().UTC())
		if err != nil {
			return newErrorResponse("SERVICE_CONTROL_AUTHORIZATION_DENIED")
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code = record.Grant.RequestID, record.Status, record.Code
		return response
	}
	if request.Type == "service.approve" {
		// Resolve the server-signed grant inside the broker, never from the device.
		record, found := s.store.GetServiceControl(request.RequestID)
		if !found {
			return newErrorResponse("SERVICE_CONTROL_AUTHORIZATION_DENIED")
		}
		request.Type, request.ServiceControl, request.Signature = "service.execute", &record.Grant, record.Signature
	}
	if request.Type == "service.execute" {
		s.autoMu.Lock()
		defer s.autoMu.Unlock()
		if s.serviceController == nil {
			return newErrorResponse("SERVICE_CONTROL_UNAVAILABLE")
		}
		record, duplicate, err := s.store.ClaimServiceControl(*request.ServiceControl, request.Signature,
			serviceOwnerProof{DeviceID: request.DeviceID, Signature: request.DeviceSignature}, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errRequestConflict) {
				return newErrorResponse("REQUEST_ID_CONFLICT")
			}
			return newErrorResponse("SERVICE_CONTROL_AUTHORIZATION_DENIED")
		}
		if !duplicate {
			parent := s.executionCtx
			if parent == nil {
				parent = context.Background()
			}
			ctx, cancel := context.WithCancel(parent)
			if s.autoCancel == nil {
				s.autoCancel = make(map[string]context.CancelFunc)
			}
			cancelKey := "service:" + record.Grant.Nonce
			s.autoCancel[cancelKey] = cancel
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { cancel(); s.autoMu.Lock(); delete(s.autoCancel, cancelKey); s.autoMu.Unlock() }()
				outcome := s.serviceController(ctx, serviceControlRequest{Name: record.Grant.ServiceName, Action: record.Grant.Action, DefinitionHash: record.Grant.DefinitionHash})
				_, _ = s.store.FinishServiceControl(record.Grant.Nonce, outcome.Status, outcome.Code, time.Now().UTC())
			}()
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code = record.Grant.RequestID, record.Status, record.Code
		return response
	}
	if request.Type == "auto_install.inspect" {
		inspector, ok := s.autoInstaller.(interface {
			Inspect(context.Context, string, string) (*selectedInstallerFacts, error)
		})
		if !ok {
			return newErrorResponse("AUTO_INSTALL_INSPECTION_UNAVAILABLE")
		}
		parent := s.executionCtx
		if parent == nil {
			parent = context.Background()
		}
		facts, err := inspector.Inspect(parent, request.AutoInspect.PackageID, request.AutoInspect.PackageVersion)
		grant := autoInstallGrant{PackageID: request.AutoInspect.PackageID, VersionID: request.AutoInspect.PackageVersion, SelectedInstaller: facts}
		if err != nil || !validInspectedInstaller(grant) {
			return newErrorResponse("AUTO_INSTALL_INSPECTION_FAILED")
		}
		response := newResponse("auto_install_inspection")
		response.SelectedInstaller = facts
		return response
	}
	if request.Type == "msi_install.inspect" {
		if s.msiInspector == nil {
			return newErrorResponse("MSI_INSTALL_INSPECTION_UNAVAILABLE")
		}
		facts, err := s.msiInspector(*request.MSIInspect)
		if err != nil || facts == nil || facts.ArtifactPath != request.MSIInspect.ArtifactPath || facts.ArtifactSHA256 != request.MSIInspect.ArtifactSHA256 || !msiDigestPattern.MatchString(facts.PublisherSHA256) {
			return newErrorResponse("MSI_INSTALL_INSPECTION_FAILED")
		}
		response := newResponse("msi_install_inspection")
		response.MSIFacts = facts
		return response
	}
	if request.Type == "msi_install.execute" {
		s.autoMu.Lock()
		defer s.autoMu.Unlock()
		if s.msiInstaller == nil {
			return newErrorResponse("MSI_INSTALL_UNAVAILABLE")
		}
		record, duplicate, err := s.store.ClaimMSIInstall(*request.MSIInstall, request.Signature, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errRequestConflict) {
				return newErrorResponse("REQUEST_ID_CONFLICT")
			}
			return newErrorResponse("MSI_INSTALL_AUTHORIZATION_DENIED")
		}
		if !duplicate {
			parent := s.executionCtx
			if parent == nil {
				parent = context.Background()
			}
			ctx, cancel := context.WithCancel(parent)
			if s.autoCancel == nil {
				s.autoCancel = make(map[string]context.CancelFunc)
			}
			cancelKey := "msi:" + record.Grant.Nonce
			s.autoCancel[cancelKey] = cancel
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { cancel(); s.autoMu.Lock(); delete(s.autoCancel, cancelKey); s.autoMu.Unlock() }()
				status, code := s.msiInstaller.Install(ctx, record.Grant)
				_, _ = s.store.FinishMSIInstall(record.Grant.Nonce, status, code, time.Now().UTC())
			}()
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code, response.MSIDigest, response.MSIBinding = record.Grant.RequestID, record.Status, record.Code, record.Digest, record.Binding
		return response
	}
	if request.Type == "auto_install.execute" {
		s.autoMu.Lock()
		defer s.autoMu.Unlock()
		if s.autoInstaller == nil {
			return newErrorResponse("AUTO_INSTALL_UNAVAILABLE")
		}
		record, duplicate, err := s.store.ClaimAutoInstall(*request.AutoInstall, request.Signature, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errRequestConflict) {
				return newErrorResponse("REQUEST_ID_CONFLICT")
			}
			return newErrorResponse("AUTO_INSTALL_AUTHORIZATION_DENIED")
		}
		if !duplicate {
			parent := s.executionCtx
			if parent == nil {
				parent = context.Background()
			}
			ctx, cancel := context.WithCancel(parent)
			if s.autoCancel == nil {
				s.autoCancel = make(map[string]context.CancelFunc)
			}
			s.autoCancel[record.Grant.Nonce] = cancel
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() {
					cancel()
					s.autoMu.Lock()
					delete(s.autoCancel, record.Grant.Nonce)
					s.autoMu.Unlock()
				}()
				status, code := s.autoInstaller.Install(ctx, record.Grant)
				_, _ = s.store.FinishAutoInstall(record.Grant.Nonce, status, code, time.Now().UTC())
			}()
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code = record.Grant.RequestID, record.Status, record.Code
		return response
	}
	if request.Type == "owner_install.identity" {
		if s.ownerPolicy == nil || s.ownerAvailable == nil {
			return newErrorResponse("OWNER_INSTALL_POLICY_UNAVAILABLE")
		}
		policy, err := s.ownerPolicy()
		if err != nil {
			return newErrorResponse("OWNER_INSTALL_POLICY_UNAVAILABLE")
		}
		state := s.store.Snapshot()
		if state.AutoInstallSigner == nil || state.AutoInstallSigner.KeyID != policy.InstanceID || !s.ownerAvailable(policy.OwnerSID) {
			return newErrorResponse("OWNER_INSTALL_POLICY_UNAVAILABLE")
		}
		response := newResponse("owner_install_identity")
		response.OwnerIdentity = &ownerInstallIdentity{InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID}
		return response
	}
	if request.Type == "owner_install.execute" {
		s.autoMu.Lock()
		defer s.autoMu.Unlock()
		if s.ownerInstaller == nil || s.ownerPolicy == nil {
			return newErrorResponse("OWNER_INSTALL_UNAVAILABLE")
		}
		policy, err := s.ownerPolicy()
		if err != nil {
			return newErrorResponse("OWNER_INSTALL_POLICY_UNAVAILABLE")
		}
		record, duplicate, err := s.store.ClaimOwnerInstall(*request.OwnerInstall, request.Signature, policy, time.Now().UTC())
		if err != nil {
			if errors.Is(err, errRequestConflict) {
				return newErrorResponse("REQUEST_ID_CONFLICT")
			}
			return newErrorResponse("OWNER_INSTALL_AUTHORIZATION_DENIED")
		}
		if !duplicate {
			parent := s.executionCtx
			if parent == nil {
				parent = context.Background()
			}
			ctx, cancel := context.WithCancel(parent)
			if s.autoCancel == nil {
				s.autoCancel = make(map[string]context.CancelFunc)
			}
			cancelKey := "owner:" + record.Grant.Nonce
			s.autoCancel[cancelKey] = cancel
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { cancel(); s.autoMu.Lock(); delete(s.autoCancel, cancelKey); s.autoMu.Unlock() }()
				result := ownerInstallResult{Status: "failed", Code: "OWNER_INSTALL_POLICY_CHANGED"}
				currentPolicy, policyErr := s.ownerPolicy()
				state := s.store.Snapshot()
				if policyErr == nil && currentPolicy == policy && state.PolicyGeneration == record.Grant.PolicyGeneration &&
					state.AutoInstallSigner != nil && state.AutoInstallSigner.KeyID == record.Grant.KeyID && time.Now().UnixMilli() < record.Grant.ExpiresMS && ctx.Err() == nil {
					result = s.ownerInstaller(ctx, policy.OwnerSID, record.Grant.PackageID, record.Grant.PackageVersion, record.Grant.InstallScope)
				}
				_, _ = s.store.FinishOwnerInstall(record.Grant.Nonce, requestStatus(result.Status), result.Code, time.Now().UTC())
			}()
		}
		response := newResponse("result")
		response.RequestID, response.Status, response.Code = record.Grant.RequestID, record.Status, record.Code
		return response
	}
	if request.Type == "decision" {
		record, err := s.store.ApplySignedDecision(request, time.Now().UTC())
		if err != nil {
			response := newErrorResponse(mapApprovalError(err))
			response.RequestID = request.RequestID
			if record.Status != "" {
				response.Status = record.Status
				response.Challenge = record.Challenge
			} else if current, ok := s.store.GetRequest(request.RequestID); ok {
				response.Status = current.Status
				response.Challenge = current.Challenge
			}
			return response
		}
		if record.Status == statusAuthorized {
			record, err = s.executeApprovedRestart(record)
			if err != nil {
				response := newErrorResponse("BROKER_STORAGE_UNAVAILABLE")
				response.RequestID = request.RequestID
				return response
			}
		}
		response := newResponse("result")
		response.RequestID = request.RequestID
		response.Status = record.Status
		response.Code = record.Code
		response.Result = record.Result
		return response
	}
	if request.Type != "propose" {
		response := newResponse("error")
		response.Code = "REQUEST_PIPE_OPERATION_REFUSED"
		return response
	}
	record, _, err := s.store.RecordProposal(request, time.Now().UTC())
	if err != nil {
		response := newResponse("error")
		if errors.Is(err, errRequestConflict) {
			response.Code = "REQUEST_ID_CONFLICT"
		} else if errors.Is(err, errInvalidRequest) {
			response.Code = "REQUEST_INVALID"
		} else {
			response.Code = "BROKER_STORAGE_UNAVAILABLE"
		}
		response.RequestID = request.RequestID
		return response
	}
	if record.Status == statusProposed {
		targetCode := "BROKER_TARGET_NOT_CONFIGURED"
		fingerprint := ""
		if s.target != nil {
			fingerprint, err = s.target.Fingerprint()
			if err == nil {
				configured := s.store.Snapshot().TargetFingerprint
				if configured != "" && configured == fingerprint {
					record, err = s.store.AwaitDeviceApproval(request.RequestID, fingerprint, time.Now().UTC())
					if err == nil {
						response := newResponse("result")
						response.RequestID = request.RequestID
						response.Status = record.Status
						response.Code = record.Code
						response.Challenge = record.Challenge
						if err := s.attachApprovalAttestation(&response, record.Challenge); err != nil {
							return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
						}
						return response
					}
					targetCode = mapApprovalError(err)
				} else if configured != "" {
					targetCode = "BROKER_TARGET_CHANGED"
				}
			}
		}
		record, err = s.store.Transition(request.RequestID, statusDenied, targetCode, time.Now().UTC())
		if err != nil {
			response := newResponse("error")
			response.Code = "BROKER_STORAGE_UNAVAILABLE"
			response.RequestID = request.RequestID
			return response
		}
	}
	response := newResponse("result")
	response.RequestID = request.RequestID
	response.Status = record.Status
	response.Code = record.Code
	response.Challenge = record.Challenge
	if err := s.attachApprovalAttestation(&response, record.Challenge); err != nil {
		return newErrorResponse("BROKER_IDENTITY_UNAVAILABLE")
	}
	return response
}

func (s *brokerIPCServer) attachApprovalAttestation(response *brokerResponse, challenge *brokerChallenge) error {
	if challenge == nil {
		return nil
	}
	response.BrokerPublicKey = s.store.BrokerPublicKey()
	var err error
	response.BrokerSignature, err = s.store.SignApprovalChallenge(*challenge)
	return err
}

func (s *brokerIPCServer) executeApprovedRestart(record requestRecord) (requestRecord, error) {
	started, err := s.store.Transition(record.Request.RequestID, statusExecuting, "EXECUTION_STARTED", time.Now().UTC())
	if err != nil {
		return requestRecord{}, err
	}
	if s.target == nil {
		return s.store.CompleteExecution(record.Request.RequestID, statusFailed, "BROKER_TARGET_NOT_CONFIGURED", "", time.Now().UTC())
	}
	if started.Challenge == nil {
		return s.store.CompleteExecution(record.Request.RequestID, statusFailed, "BROKER_STATE_INVALID", "", time.Now().UTC())
	}
	fingerprint, err := s.target.Fingerprint()
	if err != nil || fingerprint != started.Challenge.TargetFingerprint {
		code := "BROKER_TARGET_CHANGED"
		if err != nil {
			code = mapTargetError(err)
		}
		return s.store.CompleteExecution(record.Request.RequestID, statusFailed, code, "", time.Now().UTC())
	}
	result, err := s.target.Restart(fingerprint)
	if err != nil {
		status := statusFailed
		if errors.Is(err, errTargetOutcomeUnknown) {
			status = statusUnknown
		}
		return s.store.CompleteExecution(record.Request.RequestID, status, mapTargetError(err), "", time.Now().UTC())
	}
	return s.store.CompleteExecution(record.Request.RequestID, statusSucceeded, "SERVICE_RESTARTED", result.Detail, time.Now().UTC())
}

func readPipeFrame(pipe, stopEvent windows.Handle) ([]byte, error) {
	deadline := time.Now().Add(time.Duration(pipeFrameTimeout) * time.Millisecond)
	var header [4]byte
	if err := readPipeBytes(pipe, header[:], stopEvent, deadline); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 || length > maxIPCFrame {
		return nil, errInvalidRequest
	}
	payload := make([]byte, int(length))
	if err := readPipeBytes(pipe, payload, stopEvent, deadline); err != nil {
		return nil, err
	}
	return payload, nil
}

func readPipeBytes(pipe windows.Handle, buffer []byte, stopEvent windows.Handle, deadline time.Time) error {
	for offset := 0; offset < len(buffer); {
		read, err := transferPipeBytes(pipe, buffer[offset:], false, stopEvent, deadline)
		if err != nil {
			return err
		}
		if read <= 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += read
	}
	return nil
}

func writePipeBytes(pipe windows.Handle, buffer []byte, stopEvent windows.Handle, deadline time.Time) error {
	for offset := 0; offset < len(buffer); {
		written, err := transferPipeBytes(pipe, buffer[offset:], true, stopEvent, deadline)
		if err != nil {
			return err
		}
		if written <= 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += written
	}
	return nil
}

func transferPipeBytes(pipe windows.Handle, buffer []byte, write bool, stopEvent windows.Handle, deadline time.Time) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return 0, errIPCFrameTimeout
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(event)
	overlapped := windows.Overlapped{HEvent: event}
	var transferred uint32
	if write {
		err = windows.WriteFile(pipe, buffer, &transferred, &overlapped)
	} else {
		err = windows.ReadFile(pipe, buffer, &transferred, &overlapped)
	}
	if err == nil {
		return int(transferred), nil
	}
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		return 0, err
	}
	waitMS := uint32(remaining.Milliseconds())
	if waitMS == 0 {
		waitMS = 1
	}
	result, waitErr := windows.WaitForMultipleObjects([]windows.Handle{stopEvent, event}, false, waitMS)
	if waitErr != nil {
		_ = windows.CancelIoEx(pipe, &overlapped)
		_, _ = windows.WaitForSingleObject(event, pipeOperationMS)
		return 0, waitErr
	}
	if result != windows.WAIT_OBJECT_0+1 {
		_ = windows.CancelIoEx(pipe, &overlapped)
		_, _ = windows.WaitForSingleObject(event, pipeOperationMS)
		if result == windows.WAIT_OBJECT_0 {
			return 0, errIPCStopped
		}
		if result == 0x00000102 { // WAIT_TIMEOUT
			return 0, errIPCFrameTimeout
		}
		return 0, fmt.Errorf("unexpected pipe IO wait result 0x%x", result)
	}
	if err := windows.GetOverlappedResult(pipe, &overlapped, &transferred, false); err != nil {
		return 0, err
	}
	return int(transferred), nil
}

func getPipeClientFacts(pipe windows.Handle, expectedServiceSID *windows.SID, allowAdmin bool) (pipeClientFacts, error) {
	var facts pipeClientFacts
	if err := windows.GetNamedPipeClientProcessId(pipe, &facts.PID); err != nil || facts.PID == 0 {
		return facts, errors.New("APB_CLIENT_PID_UNAVAILABLE")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, facts.PID)
	if err != nil {
		return facts, errors.New("APB_CLIENT_PROCESS_UNAVAILABLE")
	}
	defer windows.CloseHandle(process)
	var created, exited, kernel, userTime windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &userTime); err != nil {
		return facts, errors.New("APB_CLIENT_START_TIME_UNAVAILABLE")
	}
	facts.ProcessCreated = uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	processToken, err := processToken(process)
	if err != nil {
		return facts, errors.New("APB_CLIENT_PROCESS_TOKEN_UNAVAILABLE")
	}
	defer processToken.Close()
	if err := tokenHasExpectedServiceSID(processToken, expectedServiceSID); err != nil {
		if !allowAdmin || !isAdministratorToken(processToken) {
			return facts, err
		}
		facts.IsAdministrator = true
	}
	processUser, err := processToken.GetTokenUser()
	if err != nil {
		return facts, errors.New("APB_CLIENT_USER_UNAVAILABLE")
	}
	facts.UserSID = processUser.User.Sid.String()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, callErr := impersonateNamedPipeClient.Call(uintptr(pipe))
	if result == 0 {
		return facts, fmt.Errorf("APB_CLIENT_IMPERSONATION_FAILED: %w", callErr)
	}
	defer windows.RevertToSelf()
	thread, err := windows.GetCurrentThread()
	if err != nil {
		return facts, errors.New("APB_CLIENT_THREAD_UNAVAILABLE")
	}
	var clientToken windows.Token
	if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &clientToken); err != nil {
		return facts, errors.New("APB_CLIENT_IMPERSONATION_TOKEN_UNAVAILABLE")
	}
	defer clientToken.Close()
	if err := tokenHasExpectedServiceSID(clientToken, expectedServiceSID); err == nil {
		facts.ServiceSID = expectedServiceSID.String()
	} else if allowAdmin && isAdministratorToken(clientToken) {
		facts.IsAdministrator = true
	} else {
		return facts, errors.New("APB_CLIENT_SERVICE_IDENTITY_REFUSED")
	}
	var impersonatedUser *windows.Tokenuser
	impersonatedUser, err = clientToken.GetTokenUser()
	if err != nil || impersonatedUser.User.Sid.String() != facts.UserSID {
		return facts, errors.New("APB_CLIENT_TOKEN_CHANGED")
	}
	if !allowAdmin && (isAdministratorToken(clientToken) || facts.UserSID == "S-1-5-18") {
		return facts, errors.New("APB_CLIENT_PRIVILEGED_IDENTITY_REFUSED")
	}
	return facts, nil
}

func processToken(process windows.Handle) (windows.Token, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return 0, err
	}
	return token, nil
}

func tokenHasExpectedServiceSID(token windows.Token, expected *windows.SID) error {
	if expected == nil {
		return errors.New("APB_EXPECTED_SERVICE_SID_MISSING")
	}
	user, err := token.GetTokenUser()
	if err != nil {
		return errors.New("APB_CLIENT_USER_UNAVAILABLE")
	}
	if user.User.Sid.Equals(expected) {
		return nil
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return errors.New("APB_CLIENT_GROUPS_UNAVAILABLE")
	}
	for _, group := range groups.AllGroups() {
		if group.Sid.Equals(expected) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return nil
		}
	}
	return errors.New("APB_CLIENT_SERVICE_IDENTITY_REFUSED")
}

func isAdministratorToken(token windows.Token) bool {
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return true
	}
	user, err := token.GetTokenUser()
	if err != nil {
		return true
	}
	if user.User.Sid.Equals(adminSID) {
		return true
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return true
	}
	for _, group := range groups.AllGroups() {
		if group.Sid.Equals(adminSID) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return true
		}
	}
	return false
}
