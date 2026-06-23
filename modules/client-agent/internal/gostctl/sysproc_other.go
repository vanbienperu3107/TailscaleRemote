//go:build !windows

package gostctl

import (
	"context"
	"os/exec"
)

func withSysProcAttr(ctx context.Context, exe string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, exe, args...)
}
