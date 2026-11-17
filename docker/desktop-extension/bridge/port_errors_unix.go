//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

const addressInUse = syscall.EADDRINUSE

func bindConflict(err error) bool {
	return errors.Is(err, addressInUse) || errors.Is(err, os.ErrPermission)
}
