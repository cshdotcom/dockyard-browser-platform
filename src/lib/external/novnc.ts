// NoVNC 池客户端：三种真实形态按优先级自动选择
//   1. NOVNC_POOL_URL 配置 → 独立 NoVNC 容器池集群 API（仅 NextJS 内网访问，带硬隔离规格下发）
//   2. DOCKER_API_URL 配置 → 平台经 Docker API 直接编排硬隔离浏览器容器（自托管）
//   3. 均未配置 → 本地模拟模式（全链路演示/沙箱验证）
// 浏览器容器安全模型：只读根FS + CapDrop=ALL + no-new-privileges + 唯一本人Profile卷(noexec)
//   + 下载目录 noexec tmpfs（下载软件运行即权限错误）+ RestartPolicy=always + supervisor 防退出死循环

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"
import {
  createIsolatedBrowserContainer,
  ensureSessionNetwork,
  resolveContainerIp,
  browserProfileDir,
  type BrowserHardeningInfo,
  type BrowserHardeningSpec,
} from "./docker"
import { writeNetworkPolicyFile, sessionNetworkGateway, type NetworkPolicy } from "../network-policy"

export interface NovncSession {
  novncSessionId: string
  wsPath: string
  secret: string // 临时访问密钥（后端加密入库，绝不返回前端）
  resolution: string
  simulated: boolean
  rfb?: { host: string; port: number } | null // RFB(TCP) 拨号目标 —— VNC 桥据此转发
  containerName?: string | null // 自托管容器引用（防退出看门狗/进程级重启）
  hardening?: BrowserHardeningInfo | null // 隔离防护快照（落库展示）
}

// VNC 桥拨号目标（与 mini-services/vnc-bridge 票据 tgt 结构一致）
export type VncDialTarget = { k: "demo" } | { k: "tcp"; h: string; p: number }

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

export interface NovncProvisionParams {
  proxyUrl?: string
  profileMount?: string
  resolution?: string
  ttlMinutes?: number
  // ---- 自托管/硬隔离参数 ----
  userId?: string
  profileKey?: string // Profile 快照或工作区键（绑定"用户对应的配置的浏览器"，崩溃重启后还原同一环境）
  workspaceId?: string
  cpuLimit?: number // 0.001 精度
  memLimitMb?: number
  startUrl?: string
  labels?: Record<string, string>
  networkPolicy?: NetworkPolicy // 生效网络访问管控（内网/容器安全位置），自托管模式强制下发
}

export async function createNovncSession(params: NovncProvisionParams): Promise<NovncSession> {
  if (externalAvailable.novnc) {
    const res = await novncFetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        proxyUrl: params.proxyUrl,
        profileDir: params.profileMount,
        resolution: params.resolution || "1920x1080",
        ttlMinutes: params.ttlMinutes,
        // 硬隔离规格下发（池侧强制执行）
        hardening: {
          readOnlyRootfs: true,
          capDropAll: true,
          noNewPrivileges: true,
          noexecDownloads: true,
          isolatedProfileVolume: !!params.profileMount,
          restartPolicy: "always",
          supervisorLoop: true,
        },
        // 网络访问管控下发（池侧按策略注入 Chromium 托管策略与网络隔离）
        networkPolicy: params.networkPolicy || { allowInternalNetwork: false, allowSecureLocationAccess: false },
      }),
    })
    if (!res.ok) throw new Error(`NoVNC API create failed: HTTP ${res.status}`)
    const json = (await res.json()) as { id: string; wsPath: string; secret: string; rfbHost?: string; rfbPort?: number }
    return {
      novncSessionId: json.id,
      wsPath: json.wsPath,
      secret: json.secret,
      resolution: params.resolution || "1920x1080",
      simulated: false,
      rfb: json.rfbHost ? { host: json.rfbHost, port: json.rfbPort || 5900 } : null,
      containerName: null,
      hardening: null,
    }
  }
  if (externalAvailable.docker) {
    // ---- 自托管：平台直接编排硬隔离浏览器容器 ----
    const network = await ensureSessionNetwork()
    const profileDir = params.userId && params.profileKey ? browserProfileDir(params.userId, params.profileKey) : null
    // 网络策略：生成 Chromium 托管策略文件（只读 bind-mount，沙箱内不可篡改）
    const policy = params.networkPolicy || {
      allowInternalNetwork: false,
      allowSecureLocationAccess: false,
      source: "GLOBAL_DEFAULT" as const,
      resolvedAt: new Date().toISOString(),
    }
    const gatewayIp = params.networkPolicy ? await sessionNetworkGateway() : null
    const policyFile =
      params.userId && params.profileKey
        ? await writeNetworkPolicyFile(`ws-${params.profileKey}`, { policy, gatewayIp, proxyUrl: params.proxyUrl || null }).catch(() => null)
        : null
    const spec: BrowserHardeningSpec = {
      image: ENV.browserImage,
      cpuLimit: params.cpuLimit ?? 1,
      memLimitMb: params.memLimitMb ?? 1024,
      pidsLimit: 256,
      network,
      profileDir,
      startUrl: params.startUrl,
      proxyUrl: params.proxyUrl,
      resolution: params.resolution || "1280x800",
      labels: params.labels,
      networkPolicy: { allowInternalNetwork: policy.allowInternalNetwork, allowSecureLocationAccess: policy.allowSecureLocationAccess },
      policyFile,
      gatewayIp,
    }
    const cont = await createIsolatedBrowserContainer(spec)
    return {
      novncSessionId: cont.name,
      wsPath: `/novnc/${cont.name}`,
      secret: randomUUID(),
      resolution: params.resolution || "1280x800",
      simulated: false,
      rfb: cont.ip ? { host: cont.ip, port: ENV.browserVncPort } : null,
      containerName: cont.name,
      hardening: cont.hardening,
    }
  }
  const id = "vnc-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simNovnc().set(id, { createdAt: Date.now(), lastInputAt: Date.now(), clients: 1, fps: 24 + Math.random() * 6, crashed: false })
  return {
    novncSessionId: id,
    wsPath: `/novnc/${id}`,
    secret: randomUUID(),
    resolution: params.resolution || "1920x1080",
    simulated: true,
    rfb: null,
    containerName: null,
    hardening: null,
  }
}

// 解析 VNC 桥拨号目标：池集群(可返回RFB端点) / 自托管容器IP / 模拟(演示RFB引擎)
export async function novncDialTarget(sessionId: string, containerRef?: string | null): Promise<VncDialTarget | null> {
  if (externalAvailable.novnc && sessionId) {
    try {
      const res = await novncFetch(`/api/sessions/${encodeURIComponent(sessionId)}/endpoint`, undefined, 6000)
      if (res.ok) {
        const json = (await res.json()) as { rfbHost?: string; rfbPort?: number }
        if (json.rfbHost) return { k: "tcp", h: json.rfbHost, p: json.rfbPort || 5900 }
      }
    } catch {
      // 池未实现端点查询 → 降级演示通道（票据不外泄）
    }
    return null
  }
  if (externalAvailable.docker && containerRef) {
    const ip = await resolveContainerIp(containerRef).catch(() => null)
    if (ip) return { k: "tcp", h: ip, p: ENV.browserVncPort }
    return null
  }
  return { k: "demo" }
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

// 池集群形态：请求池侧重启浏览器进程（同Profile拉起，防退出语义一致）
export async function restartNovncBrowser(sessionId: string): Promise<{ restarted: boolean }> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${encodeURIComponent(sessionId)}/browser/restart`, { method: "POST" }, 15000)
    if (!res.ok) throw new Error(`NoVNC API browser restart failed: HTTP ${res.status}`)
    return { restarted: true }
  }
  const s = simNovnc().get(sessionId)
  if (s) {
    s.crashed = false
    s.lastInputAt = Date.now()
    s.fps = 24 + Math.random() * 6
  }
  return { restarted: true }
}

export function touchSimNovncInput(sessionId: string) {
  const s = simNovnc().get(sessionId)
  if (s) {
    s.lastInputAt = Date.now()
    if (s.clients === 0) s.clients = 1
  }
}
