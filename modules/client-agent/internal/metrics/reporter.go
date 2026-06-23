// Package metrics pings Tailscale peers and POSTs latency samples to the dashboard.
// Replaces modules/client-mod/metrics-report.ps1.
package metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var (
	rttRe  = regexp.MustCompile(`in\s+([\d.]+)ms`)
	derpRe = regexp.MustCompile(`via DERP\(([^)]+)\)`)
)

type sample struct {
	Dst     string   `json:"dst"`
	DstIP   string   `json:"dst_ip"`
	RttMs   *float64 `json:"rtt_ms"`
	Path    string   `json:"path"`
	Ok      bool     `json:"ok"`
	LossPct *int     `json:"loss_pct"`
}

type Reporter struct {
	serverURL string
	secret    string
	tsStatus  func(ctx context.Context) ([]byte, error)
	tsPing    func(ctx context.Context, ip string, count int, timeout string) (string, error)
	interval  atomic.Int64 // seconds
}

func New(serverURL, secret string,
	tsStatus func(context.Context) ([]byte, error),
	tsPing func(context.Context, string, int, string) (string, error),
	intervalSec int,
) *Reporter {
	r := &Reporter{serverURL: serverURL, secret: secret, tsStatus: tsStatus, tsPing: tsPing}
	r.interval.Store(int64(intervalSec))
	return r
}

func (r *Reporter) SetInterval(sec int) {
	if sec > 0 {
		r.interval.Store(int64(sec))
	}
}

func (r *Reporter) Run(ctx context.Context) {
	for {
		interval := time.Duration(r.interval.Load()) * time.Second
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		if err := r.report(ctx); err != nil {
			log.Printf("[metrics] report error: %v", err)
		}
	}
}

// ReportActivePorts sends a one-time startup POST reporting which local ports the agent is
// listening on. socksPort is the Tailscale SOCKS5 port; httpPort is the gost HTTP port (0 if not running).
func (r *Reporter) ReportActivePorts(ctx context.Context, socksPort, httpPort int) error {
	selfHost, _ := os.Hostname()
	ports := map[string]int{"socks5": socksPort}
	if httpPort > 0 {
		ports["http"] = httpPort
	}
	body, _ := json.Marshal(map[string]any{
		"hostname":     selfHost,
		"ipv4":         "",
		"mac":          primaryMAC(),
		"active_ports": ports,
	})
	return r.post(ctx, body)
}

type tsStatus struct {
	Self struct {
		HostName     string   `json:"HostName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
	} `json:"Self"`
	Peer map[string]struct {
		HostName     string   `json:"HostName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
		Online       bool     `json:"Online"`
	} `json:"Peer"`
}

func (r *Reporter) report(ctx context.Context) error {
	raw, err := r.tsStatus(ctx)
	if err != nil {
		return fmt.Errorf("tailscale status: %w", err)
	}
	var st tsStatus
	if err := json.Unmarshal(raw, &st); err != nil {
		return fmt.Errorf("parse status: %w", err)
	}

	selfHost := st.Self.HostName
	selfIP := firstV4(st.Self.TailscaleIPs)
	mac := primaryMAC()

	var samples []sample
	for _, peer := range st.Peer {
		if !peer.Online {
			continue
		}
		ip := firstV4(peer.TailscaleIPs)
		if ip == "" {
			continue
		}
		out, _ := r.tsPing(ctx, ip, 2, "3s")
		s := parsePing(out, ip, peer.HostName, 2)
		samples = append(samples, s)
	}
	if len(samples) == 0 {
		return nil
	}

	body, _ := json.Marshal(map[string]any{
		"hostname": selfHost,
		"ipv4":     selfIP,
		"mac":      mac,
		"samples":  samples,
	})
	return r.post(ctx, body)
}

func parsePing(out, dstIP, dstHost string, count int) sample {
	s := sample{Dst: dstHost, DstIP: dstIP, Path: ""}
	pongs := strings.Count(out, "pong from")
	if pongs > count {
		pongs = count // guard against duplicate lines in ping output
	}
	lossPct := 100
	if count > 0 {
		lossPct = (count - pongs) * 100 / count
	}
	lp := lossPct
	s.LossPct = &lp

	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "pong from") {
			continue
		}
		s.Ok = true
		if m := rttRe.FindStringSubmatch(line); m != nil {
			v, _ := strconv.ParseFloat(m[1], 64)
			s.RttMs = &v
		}
		if m := derpRe.FindStringSubmatch(line); m != nil {
			s.Path = "derp:" + m[1]
		} else {
			s.Path = "direct"
		}
		break
	}
	return s
}

var postClient = &http.Client{Timeout: 15 * time.Second}

func (r *Reporter) post(ctx context.Context, body []byte) error {
	url := r.serverURL + "/api/metrics/report"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.secret != "" {
		req.Header.Set("X-Metrics-Secret", r.secret)
	}
	resp, err := postClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	ok := resp.StatusCode == 200 || resp.StatusCode == 201
	log.Printf("[metrics] POST %s → %d", url, resp.StatusCode)
	if !ok {
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}
	return nil
}

func firstV4(ips []string) string {
	for _, ip := range ips {
		if !strings.Contains(ip, ":") {
			return ip
		}
	}
	return ""
}

func primaryMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if mac := iface.HardwareAddr.String(); mac != "" {
			return mac
		}
	}
	return ""
}
