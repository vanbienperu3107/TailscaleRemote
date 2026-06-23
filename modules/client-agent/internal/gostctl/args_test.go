package gostctl

import (
	"strings"
	"testing"

	"github.com/vanbienperu3107/TailscaleRemote/client-agent/internal/config"
)

func cfg(listenPort, itopPort int, itopAddr, proxyRank string) *config.Config {
	return &config.Config{
		GostListenPort: listenPort,
		GostItopPort:   itopPort,
		GostItopAddr:   itopAddr,
		ProxyRank:      proxyRank,
	}
}

func TestBuildArgs_itop(t *testing.T) {
	args := BuildArgs("itop", cfg(18888, 18080, "", "socks5:7654"), "127.0.0.1:7654")
	if len(args) != 2 {
		t.Fatalf("itop: want 2 args, got %d: %v", len(args), args)
	}
	if args[0] != "-L" || !strings.Contains(args[1], ":18080") {
		t.Errorf("itop: want -L http://:18080, got %v", args)
	}
}

func TestBuildArgs_votam_noChain(t *testing.T) {
	args := BuildArgs("votam", cfg(18888, 18080, "", "socks5:7654"), "127.0.0.1:7654")
	// -L http://:18888 -F socks5://127.0.0.1:7654
	if len(args) != 4 {
		t.Fatalf("votam no-chain: want 4 args, got %d: %v", len(args), args)
	}
	if args[2] != "-F" || !strings.Contains(args[3], "socks5://127.0.0.1:7654") {
		t.Errorf("votam: missing socks5 forward, got %v", args)
	}
}

func TestBuildArgs_votam_withChain(t *testing.T) {
	args := BuildArgs("votam", cfg(18888, 18080, "10.121.1.100:18080", "socks5:7654"), "127.0.0.1:7654")
	// -L http://:18888 -F socks5://... -F http://10.121.1.100:18080
	if len(args) != 6 {
		t.Fatalf("votam chain: want 6 args, got %d: %v", len(args), args)
	}
	if !strings.Contains(args[5], "10.121.1.100") {
		t.Errorf("votam chain: missing itop addr in last arg, got %v", args)
	}
}

func TestBuildArgs_votam_emptyItopAddr(t *testing.T) {
	args := BuildArgs("votam", cfg(18888, 18080, "", "http:18888,socks5:7654"), "127.0.0.1:7654")
	// No chain added because GostItopAddr == ""
	if len(args) != 4 {
		t.Fatalf("votam empty itop: want 4 args, got %d: %v", len(args), args)
	}
}

var gostEnabledCases = []struct {
	rank string
	want bool
}{
	{"socks5:7654", false},
	{"http:18888", true},
	{"socks5:7654,http:18888", true},
	{"http:18888,socks5:7654", true},
	{"", false},
	{"  http:18888  ", true},
	{"socks5:7654 , socks5:1080", false},
}

func TestGostEnabled(t *testing.T) {
	for _, tc := range gostEnabledCases {
		got := GostEnabled(tc.rank)
		if got != tc.want {
			t.Errorf("GostEnabled(%q) = %v, want %v", tc.rank, got, tc.want)
		}
	}
}
