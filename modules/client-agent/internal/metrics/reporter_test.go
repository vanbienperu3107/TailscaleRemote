package metrics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

var pingOutputDirect = `
pong from peer-a (100.64.0.2) via 10.0.0.1:41641 in 12.5ms
`

var pingOutputDerp = `
pong from peer-b (100.64.0.3) via DERP(syd) in 88.3ms
`

var pingOutputTimeout = `
timeout waiting for response from 100.64.0.4
`

var pingOutputMultiple = `
pong from peer-c (100.64.0.5) via DERP(tok) in 55.0ms
pong from peer-c (100.64.0.5) via DERP(tok) in 53.0ms
`

func TestParsePing_direct(t *testing.T) {
	s := parsePing(pingOutputDirect, "100.64.0.2", "peer-a", 2)
	if !s.Ok {
		t.Error("direct: want Ok=true")
	}
	if s.Path != "direct" {
		t.Errorf("direct: want path=direct, got %q", s.Path)
	}
	if s.RttMs == nil || *s.RttMs != 12.5 {
		t.Errorf("direct: want rtt=12.5, got %v", s.RttMs)
	}
	if s.LossPct == nil || *s.LossPct != 50 {
		t.Errorf("direct: want loss=50 (1 pong out of 2), got %v", s.LossPct)
	}
}

func TestParsePing_derp(t *testing.T) {
	s := parsePing(pingOutputDerp, "100.64.0.3", "peer-b", 2)
	if !s.Ok {
		t.Error("derp: want Ok=true")
	}
	if s.Path != "derp:syd" {
		t.Errorf("derp: want path=derp:syd, got %q", s.Path)
	}
	if s.RttMs == nil || *s.RttMs != 88.3 {
		t.Errorf("derp: want rtt=88.3, got %v", s.RttMs)
	}
}

func TestParsePing_timeout(t *testing.T) {
	s := parsePing(pingOutputTimeout, "100.64.0.4", "peer-d", 2)
	if s.Ok {
		t.Error("timeout: want Ok=false")
	}
	if s.RttMs != nil {
		t.Error("timeout: want RttMs=nil")
	}
	if s.LossPct == nil || *s.LossPct != 100 {
		t.Errorf("timeout: want loss=100, got %v", s.LossPct)
	}
}

func TestParsePing_clampLoss(t *testing.T) {
	// Output has 2 "pong from" lines but count=1 — pongs clamped to count.
	s := parsePing(pingOutputMultiple, "100.64.0.5", "peer-c", 1)
	if s.LossPct == nil || *s.LossPct < 0 {
		t.Errorf("clamp: loss_pct must not be negative, got %v", s.LossPct)
	}
}

func TestParsePing_zeroCount(t *testing.T) {
	s := parsePing("", "1.2.3.4", "h", 0)
	if s.LossPct == nil || *s.LossPct != 100 {
		t.Errorf("zero count: want loss=100, got %v", s.LossPct)
	}
}

func TestReporter_post(t *testing.T) {
	var received map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/metrics/report" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-Metrics-Secret") != "test-secret" {
			t.Errorf("missing secret header")
		}
		json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	r := New(srv.URL, "test-secret",
		func(context.Context) ([]byte, error) { return []byte("{}"), nil },
		func(context.Context, string, int, string) (string, error) { return "", nil },
		60,
	)
	body, _ := json.Marshal(map[string]any{"hostname": "test"})
	if err := r.post(context.Background(), body); err != nil {
		t.Fatalf("post error: %v", err)
	}
	if received["hostname"] != "test" {
		t.Errorf("post: want hostname=test, got %v", received["hostname"])
	}
}

func TestReporter_postTimeout(t *testing.T) {
	// Verify postClient is not the DefaultClient (has timeout set).
	if postClient == http.DefaultClient {
		t.Error("postClient must not be http.DefaultClient (no timeout)")
	}
	if postClient.Timeout == 0 {
		t.Error("postClient.Timeout must be non-zero")
	}
}

func TestFirstV4(t *testing.T) {
	cases := []struct {
		ips  []string
		want string
	}{
		{[]string{"fd7a::1", "100.64.1.2"}, "100.64.1.2"},
		{[]string{"100.64.1.2", "fd7a::1"}, "100.64.1.2"},
		{[]string{"fd7a::1"}, ""},
		{nil, ""},
	}
	for _, tc := range cases {
		got := firstV4(tc.ips)
		if got != tc.want {
			t.Errorf("firstV4(%v) = %q, want %q", tc.ips, got, tc.want)
		}
	}
}

