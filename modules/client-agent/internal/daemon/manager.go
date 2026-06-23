// Package daemon manages the tailscaled.exe subprocess.
// On Windows, tailscaled requires admin privileges and --tun=userspace-networking
// for the portable (no-driver) mode.
package daemon

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Manager struct {
	exe       string // path to tailscaled.exe
	stateDir  string
	socksAddr string // e.g. "127.0.0.1:7654"
	logsDir   string
	baseDir   string
}

func New(baseDir, socksAddr, logsDir string) *Manager {
	return &Manager{
		exe:       filepath.Join(baseDir, "tailscaled.exe"),
		stateDir:  filepath.Join(baseDir, "state"),
		socksAddr: socksAddr,
		logsDir:   logsDir,
		baseDir:   baseDir,
	}
}

// Run starts tailscaled and keeps it alive until ctx is cancelled.
// Restarts automatically on crash with exponential back-off (max 30s).
func (m *Manager) Run(ctx context.Context) {
	if _, err := os.Stat(m.exe); os.IsNotExist(err) {
		log.Printf("[daemon] tailscaled.exe not found at %s — skipping", m.exe)
		return
	}
	if err := os.MkdirAll(m.stateDir, 0o700); err != nil {
		log.Printf("[daemon] mkdir state: %v", err)
	}

	backoff := 2 * time.Second
	for {
		cmd := exec.CommandContext(ctx, m.exe,
			"--tun=userspace-networking",
			"--socks5-server="+m.socksAddr,
			"--statedir="+m.stateDir,
			"--verbose=1",
		)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		proxyConfPath := filepath.Join(m.baseDir, "proxy.conf")
		cmd.Env = append(os.Environ(),
			"TS_PROXY_CONF="+proxyConfPath,
			"TS_LOGS_DIR="+m.logsDir,
		)

		log.Printf("[daemon] starting tailscaled (socks5=%s state=%s)", m.socksAddr, m.stateDir)
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				log.Println("[daemon] stopped")
				return
			}
			log.Printf("[daemon] tailscaled exited: %v — restart in %s", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		} else {
			backoff = 2 * time.Second
		}
	}
}
