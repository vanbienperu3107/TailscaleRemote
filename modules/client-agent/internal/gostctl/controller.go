package gostctl

import (
	"context"
	"log"
	"os"
	"sync"
	"time"

	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/config"
)

// Controller manages a single gost.exe subprocess.
// Goroutine-safe: Apply/Stop can be called from multiple goroutines.
type Controller struct {
	exe string
	mu  sync.Mutex
	// cancel cancels the current run goroutine. Nil when not running.
	cancel context.CancelFunc
}

func New(exe string) *Controller {
	return &Controller{exe: exe}
}

// Apply starts or restarts gost with args derived from role + cfg.
// No-op (silently) if gost.exe does not exist.
// If gost should not run (proxy_rank has no http port and gost_fallback=false), stops it.
func (c *Controller) Apply(role string, cfg *config.Config, socksAddr string) {
	if _, err := os.Stat(c.exe); os.IsNotExist(err) {
		return
	}
	if !GostEnabled(cfg.ProxyRank) && !cfg.GostFallback {
		c.Stop()
		return
	}
	c.start(BuildArgs(role, cfg, socksAddr))
}

// Stop kills the running gost subprocess and waits for the goroutine to exit.
func (c *Controller) Stop() {
	c.mu.Lock()
	cancel := c.cancel
	c.cancel = nil
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
}

// start cancels any existing run, then launches a new goroutine that keeps gost alive.
func (c *Controller) start(args []string) {
	// Cancel previous goroutine before starting a new one to avoid two gost processes
	// binding the same port simultaneously.
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.mu.Unlock()

	go func() {
		// Brief settle time to let the previous process release its port.
		select {
		case <-ctx.Done():
			return
		case <-time.After(300 * time.Millisecond):
		}

		backoff := 2 * time.Second
		for {
			if ctx.Err() != nil {
				log.Println("[gost] stopped")
				return
			}

			// exec.CommandContext kills the child when ctx is cancelled.
			cmd := withSysProcAttr(ctx, c.exe, args)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			log.Printf("[gost] start: %v", args)

			if err := cmd.Run(); err != nil {
				if ctx.Err() != nil {
					log.Println("[gost] stopped")
					return
				}
				log.Printf("[gost] exited: %v — restart in %s", err, backoff)
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
	}()
}
