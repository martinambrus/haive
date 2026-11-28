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

func TestSupervisionProbePermissionIsUnconfirmed(t *testing.T) {
	err := waitCommandGroupWithProbe(123456, time.Millisecond, func(int) error { return syscall.EPERM })
	if !errors.Is(err, errCommandStopUnconfirmed) || !errors.Is(err, syscall.EPERM) {
		t.Fatalf("EPERM certified an empty group: %v", err)
	}
	if err := waitCommandGroupWithProbe(123456, time.Millisecond, func(int) error { return syscall.ESRCH }); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisionCompletedGroupNotSignalled(t *testing.T) {
	calls := 0
	sweep := func(group int) error { calls++; return nil }
	if err := sweepCommandGroup(commandStatus{group: 123456, complete: true}, sweep); err != nil || calls != 0 {
		t.Fatal("signalled group proven empty")
	}
	for _, status := range []commandStatus{
		{group: 123456}, {group: 123456, complete: true, err: errors.New("bad record")},
		{group: 123456, complete: true, unconfirmed: true},
	} {
		if err := sweepCommandGroup(status, sweep); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 3 {
		t.Fatalf("missed an unconfirmed group: %d", calls)
	}
}
