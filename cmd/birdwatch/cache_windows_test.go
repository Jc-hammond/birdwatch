package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCertificateKeysArePrivateOnWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "certs")
	if err := privateCache(path); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(path, "key")
	if err := os.WriteFile(key, []byte("test fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := privateCache(path); err != nil {
		t.Fatalf("could not reopen private cache: %v", err)
	}
	// Add an explicit read grant for Everyone to this disposable key.
	if out, err := exec.Command("icacls", key, "/grant", "*S-1-1-0:(R)").CombinedOutput(); err != nil {
		t.Fatalf("could not set test permissions: %v %s", err, out)
	}
	if err := privateCache(path); err == nil {
		t.Fatal("accepted a cache with a publicly readable key")
	}
}
