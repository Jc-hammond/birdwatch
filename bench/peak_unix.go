//go:build linux || darwin

package main

import (
	"errors"
	"os/exec"
	"runtime"
	"syscall"
)

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}

func stop(cmd *exec.Cmd) (int64, error) {
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if syscall.Kill(-cmd.Process.Pid, 0) == nil {
		// A launcher exited while its serving child remained. Its RSS describes
		// the launcher; return an actionable error instead of that number.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		return 0, errors.New("the server command spawned a separate server; invoke its executable or interpreter directly to measure server memory")
	}
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
