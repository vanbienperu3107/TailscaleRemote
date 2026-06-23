package config

import (
	"context"
	"log"
	"time"
)

// Change describes which fields changed between two configs.
type Change struct {
	Old *Config
	New *Config
	// convenience flags
	LanRoutesChanged    bool
	GostArgsChanged     bool
	IntervalChanged     bool
}

func diff(old, new *Config) Change {
	c := Change{Old: old, New: new}
	if old.LanRoutes != new.LanRoutes {
		c.LanRoutesChanged = true
	}
	if old.GostListenPort != new.GostListenPort ||
		old.GostItopAddr != new.GostItopAddr ||
		old.GostItopPort != new.GostItopPort ||
		old.ProxyRank != new.ProxyRank ||
		old.GostFallback != new.GostFallback {
		c.GostArgsChanged = true
	}
	if old.MetricsInterval != new.MetricsInterval {
		c.IntervalChanged = true
	}
	return c
}

// RunPoller fetches config every fetchInterval, calls onChange when anything changes.
// First call always fires onChange with the initial config.
func RunPoller(ctx context.Context, serverURL string, fetchInterval time.Duration, onChange func(Change)) {
	var current *Config

	fetch := func() {
		cfg, err := Fetch(serverURL)
		if err != nil {
			log.Printf("[config] fetch error: %v", err)
			return
		}
		if current == nil {
			// First fetch: fire GostArgsChanged + IntervalChanged so agent initializes
			// gost and metrics ticker from the live config. Do NOT fire LanRoutesChanged
			// here — main.go already calls ts.Up() at startup with the initial routes.
			onChange(Change{Old: Defaults(), New: cfg,
				GostArgsChanged: true, IntervalChanged: true})
		} else {
			c := diff(current, cfg)
			if c.LanRoutesChanged || c.GostArgsChanged || c.IntervalChanged {
				onChange(c)
			}
		}
		current = cfg
	}

	fetch() // immediate first fetch
	tick := time.NewTicker(fetchInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			fetch()
		}
	}
}
