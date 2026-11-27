package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsJobLayoutAndKillOnClose(t *testing.T) {
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
	if err := terminateCommandJob(job); err != nil {
		t.Fatal("terminate empty job:", err)
	}
	if err := waitCommandJob(job, time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsAssignFailureStartsNothing(t *testing.T) {
	cmd, marker := supervisorPayload(t)
	var output lockedSupervisionOutput
	cmd.Stderr = &output
	var assignErr error
	err := runSupervisedWithAssign(context.Background(), cmd, func(job, process syscall.Handle) error {
		// A real Win32 failure through the production refusal branch, not an EOF simulation.
		assignErr = assignCommandJob(0, process)
		return assignErr
	})
	var unavailable *supervisionUnavailable
	if assignErr == nil || !errors.As(err, &unavailable) || !errors.Is(err, assignErr) {
		t.Fatalf("assign failure lost: %v (%v)", err, assignErr)
	}
	if !strings.Contains(output.String(), "AssignProcessToJobObject") {
		t.Fatal("Win32 failure not logged")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("payload escaped before job assignment")
	}
}

// Native Windows controls: compiled and vetted on Linux, not executed there.
func TestWindowsSupervisionHelper(t *testing.T) {
	mode := os.Getenv("HDE_WINDOWS_MODE")
	if mode == "" {
		return
	}
	exe, _ := os.Executable()
	dir := os.Getenv("HDE_WINDOWS_DIR")
	if mode == "bridge" {
		cmd := exec.Command(exe, "-test.run=^TestWindowsSupervisionHelper$")
		cmd.Env = append(os.Environ(), "HDE_WINDOWS_MODE=child")
		if runSupervised(context.Background(), cmd) != nil {
			os.Exit(2)
		}
	} else {
		if err := os.WriteFile(filepath.Join(dir, mode), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(3)
		}
		if mode == "child" {
			child := exec.Command(exe, "-test.run=^TestWindowsSupervisionHelper$")
			child.Env = append(os.Environ(), "HDE_WINDOWS_MODE=grandchild")
			if child.Start() != nil {
				os.Exit(4)
			}
		}
		time.Sleep(time.Hour)
	}
	os.Exit(0)
}

func windowsPayload(t *testing.T, mode string) (*exec.Cmd, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cmd := exec.Command(exe, "-test.run=^TestWindowsSupervisionHelper$")
	cmd.Env = append(os.Environ(), "HDE_WINDOWS_MODE="+mode, "HDE_WINDOWS_DIR="+dir)
	return cmd, dir
}

func windowsMembers(t *testing.T, dir string) []syscall.Handle {
	t.Helper()
	var members []syscall.Handle
	for _, name := range []string{"child", "grandchild"} {
		deadline := time.Now().Add(5 * time.Second)
		var pid int
		for pid == 0 {
			data, _ := os.ReadFile(filepath.Join(dir, name))
			pid, _ = strconv.Atoi(string(data))
			if time.Now().After(deadline) {
				t.Fatalf("%s did not start", name)
			}
			time.Sleep(time.Millisecond)
		}
		handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE|syscall.PROCESS_TERMINATE, false, uint32(pid))
		if err != nil {
			t.Fatal(err)
		}
		members = append(members, handle)
		t.Cleanup(func() { syscall.TerminateProcess(handle, 125); syscall.CloseHandle(handle) })
	}
	return members
}
func windowsMembersGone(t *testing.T, members []syscall.Handle, timeout uint32) {
	t.Helper()
	for _, handle := range members {
		status, err := syscall.WaitForSingleObject(handle, timeout)
		if err != nil || status != syscall.WAIT_OBJECT_0 {
			t.Fatalf("job descendant still running: %d (%v)", status, err)
		}
	}
}

func TestWindowsCancelGroup(t *testing.T) {
	cmd, dir := windowsPayload(t, "child")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runSupervised(ctx, cmd) }()
	members := windowsMembers(t, dir)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job did not terminate")
	}
	windowsMembersGone(t, members, 1000)
}

func TestWindowsParentDeath(t *testing.T) {
	bridge, dir := windowsPayload(t, "bridge")
	if err := bridge.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bridge.Process.Kill(); bridge.Wait() })
	members := windowsMembers(t, dir)
	process, err := syscall.OpenProcess(syscall.PROCESS_TERMINATE, false, uint32(bridge.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(process)
	if err := syscall.TerminateProcess(process, 125); err != nil {
		t.Fatal(fmt.Errorf("TerminateProcess bridge: %w", err))
	}
	bridge.Wait()
	windowsMembersGone(t, members, 5000)
}

type lockedSupervisionOutput struct {
	mu   sync.Mutex
	text strings.Builder
}

func (w *lockedSupervisionOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.text.Write(p)
}
func (w *lockedSupervisionOutput) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.text.String()
}
