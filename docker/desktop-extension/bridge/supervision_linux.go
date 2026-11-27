package main

import (
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

func configureChild(cmd *exec.Cmd) func() {
	// Linux ties Pdeathsig to the creating OS thread, not the Go process. Keep
	// that thread alive until Wait completes (including cancellation).
	runtime.LockOSThread()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	return runtime.UnlockOSThread
}

// Adopt and reap orphaned command descendants. Otherwise a container's PID 1
// need not reap them, and kill(group, 0) would see their zombies indefinitely.
func prepareSupervisor() error {
	const prSetChildSubreaper = 36
	_, _, err := syscall.Syscall6(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0, 0, 0, 0)
	if err != 0 {
		return err
	}
	return nil
}

func waitCommandGroup(group int) error {
	for {
		// The direct child's Wait has completed, so this cannot steal its status.
		for {
			pid, err := syscall.Wait4(-group, nil, syscall.WNOHANG, nil)
			if err == syscall.EINTR {
				continue
			}
			if err != nil && err != syscall.ECHILD {
				return err
			}
			if pid <= 0 {
				break
			}
		}
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
