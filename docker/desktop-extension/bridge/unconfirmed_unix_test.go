//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestUnconfirmedMarkerESRCH(t *testing.T) {
	b := fixture(t)
	cmd := exec.Command("sh", "-c", "sleep 300")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); cmd.Wait() }()
	if err := b.markUnconfirmed("stop", &commandOutcome{errCommandStopUnconfirmed, cmd.Process.Pid}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(b.unconfirmedPath())
	var record unconfirmedRecord
	if err != nil || json.Unmarshal(data, &record) != nil || record.PGID != cmd.Process.Pid || record.OS != b.os || record.Time == "" {
		t.Fatalf("invalid record %s (%v)", data, err)
	}
	info, _ := os.Stat(b.unconfirmedPath())
	if info.Mode().Perm() != 0600 {
		t.Fatalf("marker mode: %v", info.Mode())
	}
	if err := b.checkUnconfirmed(probeUnconfirmed); err == nil {
		t.Fatal("live/reused pgid cleared marker")
	}
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	cmd.Wait()
	if err := waitCommandGroup(cmd.Process.Pid, time.Second); err != nil {
		t.Fatal("group not reaped", err)
	}
	if err := b.checkUnconfirmed(reportUnconfirmed); err == nil {
		t.Fatal("status cleared marker")
	}
	if _, err := b.handle(context.Background(), stopReq()); err != nil {
		t.Fatal("ESRCH did not clear marker", err)
	}
	if _, err := os.Stat(b.unconfirmedPath()); !os.IsNotExist(err) {
		t.Fatal("marker remains", err)
	}
}
