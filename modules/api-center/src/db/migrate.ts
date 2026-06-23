import { sql } from 'drizzle-orm'
import { db } from './client.js'

/**
 * Migration idempotent chạy lúc boot (CREATE TABLE IF NOT EXISTS).
 * Đơn giản & an toàn cho Neon — không cần drizzle-kit trong runtime image.
 */
export async function migrate(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS derp_servers (
      region_id   INTEGER PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      node_name   TEXT NOT NULL UNIQUE,
      hostname    TEXT NOT NULL,
      ipv4        TEXT,
      ipv6        TEXT,
      derp_port   INTEGER NOT NULL DEFAULT 443,
      stun_port   INTEGER NOT NULL DEFAULT 3478,
      can_port80  BOOLEAN NOT NULL DEFAULT false,
      stun_only   BOOLEAN NOT NULL DEFAULT false,
      latitude    REAL,
      longitude   REAL,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      paused      BOOLEAN NOT NULL DEFAULT false,
      embedded    BOOLEAN NOT NULL DEFAULT false,
      priority    INTEGER NOT NULL DEFAULT 100,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      google_sub  TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL,
      name        TEXT,
      picture     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token  TEXT,
      refresh_token TEXT,
      id_token      TEXT,
      token_expiry  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ NOT NULL
    )
  `)

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`)

  // Bảng đơn dòng lưu Headscale API key (auto-refresh 24h).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS headscale_api_keys (
      id          INTEGER PRIMARY KEY,
      api_key     TEXT NOT NULL,
      prefix      TEXT,
      seeded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      refreshed_at TIMESTAMPTZ
    )
  `)

  // Latency từ metrics-report.ps1 — UPSERT theo (src_hostname, dst_hostname), không tích lũy.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS latency_samples (
      src_hostname  TEXT NOT NULL,
      dst_hostname  TEXT NOT NULL,
      src_ip        TEXT,
      mac           TEXT,
      rtt_ms        REAL,
      path          TEXT,
      ok            BOOLEAN NOT NULL DEFAULT true,
      reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (src_hostname, dst_hostname)
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_latency_src ON latency_samples(src_hostname)
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_latency_reported_at ON latency_samples(reported_at)
  `)

  // Feature A: cột maintenance cho DERP nodes
  await db.execute(sql`
    ALTER TABLE derp_servers ADD COLUMN IF NOT EXISTS maintenance BOOLEAN NOT NULL DEFAULT false
  `)

  // Feature C: SSH credentials cho DERP nodes + bảng force routes
  await db.execute(sql`
    ALTER TABLE derp_servers ADD COLUMN IF NOT EXISTS ssh_user TEXT DEFAULT 'root'
  `)
  await db.execute(sql`
    ALTER TABLE derp_servers ADD COLUMN IF NOT EXISTS ssh_port INTEGER DEFAULT 22
  `)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS derp_force_routes (
      id          SERIAL PRIMARY KEY,
      region_id   INTEGER NOT NULL REFERENCES derp_servers(region_id) ON DELETE CASCADE,
      client_ip   TEXT NOT NULL,
      label       TEXT,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_force_routes_region ON derp_force_routes(region_id)
  `)

  // Feature B: per-node DERP region assignments
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS derp_node_assignments (
      node_key   TEXT NOT NULL,
      region_id  INTEGER NOT NULL REFERENCES derp_servers(region_id) ON DELETE CASCADE,
      PRIMARY KEY (node_key, region_id)
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_node_assignments_node ON derp_node_assignments(node_key)
  `)

  // Node dedup history — ghi bởi latency module (thay thế SQLite devices.db)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS devices (
      user_name    TEXT NOT NULL,
      hostname     TEXT NOT NULL,
      mac          TEXT,
      node_id      TEXT,
      ipv4         TEXT,
      machine_key  TEXT,
      first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_count   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_name, hostname)
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices(hostname)
  `)

  // Tailscale netcheck kết quả (latest per client, UPSERT)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS client_netcheck (
      client         TEXT PRIMARY KEY,
      preferred_derp TEXT,
      region_latency TEXT,
      reported_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // Tier 1: packet loss metric column
  await db.execute(sql`
    ALTER TABLE latency_samples ADD COLUMN IF NOT EXISTS loss_pct INTEGER
  `)

  // Centralized client config table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS client_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      note       TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    INSERT INTO client_config (key, value, note) VALUES
      ('lan_routes',        '10.0.0.0/8',             'Subnets quảng bá từ máy itop (comma-separated CIDRs)'),
      ('itop_lan_prefix',   '10.121.',                 'IP prefix để tự nhận diện máy itop'),
      ('pac_extra_subnets', '172.16.0.0/12,192.168.0.0/16', 'Subnets thêm vào PAC ngoài 10.x'),
      ('pac_extra_domains', '',                         'Domain thêm vào PAC (comma-separated, không có dấu .)'),
      ('gost_fallback',     'false',                   'Tự chuyển gost nếu native routing lỗi'),
      ('metrics_interval',  '60',                      'Khoảng thời gian report (giây)'),
      ('proxy_rank',        'socks5:7654',             'Thu tu proxy: socks5:7654,http:18888 → client thu theo thu tu (PAC multi-fallback)'),
      ('gost_listen_port',  '18888',                   'Cong gost HTTP proxy tren may votam'),
      ('gost_itop_port',    '18080',                   'Cong gost HTTP proxy tren may itop (server mode)'),
      ('gost_itop_addr',    '',                        'IP:port itop de votam chain (vi du: 100.64.0.1:18080), de trong = tu dong qua SOCKS5')
    ON CONFLICT DO NOTHING
  `)
}
