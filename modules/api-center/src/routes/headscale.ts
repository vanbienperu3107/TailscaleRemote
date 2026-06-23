import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../auth/middleware.js'
import { db } from '../db/client.js'
import { latencySamples } from '../db/schema.js'
import { env } from '../env.js'
import { hsApi, isHsConfigured } from '../lib/headscale.js'

type MetricsSample = {
  dst?: unknown
  dst_ip?: unknown
  rtt_ms?: unknown
  path?: unknown
  ok?: unknown
  loss_pct?: unknown
}

type MetricsBody = {
  hostname?: unknown
  ipv4?: unknown
  mac?: unknown
  samples?: unknown
}

/** Public — không cần auth. Nhận báo cáo từ metrics-report.ps1 trên các client. */
export async function headscalePublicRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/metrics/report', async (req, reply) => {
    const secret = env.METRICS_SHARED_SECRET
    if (secret && req.headers['x-metrics-secret'] !== secret) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const body = req.body as MetricsBody
    const srcHostname = String(body.hostname ?? '').toLowerCase().trim()
    if (!srcHostname || !Array.isArray(body.samples)) {
      return reply.code(400).send({ error: 'hostname and samples[] required' })
    }

    const rows = (body.samples as MetricsSample[]).slice(0, 1000)
      .filter((s) => s.dst)
      .map((s) => ({
        srcHostname,
        dstHostname: String(s.dst ?? '').toLowerCase().trim(),
        srcIp: body.ipv4 != null ? String(body.ipv4) : null,
        mac: body.mac != null ? String(body.mac) : null,
        rttMs: typeof s.rtt_ms === 'number' ? s.rtt_ms : null,
        path: s.path != null ? String(s.path) : null,
        ok:     s.ok === true,
        lossPct: typeof s.loss_pct === 'number' && Number.isFinite(s.loss_pct as number)
          ? Math.round(Math.max(0, Math.min(100, s.loss_pct as number)))
          : null,
        reportedAt: new Date(),
      }))
      .filter((r) => r.dstHostname)

    if (rows.length === 0) return { ok: true, upserted: 0 }

    try {
      await db
        .insert(latencySamples)
        .values(rows)
        .onConflictDoUpdate({
          target: [latencySamples.srcHostname, latencySamples.dstHostname],
          set: {
            srcIp:      sql`EXCLUDED.src_ip`,
            mac:        sql`EXCLUDED.mac`,
            rttMs:      sql`EXCLUDED.rtt_ms`,
            path:       sql`EXCLUDED.path`,
            ok:         sql`EXCLUDED.ok`,
            lossPct:    sql`EXCLUDED.loss_pct`,
            reportedAt: sql`EXCLUDED.reported_at`,
          },
        })
    } catch (e) {
      return reply.code(502).send({ error: 'db error' })
    }

    return { ok: true, upserted: rows.length }
  })
}

/** Protected — requireAuth. Proxy headscale API + latency từ Neon DB. */
export async function headscaleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  // ─── Nodes ───────────────────────────────────────────────────────────────

  app.get('/api/machines', async (_req, reply) => {
    if (!(await isHsConfigured())) return { configured: false, nodes: [] }
    try {
      const d = await hsApi<{ nodes?: unknown[] }>('/api/v1/node')
      return { configured: true, nodes: d.nodes ?? [] }
    } catch (e) {
      return reply.code(502).send({ configured: true, error: String(e), nodes: [] })
    }
  })

  app.delete('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await hsApi(`/api/v1/node/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.post('/api/nodes/:id/expire', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await hsApi(`/api/v1/node/${id}/expire`, { method: 'POST' })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.post('/api/nodes/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })
    try {
      const d = await hsApi(`/api/v1/node/${id}/rename/${encodeURIComponent(name.trim())}`, {
        method: 'POST',
      })
      return { ok: true, node: d }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.put('/api/nodes/:id/tags', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { tags } = (req.body ?? {}) as { tags?: string[] }
    try {
      const d = await hsApi(`/api/v1/node/${id}/tags`, {
        method: 'PUT',
        body: { tags: tags ?? [] },
      })
      return { ok: true, node: d }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  // ─── Routes ──────────────────────────────────────────────────────────────

  app.get('/api/hs-routes', async (_req, reply) => {
    if (!(await isHsConfigured())) return { configured: false, routes: [] }
    try {
      const d = await hsApi<{ routes?: unknown[] }>('/api/v1/routes')
      return { configured: true, routes: d.routes ?? [] }
    } catch (e) {
      return reply.code(502).send({ configured: true, error: String(e), routes: [] })
    }
  })

  app.post('/api/hs-routes/:id/enable', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await hsApi(`/api/v1/routes/${id}/enable`, { method: 'POST' })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.delete('/api/hs-routes/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await hsApi(`/api/v1/routes/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  // ─── ACL Policy ──────────────────────────────────────────────────────────

  app.get('/api/acl', async (_req, reply) => {
    if (!(await isHsConfigured())) return { configured: false, policy: '' }
    try {
      const d = await hsApi<{ policy?: string }>('/api/v1/policy')
      return { configured: true, policy: d.policy ?? '' }
    } catch (e) {
      return reply.code(502).send({ configured: true, error: String(e), policy: '' })
    }
  })

  app.put('/api/acl', async (req, reply) => {
    const { policy } = (req.body ?? {}) as { policy?: string }
    if (policy === undefined) return reply.code(400).send({ error: 'policy required' })
    try {
      const d = await hsApi<{ policy?: string }>('/api/v1/policy', {
        method: 'PUT',
        body: { policy },
      })
      return { ok: true, policy: d.policy }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  // ─── Pre-auth Keys ────────────────────────────────────────────────────────

  app.get('/api/preauthkeys', async (req, reply) => {
    if (!(await isHsConfigured())) return { configured: false, preAuthKeys: [] }
    const user = (req.query as Record<string, string>).user ?? ''
    try {
      const d = await hsApi<{ preAuthKeys?: unknown[] }>(
        `/api/v1/preauthkey${user ? `?user=${encodeURIComponent(user)}` : ''}`,
      )
      return { configured: true, preAuthKeys: d.preAuthKeys ?? [] }
    } catch (e) {
      return reply.code(502).send({ configured: true, error: String(e), preAuthKeys: [] })
    }
  })

  app.post('/api/preauthkeys', async (req, reply) => {
    const body = (req.body ?? {}) as {
      user?: string
      reusable?: boolean
      ephemeral?: boolean
      expiration?: string
      aclTags?: string[]
    }
    if (!body.user) return reply.code(400).send({ error: 'user required' })
    try {
      const d = await hsApi('/api/v1/preauthkey', { method: 'POST', body })
      return { ok: true, preAuthKey: (d as Record<string, unknown>).preAuthKey ?? d }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.post('/api/preauthkeys/expire', async (req, reply) => {
    const { user, key } = (req.body ?? {}) as { user?: string; key?: string }
    if (!user || !key) return reply.code(400).send({ error: 'user and key required' })
    try {
      await hsApi('/api/v1/preauthkey/expire', { method: 'POST', body: { user, key } })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  // ─── Users ───────────────────────────────────────────────────────────────

  app.get('/api/users', async (_req, reply) => {
    if (!(await isHsConfigured())) return { configured: false, users: [] }
    try {
      const d = await hsApi<{ users?: unknown[] }>('/api/v1/user')
      return { configured: true, users: d.users ?? [] }
    } catch (e) {
      return reply.code(502).send({ configured: true, error: String(e), users: [] })
    }
  })

  app.post('/api/users', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })
    try {
      const d = await hsApi('/api/v1/user', { method: 'POST', body: { name: name.trim() } })
      return { ok: true, user: d }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.delete('/api/users/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    try {
      await hsApi(`/api/v1/user/${encodeURIComponent(name)}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  app.post('/api/users/:name/rename', async (req, reply) => {
    const { name } = req.params as { name: string }
    const { newName } = (req.body ?? {}) as { newName?: string }
    if (!newName?.trim()) return reply.code(400).send({ error: 'newName required' })
    try {
      const d = await hsApi(
        `/api/v1/user/${encodeURIComponent(name)}/rename/${encodeURIComponent(newName.trim())}`,
        { method: 'POST' },
      )
      return { ok: true, user: d }
    } catch (e) {
      return reply.code(502).send({ error: String(e) })
    }
  })

  // ─── Latency ─────────────────────────────────────────────────────────────

  /** Latency từ Neon DB (Feature L). Format pairs tương thích với hs-api.ts fetchLatency(). */
  app.get('/api/latency', async (_req, reply) => {
    try {
      const rows = await db.select().from(latencySamples)
      const pairs = rows.map((r) => ({
        src:         r.srcHostname,
        dst:         r.dstHostname,
        src_ip:      r.srcIp,
        mac:         r.mac,
        rtt_ms:      r.rttMs,
        avg_ms:      r.rttMs,
        path:        r.path,
        last_path:   r.path,
        ok:          r.ok,
        reported_at: r.reportedAt,
      }))
      return { pairs }
    } catch (e) {
      return reply.code(502).send({ error: String(e), pairs: [] })
    }
  })
}
