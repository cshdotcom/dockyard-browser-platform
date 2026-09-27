// NoVNC 池客户端：独立 NoVNC 容器集群，仅 NextJS 内网访问
// 未配置 NOVNC_POOL_URL 时模拟模式

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"

export interface NovncSession {
  novncSessionId: string
  wsPath: string
  secret: string // 临时访问密钥（后端加密入库，绝不返回前端）
  resolution: string
  simulated: boolean
}

const g = globalThis as unknown as {
  __dySimNovnc?: Map<string, { createdAt: number; lastInputAt: number; clients: number; fps: number; crashed: boolean }>
}
function simNovnc() {
  if (!g.__dySimNovnc) g.__dySimNovnc = new Map()
  return g.__dySimNovnc
}

async function novncFetch(path: string, init?: RequestInit, timeoutMs = 20000): Promise<Response> {
  const url = ENV.novncPoolUrl.replace(/\/$/, "") + path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } })
  } finally {
    clearTimeout(timer)
  }
}

export async function createNovncSession(params: { proxyUrl?: string; profileMount?: string; resolution?: string; ttlMinutes?: number }): Promise<NovncSession> {
  if (externalAvailable.novnc) {
    const res = await novncFetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        proxyUrl: params.proxyUrl,
        profileDir: params.profileMount,
        resolution: params.resolution || "1920x1080",
        ttlMinutes: params.ttlMinutes,
      }),
    })
    if (!res.ok) throw new Error(`NoVNC API create failed: HTTP ${res.status}`)
    const json = (await res.json()) as { id: string; wsPath: string; secret: string }
    return { novncSessionId: json.id, wsPath: json.wsPath, secret: json.secret, resolution: params.resolution || "1920x1080", simulated: false }
  }
  const id = "vnc-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simNovnc().set(id, { createdAt: Date.now(), lastInputAt: Date.now(), clients: 1, fps: 24 + Math.random() * 6, crashed: false })
  return {
    novncSessionId: id,
    wsPath: `/novnc/${id}`,
    secret: randomUUID(),
    resolution: params.resolution || "1920x1080",
    simulated: true,
  }
}

export async function novncHealth(sessionId: string): Promise<{ alive: boolean; clients: number; fps: number; lastInputAt: number } | null> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${sessionId}/health`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`NoVNC API health failed: HTTP ${res.status}`)
    const json = (await res.json()) as { alive: boolean; clients: number; fps: number; lastInputAt: number }
    return json
  }
  const s = simNovnc().get(sessionId)
  if (!s) return null
  return { alive: !s.crashed, clients: s.clients, fps: Math.round(s.fps * 1000) / 1000, lastInputAt: s.lastInputAt }
}

export async function destroyNovncSession(sessionId: string): Promise<boolean> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${sessionId}`, { method: "DELETE" })
    if (!res.ok && res.status !== 404) throw new Error(`NoVNC API destroy failed: HTTP ${res.status}`)
    return true
  }
  simNovnc().delete(sessionId)
  return true
}

// 刷新临时密钥（闲置重连时自动刷新）
export async function refreshNovncSecret(sessionId: string): Promise<string | null> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${sessionId}/secret/rotate`, { method: "POST" })
    if (!res.ok) return null
    const json = (await res.json()) as { secret: string }
    return json.secret
  }
  return randomUUID()
}

// 断开全部客户端连接（不销毁会话）—— 管理员强制断开
export async function disconnectNovncClients(sessionId: string): Promise<boolean> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${sessionId}/clients/disconnect`, { method: "POST" })
    if (!res.ok) throw new Error(`NoVNC API disconnect failed: HTTP ${res.status}`)
    return true
  }
  const s = simNovnc().get(sessionId)
  if (s) s.clients = 0
  return true
}

export function touchSimNovncInput(sessionId: string) {
  const s = simNovnc().get(sessionId)
  if (s) {
    s.lastInputAt = Date.now()
    if (s.clients === 0) s.clients = 1
  }
}
