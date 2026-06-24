// tailscale-agent — replaces metrics-report.ps1, manages tailscaled.exe + gost.exe.
//
// Usage:
//
//	tailscale-agent.exe --server=https://vpn2.hangocthanh.io.vn [--authkey=KEY] [--secret=SECRET]
//
// The agent:
//  1. Starts tailscaled.exe (userspace networking + SOCKS5 on --socks-addr).
//  2. Runs "tailscale up" and waits for authentication.
//  3. Detects role (itop / votam) via local IP prefix from the server config.
//  4. Starts gost.exe with appropriate args if present and proxy_rank includes http.
//  5. Reports peer latency to the dashboard every metrics_interval seconds.
//  6. Polls /api/client/config and auto-applies changes:
//     - lan_routes changed  → re-run tailscale up --advertise-routes (itop only)
//     - proxy_rank changed  → restart gost
//     - metrics_interval    → update reporter ticker
package main

import (
	"context"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/config"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/daemon"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/gostctl"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/metrics"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/proxyconf"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/role"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/tsctl"
	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/winproxy"
)

func main() {
	serverURL := flag.String("server", "", "Headscale / dashboard server URL (required)")
	authKey   := flag.String("authkey", "", "Pre-auth key (optional, leave empty for OIDC)")
	secret    := flag.String("secret", "", "X-Metrics-Secret header value")
	socksAddr := flag.String("socks-addr", "127.0.0.1:7654", "Tailscale SOCKS5 listen address")
	configInterval := flag.Duration("config-interval", 5*time.Minute, "How often to re-fetch server config")
	flag.Parse()

	if *serverURL == "" {
		log.Fatal("--server is required")
	}

	// Base directory = same folder as this exe (portable layout).
	exe, _ := os.Executable()
	baseDir := filepath.Dir(exe)

	// Apply upstream proxy from proxy.conf before any network calls.
	if err := proxyconf.Apply(baseDir); err != nil {
		log.Printf("[main] proxy.conf: %v", err)
	}
	logsDir := filepath.Join(baseDir, "logs")
	if err := os.MkdirAll(logsDir, 0755); err != nil {
		log.Printf("[main] logs dir: %v", err)
	}

	log.SetFlags(log.LstdFlags)
	log.Printf("tailscale-agent starting (server=%s socks=%s)", *serverURL, *socksAddr)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// ── 1. Start tailscaled.exe ──────────────────────────────────────────────
	dmgr := daemon.New(baseDir, *socksAddr, logsDir)
	go dmgr.Run(ctx)

	// Give tailscaled a moment to bind the socket.
	time.Sleep(2 * time.Second)

	// ── 2. Fetch initial config ───────────────────────────────────────────────
	initialCfg, err := config.Fetch(*serverURL)
	if err != nil {
		log.Printf("[main] initial config fetch failed, using defaults: %v", err)
		initialCfg = config.Defaults()
	}

	// ── 3. Detect role ────────────────────────────────────────────────────────
	var roleMu sync.Mutex
	currentRole := role.Detect(initialCfg.ItopLanPrefix)
	log.Printf("[main] role=%s (prefix=%s)", currentRole, initialCfg.ItopLanPrefix)

	// ── 4. Tailscale up ───────────────────────────────────────────────────────
	ts := tsctl.New(baseDir, *serverURL, *authKey)
	if err := ts.Up(ctx, currentRole, initialCfg.LanRoutes, 15); err != nil {
		log.Printf("[main] tailscale up error: %v", err)
	}

	// ── 5. Set Windows system PAC URL ────────────────────────────────────────
	// Clear any stale PAC from a previous unclean shutdown (SIGKILL, power loss).
	winproxy.ClearPAC()
	pacURL := *serverURL + "/api/client/proxy.pac"
	// votam: browser needs PAC to route internal subnets through Tailscale SOCKS5.
	// itop: LAN is directly reachable via advertise-routes; no PAC needed.
	if currentRole == "votam" {
		winproxy.SetPAC(pacURL)
	}
	defer winproxy.ClearPAC() // restore direct access on clean shutdown

	// ── 6. Gost controller ────────────────────────────────────────────────────
	gostExe := filepath.Join(baseDir, "gost.exe")
	gc := gostctl.New(gostExe)
	gc.Apply(currentRole, initialCfg, *socksAddr)

	// ── 7. Report active ports (once at startup) ─────────────────────────────
	_, socksPortStr, _ := net.SplitHostPort(*socksAddr)
	socksPort, _ := strconv.Atoi(socksPortStr)
	httpPort := 0
	if gostctl.GostEnabled(initialCfg.ProxyRank) || initialCfg.GostFallback {
		httpPort = initialCfg.GostListenPort
	}

	// ── 8. Metrics reporter ───────────────────────────────────────────────────
	reporter := metrics.New(*serverURL, *secret, ts.Status, ts.Ping, initialCfg.MetricsInterval, initialCfg.PingCount, initialCfg.PingTimeout)
	if err := reporter.ReportActivePorts(ctx, socksPort, httpPort); err != nil {
		log.Printf("[main] active_ports report: %v", err)
	}
	go reporter.Run(ctx)

	// ── 9. Config poller ──────────────────────────────────────────────────────
	go config.RunPoller(ctx, *serverURL, *configInterval, func(c config.Change) {
		newRole := role.Detect(c.New.ItopLanPrefix)

		roleMu.Lock()
		roleChanged := newRole != currentRole
		if roleChanged {
			log.Printf("[main] role changed: %s → %s", currentRole, newRole)
			currentRole = newRole
		}
		activeRole := currentRole
		roleMu.Unlock()

		if roleChanged {
			if activeRole == "votam" {
				winproxy.SetPAC(pacURL)
			} else {
				winproxy.ClearPAC()
			}
		}

		if c.LanRoutesChanged && activeRole == "itop" {
			log.Printf("[main] lan_routes updated: %s", c.New.LanRoutes)
			ts.AdvertiseRoutes(ctx, c.New.LanRoutes)
		}

		if c.GostArgsChanged || roleChanged {
			log.Printf("[main] gost config changed — restarting gost")
			gc.Apply(activeRole, c.New, *socksAddr)
		}

		if c.IntervalChanged {
			log.Printf("[main] metrics_interval → %ds", c.New.MetricsInterval)
			reporter.SetInterval(c.New.MetricsInterval)
		}

		if c.PingChanged {
			log.Printf("[main] ping params → count=%d timeout=%s", c.New.PingCount, c.New.PingTimeout)
			reporter.SetPingParams(c.New.PingCount, c.New.PingTimeout)
		}
	})

	<-ctx.Done()
	log.Println("[main] shutting down")
	gc.Stop()
}
