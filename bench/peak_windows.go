package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

func stop(cmd *exec.Cmd) (int64, error) {
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	const queryAndRead = 0x0400 | 0x0010
	handle, err := syscall.OpenProcess(queryAndRead, false, uint32(cmd.Process.Pid))
	if err != nil {
		return 0, err
	}
	defer syscall.CloseHandle(handle)
	// PROCESS_MEMORY_COUNTERS starts with two DWORDs followed by eight SIZE_Ts.
	var counters struct {
		Size, PageFaults           uint32
		PeakWorkingSet, WorkingSet uintptr
		Remaining                  [6]uintptr
	}
	counters.Size = uint32(unsafe.Sizeof(counters))
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("K32GetProcessMemoryInfo")
	ok, _, err := proc.Call(uintptr(handle), uintptr(unsafe.Pointer(&counters)), uintptr(counters.Size))
	if ok == 0 {
		return 0, err
	}
	return int64(counters.PeakWorkingSet), nil
}
