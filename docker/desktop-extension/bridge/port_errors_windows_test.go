package main

import (
	"net"
	"os"
	"syscall"
	"testing"
)

func TestWinsockBindConflicts(t *testing.T) {
	for _, code := range []error{addressInUse, syscall.WSAEACCES, syscall.ERROR_ACCESS_DENIED} {
		wrapped := &net.OpError{Op: "listen", Net: "tcp6", Err: &os.SyscallError{Syscall: "bind", Err: code}}
		if !bindConflict(wrapped) {
			t.Fatalf("Winsock conflict not recognized: %v", code)
		}
	}
}
