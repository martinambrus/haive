package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSupervisorPayload(t *testing.T) {
	if os.Getenv("HDE_SUPERVISOR_PAYLOAD") != "1" {
		return
	}
	os.WriteFile("payload-ran", []byte("yes"), 0600)
	os.Exit(23)
}

func supervisorPayload(t *testing.T) (*exec.Cmd, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestSupervisorPayload$")
	cmd.Dir = t.TempDir()
	cmd.Env = append(os.Environ(), "HDE_SUPERVISOR_PAYLOAD=1")
	return cmd, filepath.Join(cmd.Dir, "payload-ran")
}

func TestSupervisorNoAdmissionNoCommand(t *testing.T) {
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
	read.Close()
	write.Close() // Parent death before admission/Windows job assignment.
	if err := supervisor.Wait(); err == nil {
		t.Fatal("missing admission succeeded")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("command ran without admission: %v", err)
	}
}

func TestSupervisorPreservesExitAndDirectory(t *testing.T) {
	cmd, marker := supervisorPayload(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runSupervised(ctx, cmd)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 {
		t.Fatalf("want exit 23, got %v", err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "yes" {
		t.Fatalf("directory/environment lost: %q (%v)", data, err)
	}
}

func TestSupervisorCancelledBeforeStart(t *testing.T) {
	cmd, marker := supervisorPayload(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runSupervised(ctx, cmd); !errors.Is(err, context.Canceled) {
		t.Fatalf("want cancellation: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("cancelled command ran: %v", err)
	}
}

func TestSupervisorPreservesLookupRefusal(t *testing.T) {
	cmd, marker := supervisorPayload(t)
	cmd.Err = exec.ErrDot
	if err := runSupervised(context.Background(), cmd); !errors.Is(err, exec.ErrDot) {
		t.Fatalf("executable lookup refusal lost: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("rejected command ran: %v", err)
	}
}

func TestSupervisorRequiresNonce(t *testing.T) {
	cmd, marker := supervisorPayload(t)
	exe, _ := os.Executable()
	direct := exec.Command(exe, supervisorMode, strings.Repeat("a", 64), cmd.Path, cmd.Args[1])
	direct.Dir, direct.Env = cmd.Dir, append(cmd.Env, supervisorNonceEnv+"=")
	direct.Stdin = bytes.NewReader([]byte{1})
	var stderr bytes.Buffer
	direct.Stderr = &stderr
	if direct.Run() == nil || !strings.Contains(stderr.String(), "nonce") {
		t.Fatalf("missing nonce accepted or silent: %s", &stderr)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("payload ran without nonce")
	}
}

func TestSupervisorRefusesUnsupportedFields(t *testing.T) {
	cases := map[string]func(*exec.Cmd){
		"attributes":    func(c *exec.Cmd) { c.SysProcAttr = &syscall.SysProcAttr{} },
		"process":       func(c *exec.Cmd) { c.Process = &os.Process{} },
		"process state": func(c *exec.Cmd) { c.ProcessState = &os.ProcessState{} },
		"arguments":     func(c *exec.Cmd) { c.Args = nil },
		"stdin":         func(c *exec.Cmd) { c.Stdin = strings.NewReader("input") },
		"extra files":   func(c *exec.Cmd) { c.ExtraFiles = []*os.File{os.Stdin} },
		"cancel":        func(c *exec.Cmd) { c.Cancel = func() error { return nil } },
		"wait delay":    func(c *exec.Cmd) { c.WaitDelay = time.Second },
	}
	for name, configure := range cases {
		t.Run(name, func(t *testing.T) {
			cmd, _ := supervisorPayload(t)
			configure(cmd)
			if _, _, _, err := commandSupervisor(cmd); err == nil || !strings.Contains(err.Error(), "unsupported") {
				t.Fatalf("silently dropped %s: %v", name, err)
			}
		})
	}
}

func TestSupervisorBoundedTeardown(t *testing.T) {
	if commandTeardownTimeout != 30*time.Second {
		t.Fatal("production bound changed")
	}
	if err := boundedCommandWait(make(chan error), time.Millisecond); !errors.Is(err, errCommandStopUnconfirmed) {
		t.Fatal(err)
	}
}

func TestSupervisionFailureMapping(t *testing.T) {
	for _, req := range []request{{Action: "status", Engine: "desktop-engine"}, startReq(), stopReq(), {Action: "install", Consent: consent, Engine: "desktop-engine", Version: "0.2.0"}} {
		t.Run(req.Action, func(t *testing.T) {
			b := fixture(t)
			b.run = func(context.Context, string, []string, string, io.Writer) (string, error) {
				return "", &supervisionUnavailable{errors.New("Win32 error 5: access denied")}
			}
			_, err := b.handle(context.Background(), req)
			var unavailable *supervisionUnavailable
			if !errors.As(err, &unavailable) || strings.Contains(err.Error(), "same engine") {
				t.Fatalf("misleading supervision mapping: %v", err)
			}
		})
	}
}

func TestReadOnlyProbeScope(t *testing.T) {
	for _, req := range []request{{Action: "status", Engine: "desktop-engine"}, stopReq()} {
		b := fixture(t)
		base := b.run
		sawLease := false
		b.run = func(ctx context.Context, exe string, args []string, dir string, log io.Writer) (string, error) {
			want := req.Action == "status" || args[0] == "info"
			if got := ctx.Value(readOnlyProbeKey{}) == true; got != want {
				t.Errorf("%s %v: unsupervised=%v", req.Action, args, got)
			}
			if log != nil {
				sawLease = lockExists(b)
			}
			return base(ctx, exe, args, dir, log)
		}
		if _, err := b.handle(context.Background(), req); err != nil {
			t.Fatal(err)
		}
		if req.Action == "stop" && !sawLease {
			t.Fatal("mutation did not hold lease")
		}
	}
}
