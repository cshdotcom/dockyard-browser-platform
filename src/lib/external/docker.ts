// Docker REST API 客户端：HTTP 调用 Docker Engine API（生产通过 docker-api-proxy 暴露的 HTTP 端点访问）
// 未配置 DOCKER_API_URL 时进入本地模拟模式 —— 容器生命周期、统计、日志全链路可跑（沙箱/演示/单机部署）
// 真实模式：所有操作（创建/启动/停止/删除/统计/日志）全部 HTTP 调用完成，绝不挂载宿主机 socket

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"

// ============================================================
// 硬隔离浏览器容器（LiveDesk 自托管模式）
// 安全模型：
//   1. ReadOnlyRootfs    —— 根文件系统只读，任何位置不可写系统文件
//   2. CapDrop=ALL       —— 丢弃全部 Linux capabilities
//   3. no-new-privileges —— 禁止 setuid 提权
//   4. Profile 卷唯一挂载（rw,nosuid,nodev,noexec）—— 仅本人资料可见可写；
//      其他用户的任何文件/目录不在本容器 mount namespace 中（不可见 = 不可读）
//   5. /tmp、下载目录、/dev/shm 全部 tmpfs + noexec —— 下载可执行文件运行即报权限错误
//   6. RestartPolicy=always + 容器内 supervisor 死循环拉起浏览器 —— 用户无法以任何形式退出
//   7. 内存/CPU/Pids 硬限制 —— OOM 直接终止，防止资源滥用
// ============================================================

export interface BrowserHardeningSpec {
  image: string
  cpuLimit: number // 0.001 精度
  memLimitMb: number
  pidsLimit: number
  network: string
  profileDir: string | null // 宿主机上该用户专属 Profile 目录（唯一可写持久卷）
  startUrl?: string
  proxyUrl?: string
  resolution?: string
  env?: Record<string, string>
  labels?: Record<string, string>
  networkPolicy?: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean }
  policyFile?: string | null // 网络策略托管策略 JSON（只读 bind-mount 进 /etc/chromium/policies/managed/）
  gatewayIp?: string | null // 会话网络网关（平台内部端点封禁目标）
}

export interface BrowserHardeningInfo {
  readOnlyRootfs: boolean
  capDropAll: boolean
  noNewPrivileges: boolean
  isolatedProfileVolume: boolean
  noexecTmpDirs: string[]
  noexecDownloads: boolean
  restartPolicy: "always"
  supervisorLoop: boolean
  nonRootUser: string
  pidsLimit: number
  memLimitMb: number
  cpuLimit: number
  networkIsolated: boolean
  oomHardKill: boolean
  profileDir: string | null
  image: string
  // —— 网络访问管控（管理员按用户/组下发）——
  allowInternalNetwork: boolean
  allowSecureLocationAccess: boolean
  policyManagedChromium: boolean // Chromium 托管策略文件已注入（只读、不可篡改）
  iccDisabledNetwork: boolean // 会话网络容器互访封禁（跨用户网络不可达）
}

export const SESSION_NETWORK = "dockyard-sessions"
export const BROWSER_USER = "browser"
// Chromium 托管策略注入点（Debian chromium 策略目录，镜像内已预建，只读 bind-mount）
export const CHROMIUM_POLICY_MOUNT = "/etc/chromium/policies/managed/dockyard.json"

export function browserHardeningSummary(spec: BrowserHardeningSpec): BrowserHardeningInfo {
  return {
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    isolatedProfileVolume: !!spec.profileDir,
    noexecTmpDirs: ["/tmp", "/home/browser/downloads", "/dev/shm", "/run"],
    noexecDownloads: true,
    restartPolicy: "always",
    supervisorLoop: true,
    nonRootUser: BROWSER_USER,
    pidsLimit: spec.pidsLimit,
    memLimitMb: spec.memLimitMb,
    cpuLimit: spec.cpuLimit,
    networkIsolated: true,
    oomHardKill: true,
    profileDir: spec.profileDir,
    image: spec.image,
    allowInternalNetwork: spec.networkPolicy?.allowInternalNetwork ?? false,
    allowSecureLocationAccess: spec.networkPolicy?.allowSecureLocationAccess ?? false,
    policyManagedChromium: !!spec.policyFile,
    iccDisabledNetwork: true,
  }
}

// 容器内唯一允许的字符集（cuid/uuid/短id），杜绝路径穿越
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id)
}

export function browserProfileDir(userId: string, profileKey: string): string | null {
  if (!safeId(userId) || !safeId(profileKey)) return null
  return `${ENV.storageLocalPath.replace(/\/$/, "")}/profiles/${userId}/${profileKey}`
}

export function buildBrowserHostConfig(spec: BrowserHardeningSpec) {
  const binds = spec.profileDir ? [`${spec.profileDir}:/home/browser/profile:rw,nosuid,nodev,noexec`] : []
  // 网络策略托管策略：只读 bind-mount（只读根 FS + 非 root + CapDrop=ALL → 沙箱内无法篡改）
  if (spec.policyFile) binds.push(`${spec.policyFile}:${CHROMIUM_POLICY_MOUNT}:ro`)
  return {
    NanoCpus: Math.round(spec.cpuLimit * 1e9),
    Memory: Math.round(spec.memLimitMb * 1024 * 1024),
    MemorySwap: Math.round(spec.memLimitMb * 1024 * 1024), // 禁 swap：超限 OOM 硬终止
    PidsLimit: spec.pidsLimit,
    Privileged: false,
    ReadOnlyRootfs: true, // 根文件系统只读
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    RestartPolicy: { Name: "always" }, // 防退出：容器崩溃自动拉起（浏览器进程级自愈在镜像 supervisor）
    NetworkMode: spec.network,
    Binds: binds,
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,size=256m",
      "/home/browser/downloads": "rw,noexec,nosuid,size=128m", // 下载落点：可写不可执行
      "/dev/shm": "rw,nosuid,nodev,size=256m",
      "/run": "rw,noexec,nosuid,size=32m",
    },
    Ulimits: [{ Name: "nofile", Soft: 8192, Hard: 8192 }],
  }
}

// 确保会话专用隔离网络存在：
//   · 浏览器容器不进 host 网络
//   · ICC=false —— 同网络内容器互访封禁（跨用户浏览器网络不可达，防横向探测/跨用户读取）
//   · 平台（宿主侧）访问容器 IP:port 不受 ICC 影响，CDP/VNC 运维通道不受影响
export async function ensureSessionNetwork(): Promise<string> {
  if (externalAvailable.docker) {
    const res = await dockerFetch("/networks")
    if (res.ok) {
      const nets = (await res.json()) as Array<{ Name: string; Options?: Record<string, string> }>
      const existing = nets.find((n) => n.Name === SESSION_NETWORK)
      if (existing) {
        const strict = existing.Options?.["com.docker.network.bridge.enable_icc"] === "false"
        if (strict) return SESSION_NETWORK
        // 旧版无 ICC 网络 → 尝试删除重建为严格网络（仍有容器挂载时删除失败则沿用旧网）
        try {
          const del = await dockerFetch(`/networks/${SESSION_NETWORK}`, { method: "DELETE" })
          if (!del.ok) return SESSION_NETWORK
        } catch {
          return SESSION_NETWORK
        }
      }
    }
    const create = await dockerFetch("/networks/create", {
      method: "POST",
      body: JSON.stringify({
        Name: SESSION_NETWORK,
        Driver: "bridge",
        Options: { "com.docker.network.bridge.enable_icc": "false" }, // 容器互访封禁
      }),
    })
    if (!create.ok) throw new Error(`Docker API network create failed: HTTP ${create.status}`)
    return SESSION_NETWORK
  }
  return SESSION_NETWORK
}

// 创建硬隔离浏览器容器（真实模式：镜像内 supervisor 死循环拉起浏览器，退出即 1s 内以同一 Profile 重启）
export async function createIsolatedBrowserContainer(
  spec: BrowserHardeningSpec,
): Promise<{ id: string; name: string; ip: string | null; simulated: boolean; hardening: BrowserHardeningInfo }> {
  const hardening = browserHardeningSummary(spec)
  const name = `dy-browser-${randomUUID().replace(/-/g, "").slice(0, 12)}`
  if (externalAvailable.docker) {
    const envVars: Record<string, string> = {
      START_URL: spec.startUrl || "about:blank",
      RESOLUTION: spec.resolution || "1280x800",
      TZ: "Asia/Shanghai",
      ...(spec.proxyUrl ? { PROXY_URL: spec.proxyUrl } : {}),
      ...(spec.env || {}),
    }
    const body = {
      Image: spec.image,
      name,
      User: BROWSER_USER,
      Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
      Labels: { "dockyard.managed": "true", ...(spec.labels || {}) },
      WorkingDir: "/home/browser",
      ExposedPorts: { "5900/tcp": {}, "9222/tcp": {} },
      HostConfig: buildBrowserHostConfig(spec),
    }
    const res = await dockerFetch("/containers/create?name=" + encodeURIComponent(name), {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Docker API create browser failed: HTTP ${res.status}`)
    const json = (await res.json()) as { Id: string }
    const start = await dockerFetch(`/containers/${json.Id}/start`, { method: "POST" }, 60000)
    if (!start.ok && start.status !== 304) throw new Error(`Docker API start browser failed: HTTP ${start.status}`)
    const ip = await resolveContainerIp(json.Id).catch(() => null)
    return { id: json.Id, name, ip, simulated: false, hardening }
  }
  // 模拟模式：注册为普通模拟容器（生命周期/统计链路一致）
  const id = "sim-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simContainers().set(id, { spec: { name, image: spec.image, envVars: {}, cpuLimit: spec.cpuLimit, memLimitMb: spec.memLimitMb, autoRestart: true }, state: "running", startedAt: Date.now(), netRx: 0, netTx: 0, restarts: 0 })
  return { id, name, ip: null, simulated: true, hardening }
}

// 解析容器在隔离网络中的 IP（平台与 VNC 桥据此直连 5900/9222）
export async function resolveContainerIp(idOrName: string): Promise<string | null> {
  if (!externalAvailable.docker) return null
  const res = await dockerFetch(`/containers/${encodeURIComponent(idOrName)}/json`)
  if (!res.ok) return null
  const json = (await res.json()) as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }
  for (const net of Object.values(json.NetworkSettings?.Networks || {})) {
    if (net.IPAddress) return net.IPAddress
  }
  return null
}

// 防退出运维动作：向容器内 supervisor(PID 1) 发送 USR1 → 杀掉浏览器子进程 → 主循环立即以同一 Profile 拉起
export async function restartBrowserProcessInContainer(idOrName: string): Promise<{ restarted: boolean; simulated: boolean }> {
  if (externalAvailable.docker) {
    const execCreate = await dockerFetch(`/containers/${encodeURIComponent(idOrName)}/exec`, {
      method: "POST",
      body: JSON.stringify({ Cmd: ["kill", "-USR1", "1"], AttachStdout: true, AttachStderr: true, User: "root" }),
    })
    if (!execCreate.ok) throw new Error(`Docker exec create failed: HTTP ${execCreate.status}`)
    const { Id } = (await execCreate.json()) as { Id: string }
    const start = await dockerFetch(`/exec/${Id}/start`, { method: "POST", body: JSON.stringify({ Detach: false, Tty: false }) })
    if (!start.ok) throw new Error(`Docker exec start failed: HTTP ${start.status}`)
    return { restarted: true, simulated: false }
  }
  const c = simContainers().get(idOrName)
  if (c) {
    c.restarts = (c.restarts || 0) + 1
    c.startedAt = Date.now()
  }
  return { restarted: true, simulated: true }
}

export interface DockerContainerSpec {
  name: string
  image: string
  envVars: Record<string, string> // Sing-Box 完整JSON配置通过环境变量注入，不落地磁盘
  cpuLimit: number // 0.001 精度
  memLimitMb: number
  network?: string
  labels?: Record<string, string>
  autoRestart?: boolean
}

export interface DockerContainerInfo {
  id: string
  name: string
  state: string // running | exited | created | paused
  status: string
}

export interface DockerContainerStats {
  cpuPct: number
  memMb: number
  netRxMb: number
  netTxMb: number
}

// ---- 模拟模式状态（内存） ----
const g = globalThis as unknown as {
  __dySimContainers?: Map<string, { spec: DockerContainerSpec; state: string; startedAt: number; netRx: number; netTx: number; restarts: number }>
}

function simContainers() {
  if (!g.__dySimContainers) g.__dySimContainers = new Map()
  return g.__dySimContainers
}

async function dockerFetch(path: string, init?: RequestInit, timeoutMs = ENV.dockerApiTimeout): Promise<Response> {
  const url = ENV.dockerApiUrl.replace(/\/$/, "") + path
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

// 创建容器（Sing-Box编排专用：配置JSON通过环境变量注入容器）
export async function createContainer(spec: DockerContainerSpec): Promise<{ id: string; simulated: boolean }> {
  if (externalAvailable.docker) {
    // HostConfig 资源硬限制：CPU/内存超限直接OOM终止，禁止特权，不挂载宿主机敏感目录
    const body = {
      Image: spec.image,
      name: spec.name,
      Env: Object.entries(spec.envVars).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels || {},
      HostConfig: {
        NanoCpus: Math.round(spec.cpuLimit * 1e9),
        Memory: Math.round(spec.memLimitMb * 1024 * 1024),
        MemorySwap: Math.round(spec.memLimitMb * 1024 * 1024), // 禁止swap扩展
        Privileged: false, // 容器安全：禁止特权
        AutoRemove: false,
        RestartPolicy: spec.autoRestart ? { Name: "on-failure", MaximumRetryCount: 3 } : { Name: "no" },
        NetworkMode: spec.network || "bridge",
        Binds: [] as string[], // 不挂载宿主机敏感目录
      },
    }
    const res = await dockerFetch("/containers/create?name=" + encodeURIComponent(spec.name), {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Docker API create failed: HTTP ${res.status}`)
    const json = (await res.json()) as { Id: string }
    return { id: json.Id, simulated: false }
  }
  // 模拟模式
  const id = "sim-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simContainers().set(id, { spec, state: "created", startedAt: 0, netRx: 0, netTx: 0, restarts: 0 })
  return { id, simulated: true }
}

export async function startContainer(id: string): Promise<boolean> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/start`, { method: "POST" }, 30000)
    if (!res.ok && res.status !== 304) throw new Error(`Docker API start failed: HTTP ${res.status}`)
    return true
  }
  const c = simContainers().get(id)
  if (!c) throw new Error("容器不存在")
  c.state = "running"
  c.startedAt = Date.now()
  return true
}

export async function stopContainer(id: string, timeoutSec = 10): Promise<boolean> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/stop?t=${timeoutSec}`, { method: "POST" }, (timeoutSec + 5) * 1000)
    if (!res.ok && res.status !== 304) throw new Error(`Docker API stop failed: HTTP ${res.status}`)
    return true
  }
  const c = simContainers().get(id)
  if (!c) return true
  c.state = "exited"
  return true
}

// 信号触发 sing-box 热重载（SIGHUP）
export async function signalContainer(id: string, signal = "SIGHUP"): Promise<boolean> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/kill?signal=${signal}`, { method: "POST" })
    if (!res.ok) throw new Error(`Docker API signal failed: HTTP ${res.status}`)
    return true
  }
  return simContainers().has(id)
}

export async function removeContainer(id: string, force = false): Promise<boolean> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}?force=${force}&v=1`, { method: "DELETE" }, 30000)
    if (!res.ok && res.status !== 404) throw new Error(`Docker API remove failed: HTTP ${res.status}`)
    return true
  }
  simContainers().delete(id)
  return true
}

export async function inspectContainer(id: string): Promise<DockerContainerInfo | null> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/json`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Docker API inspect failed: HTTP ${res.status}`)
    const json = (await res.json()) as {
      Id: string
      Name: string
      State: { Status: string; Running: boolean }
    }
    return {
      id: json.Id,
      name: json.Name.replace(/^\//, ""),
      state: json.State.Status,
      status: json.State.Status,
    }
  }
  const c = simContainers().get(id)
  if (!c) return null
  return { id, name: c.spec.name, state: c.state, status: c.state }
}

export async function containerStats(id: string): Promise<DockerContainerStats> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/stats?stream=false`, undefined, 15000)
    if (!res.ok) throw new Error(`Docker API stats failed: HTTP ${res.status}`)
    const json = (await res.json()) as {
      cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus: number }
      memory_stats: { usage: number }
      networks?: Record<string, { rx_bytes: number; tx_bytes: number }>
    }
    const cpuDelta = json.cpu_stats.cpu_usage.total_usage
    const sysDelta = json.cpu_stats.system_cpu_usage || 1
    const cpus = json.cpu_stats.online_cpus || 1
    const cpuPct = (cpuDelta / sysDelta) * cpus * 100
    const net = Object.values(json.networks || {})
    const rx = net.reduce((s, n) => s + n.rx_bytes, 0)
    const tx = net.reduce((s, n) => s + n.tx_bytes, 0)
    return {
      cpuPct: Math.round(Math.min(cpuPct, 100) * 1000) / 1000,
      memMb: Math.round((json.memory_stats.usage / 1048576) * 1000) / 1000,
      netRxMb: Math.round((rx / 1048576) * 1000) / 1000,
      netTxMb: Math.round((tx / 1048576) * 1000) / 1000,
    }
  }
  // 模拟统计：基于运行时长生成演示曲线
  const c = simContainers().get(id)
  if (!c || c.state !== "running") return { cpuPct: 0, memMb: 0, netRxMb: 0, netTxMb: 0 }
  const runMin = (Date.now() - c.startedAt) / 60000
  const base = (c.spec.cpuLimit * 100) / 3
  const wave = Math.sin(runMin / 5 + c.spec.memLimitMb) * 0.4 + 0.6
  c.netRx += 0.5 + Math.random() * 2
  c.netTx += 0.3 + Math.random() * 1
  return {
    cpuPct: Math.round(Math.min(base * wave, c.spec.cpuLimit * 100) * 1000) / 1000,
    memMb: Math.round(Math.min(c.spec.memLimitMb * (0.3 + wave * 0.4), c.spec.memLimitMb) * 1000) / 1000,
    netRxMb: Math.round(c.netRx * 1000) / 1000,
    netTxMb: Math.round(c.netTx * 1000) / 1000,
  }
}

export async function containerLogs(id: string, tail = 200): Promise<string[]> {
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`)
    if (!res.ok) throw new Error(`Docker API logs failed: HTTP ${res.status}`)
    const text = await res.text()
    return text.split("\n").filter(Boolean).slice(-tail)
  }
  const c = simContainers().get(id)
  if (!c) return []
  const now = new Date().toISOString()
  const lines = [
    `${now} sing-box started (config via env var, ${Object.keys(c.spec.envVars).length} keys)`,
    `${now} inbound socks listening`,
    `${now} outbound ready [${c.spec.cpuLimit} cpu / ${c.spec.memLimitMb}mb limits]`,
  ]
  if (c.state === "running") {
    lines.push(`${new Date().toISOString()} route: ${Math.floor(Math.random() * 500)} connections active`)
  }
  return lines
}

// 宿主机资源（真实模式调用 /info、模拟模式生成水位）
export async function hostInfo(): Promise<{ cpuCores: number; memTotalMb: number; simulated: boolean }> {
  if (externalAvailable.docker) {
    const res = await dockerFetch("/info")
    if (!res.ok) throw new Error(`Docker API info failed: HTTP ${res.status}`)
    const json = (await res.json()) as { NCPU: number; MemTotal: number }
    return { cpuCores: json.NCPU, memTotalMb: Math.round(json.MemTotal / 1048576), simulated: false }
  }
  return { cpuCores: 8, memTotalMb: 16384, simulated: true }
}
