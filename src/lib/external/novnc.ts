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
  inspectContainer,
  browserProfileDir,
  type BrowserHardeningInfo,
  type BrowserHardeningSpec,
} from "./docker"
import { writeNetworkPolicyFile, sessionNetworkGateway, type NetworkPolicy } from "../network-policy"
import { resolveWorkspaceCrxPolicy, buildCrxManagedPolicy } from "../crx-policy"
import type { DomainPolicy } from "../domain-policy"
import type { EndpointPolicy } from "../endpoint-policy"

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
  domainPolicy?: DomainPolicy | null // 生效域名黑白名单（作用域合并后），同层下发
  endpointPolicy?: EndpointPolicy | null // 生效端点级精确限制（host:port），同层下发
  filePolicy?: import("../file-policy").FilePolicy | null // 生效文件访问限制（四层合并：单沙箱>用户>组>全局）
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
        // 域名黑白名单下发（黑名单直接拦截 / 白名单严格模式）
        domainPolicy: params.domainPolicy
          ? { mode: params.domainPolicy.mode, blackPatterns: params.domainPolicy.blackPatterns, whitePatterns: params.domainPolicy.whitePatterns }
          : { mode: "BLACKLIST", blackPatterns: [], whitePatterns: [] },
        // 端点级精确限制下发（host:port 精确到端口）
        endpointPolicy: params.endpointPolicy
          ? { blackPatterns: params.endpointPolicy.blackPatterns, whitePatterns: params.endpointPolicy.whitePatterns }
          : { blackPatterns: [], whitePatterns: [] },
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
    // CRX 扩展管控策略：五级合并 → Managed Preferences（ExtensionInstallForcelist/Blocklist/Settings）
    // 与网络/域名/端点策略同文件落盘（仅浏览器进程停止时写入 —— 创建流程天然满足：容器尚未启动）
    const crxManaged = params.workspaceId
      ? buildCrxManagedPolicy(await resolveWorkspaceCrxPolicy(params.workspaceId).catch(() => ({ entries: [], blocklist: [], inheritEnabled: true, blocklistExempt: false, conflicts: [] })))
      : null
    const policyFile =
      params.userId && params.profileKey
        ? await writeNetworkPolicyFile(`ws-${params.profileKey}`, { policy, gatewayIp, proxyUrl: params.proxyUrl || null, domainPolicy: params.domainPolicy || null, endpointPolicy: params.endpointPolicy || null, crxManagedPolicy: crxManaged, filePolicy: params.filePolicy || null }).catch(() => null)
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
      domainPolicy: params.domainPolicy
        ? { mode: params.domainPolicy.mode, blackPatterns: params.domainPolicy.blackPatterns, whitePatterns: params.domainPolicy.whitePatterns }
        : { mode: "BLACKLIST", blackPatterns: [], whitePatterns: [] },
      endpointPolicy: params.endpointPolicy
        ? { blackPatterns: params.endpointPolicy.blackPatterns, whitePatterns: params.endpointPolicy.whitePatterns }
        : { blackPatterns: [], whitePatterns: [] },
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

// ---- 自托管模式健康探测辅助 ----
// 桥侧会话统计（statsByWs 键 = 工作区 ID；App 与桥同容器/同主机部署，环回 TCP 直连，不引入任何 UDP）
interface BridgeStats { clients: number; lastAt: number; keys: number; pointers: number; frames: number; startedAt: number }
async function bridgeStats(workspaceId: string): Promise<BridgeStats | null> {
  const url = `http://127.0.0.1:${ENV.vncBridgePort}/stats?ws=${encodeURIComponent(workspaceId)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "x-internal": "1" } })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as { ok?: boolean; stats?: Partial<BridgeStats> } | null
    if (!json?.stats || typeof json.stats.lastAt !== "number") return null
    const s = json.stats
    return {
      clients: s.clients ?? 0,
      lastAt: s.lastAt,
      keys: s.keys ?? 0,
      pointers: s.pointers ?? 0,
      frames: s.frames ?? 0,
      startedAt: s.startedAt ?? s.lastAt,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 健康探测上下文（自托管模式必需：容器引用 + 工作区 ID 用于桥统计）
export interface NovncHealthCtx {
  workspaceId?: string | null
  containerRef?: string | null
}

export async function novncHealth(
  sessionId: string,
  ctx?: NovncHealthCtx,
): Promise<{ alive: boolean; clients: number; fps: number; lastInputAt: number | null; frames?: number } | null> {
  if (externalAvailable.novnc) {
    const res = await novncFetch(`/api/sessions/${sessionId}/health`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`NoVNC API health failed: HTTP ${res.status}`)
    const json = (await res.json()) as { alive: boolean; clients: number; fps: number; lastInputAt: number }
    return json
  }
  // ---- 自托管容器编排模式：以 Docker 真实容器状态为权威，桥统计提供真实输入活跃度 ----
  // 修复历史缺陷：此前自托管模式落入模拟表查询 → 永远返回 null → 看门狗误判“崩溃”
  // → 每轮 cron 摧毁并重建健康容器（用户观察到的“容器莫名其妙停了”）
  if (externalAvailable.docker) {
    const ref = ctx?.containerRef || sessionId // 自托管模式 novncSessionId 即容器名
    const info = await inspectContainer(ref).catch(() => null)
    if (!info) return null // 容器已不存在（会话已销毁/已回收）
    const alive = info.state === "running" || info.state === "restarting"
    // 桥统计（键鼠/帧请求真实活跃）：lastInputAt=null 表示无真实输入信号（调用方回退自身记录）
    let lastInputAt: number | null = null
    let clients = 0
    let frames: number | undefined
    if (ctx?.workspaceId) {
      const st = await bridgeStats(ctx.workspaceId)
      if (st) {
        lastInputAt = st.lastAt
        clients = st.clients
        frames = st.frames
      }
    }
    return { alive, clients, fps: 0, lastInputAt, frames }
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
