package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func configureChild(cmd *exec.Cmd) func() {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return func() {}
}
func prepareBridgeReaper() {}
func prepareSupervisor()   {}
func waitCommandGroup(group int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		err := syscall.Kill(-group, 0)
		if err == syscall.ESRCH {
			return nil
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "command supervisor warning: probe command group:", err)
			return nil
		}
		if !time.Now().Before(deadline) {
			return errCommandStopUnconfirmed
		}
		time.Sleep(time.Millisecond)
	}
}
