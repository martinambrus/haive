//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Only fake commands: no Docker daemon, stack or volume is involved.
func TestSupervisionHelper(t *testing.T) {
	mode := os.Getenv("HDE_SUPERVISION_MODE")
	if mode == "" {
		return
	}
	dir := os.Getenv("HDE_SUPERVISION_DIR")
	exe, _ := os.Executable()
	switch mode {
	case "parent":
		os.Setenv("HDE_SUPERVISION_MODE", "child")
		_, err := runCommand(context.Background(), exe, []string{"-test.run=^TestSupervisionHelper$"}, "", nil)
		if err != nil {
			os.Exit(2)
		}
	case "pdeath-parent":
		child := exec.Command(exe, "-test.run=^TestSupervisionHelper$")
		child.Env = append(os.Environ(), "HDE_SUPERVISION_MODE=grandchild")
		unlock := configureChild(child)
		defer unlock()
		if child.Start() != nil {
			os.Exit(4)
		}
		child.Wait()
	case "child":
		os.WriteFile(filepath.Join(dir, "child"), []byte(strconv.Itoa(os.Getpid())), 0600)
		grandchild := exec.Command(exe, "-test.run=^TestSupervisionHelper$")
		grandchild.Env = append(os.Environ(), "HDE_SUPERVISION_MODE=grandchild")
		if grandchild.Start() != nil {
			os.Exit(3)
		}
		fmt.Fprintln(os.Stdout, "ready")
		time.Sleep(time.Hour)
	case "grandchild":
		os.WriteFile(filepath.Join(dir, "grandchild"), []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(time.Hour)
	}
	os.Exit(0)
}

func supervisionAwait(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func supervisionPIDs(t *testing.T, dir string) []int {
	t.Helper()
	pids := []int{}
	for _, name := range []string{"child", "grandchild"} {
		path := filepath.Join(dir, name)
		supervisionAwait(t, name+" ready", func() bool { data, _ := os.ReadFile(path); n, _ := strconv.Atoi(string(data)); return n > 0 })
		data, _ := os.ReadFile(path)
		pid, _ := strconv.Atoi(string(data))
		pids = append(pids, pid)
		t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	}
	return pids
}

func supervisionAlive(pid int) bool {
	// An orphaned zombie cannot execute; the container's PID 1 may reap it later.
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	_, tail, _ := strings.Cut(string(data), ") ")
	return !strings.HasPrefix(tail, "Z ") && !strings.HasPrefix(tail, "X ")
}

func supervisionGone(t *testing.T, pids []int) {
	t.Helper()
	for _, pid := range pids {
		supervisionAwait(t, fmt.Sprintf("process %d exited", pid), func() bool { return !supervisionAlive(pid) })
	}
}

func supervisionEnv(t *testing.T, mode string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HDE_SUPERVISION_MODE", mode)
	t.Setenv("HDE_SUPERVISION_DIR", dir)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe, dir
}

func TestSupervisionParentDeath(t *testing.T) {
	exe, dir := supervisionEnv(t, "parent")
	parent := exec.Command(exe, "-test.run=^TestSupervisionHelper$")
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { parent.Process.Kill(); parent.Wait() })
	pids := supervisionPIDs(t, dir)
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	parent.Wait()
	supervisionGone(t, pids)
}

func TestSupervisionCancelGroup(t *testing.T) {
	exe, dir := supervisionEnv(t, "child")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := runCommand(ctx, exe, []string{"-test.run=^TestSupervisionHelper$"}, "", nil)
		done <- err
	}()
	pids := supervisionPIDs(t, dir)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled command succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not finish")
	}
	for _, pid := range pids {
		if supervisionAlive(pid) {
			t.Fatalf("command returned while process %d still ran", pid)
		}
	}
}

type supervisionBlockedLog struct {
	once             sync.Once
	entered, release chan struct{}
}

func (w *supervisionBlockedLog) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.release })
	return len(p), nil
}

func TestSupervisionLeaseUntilExit(t *testing.T) {
	exe, dir := supervisionEnv(t, "child")
	b := fixture(t)
	timers := newTimerSet()
	b.lockCfg.newTicker = timers.newTicker
	blocked := &supervisionBlockedLog{entered: make(chan struct{}), release: make(chan struct{})}
	var unblock sync.Once
	defer unblock.Do(func() { close(blocked.release) })
	base := b.run
	b.run = func(ctx context.Context, command string, args []string, cwd string, log io.Writer) (string, error) {
		if log != nil {
			return runCommand(ctx, exe, []string{"-test.run=^TestSupervisionHelper$"}, "", blocked)
		}
		return base(ctx, command, args, cwd, log)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { b.handle(ctx, stopReq()); close(done) }()
	pids := supervisionPIDs(t, dir)
	select {
	case <-blocked.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("output not captured")
	}
	// Prove renewal while the real child sleeps, then hold Wait's output drain
	// open after cancellation and prove both leases still beat until completion.
	for _, phase := range []string{"running", "cancelled"} {
		if phase == "cancelled" {
			cancel()
		}
		for _, path := range []string{windowPathOf(b), lockPathOf(b)} {
			before := 0
			// Another lease's tick can still be writing this record in place.
			supervisionAwait(t, "complete lease record", func() bool {
				data, _ := os.ReadFile(path)
				var record lockRecord
				if json.Unmarshal(data, &record) != nil {
					return false
				}
				before = record.Seq
				return before > 0
			})
			timers.tickAll()
			supervisionAwait(t, "lease beat while "+phase, func() bool {
				data, _ := os.ReadFile(path)
				var record lockRecord
				return json.Unmarshal(data, &record) == nil && record.Seq > before
			})
		}
	}
	select {
	case <-done:
		t.Fatal("lease released before Wait completed")
	default:
	}
	unblock.Do(func() { close(blocked.release) })
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handle did not finish")
	}
	for _, pid := range pids {
		if supervisionAlive(pid) {
			t.Fatalf("command returned while process %d still ran", pid)
		}
	}
	for _, path := range []string{windowPathOf(b), lockPathOf(b)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("lease not released after exit: %s (%v)", path, err)
		}
	}
}

// Kill only the supervisor while the bridge and both leases remain alive.
func TestSupervisionSupervisorDeath(t *testing.T) {
	exe, dir := supervisionEnv(t, "child")
	b := fixture(t)
	base := b.run
	b.run = func(ctx context.Context, command string, args []string, cwd string, log io.Writer) (string, error) {
		if log != nil {
			return runCommand(ctx, exe, []string{"-test.run=^TestSupervisionHelper$"}, "", log)
		}
		return base(ctx, command, args, cwd, log)
	}
	done := make(chan error, 1)
	go func() { _, err := b.handle(context.Background(), stopReq()); done <- err }()
	pids := supervisionPIDs(t, dir)
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pids[0]))
	if err != nil {
		t.Fatal(err)
	}
	_, tail, _ := strings.Cut(string(stat), ") ")
	supervisor, _ := strconv.Atoi(strings.Fields(tail)[1])
	if supervisor <= 1 {
		t.Fatal("invalid supervisor pid")
	}
	name, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", supervisor))
	if err != nil || strings.TrimSpace(string(name)) != "haive-cmd-guard" {
		t.Errorf("supervisor name: %q (%v)", name, err)
	}
	for _, path := range []string{windowPathOf(b), lockPathOf(b)} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("lease missing before supervisor death", err)
		}
	}
	if err := syscall.Kill(supervisor, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		for _, pid := range pids {
			if supervisionAlive(pid) {
				t.Errorf("lease released while process %d still ran", pid)
			}
		}
		if err == nil || !strings.Contains(err.Error(), "outcome is uncertain") {
			t.Errorf("missing ambiguous-outcome refusal: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not recover supervisor death")
	}
	for _, path := range []string{windowPathOf(b), lockPathOf(b)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("lease not released after teardown: %s (%v)", path, err)
		}
	}
}

// Isolate the kernel backstop: no bridge-side group sweep or EOF watcher can help.
func TestSupervisionPdeathsigBackstop(t *testing.T) {
	exe, dir := supervisionEnv(t, "pdeath-parent")
	parent := exec.Command(exe, "-test.run=^TestSupervisionHelper$")
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { parent.Process.Kill(); parent.Wait() })
	path := filepath.Join(dir, "grandchild")
	var pid int
	supervisionAwait(t, "direct child ready", func() bool { data, _ := os.ReadFile(path); pid, _ = strconv.Atoi(string(data)); return pid > 0 })
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGKILL) })
	parent.Process.Kill()
	parent.Wait()
	supervisionGone(t, []int{pid})
}

func TestSupervisionCancelBeforeStatusEOF(t *testing.T) {
	exe, dir := supervisionEnv(t, "child")
	cmd := exec.Command(exe, "-test.run=^TestSupervisionHelper$")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runSupervised(ctx, cmd) }()
	pids := supervisionPIDs(t, dir)
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pids[0]))
	if err != nil {
		t.Fatal(err)
	}
	_, tail, _ := strings.Cut(string(stat), ") ")
	supervisor, _ := strconv.Atoi(strings.Fields(tail)[1])
	if supervisor <= 1 {
		t.Fatal("invalid supervisor")
	}
	if err := syscall.Kill(supervisor, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(supervisor, syscall.SIGCONT)
	cancel()
	// The stopped supervisor keeps status open. Group signalling must not await EOF
	// or the production 30 s teardown timer.
	supervisionGone(t, pids)
	if err := syscall.Kill(supervisor, 0); err != nil {
		t.Fatalf("supervisor must still hold status open: %v", err)
	}
	syscall.Kill(supervisor, syscall.SIGCONT)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not finish")
	}
}
