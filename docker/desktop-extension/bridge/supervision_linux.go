package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

func configureChild(cmd *exec.Cmd) func() {
	runtime.LockOSThread()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	return runtime.UnlockOSThread
}

func prepareBridgeReaper() {
	const prSetChildSubreaper = 36
	_, _, err := syscall.Syscall6(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0, 0, 0, 0)
	if err != 0 {
		fmt.Fprintln(os.Stderr, "command supervisor warning: subreaper unavailable:", err)
	}
}
func prepareSupervisor() {
	// Linux comm names are limited to 15 bytes, distinct from haive-desktop so
	// pkill haive-desktop targets the bridge without killing its EOF watcher.
	name := [16]byte{}
	copy(name[:], "haive-cmd-guard")
	_, _, err := syscall.Syscall6(syscall.SYS_PRCTL, 15, uintptr(unsafe.Pointer(&name[0])), 0, 0, 0, 0)
	if err != 0 {
		fmt.Fprintln(os.Stderr, "command supervisor warning: process name:", err)
	}
	prepareBridgeReaper()
}

func waitCommandGroup(group int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		for {
			pid, err := syscall.Wait4(-group, nil, syscall.WNOHANG, nil)
			if err == syscall.EINTR {
				continue
			}
			if err != nil && err != syscall.ECHILD {
				return fmt.Errorf("%w: reap command group: %v", errCommandStopUnconfirmed, err)
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
			fmt.Fprintln(os.Stderr, "command supervisor warning: probe command group:", err)
			return nil
		}
		if !time.Now().Before(deadline) {
			return errCommandStopUnconfirmed
		}
		time.Sleep(time.Millisecond)
	}
}
