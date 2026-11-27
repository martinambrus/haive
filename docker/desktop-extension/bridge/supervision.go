package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

const supervisorMode = "--haive-command-supervisor"
const supervisorNonceEnv = "HDE_COMMAND_NONCE"

// Applies only after cancellation or supervisor exit, never to a running command.
const commandTeardownTimeout = 30 * time.Second

var errCommandUncertain = errors.New("The command outcome is uncertain because its supervisor exited unexpectedly. Inspect this install's status, operation log and updater journal before retrying; manual recovery may be required.")
var errCommandStopUnconfirmed = errors.New("Could not confirm the command stopped. Inspect this install's host processes, status and updater journal before retrying; manual recovery is required.")
var errLeaseLost = errors.New("The install lease was lost or could not be renewed safely; the operation was cancelled. Check status and the updater journal before retrying.")

type supervisionUnavailable struct{ cause error }

func (e *supervisionUnavailable) Error() string {
	return "Host command supervision is unavailable; the command was refused before execution. Check the bridge log and Windows Job Object or security policy before retrying."
}
func (e *supervisionUnavailable) Unwrap() error { return e.cause }
func supervisionFailure(cmd *exec.Cmd, err error) error {
	fmt.Fprintln(os.Stderr, "host command supervision:", err)
	if cmd.Stderr != nil {
		fmt.Fprintln(cmd.Stderr, "host command supervision:", err)
	}
	return &supervisionUnavailable{err}
}

// This mode is admitted only with a per-launch nonce and the parent's live pipe.
// No command is spawned before admission (and Windows job assignment).
func init() {
	if len(os.Args) < 2 || os.Args[1] != supervisorMode {
		return
	}
	fail := func(err error) { fmt.Fprintln(os.Stderr, "command supervisor:", err); os.Exit(125) }
	if len(os.Args) < 4 || len(os.Args[2]) != 64 || os.Getenv(supervisorNonceEnv) != os.Args[2] {
		fail(errors.New("missing or invalid launch nonce"))
		return
	}
	os.Unsetenv(supervisorNonceEnv)
	var admission [1]byte
	if _, err := io.ReadFull(os.Stdin, admission[:]); err != nil || admission[0] != 1 {
		fail(errors.New("parent did not admit the command"))
		return
	}
	cmd := exec.Command(os.Args[3], os.Args[4:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	err := superviseChild(cmd)
	// The Unix completion record proves that group teardown finished. A supervisor
	// crash before this record is an ambiguous command outcome, even at exit zero.
	finishSupervisor(err)
	if err == nil {
		os.Exit(0)
	}
	fmt.Fprintln(os.Stderr, "command supervisor:", err)
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() > 0 {
		os.Exit(exit.ExitCode())
	}
	os.Exit(125)
}

func commandSupervisor(cmd *exec.Cmd) (*exec.Cmd, *os.File, *os.File, error) {
	if cmd.Err != nil {
		return nil, nil, nil, cmd.Err
	}
	if cmd.Stdin != nil || len(cmd.ExtraFiles) != 0 || cmd.SysProcAttr != nil || cmd.Cancel != nil || cmd.WaitDelay != 0 || cmd.Process != nil || cmd.ProcessState != nil || len(cmd.Args) == 0 {
		return nil, nil, nil, errors.New("commandSupervisor: unsupported command fields (stdin, extra files, process attributes, cancellation, wait delay or started command)")
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, nil, nil, err
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, nil, err
	}
	token := hex.EncodeToString(nonce)
	read, write, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	args := append([]string{supervisorMode, token, cmd.Path}, cmd.Args[1:]...)
	supervisor := exec.Command(exe, args...)
	supervisor.Dir = cmd.Dir
	env := cmd.Env
	if env == nil {
		env = os.Environ()
	}
	for _, e := range env {
		key, _, _ := strings.Cut(e, "=")
		if !strings.EqualFold(key, supervisorNonceEnv) {
			supervisor.Env = append(supervisor.Env, e)
		}
	}
	supervisor.Env = append(supervisor.Env, supervisorNonceEnv+"="+token)
	supervisor.Stdin, supervisor.Stdout, supervisor.Stderr = read, cmd.Stdout, cmd.Stderr
	supervisor.WaitDelay = commandTeardownTimeout
	return supervisor, read, write, nil
}

func boundedCommandWait(done <-chan error, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		return errCommandStopUnconfirmed
	}
}

// Cancellation requests termination; completion includes OS teardown and output drain.
func waitCommand(ctx context.Context, cmd *exec.Cmd, cancel func()) error {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		cancel()
		if err := boundedCommandWait(done, commandTeardownTimeout); errors.Is(err, errCommandStopUnconfirmed) {
			return err
		}
		return context.Cause(ctx)
	}
}
