// Package proxyconf reads proxy.conf (same format as tailscale_mod) and applies
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars so all Go http.Client calls and
// subprocess (gost.exe) inherit the upstream corporate proxy.
package proxyconf

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type ProxyConf struct {
	Enabled    bool   `json:"enabled"`
	HttpProxy  string `json:"httpProxy"`
	HttpsProxy string `json:"httpsProxy"`
	NoProxy    string `json:"noProxy"`
	ProxyAuth  *struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"proxyAuth"`
}

// Apply reads <baseDir>/proxy.conf. If enabled=true, sets HTTP_PROXY/HTTPS_PROXY/NO_PROXY
// in the current process env so all http.Client calls and subprocesses use it.
// Returns nil if file is absent or enabled=false.
func Apply(baseDir string) error {
	path := filepath.Join(baseDir, "proxy.conf")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil // no proxy.conf — direct access
	}
	if err != nil {
		return fmt.Errorf("proxyconf: read %s: %w", path, err)
	}
	var cfg ProxyConf
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("proxyconf: parse %s: %w", path, err)
	}
	if !cfg.Enabled {
		return nil
	}
	if cfg.HttpProxy != "" {
		os.Setenv("HTTP_PROXY", cfg.HttpProxy)
	}
	if cfg.HttpsProxy != "" {
		os.Setenv("HTTPS_PROXY", cfg.HttpsProxy)
	}
	if cfg.NoProxy != "" {
		os.Setenv("NO_PROXY", cfg.NoProxy)
	}
	return nil
}
