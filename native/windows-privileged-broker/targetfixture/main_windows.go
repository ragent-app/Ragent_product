//go:build windows

// This deliberately inert service exists only for opt-in local SCM acceptance.
// It performs no I/O beyond reporting its SCM state and accepts stop/shutdown.
package main

import (
	"fmt"
	"os"
	"regexp"

	"golang.org/x/sys/windows/svc"
)

const serviceName = "Ragent-Broker-QA-Target"

type targetService struct{ name string }

func (s targetService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	if len(args) != 1 || args[0] != s.name {
		return false, 87
	}
	running := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	changes <- running
	for request := range requests {
		switch request.Cmd {
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			return false, 0
		case svc.Interrogate:
			changes <- running
		}
	}
	return false, 0
}

func main() {
	name := serviceName
	if len(os.Args) == 3 && os.Args[1] == "--service-name" && regexp.MustCompile(`^Ragent-QA-Service-[a-f0-9]{32}$`).MatchString(os.Args[2]) {
		name = os.Args[2]
	} else if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "APB_QA_TARGET_ARGUMENTS_REFUSED")
		os.Exit(2)
	}
	if err := svc.Run(name, targetService{name: name}); err != nil {
		fmt.Fprintln(os.Stderr, "APB_QA_TARGET_SCM_REFUSED")
		os.Exit(1)
	}
}
