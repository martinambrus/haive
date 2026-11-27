package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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
