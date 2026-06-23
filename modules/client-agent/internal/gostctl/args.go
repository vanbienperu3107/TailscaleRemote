package gostctl

import (
	"fmt"
	"strings"

	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/config"
)

// socksAddr is the local Tailscale SOCKS5 address (e.g. "127.0.0.1:7654").
func BuildArgs(role string, cfg *config.Config, socksAddr string) []string {
	if role == "itop" {
		// itop: HTTP proxy server — clients connect through this to reach LAN.
		// Tailscale advertise-routes handles the actual routing; gost is the HTTP frontend.
		return []string{"-L", fmt.Sprintf("http://:%d", cfg.GostItopPort)}
	}

	// votam: HTTP proxy → SOCKS5 bridge (+ optional explicit hop through itop HTTP proxy).
	args := []string{"-L", fmt.Sprintf("http://:%d", cfg.GostListenPort)}
	args = append(args, "-F", fmt.Sprintf("socks5://%s", socksAddr))

	// If admin configured explicit itop proxy addr, add a second hop.
	// This is useful when direct SOCKS5 routing doesn't cover all subnets.
	if cfg.GostItopAddr != "" {
		args = append(args, "-F", fmt.Sprintf("http://%s", cfg.GostItopAddr))
	}

	return args
}

// GostEnabled returns true if proxy_rank includes an HTTP port (means gost should run).
func GostEnabled(proxyRank string) bool {
	for _, entry := range strings.Split(proxyRank, ",") {
		entry = strings.TrimSpace(entry)
		if strings.HasPrefix(entry, "http:") {
			return true
		}
	}
	return false
}
