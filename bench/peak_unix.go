//go:build linux || darwin

package main

import (
	"errors"
	"os/exec"
	"runtime"
	"syscall"
)

func stop(cmd *exec.Cmd) (int64, error) {
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if cmd.ProcessState == nil {
		return 0, errors.New("server resource usage unavailable")
	}
	usage, ok := cmd.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok {
		return 0, errors.New("server peak memory unavailable")
	}
	peak := int64(usage.Maxrss)
	if runtime.GOOS == "linux" {
		peak *= 1024
	}
	return peak, nil
}
