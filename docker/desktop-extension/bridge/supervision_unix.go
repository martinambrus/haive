//go:build linux || darwin

package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"syscall"
)

func runSupervised(ctx context.Context, cmd *exec.Cmd) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	supervisor, read, write, err := commandSupervisor(cmd)
	if err != nil {
		return err
	}
	defer read.Close()
	defer write.Close()
	// Keep terminal signals on the bridge; the supervisor owns command teardown.
	supervisor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := supervisor.Start(); err != nil {
		return err
	}
	read.Close()
	if _, err := write.Write([]byte{1}); err != nil {
		write.Close()
		supervisor.Wait()
		return err
	}
	return waitCommand(ctx, supervisor, func() { write.Close() })
}

func superviseChild(cmd *exec.Cmd) error {
	if err := prepareSupervisor(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// EOF covers a crash/SIGKILL as well as normal cancellation. This process
	// survives its parent long enough to kill the command's complete group.
	go func() { io.Copy(io.Discard, os.Stdin); cancel() }()
	unlock := configureChild(cmd)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	kill := func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	err := waitCommand(ctx, cmd, kill)
	// A launcher can exit before its descendants. Clean up the remaining group
	// before the supervisor exits, even on an otherwise successful command.
	kill()
	if groupErr := waitCommandGroup(cmd.Process.Pid); err == nil {
		err = groupErr
	}
	return err
}
