//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
)

func privateCache(directory string) error {
	if err := os.Mkdir(directory, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("%s must be an owner-only directory", directory)
	}
	return nil
}
