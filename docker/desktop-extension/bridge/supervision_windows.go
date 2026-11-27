package main

import (
	"context"
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

func waitCommandJob(job syscall.Handle) error {
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
		time.Sleep(10 * time.Millisecond)
	}
}

func runSupervised(ctx context.Context, cmd *exec.Cmd) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job, err := newCommandJob()
	if err != nil {
		return err
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
	// The supervisor cannot spawn a command before admission. If this bridge dies
	// before assignment, EOF makes it exit without running anything. Once assigned,
	// all descendants inherit the job at creation, before executing any code.
	process, err := syscall.OpenProcess(processSetQuota|syscall.PROCESS_TERMINATE|syscall.SYNCHRONIZE, false, uint32(supervisor.Process.Pid))
	if err != nil {
		write.Close()
		supervisor.Wait()
		return err
	}
	defer syscall.CloseHandle(process)
	ok, _, assignErr := assignJobProcess.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		write.Close()
		supervisor.Wait()
		return fmt.Errorf("assign command job: %w", assignErr)
	}
	if _, err := write.Write([]byte{1}); err != nil {
		terminateCommandJob(job)
		waitCommandJob(job)
		supervisor.Wait()
		return err
	}
	// Wait for the process handle separately from exec.Wait's pipe draining: a
	// descendant holding stdout must not prevent job termination on normal exit.
	exited := make(chan error, 1)
	go func() { _, err := syscall.WaitForSingleObject(process, syscall.INFINITE); exited <- err }()
	var result error
	select {
	case result = <-exited:
	case <-ctx.Done():
		result = ctx.Err()
		terminateCommandJob(job)
		<-exited
	}
	if err := terminateCommandJob(job); err != nil && result == nil {
		result = err
	}
	if err := waitCommandJob(job); err != nil && result == nil {
		result = err
	}
	if err := supervisor.Wait(); result == nil {
		result = err
	}
	return result
}

func superviseChild(cmd *exec.Cmd) error {
	// This process was assigned before admission; CreateProcess inherits that job.
	return cmd.Run()
}
