package main

import (
	"os/exec"
	"syscall"
)

func configureChild(cmd *exec.Cmd) func() {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return func() {}
}
func prepareBridgeReaper()             {}
func prepareSupervisor()               {}
func reapCommandGroup(group int) error { return nil }
