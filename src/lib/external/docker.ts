// Docker REST API 客户端：HTTP 调用 Docker Engine API（生产通过 docker-api-proxy 暴露的 HTTP 端点访问）
// 未配置 DOCKER_API_URL 时进入本地模拟模式 —— 容器生命周期、统计、日志全链路可跑（沙箱/演示/单机部署）
// 真实模式：所有操作（创建/启动/停止/删除/统计/日志）全部 HTTP 调用完成，绝不挂载宿主机 socket

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"
import { mkdir } from "fs/promises"

// ============================================================
// 硬隔离浏览器容器（HelmPort 自托管模式）
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
  domainPolicy?: { mode: string; blackPatterns: string[]; whitePatterns: string[] }
  endpointPolicy?: { blackPatterns: string[]; whitePatterns: string[] } // 端点级精确限制（host:port）
  policyFile?: string | null // 网络策略托管策略 JSON（只读 bind-mount 进 /etc/chromium/policies/managed/）
  gatewayIp?: string | null // 会话网络网关（平台内部端点封禁目标）
  // —— r27：会话录像 + 防退出档位 ——
  recording?: { enabled: boolean; fps: number; segmentSec: number; maxSec: number } // 录像策略（进程树内 ffmpeg 分段）
  exitGuard?: "normal" | "fullscreen" | "kiosk" // 防退出档位（supervisor chromium 参数）
  recordingDir?: string | null // 容器外录像目录（宿主侧用户空间；有 spec.recording.enabled 时必填）
  recordingUserId?: string | null // 录像归属用户（用户空间目录推导；name 由本函数生成）
  // —— r36：管理员可配置容器安全附加项（后台 docker.browserSecurityOpt/CapAdd）——
  extraSecurityOpt?: string | null // JSON 数组字符串（追加 --security-opt，如自定义 seccomp profile）
  extraCapAdd?: string | null // JSON 数组字符串（追加 CapAdd；削弱隔离，管理员显式风险决策）
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
  domainPolicy?: { mode: string; blackPatterns: string[]; whitePatterns: string[] }
  endpointPolicy?: { blackPatterns: string[]; whitePatterns: string[] }
  policyManagedChromium: boolean // Chromium 托管策略文件已注入（只读、不可篡改）
  iccDisabledNetwork: boolean // 会话网络容器互访封禁（跨用户网络不可达）
  // —— 单容器全内置形态（r13）/ 外部浏览器分离部署（r14）——
  runtime?: "embedded" | "docker" | "external" // 运行时形态（缺省 docker = 历史快照兼容）
  separateLinuxUser?: boolean // 每平台用户独立 Linux 用户（Profile 700 隔离）
  mountNamespacePolicy?: boolean // unshare 用户+挂载命名空间：每沙箱私有策略视图
  vncLoopbackOnly?: boolean // RFB/CDP 仅回环绑定
  perSandboxDisplay?: boolean // 每沙箱独立虚拟显示
  // —— 外部浏览器分离部署（EXTERNAL_BROWSER_URL）快照 ——
  externalBrowser?: {
    endpoint: string // CDP 端点 host:port
    vncEndpoint: string // RFB 端点 host:port
    browser: string | null // /json/version 探测到的浏览器版本
    latencyMs: number | null
    policyNote: string // 策略执行位置说明（外部部署侧自管）
  }
  // —— r27：会话录像与防退出档位快照 ——
  recordingEnabled?: boolean // 该沙箱已开启会话录像（进程树内 ffmpeg 分段）
  exitGuard?: "normal" | "fullscreen" | "kiosk" // 防退出档位（fullscreen=全屏守卫 / kiosk=信息亭）
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
    domainPolicy: spec.domainPolicy ?? { mode: "BLACKLIST", blackPatterns: [], whitePatterns: [] },
    endpointPolicy: spec.endpointPolicy ?? { blackPatterns: [], whitePatterns: [] },
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

// 硬化默认值 + 管理员可配置附加项（r36）
// SecurityOpt/CapAdd 附加项来源：后台配置 docker.browserSecurityOpt / docker.browserCapAdd
//（JSON 数组字符串）。典型用途：部署 deploy/seccomp/dockyard-chromium.json 到
// Docker daemon 主机后填写 seccomp 项 → Chromium 原生沙箱可用（永不回退 --no-sandbox）。
function parseSecurityOptList(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]") as unknown[]
    if (!Array.isArray(arr)) return []
    return arr
      .map((v) => String(v).trim())
      .filter(Boolean)
      .filter((v) => v.length <= 200 && !/[\n\r]/.test(v)) // 单行、限长（防注入畸形 HostConfig）
  } catch {
    return []
  }
}

export function buildBrowserHostConfig(spec: BrowserHardeningSpec) {
  const binds = spec.profileDir ? [`${spec.profileDir}:/home/browser/profile:rw,nosuid,nodev,noexec`] : []
  // 网络策略托管策略：只读 bind-mount（只读根 FS + 非 root + CapDrop=ALL → 沙箱内无法篡改）
  if (spec.policyFile) binds.push(`${spec.policyFile}:${CHROMIUM_POLICY_MOUNT}:ro`)
  // r27：会话录像目录（用户空间；可写不可执行，与 Profile 同级隔离语义）
  if (spec.recording?.enabled && spec.recordingDir) binds.push(`${spec.recordingDir}:/home/browser/recordings:rw,nosuid,nodev,noexec`)
  // r36：管理员附加 security-opt（seccomp profile 等）与 capabilities（可选项）
  const extraSecurityOpt = parseSecurityOptList(spec.extraSecurityOpt || "[]")
  const extraCapAdd = parseSecurityOptList(spec.extraCapAdd || "[]")
  return {
    NanoCpus: Math.round(spec.cpuLimit * 1e9),
    Memory: Math.round(spec.memLimitMb * 1024 * 1024),
    MemorySwap: Math.round(spec.memLimitMb * 1024 * 1024), // 禁 swap：超限 OOM 硬终止
    PidsLimit: spec.pidsLimit,
    Privileged: false,
    ReadOnlyRootfs: true, // 根文件系统只读
    CapDrop: ["ALL"],
    CapAdd: extraCapAdd, // r36：管理员显式授予（默认空数组 = 保持最强隔离）
    SecurityOpt: ["no-new-privileges", ...extraSecurityOpt],
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
    // r33：镜像存在性保障（404 根因修复）——创建前确保镜像在节点本地，缺失则自动拉取
    const img = await ensureImagePresent(spec.image)
    if (!img.present) {
      throw new Error(`浏览器镜像 ${spec.image} 不可用${img.message ? `（${img.message}）` : ""}；请在节点预拉取后重试`)
    }
    // r27：录像用户空间目录（name 本函数生成 → 目录此处统一推导；调用方无需预知容器名）
    let recordDir: string | null = null
    if (spec.recording?.enabled && spec.recordingUserId && safeId(spec.recordingUserId)) {
      recordDir = `${ENV.storageLocalPath.replace(/\/$/, "")}/recordings/${spec.recordingUserId}/${name}`
      await mkdir(recordDir, { recursive: true }).catch(() => null)
    }
    const envVars: Record<string, string> = {
      START_URL: spec.startUrl || "about:blank",
      RESOLUTION: spec.resolution || "1280x800",
      TZ: "Asia/Shanghai",
      ...(spec.proxyUrl ? { PROXY_URL: spec.proxyUrl } : {}),
      ...(spec.exitGuard && spec.exitGuard !== "normal" ? { EXIT_GUARD: spec.exitGuard } : {}),
      ...(spec.recording?.enabled && recordDir
        ? {
            REC_DIR: "/home/browser/recordings",
            REC_FPS: String(spec.recording.fps),
            REC_SEGSEC: String(spec.recording.segmentSec),
            REC_MAXSEC: String(spec.recording.maxSec || 0),
            REC_SIZE: spec.resolution || "1280x800",
          }
        : {}),
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
      HostConfig: buildBrowserHostConfig({ ...spec, recordingDir: recordDir }),
    }
    const res = await dockerFetch("/containers/create?name=" + encodeURIComponent(name), {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Docker API create browser failed: HTTP ${res.status}${await dockerErrDetail(res)}`)
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

// 防退出运维动作：浏览器进程级重启（同一 Profile 1 秒内拉起）
// 单容器内嵌形态：USR1 → 嵌入式监督循环；外部容器形态：docker exec 容器内 PID 1
export async function restartBrowserProcessInContainer(idOrName: string): Promise<{ restarted: boolean; simulated: boolean }> {
  if (idOrName.startsWith("emb-")) {
    const { restartEmbeddedBrowser } = await import("../embedded-sandbox")
    const r = await restartEmbeddedBrowser(idOrName)
    return { restarted: r.restarted, simulated: false }
  }
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

export async function dockerFetch(path: string, init?: RequestInit, timeoutMs = ENV.dockerApiTimeout): Promise<Response> {
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

// ============================================================
// r33：镜像存在性保障（修复「重建会话失败：Docker API create browser failed: HTTP 404」根因）
// Docker Engine API 对 /containers/create 返回 404 的最常见原因是「本地不存在该镜像」
// （节点重装 / docker image prune / 新扩容 Worker 未预拉镜像）。
// createIsolatedBrowserContainer / createContainer 创建前统一调用：
//   1. GET /images/<ref>/json 命中 → 直接创建
//   2. 404 → POST /images/create?fromImage=<ref> 自动拉取（默认 5 分钟超时），再复查
//   3. 拉取失败 → 抛出可操作错误（提示在节点预拉镜像）
// ============================================================
async function dockerErrDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { message?: string; error?: string }
      const msg = j.message || j.error
      if (msg) return `：${msg.slice(0, 300)}`
    } catch {
      if (text) return `：${text.slice(0, 300)}`
    }
  } catch { /* 响应体不可读 */ }
  return ""
}

export async function ensureImagePresent(
  image: string,
  opts?: { pullTimeoutMs?: number; log?: (m: string) => void },
): Promise<{ present: boolean; pulled: boolean; message?: string }> {
  if (!externalAvailable.docker) return { present: true, pulled: false }
  const ref = image.trim()
  if (!ref) return { present: false, pulled: false, message: "镜像引用为空" }
  const inspect = await dockerFetch(`/images/${encodeURIComponent(ref)}/json`, { method: "GET" }, 15_000)
  if (inspect.ok) return { present: true, pulled: false }
  if (inspect.status !== 404) {
    return { present: false, pulled: false, message: `镜像检查失败 HTTP ${inspect.status}${await dockerErrDetail(inspect)}` }
  }
  // 本地不存在 → 自动拉取（流式进度体不消费，仅等状态码；registry 鉴权场景需预先 docker login）
  opts?.log?.(`镜像 ${ref} 本地不存在，自动拉取中…`)
  const pullTimeout = opts?.pullTimeoutMs ?? 300_000
  try {
    const pull = await dockerFetch(`/images/create?fromImage=${encodeURIComponent(ref)}`, { method: "POST" }, pullTimeout)
    if (!pull.ok && pull.status !== 404) {
      return { present: false, pulled: false, message: `镜像拉取失败 HTTP ${pull.status}${await dockerErrDetail(pull)}` }
    }
    if (pull.status === 404) {
      return { present: false, pulled: false, message: `仓库中不存在镜像 ${ref}（请检查镜像名/标签或在节点手动拉取）` }
    }
    // 拉取流（JSON lines）读掉以释放连接
    await pull.text().catch(() => "")
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? `镜像拉取超时（>${Math.round(pullTimeout / 1000)}s）` : `镜像拉取异常：${e instanceof Error ? e.message : String(e)}`
    return { present: false, pulled: false, message: msg }
  }
  // 复查
  const verify = await dockerFetch(`/images/${encodeURIComponent(ref)}/json`, { method: "GET" }, 15_000)
  if (verify.ok) return { present: true, pulled: true }
  return { present: false, pulled: false, message: "镜像拉取后仍未检出（请检查节点磁盘/registry 状态）" }
}

// ---- 嵌入式进程形态（r13：sing-box 容器内进程，单容器全内置）----
// 条件：未配置 DOCKER_API_URL 且镜像内 sing-box 二进制可用；调用方（singbox 编排）无感知切换
async function embeddedProcessRuntime() {
  return await import("../embedded-sandbox")
}
function isEmbProcId(id: string): boolean {
  return id.startsWith("sbx-")
}

// 创建容器（Sing-Box编排专用：配置JSON通过环境变量注入容器）
export async function createContainer(spec: DockerContainerSpec): Promise<{ id: string; simulated: boolean }> {
  // 单容器全内置：sing-box 以同容器进程运行（零外部镜像/零 Docker API）
  if (!externalAvailable.docker && spec.envVars && typeof spec.envVars.DY_SINGBOX_CONFIG === "string") {
    const m = await embeddedProcessRuntime()
    if (m.embeddedSingboxAvailable()) {
      const r = await m.createEmbeddedProcess({
        name: spec.name,
        configJson: spec.envVars.DY_SINGBOX_CONFIG,
        memLimitMb: spec.memLimitMb,
      })
      return { id: r.id, simulated: false }
    }
  }
  if (externalAvailable.docker) {
    // r33：镜像存在性保障（404 根因修复，同浏览器容器链路）
    const img = await ensureImagePresent(spec.image)
    if (!img.present) {
      throw new Error(`镜像 ${spec.image} 不可用${img.message ? `（${img.message}）` : ""}；请在节点预拉取后重试`)
    }
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
    if (!res.ok) throw new Error(`Docker API create failed: HTTP ${res.status}${await dockerErrDetail(res)}`)
    const json = (await res.json()) as { Id: string }
    return { id: json.Id, simulated: false }
  }
  // 模拟模式
  const id = "sim-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simContainers().set(id, { spec, state: "created", startedAt: 0, netRx: 0, netTx: 0, restarts: 0 })
  return { id, simulated: true }
}

export async function startContainer(id: string): Promise<boolean> {
  if (isEmbProcId(id)) return true // 进程创建即运行
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
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    return m.stopEmbeddedProcess(id)
  }
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

// 信号触发 sing-box 热重载（SIGHUP；嵌入式进程同语义）
export async function signalContainer(id: string, signal = "SIGHUP"): Promise<boolean> {
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    return m.signalEmbeddedProcess(id, signal)
  }
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}/kill?signal=${signal}`, { method: "POST" })
    if (!res.ok) throw new Error(`Docker API signal failed: HTTP ${res.status}`)
    return true
  }
  return simContainers().has(id)
}

export async function removeContainer(id: string, force = false): Promise<boolean> {
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    return m.removeEmbeddedProcess(id)
  }
  if (externalAvailable.docker) {
    const res = await dockerFetch(`/containers/${id}?force=${force}&v=1`, { method: "DELETE" }, 30000)
    if (!res.ok && res.status !== 404) throw new Error(`Docker API remove failed: HTTP ${res.status}`)
    return true
  }
  simContainers().delete(id)
  return true
}

export async function inspectContainer(id: string): Promise<DockerContainerInfo | null> {
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    const info = await m.embeddedProcessInfo(id)
    if (!info) return null
    return { id, name: id, state: info.state, status: info.state }
  }
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
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    const s = await m.embeddedProcessStats(id)
    if (!s) return { cpuPct: 0, memMb: 0, netRxMb: 0, netTxMb: 0 }
    return s
  }
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
  if (isEmbProcId(id)) {
    const m = await embeddedProcessRuntime()
    return m.embeddedProcessLogs(id, tail)
  }
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

// r23：宿主机真实资源采集（CPU%/内存/磁盘）—— 用于 host_probe 水位预警
// · CPU：两次采样 /proc/stat 差分（250ms 间隔）得出真实使用率；无 /proc 时回退 loadavg 近似
// · 内存：/proc/meminfo（容器内非 namespaced 时即宿主机真实值）；回退 os 模块
// · 磁盘：优先 Docker data-root（容器存储所在文件系统 —— 用户明确要求识别容器存储位置磁盘用量）；
//   无 Docker 时回退平台数据目录所在文件系统
export interface HostRealMetrics {
  cpuCores: number
  cpuUsedPct: number
  memTotalMb: number
  memUsedMb: number
  diskTotalMb: number
  diskUsedPct: number
  diskPath: string
  diskSource: "docker-data-root" | "storage-path" | "root"
  memSource: "meminfo" | "os"
  cpuSource: "proc-stat" | "loadavg"
  simulated: boolean
}

export async function hostRealMetrics(opts?: { storageFallbackPath?: string }): Promise<HostRealMetrics> {
  const os = await import("os")

  // ---- 基础信息（优先 Docker API：宿主机真实核数/内存；容器视角一致） ----
  let cpuCores = os.cpus().length
  let memTotalMb = Math.round(os.totalmem() / 1048576)
  let simulated = false
  let dockerRootDir: string | null = null
  if (externalAvailable.docker) {
    try {
      const res = await dockerFetch("/info")
      if (res.ok) {
        const json = (await res.json()) as { NCPU?: number; MemTotal?: number; DockerRootDir?: string; Driver?: string }
        if (json.NCPU) cpuCores = json.NCPU
        if (json.MemTotal) memTotalMb = Math.round(json.MemTotal / 1048576)
        dockerRootDir = json.DockerRootDir || null
      }
    } catch {
      // Docker API 不可达 → 用 os 数据 + 存储路径磁盘
    }
  } else {
    simulated = true
  }

  // ---- CPU：/proc/stat 差分 ----
  const readProcStat = async (): Promise<number[] | null> => {
    try {
      const fs = await import("fs/promises")
      const txt = await fs.readFile("/proc/stat", "utf8")
      const line = txt.split("\n")[0]
      const parts = line.split(/\s+/).slice(1).map(Number)
      if (parts.length < 4) return null
      return parts
    } catch {
      return null
    }
  }
  let cpuUsedPct = 0
  let cpuSource: HostRealMetrics["cpuSource"] = "loadavg"
  const stat1 = await readProcStat()
  if (stat1) {
    await new Promise((r) => setTimeout(r, 250))
    const stat2 = await readProcStat()
    if (stat2) {
      const idle1 = stat1[3] + (stat1[4] || 0)
      const idle2 = stat2[3] + (stat2[4] || 0)
      const total1 = stat1.reduce((a, b) => a + b, 0)
      const total2 = stat2.reduce((a, b) => a + b, 0)
      const dTotal = total2 - total1
      const dIdle = idle2 - idle1
      if (dTotal > 0) {
        cpuUsedPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
        cpuSource = "proc-stat"
      }
    }
  }
  if (cpuSource === "loadavg") {
    // 回退：1 分钟负载 / 核数（粗略上限截断 100%）
    const load = os.loadavg()[0]
    cpuUsedPct = Math.max(0, Math.min(100, (load / Math.max(1, cpuCores)) * 100))
  }

  // ---- 内存：/proc/meminfo ----
  let memUsedMb = 0
  let memSource: HostRealMetrics["memSource"] = "os"
  try {
    const fs = await import("fs/promises")
    const txt = await fs.readFile("/proc/meminfo", "utf8")
    const map = new Map<string, number>()
    for (const line of txt.split("\n")) {
      const m = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim())
      if (m) map.set(m[1], Number(m[2]))
    }
    const totalKb = map.get("MemTotal")
    const availKb = map.get("MemAvailable") ?? map.get("MemFree")
    if (totalKb && availKb !== undefined) {
      memTotalMb = Math.round(totalKb / 1024)
      memUsedMb = Math.round((totalKb - availKb) / 1024)
      memSource = "meminfo"
    }
  } catch {
    // 回退 os
  }
  if (memSource === "os") {
    memUsedMb = Math.round((os.totalmem() - os.freemem()) / 1048576)
  }

  // ---- 磁盘：Docker data-root 优先（容器存储位置的真实文件系统用量） ----
  const statfsOf = async (p: string): Promise<{ totalMb: number; usedPct: number } | null> => {
    try {
      const fs = await import("fs/promises")
      const st = await (fs as unknown as { statfs?: (p: string) => Promise<{ blocks: number; bsize: number; bfree: number; bavail: number }> }).statfs?.(p)
      if (!st || !st.blocks || !st.bsize) return null
      const total = st.blocks * st.bsize
      const free = st.bfree * st.bsize
      return { totalMb: Math.round(total / 1048576), usedPct: total > 0 ? ((total - free) / total) * 100 : 0 }
    } catch {
      return null
    }
  }
  let diskPath = dockerRootDir || opts?.storageFallbackPath || "/"
  let diskSource: HostRealMetrics["diskSource"] = dockerRootDir ? "docker-data-root" : opts?.storageFallbackPath ? "storage-path" : "root"
  let disk = await statfsOf(diskPath)
  if (!disk && diskSource !== "root") {
    // data-root 不可读（权限/不存在）→ 回退根文件系统
    disk = await statfsOf("/")
    diskPath = "/"
    diskSource = "root"
  }
  const diskTotalMb = disk?.totalMb ?? 0
  const diskUsedPct = disk ? Math.round(disk.usedPct * 1000) / 1000 : 0

  return {
    cpuCores,
    cpuUsedPct: Math.round(cpuUsedPct * 1000) / 1000,
    memTotalMb,
    memUsedMb,
    diskTotalMb,
    diskUsedPct,
    diskPath,
    diskSource,
    memSource,
    cpuSource,
    simulated,
  }
}
