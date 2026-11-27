//go:build linux || darwin

package main

import (
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestSupervisionGroupTeardownBound(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 300")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); cmd.Wait() }()
	// A live group cannot disappear without a signal. Use the injectable bound
	// rather than waiting for the generous production deadline.
	if err := waitCommandGroup(cmd.Process.Pid, time.Millisecond); !errors.Is(err, errCommandStopUnconfirmed) {
		t.Fatalf("unconfirmed live group: %v", err)
	}
}
