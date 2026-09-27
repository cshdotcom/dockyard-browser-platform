// Steel-Browser HTTP API 客户端：所有调用经 NextJS 后端中转，Steel 服务仅内网可达
// 未配置 STEEL_BROWSER_URL 时模拟模式：会话生命周期全链路可跑

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"

export interface CreateSteelSessionParams {
  proxyUrl?: string
  userAgent?: string
  timezone?: string
  locale?: string
  geo?: { lat: number; lon: number }
  fingerprintSeed?: string
  profileMount?: string // profile 快照目录
  ttlMinutes?: number
}

export interface SteelSession {
  sessionId: string
  cdpUrl: string
  debuggerUrl?: string
  simulated: boolean
}

const g = globalThis as unknown as { __dySimSteelSessions?: Map<string, { createdAt: number; lastActive: number; params: CreateSteelSessionParams; crashed: boolean }> }

function simSessions() {
  if (!g.__dySimSteelSessions) g.__dySimSteelSessions = new Map()
  return g.__dySimSteelSessions
}

async function steelFetch(path: string, init?: RequestInit, timeoutMs = 15000): Promise<Response> {
  const url = ENV.steelUrl.replace(/\/$/, "") + path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } })
  } finally {
    clearTimeout(timer)
  }
}

// 创建浏览器会话：POST /v1/sessions
export async function createSession(params: CreateSteelSessionParams): Promise<SteelSession> {
  if (externalAvailable.steel) {
    const res = await steelFetch("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        proxyUrl: params.proxyUrl,
        userAgent: params.userAgent,
        timezone: params.timezone,
        locale: params.locale,
        geolocation: params.geo,
        fingerprint: params.fingerprintSeed,
        profileDir: params.profileMount,
        ttlMinutes: params.ttlMinutes,
      }),
    })
    if (!res.ok) throw new Error(`Steel API create failed: HTTP ${res.status}`)
    const json = (await res.json()) as { id: string; cdpUrl: string; debuggerUrl?: string }
    return { sessionId: json.id, cdpUrl: json.cdpUrl, debuggerUrl: json.debuggerUrl, simulated: false }
  }
  const id = "stl-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simSessions().set(id, { createdAt: Date.now(), lastActive: Date.now(), params, crashed: false })
  return {
    sessionId: id,
    cdpUrl: `ws://steel-internal/v1/sessions/${id}/cdp`,
    simulated: true,
  }
}

// 查询会话状态
export async function sessionStatus(sessionId: string): Promise<{ status: "ACTIVE" | "CRASHED" | "GONE"; lastActive: number } | null> {
  if (externalAvailable.steel) {
    const res = await steelFetch(`/v1/sessions/${sessionId}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Steel API status failed: HTTP ${res.status}`)
    const json = (await res.json()) as { status: string; lastActiveAt?: string }
    return {
      status: (json.status === "ACTIVE" ? "ACTIVE" : json.status === "CRASHED" ? "CRASHED" : "GONE") as "ACTIVE" | "CRASHED" | "GONE",
      lastActive: json.lastActiveAt ? new Date(json.lastActiveAt).getTime() : Date.now(),
    }
  }
  const s = simSessions().get(sessionId)
  if (!s) return null
  // 模拟：2%概率僵死
  const stale = Date.now() - s.lastActive > 30 * 60_000
  return { status: s.crashed ? "CRASHED" : stale ? "GONE" : "ACTIVE", lastActive: s.lastActive }
}

// 会话活跃心跳（CDP流量经过网关时更新）
export function touchSimSession(sessionId: string) {
  const s = simSessions().get(sessionId)
  if (s) s.lastActive = Date.now()
}

// 销毁会话：DELETE /v1/sessions/:id
export async function destroySession(sessionId: string): Promise<boolean> {
  if (externalAvailable.steel) {
    const res = await steelFetch(`/v1/sessions/${sessionId}`, { method: "DELETE" })
    if (!res.ok && res.status !== 404) throw new Error(`Steel API destroy failed: HTTP ${res.status}`)
    return true
  }
  simSessions().delete(sessionId)
  return true
}

// 导出浏览器 profile（快照体系）
export async function exportProfile(sessionId: string): Promise<{ archiveKey: string; simulated: boolean } | null> {
  if (externalAvailable.steel) {
    const res = await steelFetch(`/v1/sessions/${sessionId}/profile/export`, { method: "POST" }, 60000)
    if (!res.ok) return null
    const json = (await res.json()) as { archiveUrl: string }
    return { archiveKey: json.archiveUrl, simulated: false }
  }
  return { archiveKey: `sim-profile-${sessionId}.tar.gz`, simulated: true }
}

// 节点负载（Steel 集群调度）
export async function nodeLoad(): Promise<{ activeSessions: number; loadScore: number } | null> {
  if (externalAvailable.steel) {
    try {
      const res = await steelFetch("/v1/health")
      if (!res.ok) return null
      const json = (await res.json()) as { activeSessions?: number; load?: number }
      return { activeSessions: json.activeSessions ?? 0, loadScore: json.load ?? 0 }
    } catch {
      return null
    }
  }
  return { activeSessions: simSessions().size, loadScore: Math.min(simSessions().size / 50, 1) }
}
