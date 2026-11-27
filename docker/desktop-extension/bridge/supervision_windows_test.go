package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsJobLayoutAndKillOnClose(t *testing.T) {
	// Both supported Windows architectures use the Win64 ABI.
	var limits jobLimits
	if unsafe.Sizeof(limits) != 144 || unsafe.Offsetof(limits.IO) != 64 || unsafe.Offsetof(limits.LimitFlags) != 16 {
		t.Fatal("job limit layout does not match Win64")
	}
	if unsafe.Sizeof(jobAccounting{}) != 48 {
		t.Fatal("job accounting layout does not match Win64")
	}
	job, err := newCommandJob()
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(job)
	ok, _, err := queryJobInformation.Call(uintptr(job), jobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits), 0)
	if ok == 0 {
		t.Fatal(err)
	}
	if limits.LimitFlags != jobObjectLimitKillOnJobClose {
		t.Fatalf("unexpected job flags: %x", limits.LimitFlags)
	}
	if err := waitCommandJob(job); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsAdmissionFailureStartsNothing(t *testing.T) {
	// Same EOF path used if OpenProcess/AssignProcessToJobObject fails. A process
	// that was started before assignment can execute only the waiting supervisor.
	cmd, marker := supervisorPayload(t)
	supervisor, read, write, err := commandSupervisor(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	if err := supervisor.Start(); err != nil {
		t.Fatal(err)
	}
	write.Close()
	if _, ok := supervisor.Wait().(*exec.ExitError); !ok {
		t.Fatal("unassigned supervisor did not exit")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("payload escaped before job assignment")
	}
}

// Native Windows control, compiled but not executable on the Linux runner.
func TestWindowsSleepingPayload(t *testing.T) {
	if os.Getenv("HDE_WINDOWS_SLEEP") != "1" {
		return
	}
	fmt.Fprintln(os.Stdout, os.Getpid())
	time.Sleep(time.Hour)
	os.Exit(0)
}

type windowsReadyWriter struct{ ready chan int }

func (w windowsReadyWriter) Write(p []byte) (int, error) {
	if pid, err := strconv.Atoi(strings.TrimSpace(string(p))); err == nil {
		select {
		case w.ready <- pid:
		default:
		}
	}
	return len(p), nil
}

func TestWindowsCancelTerminatesJobMember(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.Command(exe, "-test.run=^TestWindowsSleepingPayload$")
	cmd.Env = append(os.Environ(), "HDE_WINDOWS_SLEEP=1")
	ready := make(chan int, 1)
	cmd.Stdout = windowsReadyWriter{ready}
	done := make(chan error, 1)
	go func() { done <- runSupervised(ctx, cmd) }()
	var pid int
	select {
	case pid = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("job member did not start")
	}
	process, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(process)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled job succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job did not terminate")
	}
	status, err := syscall.WaitForSingleObject(process, 0)
	if err != nil || status != syscall.WAIT_OBJECT_0 {
		t.Fatalf("command still active after Wait: %d (%v)", status, err)
	}
}
