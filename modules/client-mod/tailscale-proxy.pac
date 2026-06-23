// PAC TINH (du phong) - dung khi chua fetch duoc PAC dong tu server.
//
// PAC DONG (khong can sua file nay) — admin cau hinh subnet/domain trong Dashboard:
//   https://vpn2.hangocthanh.io.vn/api/client/proxy.pac
// Tro browser vao URL tren, khong can chinh sua file nay nua.
//
// File nay van co hieu luc khi server chua len hoac client dung offline.
function FindProxyForURL(url, host) {
    // ── Cac subnet RFC-1918 mac dinh ────────────────────────────────────────
    if (isInNet(host, "10.0.0.0",    "255.0.0.0"))   return "SOCKS5 127.0.0.1:7654";
    if (isInNet(host, "172.16.0.0",  "255.240.0.0"))  return "SOCKS5 127.0.0.1:7654";
    if (isInNet(host, "192.168.0.0", "255.255.0.0"))  return "SOCKS5 127.0.0.1:7654";

    // ── Domain noi bo (them o day NEU khong dung PAC dong) ──────────────────
    // Bo comment dong phu hop, hoac dung /api/client/proxy.pac:
    // if (dnsDomainIs(host, ".bitel.com.pe"))   return "SOCKS5 127.0.0.1:7654";
    // if (dnsDomainIs(host, ".corp.local"))     return "SOCKS5 127.0.0.1:7654";

    // ── Mode gost fallback (votam-gost) ─────────────────────────────────────
    // Doi SOCKS5 -> PROXY 127.0.0.1:18888 khi dung gost:
    // if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "PROXY 127.0.0.1:18888";

    return "DIRECT";
}
