import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../auth/middleware.js'
import { db } from '../db/client.js'
import { clientConfig, clientNetcheck, devices, latencySamples } from '../db/schema.js'

type DeviceNode = {
  user?: unknown
  hostname?: unknown
  node_id?: unknown
  ipv4?: unknown
  machine_key?: unknown
}

/** Public — không cần auth. Gọi bởi latency module (internal Docker network). */
export async function devicesPublicRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/devices/report
   * Body: { nodes: [{user, hostname, node_id, ipv4, machine_key}] }
   * Gọi bởi latency dedup process sau mỗi poll headscale API.
   * UPSERT theo (user_name, hostname): update node_id, ipv4, machine_key, last_seen, seen_count++.
   */
  app.post('/api/devices/report', async (req, reply) => {
    const body = req.body as { nodes?: unknown[] }
    if (!Array.isArray(body?.nodes)) {
      return reply.code(400).send({ error: 'nodes[] required' })
    }

    const valid = (body.nodes as DeviceNode[]).filter(
      (n) =>
        typeof n.hostname === 'string' &&
        n.hostname.trim() &&
        typeof n.user === 'string' &&
        n.user.trim(),
    )
    if (valid.length === 0) return { ok: true, upserted: 0 }
    const limited = valid.slice(0, 500)

    const conflictSet = {
      target: [devices.userName, devices.hostname],
      set: {
        nodeId:     sql`EXCLUDED.node_id`,
        ipv4:       sql`EXCLUDED.ipv4`,
        machineKey: sql`EXCLUDED.machine_key`,
        lastSeen:   sql`now()`,
        seenCount:  sql`devices.seen_count + 1`,
      },
    }
    const rows = limited.map((n) => ({
      userName:   String(n.user).trim(),
      hostname:   String(n.hostname).trim(),
      nodeId:     n.node_id != null ? String(n.node_id) : null,
      ipv4:       n.ipv4 != null && String(n.ipv4) ? String(n.ipv4) : null,
      machineKey: n.machine_key != null ? String(n.machine_key) : null,
    }))

    try {
      await db.insert(devices).values(rows).onConflictDoUpdate(conflictSet)
      return { ok: true, upserted: rows.length }
    } catch (bulkErr) {
      app.log.warn({ err: bulkErr }, 'devices/report bulk insert failed, retrying individually')
      let count = 0
      for (const row of rows) {
        try {
          await db.insert(devices).values(row).onConflictDoUpdate(conflictSet)
          count++
        } catch (e) {
          app.log.error({ err: e, hostname: row.hostname }, 'devices row insert error')
        }
      }
      return { ok: true, upserted: count }
    }
  })

  /**
   * POST /api/metrics/netcheck
   * Body: { hostname, preferred_derp, region_latency: {code: ms} }
   * Gọi bởi Tailscale client script sau khi chạy `tailscale netcheck`.
   * UPSERT theo client hostname — chỉ giữ latest per client.
   */
  app.post('/api/metrics/netcheck', async (req, reply) => {
    const body = req.body as {
      hostname?: unknown
      preferred_derp?: unknown
      region_latency?: unknown
    }
    const client = String(body?.hostname ?? '').trim()
    if (!client) return reply.code(400).send({ error: 'hostname required' })

    const rl = body.region_latency != null ? JSON.stringify(body.region_latency) : null
    if (rl && rl.length > 8192) {
      return reply.code(400).send({ error: 'region_latency too large' })
    }
    const regionLatency = rl

    try {
      await db
        .insert(clientNetcheck)
        .values({
          client,
          preferredDerp: body.preferred_derp != null ? String(body.preferred_derp) : null,
          regionLatency,
        })
        .onConflictDoUpdate({
          target: [clientNetcheck.client],
          set: {
            preferredDerp: sql`EXCLUDED.preferred_derp`,
            regionLatency: sql`EXCLUDED.region_latency`,
            reportedAt:    sql`now()`,
          },
        })
    } catch (e) {
      app.log.error({ err: e }, 'netcheck insert error')
      return reply.code(502).send({ error: 'db error' })
    }
    return { ok: true }
  })

  /**
   * GET /api/metrics/health
   * Query: ?expect=collector,vpn3,vpn4&window=180 (seconds)
   * Smoke gate sau deploy: kiểm tra các reporter có báo cáo trong window giây không.
   * 200 {ok:true} | 503 {ok:false, stale:[...]} — dùng trong deploy workflow.
   */
  app.get('/api/metrics/health', async (req, reply) => {
    const qs = req.query as Record<string, string>
    const expect = (qs.expect ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const window = Math.min(3600, Math.max(1, Number.parseInt(qs.window ?? '180', 10) || 180))

    if (expect.length === 0) {
      return { ok: true, stale: [], expected: [], window_s: window }
    }

    const cutoff = new Date(Date.now() - window * 1000)
    const rows = await db
      .selectDistinct({ src: latencySamples.srcHostname })
      .from(latencySamples)
      .where(sql`${latencySamples.reportedAt} >= ${cutoff}`)

    const fresh = new Set(rows.map((r) => r.src))
    const stale = expect.filter((s) => !fresh.has(s))

    if (stale.length > 0) {
      return reply.code(503).send({ ok: false, stale, expected: expect, window_s: window })
    }
    return { ok: true, stale: [], expected: expect, window_s: window }
  })

  /** GET /api/metrics/derp-stats
   * Tier 1: Thống kê RTT theo DERP region trong 1 giờ gần nhất.
   * Kết quả gộp từ latency_samples WHERE path LIKE 'derp:%'.
   */
  app.get('/api/metrics/derp-stats', async (_req, reply) => {
    try {
      const rows = await db
        .select({
          path:   latencySamples.path,
          avgMs:  sql<number>`ROUND(AVG(${latencySamples.rttMs})::numeric, 1)`,
          minMs:  sql<number>`MIN(${latencySamples.rttMs})`,
          maxMs:  sql<number>`MAX(${latencySamples.rttMs})`,
          cnt:    sql<number>`COUNT(*)::int`,
          okCnt:  sql<number>`SUM(CASE WHEN ${latencySamples.ok} THEN 1 ELSE 0 END)::int`,
          lastAt: sql<string>`MAX(${latencySamples.reportedAt})::text`,
        })
        .from(latencySamples)
        .where(
          sql`${latencySamples.path} LIKE 'derp:%'
              AND ${latencySamples.rttMs} IS NOT NULL
              AND ${latencySamples.reportedAt} >= NOW() - INTERVAL '1 hour'`
        )
        .groupBy(latencySamples.path)
        .orderBy(sql`AVG(${latencySamples.rttMs}) ASC`)
      return {
        stats: rows.map((r) => ({
          region:   (r.path ?? '').replace('derp:', ''),
          avg_ms:   r.avgMs,
          min_ms:   r.minMs,
          max_ms:   r.maxMs,
          samples:  r.cnt,
          ok_rate:  r.cnt > 0 ? Math.round((r.okCnt / r.cnt) * 100) : 0,
          last_seen: r.lastAt,
        })),
      }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  /** GET /api/client/config
   * Public — trả về cấu hình tập trung cho Windows client.
   * Client dùng để override LAN_ROUTES, ITOP_LAN_PREFIX, v.v. mà không cần sửa BAT.
   */
  app.get('/api/client/config', async (_req, reply) => {
    try {
      const rows = await db.select().from(clientConfig)
      const m: Record<string, string> = {}
      rows.forEach((r) => { m[r.key] = r.value })
      return {
        lan_routes:        m.lan_routes        ?? '10.0.0.0/8',
        itop_lan_prefix:   m.itop_lan_prefix   ?? '10.121.',
        pac_extra_subnets: m.pac_extra_subnets ?? '',
        pac_extra_domains: m.pac_extra_domains ?? '',
        gost_fallback:     m.gost_fallback      === 'true',
        metrics_interval:  parseInt(m.metrics_interval ?? '60', 10),
        proxy_rank:       m.proxy_rank        ?? 'socks5:7654',
        gost_listen_port: parseInt(m.gost_listen_port ?? '18888', 10),
        gost_itop_port:   parseInt(m.gost_itop_port   ?? '18080', 10),
        gost_itop_addr:   m.gost_itop_addr    ?? '',
        squid_proxy_addr: m.squid_proxy_addr ?? '',
        squid_proxy_port: parseInt(m.squid_proxy_port ?? '3128', 10) || 3128,
      }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  /** GET /api/client/proxy.pac
   * Public — PAC động từ client_config.proxy_rank:
   *   "socks5:7654"           → SOCKS5 127.0.0.1:7654
   *   "socks5:7654,http:18888"→ SOCKS5 127.0.0.1:7654; PROXY 127.0.0.1:18888
   * Trình duyệt trỏ vào URL này — admin đổi DB → PAC tự cập nhật.
   */
  app.get('/api/client/proxy.pac', async (_req, reply) => {
    // Clamp CIDR bits to [0,32] — JS << wraps on > 32, producing wrong masks.
    function cidrToMask(bits: number): string {
      const b = Math.max(0, Math.min(32, Number.isFinite(bits) ? bits : 24))
      const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0
      return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.')
    }
    // Strict allowlists to prevent JS injection into PAC file.
    const ipRe     = /^(\d{1,3}\.){3}\d{1,3}$/
    const domainRe = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/
    const proxyEntryRe = /^[A-Z0-9.:]+ 127\.0\.0\.1:\d{1,5}$/i

    try {
      const rows = await db.select().from(clientConfig)
      const m: Record<string, string> = {}
      rows.forEach((r) => { m[r.key] = r.value })

      // Build proxy chain from proxy_rank (DB-controlled, admin-configurable).
      const rankStr = m.proxy_rank ?? 'socks5:7654'
      let proxyStr = rankStr.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const [proto, port] = entry.split(':')
          const portNum = parseInt(port ?? '', 10)
          if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) return null
          if (proto === 'socks5') return `SOCKS5 127.0.0.1:${portNum}`
          if (proto === 'socks')  return `SOCKS 127.0.0.1:${portNum}`
          if (proto === 'http')   return `PROXY 127.0.0.1:${portNum}`
          return null
        })
        .filter((e): e is string => e !== null && proxyEntryRe.test(e))
        .join('; ') || 'SOCKS5 127.0.0.1:7654'

      // Append remote Squid proxy if configured — admin sets in DB, validated before embed.
      const squidAddr = (m.squid_proxy_addr ?? '').trim()
      const squidPort = parseInt(m.squid_proxy_port ?? '3128', 10) || 3128
      if (squidAddr && ipRe.test(squidAddr) && squidPort > 0 && squidPort <= 65535) {
        proxyStr += `; PROXY ${squidAddr}:${squidPort}`
      }

      const allSubnets = [
        m.lan_routes ?? '10.0.0.0/8',
        ...(m.pac_extra_subnets ?? '').split(','),
      ].map((s) => s.trim()).filter(Boolean)

      const domains = (m.pac_extra_domains ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean)

      // Strict validation before embedding into PAC JS — prevent injection.
      const subnetLines = allSubnets.map((cidr) => {
        const [ip, bitsStr] = cidr.split('/')
        if (!ipRe.test(ip ?? '')) return ''
        const bits = parseInt(bitsStr ?? '24', 10)
        if (!Number.isFinite(bits) || bits < 0 || bits > 32) return ''
        const mask = cidrToMask(bits)
        return `    if (isInNet(host, "${ip}", "${mask}")) return "${proxyStr}";`
      }).filter(Boolean).join('\n')

      const domainLines = domains.map((d) => {
        if (!domainRe.test(d)) return ''
        return `    if (dnsDomainIs(host, ".${d}") || host === "${d}") return "${proxyStr}";`
      }).filter(Boolean).join('\n')

      const pac = [
        `// PAC tu dong — admin config tai /api/client/config`,
        `// proxy_rank: ${rankStr.replace(/[^\w:,]/g, '')}`,
        `function FindProxyForURL(url, host) {`,
        subnetLines,
        domainLines,
        `    return "DIRECT";`,
        `}`,
      ].filter(Boolean).join('\n')

      void reply.header('Content-Type', 'application/x-ns-proxy-autoconfig')
      return reply.send(pac)
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })
}

/** Protected — requireAuth. Đọc device + netcheck data. */
export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  /** GET /api/devices — danh sách tất cả thiết bị từ node dedup history. */
  app.get('/api/devices', async (_req, reply) => {
    try {
      const rows = await db
        .select()
        .from(devices)
        .orderBy(devices.userName, devices.hostname)
      return { devices: rows }
    } catch (e) {
      return reply.code(502).send({ error: String(e), devices: [] })
    }
  })

  /** GET /api/netcheck — latest netcheck per client (preferred DERP + region latencies). */
  app.get('/api/netcheck', async (_req, reply) => {
    try {
      const rows = await db.select().from(clientNetcheck).orderBy(clientNetcheck.client)
      return {
        clients: rows.map((r) => ({
          client:        r.client,
          preferredDerp: r.preferredDerp,
          regionLatency: (() => { try { return r.regionLatency ? (JSON.parse(r.regionLatency) as Record<string, number>) : {} } catch { return {} } })(),
          reportedAt:    r.reportedAt,
        })),
      }
    } catch (e) {
      return reply.code(502).send({ error: String(e), clients: [] })
    }
  })
}
