package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

var jobKernel = syscall.NewLazyDLL("kernel32.dll")
var createJobObject = jobKernel.NewProc("CreateJobObjectW")
var setJobInformation = jobKernel.NewProc("SetInformationJobObject")
var assignJobProcess = jobKernel.NewProc("AssignProcessToJobObject")
var terminateJobObject = jobKernel.NewProc("TerminateJobObject")
var queryJobInformation = jobKernel.NewProc("QueryInformationJobObject")

const jobObjectExtendedLimitInformation = 9
const jobObjectBasicAccountingInformation = 1
const jobObjectLimitKillOnJobClose = 0x2000
const processSetQuota = 0x0100 // PROCESS_SET_QUOTA is absent from Go syscall.

// Win64 layout shared by amd64 and arm64. No breakaway flags are enabled.
// https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information
// https://learn.microsoft.com/windows/win32/procthread/job-objects
// The handle is unnamed and non-inheritable: only the bridge keeps it alive.
type jobLimits struct {
	PerProcessUserTime, PerJobUserTime                         int64
	LimitFlags                                                 uint32
	MinimumWorkingSet, MaximumWorkingSet                       uintptr
	ActiveProcessLimit                                         uint32
	Affinity                                                   uintptr
	PriorityClass, SchedulingClass                             uint32
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

type jobAccounting struct {
	UserTime, KernelTime, PeriodUserTime, PeriodKernelTime           int64
	PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}

func newCommandJob() (syscall.Handle, error) {
	handle, _, err := createJobObject.Call(0, 0)
	if handle == 0 {
		return 0, fmt.Errorf("create command job: %w", err)
	}
	job := syscall.Handle(handle)
	limits := jobLimits{LimitFlags: jobObjectLimitKillOnJobClose}
	ok, _, err := setJobInformation.Call(handle, jobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, fmt.Errorf("configure command job: %w", err)
	}
	return job, nil
}

func terminateCommandJob(job syscall.Handle) error {
	ok, _, err := terminateJobObject.Call(uintptr(job), 125)
	if ok == 0 {
		return fmt.Errorf("terminate command job: %w", err)
	}
	return nil
}

func waitCommandJob(job syscall.Handle, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	// Termination is asynchronous. Keep the handle and install lease until every
	// job member has exited, not merely until the supervisor has exited.
	for {
		var accounting jobAccounting
		ok, _, err := queryJobInformation.Call(uintptr(job), jobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), unsafe.Sizeof(accounting), 0)
		if ok == 0 {
			return fmt.Errorf("query command job: %w", err)
		}
		if accounting.ActiveProcesses == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return errCommandStopUnconfirmed
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assignCommandJob(job, process syscall.Handle) error {
	ok, _, err := assignJobProcess.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	return nil
}

func runSupervised(ctx context.Context, cmd *exec.Cmd) error {
	return runSupervisedWithAssign(ctx, cmd, assignCommandJob)
}

func runSupervisedWithAssign(ctx context.Context, cmd *exec.Cmd, assign func(syscall.Handle, syscall.Handle) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job, err := newCommandJob()
	if err != nil {
		return supervisionFailure(cmd, err)
	}
	defer syscall.CloseHandle(job)
	supervisor, read, write, err := commandSupervisor(cmd)
	if err != nil {
		return err
	}
	defer read.Close()
	defer write.Close()
	if err := supervisor.Start(); err != nil {
		return err
	}
	read.Close()
	done := make(chan error, 1)
	refuse := func(err error) error {
		write.Close()
		return errors.Join(supervisionFailure(cmd, err), boundedCommandWait(done, commandTeardownTimeout))
	}
	process, err := syscall.OpenProcess(processSetQuota|syscall.PROCESS_TERMINATE|syscall.SYNCHRONIZE, false, uint32(supervisor.Process.Pid))
	// Keep os.Process's handle until OpenProcess has acquired its own, excluding
	// PID reuse even if the supervisor crashes before admission.
	go func() { done <- supervisor.Wait() }()
	if err != nil {
		return refuse(fmt.Errorf("open command supervisor: %w", err))
	}
	if err := assign(job, process); err != nil {
		syscall.CloseHandle(process)
		return refuse(err)
	}
	// The waiter owns this handle: a bounded return must not close a handle
	// underneath an outstanding WaitForSingleObject. Closing the job on return
	// still kills members if termination failed.
	exited := make(chan error, 1)
	go func() {
		defer syscall.CloseHandle(process)
		_, err := syscall.WaitForSingleObject(process, syscall.INFINITE)
		exited <- err
	}()
	// Assignment is complete before admission; every command descendant inherits
	// the job at creation, and only the bridge owns its kill-on-close handle.
	if _, err := write.Write([]byte{1}); err != nil {
		terminateErr := terminateCommandJob(job)
		groupErr := waitCommandJob(job, commandTeardownTimeout)
		return errors.Join(err, terminateErr, groupErr, boundedCommandWait(done, commandTeardownTimeout))
	}
	// Observe the kernel process handle independently of output draining.
	var result error
	select {
	case result = <-exited:
	case <-ctx.Done():
		result = context.Cause(ctx)
	}
	terminateErr := terminateCommandJob(job)
	groupErr := waitCommandJob(job, commandTeardownTimeout)
	waitErr := boundedCommandWait(done, commandTeardownTimeout)
	if terminateErr != nil || groupErr != nil || errors.Is(waitErr, errCommandStopUnconfirmed) || errors.Is(waitErr, exec.ErrWaitDelay) {
		return errors.Join(errCommandStopUnconfirmed, terminateErr, groupErr, waitErr, result)
	}
	return errors.Join(result, waitErr)
}

func finishSupervisor(error) {}

func superviseChild(cmd *exec.Cmd) error {
	// This process was assigned before admission; CreateProcess inherits that job.
	return cmd.Run()
}
