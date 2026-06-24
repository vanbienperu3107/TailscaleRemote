package config

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Config mirrors GET /api/client/config response.
type Config struct {
	LanRoutes       string `json:"lan_routes"`
	ItopLanPrefix   string `json:"itop_lan_prefix"`
	PacExtraSubnets string `json:"pac_extra_subnets"`
	PacExtraDomains string `json:"pac_extra_domains"`
	GostFallback    bool   `json:"gost_fallback"`
	MetricsInterval int    `json:"metrics_interval"`
	ProxyRank       string `json:"proxy_rank"`
	GostListenPort  int    `json:"gost_listen_port"`
	GostItopAddr    string `json:"gost_itop_addr"`
	GostItopPort    int    `json:"gost_itop_port"`
	PingCount       int    `json:"ping_count"`
	PingTimeout     string `json:"ping_timeout"`
}

func Defaults() *Config {
	return &Config{
		LanRoutes:       "10.0.0.0/8",
		ItopLanPrefix:   "10.121.",
		MetricsInterval: 60,
		ProxyRank:       "socks5:7654",
		GostListenPort:  18888,
		GostItopPort:    18080,
		PingCount:       2,
		PingTimeout:     "3s",
	}
}

var client = &http.Client{Timeout: 8 * time.Second}

func Fetch(serverURL string) (*Config, error) {
	resp, err := client.Get(serverURL + "/api/client/config")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("server returned %d", resp.StatusCode)
	}
	var cfg Config
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return nil, err
	}
	// fill defaults for zero values
	if cfg.MetricsInterval <= 0 {
		cfg.MetricsInterval = 60
	}
	if cfg.GostListenPort <= 0 {
		cfg.GostListenPort = 18888
	}
	if cfg.GostItopPort <= 0 {
		cfg.GostItopPort = 18080
	}
	if cfg.LanRoutes == "" {
		cfg.LanRoutes = "10.0.0.0/8"
	}
	if cfg.ProxyRank == "" {
		cfg.ProxyRank = "socks5:7654"
	}
	if cfg.PingCount <= 0 {
		cfg.PingCount = 2
	}
	if cfg.PingTimeout == "" {
		cfg.PingTimeout = "3s"
	}
	return &cfg, nil
}
