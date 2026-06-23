"""Unit test cho logic dedup + server-ping + api-center reporting (chay trong CI)."""
from unittest.mock import call, patch

import pytest

from dedup import (normalize, parse_pingresult, pingable_nodes,
                   plan_actions, plan_route_approvals,
                   report_devices, report_samples,
                   server_ping_all)


def mk(id, host, given, user="u", online=False, last=0, ips=None, machine_key=""):
    return {"id": id, "hostname": host, "given_name": given,
            "user": user, "online": online, "last_seen": last,
            "ips": ips or [], "machine_key": machine_key}


# ──────────────────────────── plan_actions ────────────────────────────────────

def test_keep_online_delete_offline_rename_clean():
    nodes = [
        mk("8",  "itop", "itop",           online=False, last=100),
        mk("11", "itop", "itop-eu4igccy",  online=False, last=200),
        mk("15", "itop", "itop-i8shta5a",  online=True,  last=300),
    ]
    acts = plan_actions(nodes)
    assert {a["id"] for a in acts if a["action"] == "delete"} == {"8", "11"}
    ren = [a for a in acts if a["action"] == "rename"]
    assert len(ren) == 1 and ren[0]["id"] == "15" and ren[0]["to"] == "itop"


def test_single_suffixed_node_renamed():
    nodes = [mk("15", "itop", "itop-i8shta5a", online=True, last=300)]
    acts = plan_actions(nodes)
    assert any(a["action"] == "rename" and a["to"] == "itop" for a in acts)
    assert not any(a["action"] == "delete" for a in acts)


def test_clean_single_node_no_action():
    nodes = [mk("6", "votam-pc", "votam-pc", online=True, last=300)]
    assert plan_actions(nodes) == []


def test_never_delete_online_duplicate():
    nodes = [mk("a", "h", "h",   online=True, last=100),
             mk("b", "h", "h-x", online=True, last=200)]
    acts = plan_actions(nodes)
    assert any(a["action"] == "skip" and a["id"] == "a" for a in acts)
    assert not any(a["action"] == "delete" for a in acts)


def test_different_users_not_merged():
    nodes = [mk("1", "h", "h",   user="x", online=True, last=1),
             mk("2", "h", "h-y", user="y", online=True, last=2)]
    assert not any(a["action"] == "delete" for a in plan_actions(nodes))


def test_offline_only_group_keeps_latest():
    nodes = [mk("1", "h", "h-a", online=False, last=100),
             mk("2", "h", "h-b", online=False, last=500)]
    acts = plan_actions(nodes)
    assert {a["id"] for a in acts if a["action"] == "delete"} == {"1"}
    assert any(a["action"] == "rename" and a["id"] == "2" and a["to"] == "h"
               for a in acts)


def test_id_int_tiebreak_not_string():
    # "9" > "10" theo string nhung 9 < 10 theo int -> keeper phai la id=10 (last_seen bang nhau)
    nodes = [mk("9",  "h", "h-a", online=False, last=500),
             mk("10", "h", "h-b", online=False, last=500)]
    acts = plan_actions(nodes)
    assert {a["id"] for a in acts if a["action"] == "delete"} == {"9"}


# ──────────────────────────── plan_route_approvals ────────────────────────────

def test_route_approval_advertised_route_gets_approved():
    raw = [{"id": 5, "availableRoutes": ["10.0.0.0/8"], "approvedRoutes": []}]
    assert plan_route_approvals(raw) == [("5", ["10.0.0.0/8"])]


def test_route_approval_idempotent_when_already_approved():
    raw = [{"id": 5, "availableRoutes": ["10.0.0.0/8"],
            "approvedRoutes": ["10.0.0.0/8"]}]
    assert plan_route_approvals(raw) == []


def test_route_approval_union_keeps_existing():
    raw = [{"id": 7, "available_routes": ["192.168.1.0/24"],
            "approved_routes": ["10.0.0.0/8"]}]
    assert plan_route_approvals(raw) == [("7", ["10.0.0.0/8", "192.168.1.0/24"])]


def test_route_approval_no_routes_or_no_id_skipped():
    raw = [
        {"id": 9, "availableRoutes": [], "approvedRoutes": []},
        {"availableRoutes": ["10.0.0.0/8"]},   # thiếu id -> bỏ
    ]
    assert plan_route_approvals(raw) == []


# ──────────────────────────── normalize ───────────────────────────────────────

def test_normalize_camel_and_snake():
    raw = [
        {"id": 6, "name": "votam-pc", "givenName": "votam-pc",
         "user": {"name": "votam"}, "online": True,
         "lastSeen": "2024-01-15T10:02:03Z",  # RFC3339 (headscale 0.27.x)
         "ipAddresses": ["100.64.0.3", "fd7a::3"],
         "machineKey": "mkey:x"},
        {"id": 8, "name": "itop", "given_name": "itop-x",
         "user": {"name": "u"}, "online": False,
         "last_seen": {"seconds": 99},  # protobuf dict (backward compat)
         "ip_addresses": ["100.64.0.1"],
         "machine_key": "mkey:y"},
    ]
    out = normalize(raw)
    assert out[0]["id"] == "6" and out[0]["hostname"] == "votam-pc"
    assert out[0]["given_name"] == "votam-pc" and out[0]["user"] == "votam"
    assert out[0]["online"] is True and out[0]["last_seen"] > 0  # RFC3339 parsed to epoch
    assert out[1]["given_name"] == "itop-x" and out[1]["last_seen"] == 99


# ──────────────────────────── pingable_nodes + server_ping_all ───────────────

def test_pingable_nodes_chi_online(monkeypatch):
    monkeypatch.setattr("dedup.SRC_NAME", "collector")
    nodes = [
        mk("1", "alive",     "alive",     online=True,  ips=["100.64.0.2", "fd7a::2"]),
        mk("2", "dead",      "dead",      online=False, ips=["100.64.0.3"]),
        mk("3", "collector", "collector", online=True,  ips=["100.64.0.1"]),
        mk("4", "noip",      "noip",      online=True,  ips=["fd7a::9"]),
    ]
    assert pingable_nodes(nodes) == [("alive", "100.64.0.2")]


def test_server_ping_all_khong_ping_node_chet():
    pinged = []

    def fake_ping(ip):
        pinged.append(ip)
        return {"LatencySeconds": 0.01, "Endpoint": "1.2.3.4:41641"}

    nodes = [
        mk("1", "alive", "alive", online=True,  ips=["100.64.0.2"]),
        mk("2", "dead",  "dead",  online=False, ips=["100.64.0.3"]),
    ]
    samples = server_ping_all(nodes, ping_fn=fake_ping)
    assert pinged == ["100.64.0.2"]
    assert len(samples) == 1
    assert samples[0]["dst"] == "alive" and samples[0]["ok"] is True


# ──────────────────────────── parse_pingresult ────────────────────────────────

def test_parse_pingresult():
    d = parse_pingresult({"LatencySeconds": 0.012, "Endpoint": "1.2.3.4:41641"})
    assert d == {"ok": True, "rtt_ms": 12.0, "path": "direct"}
    r = parse_pingresult({"LatencySeconds": 0.045, "DERPRegionCode": "myderp"})
    assert r["ok"] and r["path"] == "derp:myderp" and r["rtt_ms"] == 45.0
    assert parse_pingresult({"Err": "timeout"})["ok"] is False
    assert parse_pingresult({"LatencySeconds": 0})["ok"] is False
    assert parse_pingresult(None)["ok"] is False


# ──────────────────────────── report_devices ──────────────────────────────────

def test_report_devices_posts_payload():
    nodes = [
        mk("3", "vpn3", "vpn3", user="main", ips=["100.64.0.5", "fd7a::5"],
           machine_key="mk:abc"),
        mk("7", "vpn4", "vpn4", user="main", ips=["100.64.0.6"],
           machine_key="mk:xyz"),
    ]
    with patch("dedup._post_json", return_value=(200, {})) as mock_post:
        report_devices(nodes)
        assert mock_post.call_count == 1
        url, body = mock_post.call_args[0]
        assert url.endswith("/api/devices/report")
        assert len(body["nodes"]) == 2
        n0 = body["nodes"][0]
        assert n0["hostname"] == "vpn3" and n0["node_id"] == "3"
        assert n0["ipv4"] == "100.64.0.5"
        assert n0["machine_key"] == "mk:abc"


def test_report_devices_skips_empty_hostname():
    nodes = [mk("1", "", "", user="u")]
    with patch("dedup._post_json", return_value=(200, {})) as mock_post:
        report_devices(nodes)
        mock_post.assert_not_called()


def test_report_devices_logs_on_error():
    nodes = [mk("1", "vpn3", "vpn3", user="main", ips=["100.64.0.5"])]
    with patch("dedup._post_json", return_value=(503, {})):
        with patch("dedup.log") as mock_log:
            report_devices(nodes)
            mock_log.assert_called_once()
            assert "devices/report" in str(mock_log.call_args)


# ──────────────────────────── report_samples ─────────────────────────────────

def test_report_samples_posts_to_api_center():
    samples = [{"dst": "vpn3", "dst_ip": "100.64.0.5",
                "rtt_ms": 12.3, "path": "direct", "ok": True}]
    with patch("dedup._post_json", return_value=(201, {})) as mock_post:
        report_samples(samples)
        assert mock_post.call_count == 1
        url, body = mock_post.call_args[0]
        assert url.endswith("/api/metrics/report")
        assert body["samples"] == samples
        assert "hostname" in body


def test_report_samples_skips_empty():
    with patch("dedup._post_json") as mock_post:
        report_samples([])
        mock_post.assert_not_called()


def test_report_samples_logs_on_error():
    samples = [{"dst": "vpn3", "dst_ip": "100.64.0.5",
                "rtt_ms": 5.0, "path": "direct", "ok": True}]
    with patch("dedup._post_json", return_value=(500, {})):
        with patch("dedup.log") as mock_log:
            report_samples(samples)
            mock_log.assert_called_once()
            assert "metrics/report" in str(mock_log.call_args)
