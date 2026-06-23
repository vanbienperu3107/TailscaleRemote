// Package tsctl wraps the tailscale CLI for operations the agent needs to trigger.
package tsctl

import (
	"context"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Client struct {
	exe       string // path to tailscale.exe
	serverURL string
	authKey   string
}

func New(baseDir, serverURL, authKey string) *Client {
	return &Client{
		exe:       filepath.Join(baseDir, "tailscale.exe"),
		serverURL: serverURL,
		authKey:   authKey,
	}
}

// Up runs "tailscale up" and waits for success, retrying up to maxTries times.
func (c *Client) Up(ctx context.Context, role, lanRoutes string, maxTries int) error {
	args := []string{
		"up",
		"--unattended",
		"--login-server=" + c.serverURL,
		"--accept-routes",
	}
	if c.authKey != "" {
		args = append(args, "--authkey="+c.authKey)
	}
	if role == "itop" && lanRoutes != "" {
		args = append(args, "--advertise-routes="+lanRoutes)
	}

	for i := 0; i < maxTries; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		cmd := exec.CommandContext(ctx, c.exe, args...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			log.Printf("[tsctl] up OK (role=%s routes=%s)", role, lanRoutes)
			return nil
		}
		log.Printf("[tsctl] up attempt %d/%d failed: %v — %s", i+1, maxTries, err, strings.TrimSpace(string(out)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return nil // don't hard-fail; daemon may not be ready yet — caller retries later
}

// AdvertiseRoutes re-runs "tailscale up --advertise-routes=routes" to update the route set.
func (c *Client) AdvertiseRoutes(ctx context.Context, routes string) {
	args := []string{"up", "--login-server=" + c.serverURL, "--accept-routes",
		"--advertise-routes=" + routes}
	out, err := exec.CommandContext(ctx, c.exe, args...).CombinedOutput()
	if err != nil {
		log.Printf("[tsctl] advertise-routes update failed: %v — %s", err, strings.TrimSpace(string(out)))
		return
	}
	log.Printf("[tsctl] advertise-routes updated: %s", routes)
}

// Status returns the JSON output of "tailscale status --json".
func (c *Client) Status(ctx context.Context) ([]byte, error) {
	return exec.CommandContext(ctx, c.exe, "status", "--json").Output()
}

// Ping runs "tailscale ping -c N --timeout Ts <ip>" and returns combined output.
func (c *Client) Ping(ctx context.Context, ip string, count int, timeout string) (string, error) {
	out, err := exec.CommandContext(ctx, c.exe,
		"ping", "-c", itoa(count), "--timeout", timeout, ip).CombinedOutput()
	return string(out), err
}

func itoa(n int) string {
	if n <= 0 {
		return "2"
	}
	b := make([]byte, 0, 4)
	if n >= 100 {
		b = append(b, byte('0'+n/100))
	}
	if n >= 10 {
		b = append(b, byte('0'+(n/10)%10))
	}
	b = append(b, byte('0'+n%10))
	return string(b)
}
