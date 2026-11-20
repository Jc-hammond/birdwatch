package main

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Windows ignores Unix mode bits. Create a protected DACL granting full access only
// to the current SID, inherited by new cache files, and check existing cache entries.
var (
	advapi          = syscall.NewLazyDLL("advapi32.dll")
	parseDescriptor = advapi.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	readDescriptor  = advapi.NewProc("GetNamedSecurityInfoW")
	getACE          = advapi.NewProc("GetAce")
)

func privateCache(directory string) error {
	account, err := user.Current()
	if err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(directory)
	if err != nil {
		return err
	}
	sddl, err := syscall.UTF16PtrFromString("O:" + account.Uid + "D:P(A;OICI;FA;;;" + account.Uid + ")")
	if err != nil {
		return err
	}
	var descriptor syscall.Handle
	ok, _, err := parseDescriptor.Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return err
	}
	defer syscall.LocalFree(descriptor)
	attrs := syscall.SecurityAttributes{SecurityDescriptor: uintptr(descriptor)}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	if err = syscall.CreateDirectory(name, &attrs); err != nil && !errors.Is(err, syscall.ERROR_ALREADY_EXISTS) {
		return err
	}

	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s must be a directory", directory)
	}
	if err = checkCacheACL(directory, account.Uid, true); err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			return errors.New("unexpected certificate cache entry")
		}
		if err = checkCacheACL(filepath.Join(directory, entry.Name()), account.Uid, false); err != nil {
			return err
		}
	}
	return nil
}

func checkCacheACL(path, sid string, directory bool) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	// ACL and ACCESS_ALLOWED_ACE layouts are defined in winnt.h.
	var acl *struct {
		Revision, Reserved     byte
		Size, Count, Reserved2 uint16
	}
	var descriptor syscall.Handle
	const fileObject, daclInformation = 1, 4
	rc, _, _ := readDescriptor.Call(uintptr(unsafe.Pointer(name)), fileObject, daclInformation,
		0, 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if rc != 0 {
		return syscall.Errno(rc)
	}
	defer syscall.LocalFree(descriptor)
	denied := errors.New("certificate cache must grant access only to the server account")
	if acl == nil || acl.Count != 1 {
		return denied
	}
	var ace *struct {
		Type, Flags byte
		Size        uint16
		Mask        uint32
		SID         syscall.SID
	}
	ok, _, err := getACE.Call(uintptr(unsafe.Pointer(acl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 {
		return err
	}
	// ACCESS_ALLOWED_ACE_TYPE = 0. Directory grants must inherit to containers and objects.
	if ace.Type != 0 || (directory && ace.Flags&3 != 3) {
		return denied
	}
	trustee, err := ace.SID.String()
	if err != nil {
		return err
	}
	if trustee != sid {
		return denied
	}
	return nil
}
