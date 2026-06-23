package gostctl

import (
	"context"
	"os/exec"
	"syscall"
)

// withSysProcAttr wraps exec.CommandContext with Windows process group flags
// so that when the context is cancelled, the child process tree is killed cleanly.
func withSysProcAttr(ctx context.Context, exe string, args []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	return cmd
}
