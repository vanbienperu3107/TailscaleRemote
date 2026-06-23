package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDefaults(t *testing.T) {
	d := Defaults()
	if d.LanRoutes != "10.0.0.0/8" {
		t.Errorf("LanRoutes default: %q", d.LanRoutes)
	}
	if d.MetricsInterval != 60 {
		t.Errorf("MetricsInterval default: %d", d.MetricsInterval)
	}
	if d.GostListenPort != 18888 {
		t.Errorf("GostListenPort default: %d", d.GostListenPort)
	}
	if d.GostItopPort != 18080 {
		t.Errorf("GostItopPort default: %d", d.GostItopPort)
	}
	if d.ProxyRank != "socks5:7654" {
		t.Errorf("ProxyRank default: %q", d.ProxyRank)
	}
}

func TestFetch_success(t *testing.T) {
	want := Config{
		LanRoutes:       "10.0.0.0/8",
		ItopLanPrefix:   "10.121.",
		MetricsInterval: 30,
		ProxyRank:       "socks5:7654,http:18888",
		GostListenPort:  18888,
		GostItopPort:    18080,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/client/config" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(want)
	}))
	defer srv.Close()

	got, err := Fetch(srv.URL)
	if err != nil {
		t.Fatalf("Fetch error: %v", err)
	}
	if got.LanRoutes != want.LanRoutes {
		t.Errorf("LanRoutes: got %q, want %q", got.LanRoutes, want.LanRoutes)
	}
	if got.MetricsInterval != want.MetricsInterval {
		t.Errorf("MetricsInterval: got %d, want %d", got.MetricsInterval, want.MetricsInterval)
	}
	if got.ProxyRank != want.ProxyRank {
		t.Errorf("ProxyRank: got %q, want %q", got.ProxyRank, want.ProxyRank)
	}
}

func TestFetch_serverError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(502)
	}))
	defer srv.Close()

	_, err := Fetch(srv.URL)
	if err == nil {
		t.Error("expected error on 502, got nil")
	}
}

func TestFetch_fillsZeroDefaults(t *testing.T) {
	// Server returns all-zero values — Fetch should fill in defaults.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"lan_routes":"","metrics_interval":0,"gost_listen_port":0,"proxy_rank":""}`))
	}))
	defer srv.Close()

	got, err := Fetch(srv.URL)
	if err != nil {
		t.Fatalf("Fetch error: %v", err)
	}
	if got.LanRoutes != "10.0.0.0/8" {
		t.Errorf("LanRoutes fill: got %q", got.LanRoutes)
	}
	if got.MetricsInterval != 60 {
		t.Errorf("MetricsInterval fill: got %d", got.MetricsInterval)
	}
	if got.GostListenPort != 18888 {
		t.Errorf("GostListenPort fill: got %d", got.GostListenPort)
	}
	if got.ProxyRank != "socks5:7654" {
		t.Errorf("ProxyRank fill: got %q", got.ProxyRank)
	}
}

func TestFetch_badJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("not json {{{"))
	}))
	defer srv.Close()

	_, err := Fetch(srv.URL)
	if err == nil {
		t.Error("expected error on bad JSON, got nil")
	}
}
