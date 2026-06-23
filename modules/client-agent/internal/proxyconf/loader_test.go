package proxyconf

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeProxyConf(t *testing.T, dir string, cfg ProxyConf) {
	t.Helper()
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal proxy.conf: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "proxy.conf"), data, 0o600); err != nil {
		t.Fatalf("write proxy.conf: %v", err)
	}
}

func TestApply_enabled(t *testing.T) {
	dir := t.TempDir()
	writeProxyConf(t, dir, ProxyConf{
		Enabled:    true,
		HttpProxy:  "http://proxy:8080",
		HttpsProxy: "https://proxy:8443",
		NoProxy:    "localhost,127.0.0.1",
	})

	// Clean up env after test regardless of outcome.
	t.Cleanup(func() {
		os.Unsetenv("HTTP_PROXY")
		os.Unsetenv("HTTPS_PROXY")
		os.Unsetenv("NO_PROXY")
	})

	if err := Apply(dir); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	if got := os.Getenv("HTTP_PROXY"); got != "http://proxy:8080" {
		t.Errorf("HTTP_PROXY = %q, want %q", got, "http://proxy:8080")
	}
	if got := os.Getenv("HTTPS_PROXY"); got != "https://proxy:8443" {
		t.Errorf("HTTPS_PROXY = %q, want %q", got, "https://proxy:8443")
	}
	if got := os.Getenv("NO_PROXY"); got != "localhost,127.0.0.1" {
		t.Errorf("NO_PROXY = %q, want %q", got, "localhost,127.0.0.1")
	}
}

func TestApply_disabled(t *testing.T) {
	dir := t.TempDir()
	writeProxyConf(t, dir, ProxyConf{
		Enabled:   false,
		HttpProxy: "http://proxy:8080",
	})

	// Ensure env is clean before and after.
	os.Unsetenv("HTTP_PROXY")
	t.Cleanup(func() { os.Unsetenv("HTTP_PROXY") })

	if err := Apply(dir); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	if got := os.Getenv("HTTP_PROXY"); got != "" {
		t.Errorf("HTTP_PROXY should not be set when enabled=false, got %q", got)
	}
}

func TestApply_missing(t *testing.T) {
	dir := t.TempDir()
	// No proxy.conf written.

	os.Unsetenv("HTTP_PROXY")
	t.Cleanup(func() { os.Unsetenv("HTTP_PROXY") })

	if err := Apply(dir); err != nil {
		t.Errorf("Apply with missing file should return nil, got: %v", err)
	}

	if got := os.Getenv("HTTP_PROXY"); got != "" {
		t.Errorf("HTTP_PROXY should not be set when file is missing, got %q", got)
	}
}
