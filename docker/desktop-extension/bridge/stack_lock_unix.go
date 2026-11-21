//go:build !windows

package main

import "syscall"

const noFollow = syscall.O_NOFOLLOW
