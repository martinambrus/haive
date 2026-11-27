//go:build linux || darwin

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// FD 3 belongs only to the supervisor. We mark it close-on-exec, and
// the command receives no ExtraFiles, so command descendants cannot hold it open.
var supervisorStatusFile *os.File

func supervisorStatus() *os.File {
	if supervisorStatusFile == nil {
		syscall.CloseOnExec(3)
		supervisorStatusFile = os.NewFile(3, "command-status")
	}
	return supervisorStatusFile
}
func finishSupervisor(err error) {
	status := supervisorStatus()
	defer status.Close()
	if errors.Is(err, errCommandStopUnconfirmed) {
		fmt.Fprintln(status, "unconfirmed")
		return
	}
	fmt.Fprintln(status, "complete")
}

type commandStatus struct {
	group                 int
	complete, unconfirmed bool
	err                   error
}

func readCommandStatus(r io.Reader) commandStatus {
	var status commandStatus
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		switch line {
		case "complete":
			status.complete = true
		case "unconfirmed":
			status.unconfirmed = true
		default:
			var group int
			if _, err := fmt.Sscanf(line, "group %d", &group); err != nil || group <= 1 || status.group != 0 {
				status.err = errors.New("invalid supervisor status")
			} else {
				status.group = group
			}
		}
	}
	if err := scanner.Err(); err != nil {
		status.err = err
	}
	return status
}

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
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer statusRead.Close()
	defer statusWrite.Close()
	supervisor.ExtraFiles = []*os.File{statusWrite}
	// Also reap descendants adopted after a supervisor dies on Linux.
	prepareBridgeReaper()
	supervisor.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := supervisor.Start(); err != nil {
		return err
	}
	read.Close()
	statusWrite.Close()
	done := make(chan error, 1)
	go func() { done <- supervisor.Wait() }()
	reported := make(chan commandStatus, 1)
	go func() { reported <- readCommandStatus(statusRead) }()
	if _, err := write.Write([]byte{1}); err != nil {
		write.Close()
		supervisor.Process.Kill()
		return errors.Join(err, boundedCommandWait(done, commandTeardownTimeout))
	}
	var status commandStatus
	var cancelled bool
	select {
	case status = <-reported:
	case <-ctx.Done():
		cancelled = true
		write.Close()
		timer := time.NewTimer(commandTeardownTimeout)
		defer timer.Stop()
		select {
		case status = <-reported:
		case <-timer.C:
			supervisor.Process.Kill()
			// Killing closes its status descriptor; collect the group for our sweep.
			select {
			case status = <-reported:
			case <-time.After(commandTeardownTimeout):
				return errCommandStopUnconfirmed
			}
		}
	}
	// EOF is independent of stdout draining, so grandchildren cannot hide the
	// supervisor's death by retaining output descriptors.
	var groupErr error
	if status.group > 1 {
		syscall.Kill(-status.group, syscall.SIGKILL)
		groupErr = waitCommandGroup(status.group, commandTeardownTimeout)
	}
	waitErr := boundedCommandWait(done, commandTeardownTimeout)
	if groupErr != nil || status.unconfirmed || errors.Is(waitErr, errCommandStopUnconfirmed) || errors.Is(waitErr, exec.ErrWaitDelay) {
		return errors.Join(errCommandStopUnconfirmed, groupErr, waitErr)
	}
	var exit *exec.ExitError
	signalled := errors.As(waitErr, &exit) && exit.Sys().(syscall.WaitStatus).Signaled()
	if !status.complete || status.err != nil || signalled {
		return errors.Join(errCommandUncertain, status.err, waitErr)
	}
	if cancelled {
		return context.Cause(ctx)
	}
	return waitErr
}

func superviseChild(cmd *exec.Cmd) error {
	prepareSupervisor()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { io.Copy(io.Discard, os.Stdin); cancel() }()
	unlock := configureChild(cmd)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	status := supervisorStatus()
	if err := cmd.Start(); err != nil {
		return err
	}
	_, reportErr := fmt.Fprintln(status, "group", cmd.Process.Pid)
	kill := func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	if reportErr != nil {
		kill()
	}
	err := waitCommand(ctx, cmd, kill)
	kill()
	return errors.Join(err, waitCommandGroup(cmd.Process.Pid, commandTeardownTimeout), reportErr)
}
