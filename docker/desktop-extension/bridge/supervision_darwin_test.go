package main

import (
	"context"
	"os/exec"
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
