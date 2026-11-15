//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	targetExecutableName = "Ragent-Broker-QA-Target.exe"
	targetStopTimeout    = 15 * time.Second
	targetStartTimeout   = 15 * time.Second
	targetBinaryMaxBytes = 128 * 1024 * 1024
)

var (
	errTargetUnavailable    = errors.New("APB_TARGET_UNAVAILABLE")
	errTargetPolicy         = errors.New("APB_TARGET_POLICY_REFUSED")
	errTargetChanged        = errors.New("APB_TARGET_CHANGED")
	errTargetNotRunning     = errors.New("APB_TARGET_NOT_RUNNING")
	errTargetRestart        = errors.New("APB_TARGET_RESTART_FAILED")
	errTargetOutcomeUnknown = errors.New("APB_TARGET_RESTART_OUTCOME_UNKNOWN")
)

type brokerTargetController interface {
	Fingerprint() (string, error)
	Restart(expectedFingerprint string) (brokerOperationResult, error)
}

type windowsBrokerTargetController struct{}

type brokerTargetFingerprintInput struct {
	ServiceName         string
	ServiceType         uint32
	StartType           uint32
	ErrorControl        uint32
	BinaryPathName      string
	LoadOrderGroup      string
	Dependencies        []string
	ServiceStartName    string
	DisplayName         string
	Description         string
	ServiceSIDType      uint32
	DelayedAutoStart    bool
	BinarySHA256        string
	ServiceSecuritySDDL string
	BinarySecuritySDDL  string
	RecoveryActions     []int
	RecoveryCommand     string
	RecoveryOnNonCrash  bool
}

func mapTargetError(err error) string {
	switch {
	case errors.Is(err, errTargetChanged):
		return "BROKER_TARGET_CHANGED"
	case errors.Is(err, errTargetNotRunning):
		return "SERVICE_NOT_RUNNING"
	case errors.Is(err, errTargetRestart):
		return "SERVICE_RESTART_FAILED"
	case errors.Is(err, errTargetOutcomeUnknown):
		return "SERVICE_RESTART_OUTCOME_UNKNOWN"
	case errors.Is(err, errTargetPolicy):
		return "BROKER_TARGET_NOT_CONFIGURED"
	default:
		return "BROKER_TARGET_NOT_CONFIGURED"
	}
}

func (windowsBrokerTargetController) Fingerprint() (string, error) {
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "", errTargetUnavailable
	}
	defer windows.CloseServiceHandle(manager)
	serviceName, err := windows.UTF16PtrFromString(firstBrokerTargetID)
	if err != nil {
		return "", errTargetUnavailable
	}
	service, err := windows.OpenService(manager, serviceName, windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS|windows.READ_CONTROL)
	if err != nil {
		return "", errTargetUnavailable
	}
	defer windows.CloseServiceHandle(service)
	return fingerprintBrokerTargetHandle(service)
}

func fingerprintBrokerTargetHandle(service windows.Handle) (string, error) {
	config, err := (&mgr.Service{Name: firstBrokerTargetID, Handle: service}).Config()
	if err != nil || !validBrokerTargetConfig(config) {
		return "", errTargetPolicy
	}
	arguments, err := windows.DecomposeCommandLine(config.BinaryPathName)
	if err != nil || len(arguments) != 1 {
		return "", errTargetPolicy
	}
	binaryPath := filepath.Clean(arguments[0])
	if !filepath.IsAbs(binaryPath) || !strings.EqualFold(filepath.Base(binaryPath), targetExecutableName) {
		return "", errTargetPolicy
	}
	if err := verifyProtectedTargetPath(binaryPath); err != nil {
		return "", errTargetPolicy
	}
	binaryHash, err := hashTargetBinary(binaryPath)
	if err != nil {
		return "", errTargetUnavailable
	}
	serviceSD, err := windows.GetSecurityInfo(service, windows.SE_SERVICE, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION)
	if err != nil || serviceSD == nil {
		return "", errTargetUnavailable
	}
	if err := validateTargetSecurityDescriptor(serviceSD); err != nil {
		return "", errTargetPolicy
	}
	if err := validateTargetServiceACL(serviceSD); err != nil {
		return "", errTargetPolicy
	}
	fileSD, err := windows.GetNamedSecurityInfo(binaryPath, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION)
	if err != nil || fileSD == nil {
		return "", errTargetUnavailable
	}
	if err := validateTargetSecurityDescriptor(fileSD); err != nil {
		return "", errTargetPolicy
	}
	managedService := &mgr.Service{Name: firstBrokerTargetID, Handle: service}
	actions, err := managedService.RecoveryActions()
	if err != nil {
		return "", errTargetUnavailable
	}
	for _, action := range actions {
		if action.Type != mgr.NoAction {
			return "", errTargetPolicy
		}
	}
	recoveryCommand, err := managedService.RecoveryCommand()
	if err != nil || recoveryCommand != "" {
		return "", errTargetPolicy
	}
	recoveryNonCrash, err := managedService.RecoveryActionsOnNonCrashFailures()
	if err != nil || recoveryNonCrash {
		return "", errTargetPolicy
	}
	actionTypes := make([]int, len(actions))
	for index, action := range actions {
		actionTypes[index] = action.Type
	}
	input := brokerTargetFingerprintInput{
		ServiceName: firstBrokerTargetID, ServiceType: config.ServiceType, StartType: config.StartType,
		ErrorControl: config.ErrorControl, BinaryPathName: config.BinaryPathName, LoadOrderGroup: config.LoadOrderGroup,
		Dependencies: append([]string(nil), config.Dependencies...), ServiceStartName: config.ServiceStartName,
		DisplayName: config.DisplayName, Description: config.Description, ServiceSIDType: config.SidType,
		DelayedAutoStart: config.DelayedAutoStart, BinarySHA256: binaryHash, ServiceSecuritySDDL: serviceSD.String(),
		BinarySecuritySDDL: fileSD.String(), RecoveryActions: actionTypes, RecoveryCommand: recoveryCommand,
		RecoveryOnNonCrash: recoveryNonCrash,
	}
	return brokerTargetFingerprint(input), nil
}

func brokerTargetFingerprint(input brokerTargetFingerprintInput) string {
	encoded, _ := json.Marshal(input)
	digest := sha256.Sum256(append([]byte("Ragent Broker QA Target v1\x00"), encoded...))
	return hex.EncodeToString(digest[:])
}

func validBrokerTargetConfig(config mgr.Config) bool {
	return config.ServiceType == windows.SERVICE_WIN32_OWN_PROCESS && config.StartType == windows.SERVICE_DEMAND_START &&
		config.ErrorControl == windows.SERVICE_ERROR_IGNORE && config.LoadOrderGroup == "" && config.TagId == 0 &&
		len(config.Dependencies) == 0 && (strings.EqualFold(config.ServiceStartName, `NT AUTHORITY\LocalService`) ||
		strings.EqualFold(config.ServiceStartName, "LocalService")) && !config.DelayedAutoStart
}

func verifyProtectedTargetPath(path string) error {
	attributes, err := windows.GetFileAttributes(mustUTF16(path))
	if err != nil || attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errTargetPolicy
	}
	stat, err := os.Stat(path)
	if err != nil || stat.Size() <= 0 || stat.Size() > targetBinaryMaxBytes {
		return errTargetPolicy
	}
	clean := filepath.Clean(path)
	parts := []string{clean}
	for parent := filepath.Dir(clean); ; parent = filepath.Dir(parent) {
		parts = append(parts, parent)
		if parent == filepath.Dir(parent) {
			break
		}
	}
	if !strings.EqualFold(filepath.Base(filepath.Dir(clean)), "BrokerQA") ||
		!strings.EqualFold(filepath.Base(filepath.Dir(filepath.Dir(clean))), "Ragent") ||
		!strings.EqualFold(filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(clean)))), "Program Files") {
		return errTargetPolicy
	}
	for _, objectPath := range parts {
		objectAttributes, err := windows.GetFileAttributes(mustUTF16(objectPath))
		if err != nil || objectAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errTargetPolicy
		}
		isDirectory := objectAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
		sd, err := windows.GetNamedSecurityInfo(objectPath, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
		if err != nil || sd == nil {
			return errTargetPolicy
		}
		if err := validateTargetSecurityDescriptor(sd); err != nil {
			return err
		}
		acl, _, err := sd.DACL()
		if err != nil || acl == nil {
			return errTargetPolicy
		}
		writeMask := uint32(windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL |
			0x00000002 | 0x00000004 | 0x00000010 | 0x00000100)
		if isDirectory {
			writeMask |= 0x00000040
		}
		for index := uint32(0); index < uint32(acl.AceCount); index++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(acl, index, &ace); err != nil || ace == nil {
				return errTargetPolicy
			}
			if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
				continue
			}
			if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
				return errTargetPolicy
			}
			// An inherit-only ACE does not grant access on this object. Any
			// inherited copy that applies to a later path object is inspected
			// when that object is visited below. Rejecting the ancestor ACE here
			// would incorrectly reject a protected Program Files child whose
			// DACL stops inheritance.
			if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
				continue
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if trustedStatePrincipal(sid) || uint32(ace.Mask)&writeMask == 0 {
				continue
			}
			return errTargetPolicy
		}
	}
	return nil
}

func validateTargetSecurityDescriptor(sd *windows.SECURITY_DESCRIPTOR) error {
	owner, _, err := sd.Owner()
	if err != nil || !trustedStatePrincipal(owner) {
		return errTargetPolicy
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errTargetPolicy
	}
	return nil
}

func validateTargetServiceACL(sd *windows.SECURITY_DESCRIPTOR) error {
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return errTargetPolicy
	}
	unsafeRights := uint32(windows.SERVICE_CHANGE_CONFIG | windows.SERVICE_START | windows.SERVICE_STOP |
		windows.WRITE_DAC | windows.WRITE_OWNER | windows.DELETE | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil || ace == nil {
			return errTargetPolicy
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errTargetPolicy
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !trustedStatePrincipal(sid) && uint32(ace.Mask)&unsafeRights != 0 {
			return errTargetPolicy
		}
	}
	return nil
}

func hashTargetBinary(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.Size() <= 0 || stat.Size() > targetBinaryMaxBytes {
		return "", errTargetPolicy
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, targetBinaryMaxBytes+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (windowsBrokerTargetController) Restart(expectedFingerprint string) (brokerOperationResult, error) {
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return brokerOperationResult{}, errTargetUnavailable
	}
	defer windows.CloseServiceHandle(manager)
	serviceName, err := windows.UTF16PtrFromString(firstBrokerTargetID)
	if err != nil {
		return brokerOperationResult{}, errTargetUnavailable
	}
	service, err := windows.OpenService(manager, serviceName,
		windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS|windows.SERVICE_START|windows.SERVICE_STOP|windows.READ_CONTROL)
	if err != nil {
		return brokerOperationResult{}, errTargetUnavailable
	}
	defer windows.CloseServiceHandle(service)
	fingerprint, err := fingerprintBrokerTargetHandle(service)
	if err != nil || fingerprint != expectedFingerprint {
		return brokerOperationResult{}, errTargetChanged
	}
	status, err := queryBrokerTargetStatus(service)
	if err != nil {
		return brokerOperationResult{}, errTargetUnavailable
	}
	if status.CurrentState != windows.SERVICE_RUNNING {
		return brokerOperationResult{}, errTargetNotRunning
	}
	if err := windows.ControlService(service, windows.SERVICE_CONTROL_STOP, new(windows.SERVICE_STATUS)); err != nil {
		return brokerOperationResult{}, errTargetRestart
	}
	if err := waitForBrokerTargetState(service, windows.SERVICE_STOPPED, targetStopTimeout); err != nil {
		return brokerOperationResult{}, errTargetOutcomeUnknown
	}
	fingerprint, err = fingerprintBrokerTargetHandle(service)
	if err != nil || fingerprint != expectedFingerprint {
		return brokerOperationResult{}, errTargetChanged
	}
	if err := windows.StartService(service, 0, nil); err != nil {
		return brokerOperationResult{}, errTargetOutcomeUnknown
	}
	if err := waitForBrokerTargetState(service, windows.SERVICE_RUNNING, targetStartTimeout); err != nil {
		return brokerOperationResult{}, errTargetOutcomeUnknown
	}
	return brokerOperationResult{Operation: "service.restart", TargetID: firstBrokerTargetID, Detail: "restarted"}, nil
}

func queryBrokerTargetStatus(service windows.Handle) (windows.SERVICE_STATUS_PROCESS, error) {
	var status windows.SERVICE_STATUS_PROCESS
	var needed uint32
	err := windows.QueryServiceStatusEx(service, windows.SC_STATUS_PROCESS_INFO, (*byte)(unsafe.Pointer(&status)), uint32(unsafe.Sizeof(status)), &needed)
	return status, err
}

func waitForBrokerTargetState(service windows.Handle, wanted uint32, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := queryBrokerTargetStatus(service)
		if err != nil {
			return err
		}
		if status.CurrentState == wanted {
			return nil
		}
		if !brokerTargetTransitionPending(status.CurrentState, wanted) {
			return errTargetRestart
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errTargetRestart
}

// SCM can briefly report the old stable state after accepting Stop or Start.
// Keep waiting for that transition, but reject states from the opposite path.
func brokerTargetTransitionPending(current, wanted uint32) bool {
	switch wanted {
	case windows.SERVICE_STOPPED:
		return current == windows.SERVICE_RUNNING || current == windows.SERVICE_STOP_PENDING
	case windows.SERVICE_RUNNING:
		return current == windows.SERVICE_STOPPED || current == windows.SERVICE_START_PENDING
	default:
		return false
	}
}
