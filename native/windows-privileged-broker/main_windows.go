// The Broker exposes a narrowly scoped local IPC surface, but administrator
// execution remains disabled until owner and device authorization is installed.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
)

const serviceName = "Ragent-PrivilegedBroker"

// Startup failures use stable service-specific exit codes so disposable-runner
// acceptance can identify the failed trust-boundary check without logging
// paths, tokens, or other runtime data.
const (
	brokerExitIdentityRefused   uint32 = 1001
	brokerExitServiceSIDRefused uint32 = 1002
	brokerExitStatePathRefused  uint32 = 1003
	brokerExitStateFileRefused  uint32 = 1004
	brokerExitStoreUnavailable  uint32 = 1005
	brokerExitIPCUnavailable    uint32 = 1006
	brokerExitIPCRuntimeFailed  uint32 = 1007
	brokerExitStateAncestorACL  uint32 = 1008
	brokerExitStateRootACL      uint32 = 1009
	brokerExitStateFileACL      uint32 = 1010
)

func brokerStatePathFailureCode(err error) uint32 {
	if err == nil {
		return 0
	}
	switch {
	case strings.HasPrefix(err.Error(), "APB_STATE_ANCESTOR_"):
		return brokerExitStateAncestorACL
	case strings.HasPrefix(err.Error(), "APB_STATE_FILE_"):
		return brokerExitStateFileACL
	default:
		return brokerExitStateRootACL
	}
}

func brokerIPCRuntimeFailureCode(err error) string {
	if err == nil {
		return "UNEXPECTED_CLEAN_EXIT"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return "WIN32_" + strconv.FormatUint(uint64(errno), 10)
	}
	return "OTHER"
}

func reportBrokerIPCRuntimeFailure(err error) {
	log, openErr := eventlog.Open("Ragent")
	if openErr != nil {
		return
	}
	defer log.Close()
	_ = log.Error(707, "APB_IPC_RUNTIME_FAILED:"+brokerIPCRuntimeFailureCode(err))
}

type brokerService struct{}

func (brokerService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	if len(args) != 1 || args[0] != serviceName {
		return false, 87 // ERROR_INVALID_PARAMETER
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != "S-1-5-18" {
		return true, brokerExitIdentityRefused
	}
	serviceSID, _, _, err := windows.LookupSID("", `NT SERVICE\`+serviceName)
	if err != nil {
		return true, brokerExitServiceSIDRefused
	}
	if err := tokenHasExpectedServiceSID(windows.GetCurrentProcessToken(), serviceSID); err != nil {
		return true, brokerExitServiceSIDRefused
	}
	stateDirectory, err := brokerStateDirectory()
	if err != nil {
		return true, brokerExitStatePathRefused
	}
	if err := ensureBrokerStateDirectory(stateDirectory, serviceSID); err != nil {
		return true, brokerStatePathFailureCode(err)
	}
	if err := verifyProtectedStateDirectory(stateDirectory, serviceSID); err != nil {
		return true, brokerStatePathFailureCode(err)
	}
	statePath := filepath.Join(stateDirectory, stateFileName)
	if err := ensureRegularStateFile(statePath); err != nil {
		return true, brokerExitStateFileRefused
	}
	store, err := openBrokerStore(statePath)
	if err != nil {
		return true, brokerExitStoreUnavailable
	}
	ipc, err := newBrokerIPCServer(store)
	if err != nil {
		return true, brokerExitIPCUnavailable
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ipcDone := make(chan error, 1)
	go func() { ipcDone <- ipc.Run(ctx) }()

	running := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	changes <- running
	for {
		select {
		case request, ok := <-requests:
			if !ok {
				cancel()
				ipc.Stop()
				if err := <-ipcDone; err != nil {
					return false, 1064
				}
				return false, 0
			}
			switch request.Cmd {
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				ipc.Stop()
				if err := <-ipcDone; err != nil {
					return false, 1064 // ERROR_EXCEPTION_IN_SERVICE
				}
				return false, 0
			case svc.Interrogate:
				changes <- running
			}
		case err := <-ipcDone:
			reportBrokerIPCRuntimeFailure(err)
			return true, brokerExitIPCRuntimeFailed
		}
	}
}

func main() {
	if len(os.Args) > 1 {
		if err := runBrokerAdminCLI(os.Args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(2)
		}
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "APB_ARGUMENTS_REFUSED")
		os.Exit(2)
	}
	if err := svc.Run(serviceName, brokerService{}); err != nil {
		fmt.Fprintln(os.Stderr, "APB_SCM_START_REFUSED")
		os.Exit(1)
	}
}
