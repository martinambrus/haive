//go:build linux || darwin

package main

import (
	"os"
	"syscall"
)

func commandGroupGone(group int) bool { return group > 1 && syscall.Kill(-group, 0) == syscall.ESRCH }

func syncMarkerDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
