// Docker REST API 客户端：HTTP 调用 Docker Engine API（生产通过 docker-api-proxy 暴露的 HTTP 端点访问）
// 未配置 DOCKER_API_URL 时进入本地模拟模式 —— 容器生命周期、统计、日志全链路可跑（沙箱/演示/单机部署）
// 真实模式：所有操作（创建/启动/停止/删除/统计/日志）全部 HTTP 调用完成，绝不挂载宿主机 socket

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"

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
