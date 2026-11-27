package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
)

const supervisorMode = "--haive-command-supervisor"

// The private mode also works in a re-executed Go test binary. It runs before
// request decoding, has no Docker logic, and inherits only the filtered command
// environment. No command can start before the parent sends the admission byte.
func init() {
	if len(os.Args) < 2 || os.Args[1] != supervisorMode {
		return
	}
	if len(os.Args) < 3 {
		os.Exit(125)
	}
	var admission [1]byte
	if _, err := io.ReadFull(os.Stdin, admission[:]); err != nil || admission[0] != 1 {
		os.Exit(125)
	}
	cmd := exec.Command(os.Args[2], os.Args[3:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	err := superviseChild(cmd)
	if err == nil {
		os.Exit(0)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() > 0 {
		os.Exit(exit.ExitCode())
	}
	os.Exit(125)
}

// The only pipe writer lives in the bridge. The supervisor never passes its
// stdin to the command, so a grandchild cannot accidentally hold the lease alive.
func commandSupervisor(cmd *exec.Cmd) (*exec.Cmd, *os.File, *os.File, error) {
	// Preserve exec.LookPath failures (including ErrDot) rather than resolving a
	// rejected command again after moving into its working directory.
	if cmd.Err != nil {
		return nil, nil, nil, cmd.Err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, nil, nil, err
	}
	read, write, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	args := append([]string{supervisorMode, cmd.Path}, cmd.Args[1:]...)
	supervisor := exec.Command(exe, args...)
	supervisor.Dir, supervisor.Env = cmd.Dir, cmd.Env
	supervisor.Stdin, supervisor.Stdout, supervisor.Stderr = read, cmd.Stdout, cmd.Stderr
	return supervisor, read, write, nil
}

// Cancellation is a request to terminate, not command completion. Always wait
// for OS supervision and output draining before the caller can release its leases.
func waitCommand(ctx context.Context, cmd *exec.Cmd, cancel func()) error {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		cancel()
		<-done
		return ctx.Err()
	}
}
