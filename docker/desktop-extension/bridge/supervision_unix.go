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
	"strconv"
	"strings"
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
	return readCommandStatusReporting(r, func(int) {})
}
func readCommandStatusReporting(r io.Reader, report func(int)) commandStatus {
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
			group, err := strconv.Atoi(strings.TrimPrefix(line, "group "))
			if !strings.HasPrefix(line, "group ") || err != nil || group <= 1 || status.group != 0 {
				status.err = errors.New("invalid supervisor status")
			} else {
				status.group = group
				report(group)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		status.err = err
	}
	return status
}

func runSupervised(ctx context.Context, cmd *exec.Cmd) error {
	return runSupervisedWithTimeout(ctx, cmd, commandTeardownTimeout)
}
func runSupervisedWithTimeout(ctx context.Context, cmd *exec.Cmd, teardown time.Duration) (result error) {
	group := 0
	defer func() {
		if errors.Is(result, errCommandStopUnconfirmed) || errors.Is(result, errCommandUncertain) {
			result = &commandOutcome{result, group}
		}
	}()
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
	groups := make(chan int, 1)
	go func() { reported <- readCommandStatusReporting(statusRead, func(g int) { groups <- g }) }()
	if _, err := write.Write([]byte{1}); err != nil {
		write.Close()
		supervisor.Process.Kill()
		return errors.Join(err, boundedCommandWait(done, commandTeardownTimeout))
	}
	var status commandStatus
	var cancelled, killed bool
	cancelDone := ctx.Done()
	var timeout <-chan time.Time
	timer := time.NewTimer(teardown)
	timer.Stop()
	defer timer.Stop()
	signalGroup := func() {
		if group > 1 {
			syscall.Kill(-group, syscall.SIGKILL)
		}
	}
collect:
	for {
		select {
		case group = <-groups:
			// Publication is independent of EOF, including a stalled supervisor.
			if cancelled {
				signalGroup()
			}
		case status = <-reported:
			if status.group > 1 {
				group = status.group
			}
			break collect
		case <-cancelDone:
			cancelled = true
			cancelDone = nil
			write.Close()
			signalGroup()
			timer.Reset(teardown)
			timeout = timer.C
		case <-timeout:
			signalGroup()
			supervisor.Process.Kill()
			if killed {
				return errCommandStopUnconfirmed
			}
			killed = true
			timer.Reset(teardown)
		}
	}
	// EOF is independent of stdout draining, so grandchildren cannot hide the
	// supervisor's death by retaining output descriptors.
	groupErr := sweepCommandGroup(status, func(group int) error {
		syscall.Kill(-group, syscall.SIGKILL)
		return waitCommandGroup(group, teardown)
	})
	waitErr := boundedCommandWait(done, teardown)
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
	groupErr := waitCommandGroup(cmd.Process.Pid, commandTeardownTimeout)
	var probeErr *commandGroupProbeError
	// A permission/probe failure is a warning only after a successful command.
	// Cancel and supervisor-death sweeps always require ESRCH.
	if err == nil && ctx.Err() == nil && reportErr == nil && errors.As(groupErr, &probeErr) {
		fmt.Fprintln(os.Stderr, "command supervisor warning: probe command group:", probeErr.cause)
		groupErr = nil
	}
	return errors.Join(err, groupErr, reportErr)
}

type commandGroupProbeError struct{ cause error }

func (e *commandGroupProbeError) Error() string { return e.cause.Error() }
func (e *commandGroupProbeError) Unwrap() error { return e.cause }

func waitCommandGroup(group int, timeout time.Duration) error {
	return waitCommandGroupWithProbe(group, timeout, func(group int) error { return syscall.Kill(-group, 0) })
}
func waitCommandGroupWithProbe(group int, timeout time.Duration, probe func(int) error) error {
	deadline := time.Now().Add(timeout)
	for {
		if err := reapCommandGroup(group); err != nil {
			return err
		}
		err := probe(group)
		if err == syscall.ESRCH {
			return nil
		}
		if err != nil {
			return errors.Join(errCommandStopUnconfirmed, &commandGroupProbeError{err})
		}
		if !time.Now().Before(deadline) {
			return errCommandStopUnconfirmed
		}
		time.Sleep(time.Millisecond)
	}
}

func sweepCommandGroup(status commandStatus, sweep func(int) error) error {
	if status.group <= 1 || (status.complete && status.err == nil && !status.unconfirmed) {
		return nil
	}
	return sweep(status.group)
}
