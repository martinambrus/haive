package main

import (
	"os/exec"
	"syscall"
	"time"
)

func configureChild(cmd *exec.Cmd) func() {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return func() {}
}

func prepareSupervisor() error { return nil }

func waitCommandGroup(group int) error {
	// Orphans are reaped by launchd on macOS. Do not release the install lease
	// merely because SIGKILL was sent; wait until the whole process group is gone.
	for {
		err := syscall.Kill(-group, 0)
		if err == syscall.ESRCH {
			return nil
		}
		if err != nil {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}
