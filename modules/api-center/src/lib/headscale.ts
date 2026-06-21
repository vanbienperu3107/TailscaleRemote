import { env } from '../env.js'
import { getApiKey } from './apikey-manager.js'

/** Gọi headscale HTTP API bằng Bearer API key (đọc từ DB, fallback env). */
export async function hsApi<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const key = await getApiKey()
  if (!key) throw new Error('no_headscale_key')
  const url = `${env.HEADSCALE_API_URL.replace(/\/$/, '')}${path}`
  const hasBody = options?.body !== undefined
  const res = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(options!.body) : undefined,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`headscale ${res.status}: ${text}`)
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

/** Kiểm tra xem đã có API key cấu hình chưa (DB hoặc env). */
export async function isHsConfigured(): Promise<boolean> {
  const key = await getApiKey()
  return !!key
}

/** Lấy JSON từ node-dedup collector (cùng mạng compose). */
export async function nodededup<T = unknown>(path: string): Promise<T> {
  const url = `${env.NODEDEDUP_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`node-dedup ${res.status}`)
  return (await res.json()) as T
}
