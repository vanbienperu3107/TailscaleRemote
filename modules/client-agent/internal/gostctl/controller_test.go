//go:build !windows

// Tests run on Linux in CI; use /bin/echo as a stand-in for gost.exe.
// Windows tests would need a real .exe; excluded to keep CI fast.

package gostctl

import (
	"os"
	"testing"
	"time"

	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/config"
)

func echo() string {
	if _, err := os.Stat("/bin/echo"); err == nil {
		return "/bin/echo"
	}
	return "/usr/bin/echo"
}

func TestController_stopBeforeStart(t *testing.T) {
	c := New(echo())
	// Stop on a never-started controller must not panic or block.
	done := make(chan struct{})
	go func() { c.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() deadlocked on never-started controller")
	}
}

func TestController_applyStop(t *testing.T) {
	c := New(echo())
	cfg := &config.Config{
		ProxyRank:      "http:18888",
		GostListenPort: 18888,
		GostItopPort:   18080,
	}
	// Apply starts the goroutine; /bin/echo exits immediately and restarts.
	// Give it a moment to enter the loop.
	c.Apply("votam", cfg, "127.0.0.1:7654")
	time.Sleep(600 * time.Millisecond)

	done := make(chan struct{})
	go func() { c.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop() deadlocked after Apply()")
	}
}

func TestController_rapidReapply(t *testing.T) {
	c := New(echo())
	cfg := &config.Config{
		ProxyRank:      "http:18888",
		GostListenPort: 18888,
		GostItopPort:   18080,
	}
	// Rapid Apply calls must not deadlock (previous goroutine cancellation race).
	done := make(chan struct{})
	go func() {
		for i := range 5 {
			cfg.GostListenPort = 18880 + i
			c.Apply("votam", cfg, "127.0.0.1:7654")
			time.Sleep(50 * time.Millisecond)
		}
		c.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("rapid Apply/Stop deadlocked")
	}
}

func TestController_missingExe(t *testing.T) {
	c := New("/nonexistent/gost.exe.test")
	cfg := &config.Config{ProxyRank: "http:18888"}
	// Apply on missing exe is a no-op — must not panic.
	c.Apply("votam", cfg, "127.0.0.1:7654")
	c.Stop()
}
