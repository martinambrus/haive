package main

import (
	"errors"
	"os"
	"syscall"
)

// Go's syscall.EADDRINUSE on Windows is an invented POSIX compatibility value,
// not Winsock's code. Go exposes WSAEACCES but not WSAEADDRINUSE, whose stable
// value is specified at https://learn.microsoft.com/windows/win32/winsock/windows-sockets-error-codes-2.
const addressInUse syscall.Errno = 10048

func bindConflict(err error) bool {
	return errors.Is(err, addressInUse) || errors.Is(err, syscall.WSAEACCES) || errors.Is(err, os.ErrPermission)
}
