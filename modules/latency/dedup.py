#!/usr/bin/env python3
"""
node-dedup + server-ping: chay tren vpn2, khong SQLite, khong HTTP server.
Tat ca du lieu luu qua api-center -> Neon Postgres (dung chung voi toan he thong).

PHAN 1 - DEDUP:
  Gom node headscale theo (user, hostname), giu lai 1 node (uu tien online,
  roi last_seen moi nhat), xoa ban trung OFFLINE. Doi given_name ve hostname
  sach (bo hau to). POST danh sach node len api-center de ghi lich su thiet bi.

PHAN 2 - SERVER PING:
  Ping tung node SONG qua LocalAPI cua tailscale sidecar (unix socket).
  POST ket qua vao api-center /api/metrics/report (cung endpoint voi relay nodes).
  Nguon duoc danh nhan la SRC_NAME (mac dinh 'collector').

PHAN 3 - AUTO-APPROVE ROUTES:
  Doc availableRoutes, goi POST /approve_routes cho route chua duyet.
  Khong can tag, khong can duyet tay. Ton trong DRY_RUN.

Bien moi truong:
  HS_API_URL          (mac dinh http://derp-controller:8080)
  HS_API_KEY          (bat buoc)
  API_CENTER_URL      (mac dinh http://api-center:8787)
  POLL_INTERVAL       (giay, mac dinh 30)
  DRY_RUN             (true/false, mac dinh true - chi log ke hoach)
  AUTO_APPROVE_ROUTES (true/false, mac dinh true)
  TS_SOCKET           (mac dinh /var/run/tailscale/tailscaled.sock)
  SRC_NAME            (ten nguon khi server ping, mac dinh 'collector')
"""
import datetime
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HS_API_URL      = os.environ.get("HS_API_URL", "http://derp-controller:8080").rstrip("/")
HS_API_KEY      = os.environ.get("HS_API_KEY", "")
API_CENTER_URL  = os.environ.get("API_CENTER_URL", "http://api-center:8787").rstrip("/")
DRY_RUN         = os.environ.get("DRY_RUN", "true").lower() in ("1", "true", "yes")
AUTO_APPROVE_ROUTES = os.environ.get("AUTO_APPROVE_ROUTES", "true").lower() in ("1", "true", "yes")
TS_SOCKET       = os.environ.get("TS_SOCKET", "/var/run/tailscale/tailscaled.sock")
SRC_NAME        = os.environ.get("SRC_NAME", "collector")


def _env_int(key, default):
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


POLL_INTERVAL = _env_int("POLL_INTERVAL", 30)


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *a, flush=True)


# ---- Headscale API ----

def _api(method, path, body=None):
    data = None
    req = urllib.request.Request(HS_API_URL + path, method=method)
    req.add_header("Authorization", "Bearer " + HS_API_KEY)
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=15) as r:
        resp = r.read().decode()
        return json.loads(resp) if resp.strip() else {}


def _g(d, *keys, default=None):
    """Lay gia tri theo nhieu key (camelCase API / snake_case CLI)."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


# ---- LocalAPI unix socket ----

class _UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("local-tailscaled.sock", timeout=timeout)
        self._uds = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._uds)
        self.sock = s


def localapi_ping(ip, ptype="disco", timeout=8):
    """Ping 1 peer qua LocalAPI sidecar. None neu loi/chua san sang."""
    conn = None
    try:
        conn = _UnixHTTP(TS_SOCKET, timeout)
        conn.request("POST", "/localapi/v0/ping?ip=%s&type=%s" % (ip, ptype),
                     headers={"Content-Length": "0"})
        resp = conn.getresponse()
        body = resp.read()
        return json.loads(body or b"{}") if resp.status == 200 else None
    except Exception:
        return None
    finally:
        if conn:
            conn.close()


def parse_pingresult(pr):
    """PURE: PingResult LocalAPI -> {ok, rtt_ms, path}."""
    if not isinstance(pr, dict) or pr.get("Err"):
        return {"ok": False, "rtt_ms": None, "path": ""}
    lat = pr.get("LatencySeconds") or 0
    if not lat:
        return {"ok": False, "rtt_ms": None, "path": ""}
    if pr.get("Endpoint"):
        path = "direct"
    else:
        derp = pr.get("DERPRegionCode") or pr.get("DERPRegionID")
        path = ("derp:%s" % derp) if derp else "direct"
    return {"ok": True, "rtt_ms": round(float(lat) * 1000, 1), "path": path}


def pingable_nodes(nodes):
    """PURE: chon node co the ping (ONLINE, co hostname, co IPv4, khong phai SRC_NAME)."""
    out = []
    for n in nodes:
        if not n["online"]:
            continue
        if not n["hostname"] or n["hostname"] == SRC_NAME:
            continue
        ip4 = next((ip for ip in n["ips"] if ":" not in ip), "")
        if not ip4:
            continue
        out.append((n["hostname"], ip4))
    return out


def server_ping_all(nodes, ping_fn=localapi_ping):
    """Server tu ping moi node SONG qua LocalAPI sidecar -> list sample."""
    out = []
    for hostname, ip4 in pingable_nodes(nodes):
        r = parse_pingresult(ping_fn(ip4))
        out.append({"dst": hostname, "dst_ip": ip4,
                    "rtt_ms": r["rtt_ms"], "path": r["path"], "ok": r["ok"]})
    return out


# ---- Node normalize + dedup logic ----

def normalize(raw_nodes):
    """PURE: chuyen JSON node tho -> dict gon. Test duoc."""
    out = []
    for n in raw_nodes:
        ls = _g(n, "lastSeen", "last_seen", default=None)
        if isinstance(ls, dict):
            last = int(ls.get("seconds", 0) or 0)
        elif isinstance(ls, str) and ls:
            try:
                last = int(datetime.datetime.fromisoformat(
                    ls.replace("Z", "+00:00")).timestamp())
            except Exception:
                last = 0
        else:
            last = 0
        user = _g(n, "user", default={}) or {}
        out.append({
            "id": str(_g(n, "id", default="")),
            "hostname": _g(n, "name", default="") or "",
            "given_name": _g(n, "givenName", "given_name", default="") or "",
            "user": (user.get("name", "") if isinstance(user, dict) else str(user)) or "",
            "online": bool(_g(n, "online", default=False)),
            "last_seen": last,
            "ips": _g(n, "ipAddresses", "ip_addresses", default=[]) or [],
            "machine_key": _g(n, "machineKey", "machine_key", default="") or "",
        })
    return out


def plan_actions(nodes):
    """PURE: tra ve list hanh dong (delete/rename/skip). Test doc lap duoc."""
    groups = {}
    for n in nodes:
        groups.setdefault((n["user"], n["hostname"]), []).append(n)
    actions = []
    for (user, hostname), group in sorted(groups.items()):
        if not hostname:
            continue
        keeper = sorted(
            group,
            key=lambda n: (1 if n["online"] else 0, n["last_seen"],
                           int(n["id"]) if str(n["id"]).isdigit() else 0),
            reverse=True,
        )[0]
        for n in group:
            if n["id"] == keeper["id"]:
                continue
            if n["online"]:
                actions.append({"action": "skip", "id": n["id"],
                                "name": n["given_name"],
                                "reason": "trung nhung dang ONLINE -> khong xoa"})
            else:
                actions.append({"action": "delete", "id": n["id"],
                                "name": n["given_name"],
                                "reason": "trung hostname '%s' (user %s)" % (hostname, user)})
        if keeper["given_name"] != hostname:
            actions.append({"action": "rename", "id": keeper["id"],
                            "from": keeper["given_name"], "to": hostname})
    return actions


def apply_action(a):
    try:
        if a["action"] == "delete":
            _api("DELETE", "/api/v1/node/%s" % a["id"])
        elif a["action"] == "rename":
            name = urllib.parse.quote(str(a["to"]), safe="")
            _api("POST", "/api/v1/node/%s/rename/%s" % (a["id"], name))
        return True
    except urllib.error.HTTPError as e:
        log("apply_action loi HTTP %s id=%s: %s" % (e.code, a["id"], e))
        return False
    except Exception as e:
        log("apply_action loi id=%s: %r" % (a["id"], e))
        return False


def plan_route_approvals(raw_nodes):
    """PURE: tra ve list (node_id, routes) can approve. Test doc lap duoc."""
    out = []
    for n in raw_nodes:
        nid = str(_g(n, "id", default="") or "")
        if not nid:
            continue
        available = set(_g(n, "availableRoutes", "available_routes", default=[]) or [])
        approved  = set(_g(n, "approvedRoutes", "approved_routes", default=[]) or [])
        if available - approved:
            out.append((nid, sorted(approved | available)))
    return out


# ---- api-center HTTP calls ----

def _post_json(url, body):
    """POST JSON -> (status_code, response_dict). Khong raise exception."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Content-Length", str(len(data)))
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        log("POST loi:", repr(e))
        return 0, {}


def report_devices(nodes):
    """POST danh sach node -> api-center /api/devices/report (ghi lich su thiet bi)."""
    payload = []
    for n in nodes:
        if not n["hostname"]:
            continue
        ipv4 = next((ip for ip in n["ips"] if ":" not in ip), "")
        payload.append({
            "user":        n["user"],
            "hostname":    n["hostname"],
            "node_id":     n["id"],
            "ipv4":        ipv4 if ipv4 else None,
            "machine_key": n["machine_key"],
        })
    if not payload:
        return
    status, _ = _post_json(API_CENTER_URL + "/api/devices/report", {"nodes": payload})
    if status not in (200, 201):
        log("devices/report HTTP", status)


def report_samples(samples):
    """POST ping samples -> api-center /api/metrics/report (cung endpoint voi relay nodes)."""
    if not samples:
        return
    status, _ = _post_json(API_CENTER_URL + "/api/metrics/report", {
        "hostname": SRC_NAME,
        "ipv4":     "",
        "mac":      "",
        "samples":  samples,
    })
    if status not in (200, 201):
        log("metrics/report HTTP", status)


# ---- Main loop ----

def main():
    if not HS_API_KEY:
        log("THIEU HS_API_KEY -> thoat")
        sys.exit(1)
    log("node-dedup chay. API=%s poll=%ss DRY_RUN=%s API_CENTER=%s" % (
        HS_API_URL, POLL_INTERVAL, DRY_RUN, API_CENTER_URL))
    while True:
        try:
            raw = _api("GET", "/api/v1/node").get("nodes", [])
            nodes = normalize(raw)

            # Ghi lich su thiet bi -> Neon qua api-center
            report_devices(nodes)

            # Server ping moi node SONG (qua LocalAPI sidecar) -> Neon qua api-center
            samples = server_ping_all(nodes)
            if samples:
                report_samples(samples)
                up = sum(1 for s in samples if s["ok"])
                log("server ping: %d/%d node OK" % (up, len(samples)))

            # Tu duyet route node quang ba
            if AUTO_APPROVE_ROUTES:
                for nid, routes in plan_route_approvals(raw):
                    if DRY_RUN:
                        log("[DRY] APPROVE-ROUTES node", nid, "->", routes)
                    else:
                        try:
                            _api("POST", "/api/v1/node/%s/approve_routes" % nid,
                                 {"routes": routes})
                            log("APPROVE-ROUTES node", nid, "->", routes)
                        except Exception as e:
                            log("approve-routes loi node", nid, repr(e))

            # Dedup: xoa ban trung + rename given_name
            for a in plan_actions(nodes):
                label = a.get("name") or a.get("from", "")
                if a["action"] == "skip":
                    log("SKIP", label, "-", a["reason"])
                elif DRY_RUN:
                    log("[DRY]", a["action"].upper(), label,
                        "->", a.get("to", ""), a.get("reason", ""))
                else:
                    if apply_action(a):
                        log(a["action"].upper(), label,
                            "->", a.get("to", ""), a.get("reason", ""))

        except urllib.error.URLError as e:
            log("API loi:", e)
        except Exception as e:
            log("Loi:", repr(e))
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
