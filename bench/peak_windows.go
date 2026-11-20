package main

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

func configureProcess(cmd *exec.Cmd) {
	cmd.Cancel = func() error { return terminateTree(cmd) }
}

func terminateTree(cmd *exec.Cmd) error {
	return exec.Command("taskkill.exe", "/pid", strconv.Itoa(cmd.Process.Pid), "/t", "/f").Run()
}

func stop(cmd *exec.Cmd) (int64, error) {
	defer func() { _ = terminateTree(cmd); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	const queryAndRead = 0x0400 | 0x0010
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snapshot, &entry); err == nil; err = syscall.Process32Next(snapshot, &entry) {
		if entry.ParentProcessID == uint32(cmd.Process.Pid) {
			return 0, errors.New("the server command spawned a separate server; invoke its executable or interpreter directly to measure server memory")
		}
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return 0, err
	}
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
