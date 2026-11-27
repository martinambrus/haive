package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDarwinChildOwnsGroup(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	unlock := configureChild(cmd)
	defer unlock()
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("child must own its process group")
	}
}

// Native macOS control; cross-compiled, not executed by Linux CI.
func TestDarwinCancelPipe(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.Command("sh", "-c", "sleep 60 & wait")
	cmd.Stdout = supervisionCancelWriter{cancel}
	cmd.Args[2] = "echo ready; sleep 60 & wait"
	done := make(chan error, 1)
	go func() { done <- runSupervised(ctx, cmd) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("group cancellation did not finish")
	}
}

type supervisionCancelWriter struct{ cancel context.CancelFunc }

func (w supervisionCancelWriter) Write(p []byte) (int, error) { w.cancel(); return len(p), nil }

func TestDarwinBridgeHelper(t *testing.T) {
	if os.Getenv("HDE_DARWIN_BRIDGE") != "1" {
		return
	}
	log, err := os.Create(filepath.Join(os.Getenv("HDE_DARWIN_DIR"), "output"))
	if err != nil {
		os.Exit(3)
	}
	defer log.Close()
	cmd := exec.Command("sh", "-c", `echo $$ > "$HDE_DARWIN_DIR/child"; sleep 300 & echo $! > "$HDE_DARWIN_DIR/grandchild"; wait`)
	cmd.Stdout, cmd.Stderr = log, log
	if runSupervised(context.Background(), cmd) != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func TestDarwinParentDeath(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bridge := exec.Command(exe, "-test.run=^TestDarwinBridgeHelper$")
	bridge.Env = append(os.Environ(), "HDE_DARWIN_BRIDGE=1", "HDE_DARWIN_DIR="+dir)
	if err := bridge.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bridge.Process.Kill(); bridge.Wait() })
	var pids []int
	for _, name := range []string{"child", "grandchild"} {
		var pid int
		darwinAwait(t, name+" ready", func() bool {
			data, _ := os.ReadFile(filepath.Join(dir, name))
			pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
			return pid > 1
		})
		pids = append(pids, pid)
		t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	}
	if err := bridge.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	bridge.Wait()
	for _, pid := range pids {
		darwinAwait(t, "command group gone", func() bool {
			if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
				return true
			}
			// launchd may not yet have reaped an exited process; a zombie cannot execute.
			out, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
			return strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
		})
	}
}

func darwinAwait(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out: " + what)
		}
		time.Sleep(time.Millisecond)
	}
}
