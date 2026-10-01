// ============================================================
// 嵌入式沙箱运行时（单容器全内置架构）— r13
//
// 目标：所有组件（平台 / VNC 桥 / WS 枢纽 / Xvfb / Chromium / x11vnc / sing-box）
// 全部运行在同一个容器内 —— 零外部服务、零 Docker-in-Docker、零外部镜像依赖。
//
// 每个浏览器工作区（沙箱）= 容器内一棵独立进程树：
//   sandbox-launch.sh（监督循环，防退出）── 同一 Profile 1s 内自动拉起
//     ├── Xvfb :<display>            —— 每沙箱独立虚拟显示
//     ├── x11vnc 127.0.0.1:<rfbPort> —— 仅回环可达，由 VNC 桥票据中转
//     └── chromium（CDP 127.0.0.1:<cdpPort>）
//           └── runuser + unshare -Urm（用户+挂载命名空间）
//                 └── mount --bind <每沙箱策略文件> /etc/chromium/policies/managed/dockyard.json
//                     —— 每沙箱独立 Chromium 托管策略（URLBlocklist/CRX/文件限制…），
//                        视图仅本进程树可见，宿主与其他沙箱完全不受影响（无需任何特权）
//
// 进程隔离模型：
//   · 每平台用户一个 Linux 用户（dyu-<hash>，root 环境自动创建）—— Profile/下载目录
//     700 权限互不可读；prlimit --nproc 按 UID 生效（进程数硬上限）
//   · 监督循环：浏览器任何形式退出（关闭窗口/崩溃/OOM/被杀）1 秒内同一 Profile 拉起
//   · USR1 → 浏览器进程级重启（策略刷新后即时生效通道，与容器模式语义一致）
//   · 状态落盘 state.json —— 平台重启后自动重新收养（re-adopt）存活沙箱
// ============================================================

import { spawn, spawnSync } from "child_process"
import net from "net"
import fs from "fs"
import { mkdir, readFile, writeFile, rm, readdir, stat, access } from "fs/promises"
import { join, dirname } from "path"
import { randomUUID } from "crypto"
import { ENV } from "./env"
import { EMBEDDED_CDP_PORT_RANGE, EMBEDDED_RFB_PORT_RANGE } from "./network-policy"
import type { BrowserHardeningInfo } from "./external/docker"

// ============================================================
// 运行时形态解析（BROWSER_RUNTIME=auto|embedded|docker|pool）
// ============================================================

export type BrowserRuntimeMode = "embedded" | "docker" | "pool" | "sim"

let modeCache: { mode: BrowserRuntimeMode; reason: string } | null = null

export interface EmbeddedBinaries {
  chrome: string | null
  xvfb: string | null
  x11vnc: string | null
  singbox: string | null
}

const BIN_CANDIDATES = {
  chrome: [
    process.env.EMBEDDED_BROWSER_BIN || "",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-unwrapped",
  ].filter(Boolean),
  xvfb: [process.env.EMBEDDED_XVFB_BIN || "", "/usr/bin/Xvfb"],
  x11vnc: [process.env.EMBEDDED_X11VNC_BIN || "", "/usr/bin/x11vnc", "/usr/local/bin/x11vnc"],
  singbox: [process.env.EMBEDDED_SINGBOX_BIN || "", "/usr/local/bin/sing-box", "/usr/bin/sing-box"],
}

let binCache: EmbeddedBinaries | null = null

export function embeddedBinaries(): EmbeddedBinaries {
  if (binCache) return binCache
  const pick = (list: string[]): string | null => {
    for (const p of list) {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch {
        /* try next */
      }
    }
    return null
  }
  binCache = {
    chrome: pick(BIN_CANDIDATES.chrome),
    xvfb: pick(BIN_CANDIDATES.xvfb),
    x11vnc: pick(BIN_CANDIDATES.x11vnc),
    singbox: pick(BIN_CANDIDATES.singbox),
  }
  return binCache
}

export function resetEmbeddedCaches() {
  modeCache = null
  binCache = null
}

// 解析当前浏览器运行时形态（cached；novnc/docker 路由共用）
export function resolveBrowserRuntimeMode(): { mode: BrowserRuntimeMode; reason: string } {
  if (modeCache) return modeCache
  const forced = (process.env.BROWSER_RUNTIME || "auto").toLowerCase()
  const bins = embeddedBinaries()
  const browserReady = !!(bins.chrome && bins.xvfb && bins.x11vnc)
  if (forced === "embedded") {
    modeCache = browserReady
      ? { mode: "embedded", reason: "BROWSER_RUNTIME=embedded（强制单容器内嵌）" }
      : { mode: "sim", reason: "BROWSER_RUNTIME=embedded 但镜像缺少 chromium/xvfb/x11vnc → 演示模式" }
    return modeCache
  }
  if (forced === "docker" || forced === "pool") {
    const ok = forced === "docker" ? !!ENV.dockerApiUrl : !!ENV.novncPoolUrl
    modeCache = ok
      ? { mode: forced, reason: `BROWSER_RUNTIME=${forced}（外部编排形态）` }
      : { mode: "sim", reason: `BROWSER_RUNTIME=${forced} 但对应服务 URL 未配置` }
    return modeCache
  }
  // auto：单容器内嵌优先（零外部依赖）；仅在容器内无浏览器组件时才降级
  if (browserReady) {
    modeCache = { mode: "embedded", reason: "auto：容器内浏览器组件齐备 → 单容器内嵌沙箱" }
    return modeCache
  }
  if (ENV.novncPoolUrl) {
    modeCache = { mode: "pool", reason: "auto：容器内无浏览器组件，NOVNC_POOL_URL 已配置" }
    return modeCache
  }
  if (ENV.dockerApiUrl) {
    modeCache = { mode: "docker", reason: "auto：容器内无浏览器组件，DOCKER_API_URL 已配置" }
    return modeCache
  }
  modeCache = { mode: "sim", reason: "auto：无浏览器组件且未配置外部编排 → 演示模式" }
  return modeCache
}

// ============================================================
// 资源分配（display / RFB 端口 / CDP 端口）
// ============================================================

const DISPLAY_MIN = 100
const DISPLAY_MAX = 254
// 端口段与 network-policy.ts 跨沙箱基线严格一致（deny-wins 封禁段）
const RFB_PORT_BASE = EMBEDDED_RFB_PORT_RANGE.base // 仅 127.0.0.1 绑定，不对外；段长与基线一致
const CDP_PORT_BASE = EMBEDDED_CDP_PORT_RANGE.base // 仅 127.0.0.1 绑定，不对外；段长与基线一致
const PORT_SPAN = EMBEDDED_CDP_PORT_RANGE.span

function sandboxRoot(): string {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "sandboxes")
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function tcpProbe(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port })
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(timeoutMs, () => done(true)) // 连不上 = 空闲
    s.once("connect", () => done(false))
    s.once("error", () => done(true))
  })
}

// display 编号占用（X lock 文件存在即占用）
function displayTaken(n: number): Promise<boolean> {
  return pathExists(`/tmp/.X${n}-lock`)
}

async function allocateDisplay(): Promise<number> {
  for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) {
    if (!(await displayTaken(n))) return n
  }
  throw new Error("无可用虚拟显示编号（沙箱数达到上限 155）")
}

async function allocatePort(base: number, span = PORT_SPAN): Promise<number> {
  for (let i = 0; i < span; i++) {
    const p = base + i
    if (await tcpProbe(p)) return p
  }
  throw new Error(`无可用端口（base=${base}）`)
}

// ============================================================
// Linux 沙箱用户（root 环境自动创建；非 root 环境以当前用户降级运行）
// ============================================================

function linuxUserFor(userId: string): string {
  return "dyu-" + Buffer.from(userId).toString("hex").slice(0, 8)
}

async function ensureLinuxUser(userId: string): Promise<string | null> {
  const name = linuxUserFor(userId)
  const uid = process.getuid?.() ?? 0
  if (uid !== 0) return null // 非 root（开发环境）：同用户模式，隔离降级（真实进程链路不受影响）
  try {
    const s = fs.readFileSync("/etc/passwd", "utf8")
    if (s.split("\n").some((l) => l.startsWith(`${name}:`))) return name
    const home = join(ENV.storageLocalPath.replace(/\/$/, ""), "homes", name)
    await mkdir(dirname(home), { recursive: true })
    // -M：home 目录由存储卷统一管理；同步创建后校验结果
    const r = spawnSync("useradd", ["-M", "-d", home, "-s", "/bin/sh", name], { timeout: 10_000 })
    if (r.status !== 0) {
      return null
    }
    return name
  } catch {
    return null
  }
}

// ============================================================
// 沙箱注册表（内存 + state.json 磁盘持久化 / re-adopt）
// ============================================================

export interface EmbeddedSandboxEntry {
  id: string // emb-<hex12>
  userId: string
  profileKey: string
  workspaceId?: string | null
  linuxUser: string | null
  display: number
  rfbPort: number
  cdpPort: number
  supervisorPid: number | null
  startedAt: number
  restarts: number
  sandboxDir: string
  policyFile: string | null
  profileDir: string
  downloadsDir: string
}

const g = globalThis as unknown as {
  __dyEmbedded?: Map<string, EmbeddedSandboxEntry>
  __dyEmbeddedAdopted?: boolean
}

function registry(): Map<string, EmbeddedSandboxEntry> {
  if (!g.__dyEmbedded) g.__dyEmbedded = new Map()
  return g.__dyEmbedded
}

function procAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

// 平台重启后重新收养：扫描 storage/sandboxes/*/state.json，监督进程仍活着的重新注册
export async function adoptEmbeddedSandboxes(): Promise<number> {
  if (g.__dyEmbeddedAdopted) return registry().size
  g.__dyEmbeddedAdopted = true
  const root = sandboxRoot()
  let adopted = 0
  let dirs: string[] = []
  try {
    dirs = await readdir(root)
  } catch {
    return 0
  }
  for (const d of dirs) {
    if (!/^emb-[a-f0-9]{6,16}$/.test(d)) continue
    const dir = join(root, d)
    try {
      const raw = await readFile(join(dir, "state.json"), "utf8")
      const st = JSON.parse(raw) as Partial<EmbeddedSandboxEntry> & { status?: string }
      if (st.status === "stopped") continue
      if (!procAlive(st.supervisorPid)) continue
      registry().set(d, {
        id: d,
        userId: st.userId || "",
        profileKey: st.profileKey || "",
        workspaceId: st.workspaceId || null,
        linuxUser: st.linuxUser || null,
        display: st.display || 0,
        rfbPort: st.rfbPort || 0,
        cdpPort: st.cdpPort || 0,
        supervisorPid: st.supervisorPid || null,
        startedAt: st.startedAt || Date.now(),
        restarts: st.restarts || 0,
        sandboxDir: dir,
        policyFile: st.policyFile || null,
        profileDir: st.profileDir || "",
        downloadsDir: st.downloadsDir || "",
      })
      adopted++
    } catch {
      /* 状态文件损坏的目录交由回收任务清理 */
    }
  }
  return adopted
}

// ============================================================
// 沙箱创建（进程树编排）
// ============================================================

export interface EmbeddedSandboxSpec {
  userId: string
  profileKey: string
  workspaceId?: string | null
  resolution?: string // WxH
  startUrl?: string
  proxyUrl?: string | null
  cpuLimit?: number
  memLimitMb?: number
  pidsLimit?: number
  policyFile?: string | null
  lang?: string
}

export interface EmbeddedSandboxHandle {
  id: string
  name: string
  rfb: { host: string; port: number }
  cdpPort: number
  display: number
  linuxUser: string | null
  simulated: false
  hardening: BrowserHardeningInfo
}

export function embeddedHardeningSummary(spec: EmbeddedSandboxSpec, linuxUser: string | null): BrowserHardeningInfo {
  return {
    // —— 与 docker.ts BrowserHardeningInfo 对齐（UI 快照复用）——
    readOnlyRootfs: false, // 单容器形态：与平台共享根 FS（进程隔离模型）
    capDropAll: false,
    noNewPrivileges: false,
    isolatedProfileVolume: true, // Profile/下载目录按 Linux 用户 700 隔离
    noexecTmpDirs: [],
    noexecDownloads: false,
    restartPolicy: "always",
    supervisorLoop: true,
    nonRootUser: linuxUser || process.env.USER || "current-user",
    pidsLimit: spec.pidsLimit ?? 256,
    memLimitMb: spec.memLimitMb ?? 1024,
    cpuLimit: spec.cpuLimit ?? 1,
    networkIsolated: false, // 单容器共享网络命名空间；网络面由 Chromium 托管策略管控
    oomHardKill: true,
    profileDir: null,
    image: "embedded(单容器内嵌)",
    allowInternalNetwork: false,
    allowSecureLocationAccess: false,
    policyManagedChromium: !!spec.policyFile,
    iccDisabledNetwork: true, // RFB/CDP 仅回环绑定 + 端点策略封禁 → 外部不可触达
    // —— 单容器内嵌扩展字段 ——
    runtime: "embedded" as const,
    separateLinuxUser: !!linuxUser,
    mountNamespacePolicy: !!spec.policyFile, // unshare -Urm 私有挂载命名空间策略注入
    vncLoopbackOnly: true,
    perSandboxDisplay: true,
  } as BrowserHardeningInfo
}

function resolutionArgs(res: string): string[] {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(res || "")
  if (!m) return ["--window-size=1280,800"]
  return ["--window-position=0,0", `--window-size=${m[1]},${m[2]}`]
}

function launchScriptPath(): string {
  // 部署形态（standalone）：/app/docker/embedded/sandbox-launch.sh
  // 开发形态：仓库根 docker/embedded/sandbox-launch.sh
  const cands = [
    join(process.cwd(), "docker/embedded/sandbox-launch.sh"),
    "/app/docker/embedded/sandbox-launch.sh",
  ]
  for (const p of cands) {
    try {
      fs.accessSync(p)
      return p
    } catch {
      /* next */
    }
  }
  return cands[0]
}

async function waitRfbUp(port: number, timeoutMs = 20000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!(await tcpProbe(port))) return true // 能连上 = x11vnc 已就绪
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export async function createEmbeddedSandbox(spec: EmbeddedSandboxSpec): Promise<EmbeddedSandboxHandle> {
  await adoptEmbeddedSandboxes()
  const bins = embeddedBinaries()
  if (!bins.chrome || !bins.xvfb || !bins.x11vnc) throw new Error("容器内浏览器组件缺失（chromium/xvfb/x11vnc）")
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(spec.profileKey) || !/^[A-Za-z0-9_-]{4,64}$/.test(spec.userId)) {
    throw new Error("非法用户/配置键")
  }

  const id = "emb-" + randomUUID().replace(/-/g, "").slice(0, 12)
  const root = sandboxRoot()
  const sandboxDir = join(root, id)
  const logDir = join(sandboxDir, "logs")
  const storage = ENV.storageLocalPath.replace(/\/$/, "")
  const profileDir = join(storage, "profiles", spec.userId, spec.profileKey)
  const downloadsDir = join(sandboxDir, "downloads")
  await Promise.all(
    [sandboxDir, logDir, profileDir, downloadsDir, join(storage, "netpolicy")].map((d) => mkdir(d, { recursive: true })),
  )

  const [display, rfbPort, cdpPort] = await Promise.all([allocateDisplay(), allocatePort(RFB_PORT_BASE), allocatePort(CDP_PORT_BASE)])
  const linuxUser = await ensureLinuxUser(spec.userId)

  const resolution = spec.resolution || "1280x800"
  const pidsLimit = Math.max(64, Math.min(1024, spec.pidsLimit ?? 256))
  const memLimitMb = Math.max(256, spec.memLimitMb ?? 1024)
  const jsHeapMb = Math.max(128, Math.floor(memLimitMb / 2))

  // ---- 生成每沙箱 chromium 内层启动脚本（unshare -Urm 挂载命名空间内执行）----
  // bind 挂载每沙箱策略文件 → /etc/chromium/policies/managed/dockyard.json
  //（视图仅本进程树可见；宿主与其他沙箱不受影响，见文件头注释）
  const proxyArgs = spec.proxyUrl ? `--proxy-server=${spec.proxyUrl}` : ""
  const inner = `#!/bin/sh
# 由嵌入式沙箱引擎生成（沙箱 ${id}）
DY_POLICY_FILE="\${DY_POLICY_FILE:-}"
if [ -n "$DY_POLICY_FILE" ] && [ -f "$DY_POLICY_FILE" ]; then
  if [ -e /etc/chromium/policies/managed/dockyard.json ]; then
    mount --bind "$DY_POLICY_FILE" /etc/chromium/policies/managed/dockyard.json 2>>"$DY_LOG_DIR/policy.log" \\
      || echo "[emb] WARN: 策略挂载不可用（挂载命名空间受限）→ 以全局基线运行" >>"$DY_LOG_DIR/policy.log"
  else
    echo "[emb] WARN: /etc/chromium/policies/managed/dockyard.json 不存在 → 以全局基线运行" >>"$DY_LOG_DIR/policy.log"
  fi
fi
exec prlimit --nproc=${pidsLimit} -- "${bins.chrome}" \\
  --user-data-dir="\${DY_PROFILE_DIR}" \\
  --no-sandbox --disable-gpu --no-first-run \\
  --disable-session-crashed-bubble --hide-crash-restore-bubble \\
  --restore-last-session ${resolutionArgs(resolution).join(" ")} \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} \\
  --download.default_directory="\${DY_DOWNLOADS_DIR}" \\
  --disable-features=ExitWarningBubble --disable-dev-shm-usage \\
  --js-flags=--max-old-space-size=${jsHeapMb} \\
  --lang="\${DY_LANG:-zh-CN}" \\
  ${proxyArgs} \\
  "\${DY_START_URL:-about:blank}"
`
  const innerPath = join(sandboxDir, "chrome-inner.sh")
  await writeFile(innerPath, inner, { mode: 0o755 })

  // ---- 每沙箱统一 HOME（Linux 用户模式下归该用户所有）----
  const sandboxHome = linuxUser ? join(storage, "homes", linuxUser) : sandboxDir
  if (linuxUser) await mkdir(sandboxHome, { recursive: true })

  const child = spawn(launchScriptPath(), [], {
    env: {
      ...process.env,
      DY_SANDBOX_ID: id,
      DY_SANDBOX_DIR: sandboxDir,
      DY_LOG_DIR: logDir,
      DY_INNER: innerPath,
      DY_CHROME_BIN: bins.chrome,
      DY_XVFB_BIN: bins.xvfb,
      DY_X11VNC_BIN: bins.x11vnc,
      DY_USER: linuxUser || "",
      DY_USER_ID: spec.userId,
      DY_PROFILE_KEY: spec.profileKey,
      DY_WORKSPACE_ID: spec.workspaceId || "",
      DY_USER_HOME: sandboxHome,
      DY_DISPLAY: String(display),
      DY_RFB_PORT: String(rfbPort),
      DY_CDP_PORT: String(cdpPort),
      DY_RESOLUTION: `${resolution}x24`,
      DY_START_URL: spec.startUrl || "about:blank",
      DY_PROXY_URL: spec.proxyUrl || "",
      DY_POLICY_FILE: spec.policyFile || "",
      DY_LANG: spec.lang || "zh-CN",
      DY_PROFILE_DIR: profileDir,
      DY_DOWNLOADS_DIR: downloadsDir,
      DY_PIDS: String(pidsLimit),
    },
    detached: true, // 脱离平台进程组：平台重启不牵连沙箱（state.json 重新收养）
    stdio: ["ignore", fs.openSync(join(logDir, "supervisor.log"), "a"), fs.openSync(join(logDir, "supervisor.log"), "a")],
  })
  child.unref()

  const ok = await waitRfbUp(rfbPort)
  if (!ok) {
    // 监督脚本自灭（X 冲突/组件异常）→ 读取日志给出可诊断错误
    let tail = ""
    try {
      tail = (await readFile(join(logDir, "supervisor.log"), "utf8")).split("\n").slice(-8).join("\n")
    } catch {
      /* ignore */
    }
    await destroyEmbeddedSandbox(id).catch(() => null)
    throw new Error(`沙箱进程树启动失败（x11vnc 未就绪）\n${tail}`)
  }

  // Chromium CDP 就绪等待（晚于 x11vnc 约 1~3 秒；非致命：仅影响立即可用性）
  const t0 = Date.now()
  while (Date.now() - t0 < 12000) {
    if (!(await tcpProbe(cdpPort))) break
    await new Promise((r) => setTimeout(r, 300))
  }

  const entry: EmbeddedSandboxEntry = {
    id,
    userId: spec.userId,
    profileKey: spec.profileKey,
    workspaceId: spec.workspaceId || null,
    linuxUser,
    display,
    rfbPort,
    cdpPort,
    supervisorPid: null, // 下方从 state.json 回填
    startedAt: Date.now(),
    restarts: 0,
    sandboxDir,
    policyFile: spec.policyFile || null,
    profileDir,
    downloadsDir,
  }
  registry().set(id, entry)
  void refreshSupervisorPid(entry)
  return {
    id,
    name: id,
    rfb: { host: "127.0.0.1", port: rfbPort },
    cdpPort,
    display,
    linuxUser,
    simulated: false as const,
    hardening: embeddedHardeningSummary(spec, linuxUser),
  }
}

async function refreshSupervisorPid(entry: EmbeddedSandboxEntry) {
  try {
    const raw = await readFile(join(entry.sandboxDir, "state.json"), "utf8")
    const st = JSON.parse(raw) as { supervisorPid?: number }
    if (st.supervisorPid) {
      entry.supervisorPid = st.supervisorPid
      await writeFile(join(entry.sandboxDir, "supervisor.pid"), String(st.supervisorPid))
    }
  } catch {
    /* 稍后健康探测重试 */
  }
}

// ============================================================
// 运维操作：健康 / 统计 / 日志 / 进程重启 / 停止 / 销毁
// ============================================================

export async function embeddedSandbox(idOrRef: string): Promise<EmbeddedSandboxEntry | null> {
  await adoptEmbeddedSandboxes()
  const id = idOrRef.startsWith("emb-") ? idOrRef : idOrRef
  let entry = registry().get(id)
  if (entry) {
    if (!procAlive(entry.supervisorPid)) void refreshSupervisorPid(entry)
    return entry
  }
  // 磁盘兜底（进程重启后 registry 未命中）
  const dir = join(sandboxRoot(), id)
  try {
    const raw = await readFile(join(dir, "state.json"), "utf8")
    const st = JSON.parse(raw) as Partial<EmbeddedSandboxEntry>
    if (!procAlive(st.supervisorPid)) return null
    entry = {
      id,
      userId: st.userId || "",
      profileKey: st.profileKey || "",
      workspaceId: st.workspaceId || null,
      linuxUser: st.linuxUser || null,
      display: st.display || 0,
      rfbPort: st.rfbPort || 0,
      cdpPort: st.cdpPort || 0,
      supervisorPid: st.supervisorPid || null,
      startedAt: st.startedAt || 0,
      restarts: st.restarts || 0,
      sandboxDir: dir,
      policyFile: st.policyFile || null,
      profileDir: st.profileDir || "",
      downloadsDir: st.downloadsDir || "",
    }
    registry().set(id, entry)
    return entry
  } catch {
    return null
  }
}

export function embeddedSandboxAlive(entry: EmbeddedSandboxEntry): boolean {
  return procAlive(entry.supervisorPid)
}

export async function embeddedSandboxStats(id: string): Promise<{ cpuPct: number; memMb: number; netRxMb: number; netTxMb: number; uptimeSec: number; restarts: number } | null> {
  const entry = await embeddedSandbox(id)
  if (!entry || !procAlive(entry.supervisorPid)) return null
  // 真实 /proc 采样：监督树整体（含 chromium/Xvfb/x11vnc 子进程按 cgroup 汇聚成本高，
  // 以 chromium 主进程 + 监督 RSS 近似代表沙箱负载）
  const pid = entry.supervisorPid!
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8")
    const rss = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] || 0) / 1024
    const statm = await readFile(`/proc/${pid}/statm`, "utf8")
    const pages = Number(statm.split(" ")[1] || 0)
    const pageSize = 4096
    // CPU：utime+stime（含已收割子进程）相对运行时长 → 近似占用率
    const statRaw = await readFile(`/proc/${pid}/stat`, "utf8")
    const rest = statRaw.slice(statRaw.lastIndexOf(")") + 2).trim().split(" ")
    const utime = Number(rest[11] || 0) + Number(rest[12] || 0) // utime+stime（jiffies，含子进程字段紧随其后）
    const cutime = Number(rest[13] || 0) + Number(rest[14] || 0)
    const hz = 100
    const cpuSec = (utime + cutime) / hz
    const uptimeSec = Math.max(1, Math.round((Date.now() - entry.startedAt) / 1000))
    // chromium 主进程 PID（state.json chromePid）
    let chromeRss = 0
    try {
      const st = JSON.parse(await readFile(join(entry.sandboxDir, "state.json"), "utf8")) as { chromePid?: number }
      if (st.chromePid && procAlive(st.chromePid)) {
        const cs = await readFile(`/proc/${st.chromePid}/status`, "utf8")
        chromeRss = Number(/VmRSS:\s+(\d+) kB/.exec(cs)?.[1] || 0) / 1024
      }
    } catch {
      /* ignore */
    }
    return {
      cpuPct: Math.round((cpuSec / uptimeSec) * 100 * 1000) / 1000,
      memMb: Math.round((rss + chromeRss) * 1000) / 1000,
      netRxMb: 0,
      netTxMb: 0,
      uptimeSec,
      restarts: entry.restarts,
    }
  } catch {
    return null
  }
}

export async function embeddedSandboxLogs(id: string, tail = 200): Promise<string[]> {
  const entry = await embeddedSandbox(id)
  if (!entry) return []
  try {
    const raw = await readFile(join(entry.sandboxDir, "logs", "supervisor.log"), "utf8")
    return raw.split("\n").filter(Boolean).slice(-tail)
  } catch {
    return []
  }
}

// USR1 → 监督脚本杀浏览器子进程 → 主循环 1 秒内同一 Profile 拉起（策略重读）
export async function restartEmbeddedBrowser(id: string): Promise<{ restarted: boolean }> {
  const entry = await embeddedSandbox(id)
  if (!entry || !procAlive(entry.supervisorPid)) return { restarted: false }
  try {
    process.kill(entry.supervisorPid!, "SIGUSR1")
    return { restarted: true }
  } catch {
    return { restarted: false }
  }
}

// 停止：SIGTERM 监督（脚本 trap 后级联终止 chromium/x11vnc/Xvfb）；保留 Profile/策略文件
export async function stopEmbeddedSandbox(id: string): Promise<boolean> {
  const entry = await embeddedSandbox(id)
  if (!entry) return true
  if (procAlive(entry.supervisorPid)) {
    try {
      process.kill(entry.supervisorPid!, "SIGTERM")
    } catch {
      /* 已退出 */
    }
    // 等待优雅退出（最多 10s）
    for (let i = 0; i < 40 && procAlive(entry.supervisorPid); i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (procAlive(entry.supervisorPid)) {
      try {
        process.kill(entry.supervisorPid!, "SIGKILL")
      } catch {
        /* ignore */
      }
    }
  }
  registry().delete(id)
  return true
}

// 销毁：停止 + 清理沙箱运行目录（Profile 持久目录按回收站策略另管）
export async function destroyEmbeddedSandbox(id: string): Promise<boolean> {
  await stopEmbeddedSandbox(id)
  const dir = join(sandboxRoot(), id)
  await rm(dir, { recursive: true, force: true }).catch(() => null)
  return true
}

// ============================================================
// sing-box 嵌入式进程模式（同容器进程替代外部容器；无 UDP：出入均为 TCP socks）
// ============================================================

export interface EmbeddedProcessEntry {
  id: string
  name: string
  pid: number | null
  configPath: string
  logPath: string
  startedAt: number
  memLimitMb: number
}

const gp = globalThis as unknown as { __dyEmbeddedProcs?: Map<string, EmbeddedProcessEntry> }

function procRegistry(): Map<string, EmbeddedProcessEntry> {
  if (!gp.__dyEmbeddedProcs) gp.__dyEmbeddedProcs = new Map()
  return gp.__dyEmbeddedProcs
}

// sing-box 运行时是否可用（单容器形态；未配置 DOCKER_API_URL 时启用）
export function embeddedSingboxAvailable(): boolean {
  return !!embeddedBinaries().singbox && !ENV.dockerApiUrl
}

export async function createEmbeddedProcess(opts: {
  name: string
  configJson: string
  memLimitMb?: number
  pidsLimit?: number
}): Promise<{ id: string; pid: number | null }> {
  const bin = embeddedBinaries().singbox!
  const id = "sbx-" + randomUUID().replace(/-/g, "").slice(0, 12)
  const dir = join(sandboxRoot(), "singbox")
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, `${id}.json`)
  const logPath = join(dir, `${id}.log`)
  await writeFile(configPath, opts.configJson, { mode: 0o600 })
  const memMb = Math.max(64, opts.memLimitMb ?? 256)
  const jsHeap = Math.max(64, Math.floor(memMb / 2))
  const child = spawn(bin, ["run", "-D", join(dir, `${id}.work`), "-c", configPath], {
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", fs.openSync(logPath, "a"), fs.openSync(logPath, "a")],
  })
  child.unref()
  procRegistry().set(id, {
    id,
    name: opts.name,
    pid: child.pid ?? null,
    configPath,
    logPath,
    startedAt: Date.now(),
    memLimitMb: memMb,
  })
  await new Promise((r) => setTimeout(r, 600))
  return { id, pid: child.pid ?? null }
}

export function embeddedProcessEntry(id: string): EmbeddedProcessEntry | null {
  return procRegistry().get(id) || null
}

export async function embeddedProcessInfo(id: string): Promise<{ state: string } | null> {
  const e = procRegistry().get(id)
  if (!e) return null
  return { state: procAlive(e.pid) ? "running" : "exited" }
}

export async function stopEmbeddedProcess(id: string): Promise<boolean> {
  const e = procRegistry().get(id)
  if (!e) return true
  if (procAlive(e.pid)) {
    try {
      process.kill(e.pid!, "SIGTERM")
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 20 && procAlive(e.pid); i++) await new Promise((r) => setTimeout(r, 200))
    if (procAlive(e.pid)) {
      try {
        process.kill(e.pid!, "SIGKILL")
      } catch {
        /* ignore */
      }
    }
  }
  procRegistry().delete(id)
  return true
}

export async function signalEmbeddedProcess(id: string, signal: string): Promise<boolean> {
  const e = procRegistry().get(id)
  if (!e || !procAlive(e.pid)) return false
  try {
    process.kill(e.pid!, signal === "SIGHUP" ? "SIGHUP" : signal)
    return true
  } catch {
    return false
  }
}

export async function embeddedProcessStats(id: string): Promise<{ cpuPct: number; memMb: number; netRxMb: number; netTxMb: number } | null> {
  const e = procRegistry().get(id)
  if (!e || !procAlive(e.pid)) return null
  try {
    const status = await readFile(`/proc/${e.pid}/status`, "utf8")
    const rss = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] || 0) / 1024
    return { cpuPct: 0, memMb: Math.round(rss * 1000) / 1000, netRxMb: 0, netTxMb: 0 }
  } catch {
    return null
  }
}

export async function embeddedProcessLogs(id: string, tail = 200): Promise<string[]> {
  const e = procRegistry().get(id)
  if (!e) return []
  try {
    const raw = await readFile(e.logPath, "utf8")
    return raw.split("\n").filter(Boolean).slice(-tail)
  } catch {
    return []
  }
}

export async function removeEmbeddedProcess(id: string): Promise<boolean> {
  await stopEmbeddedProcess(id)
  const e = procRegistry().get(id)
  // stopEmbeddedProcess 已删除注册表项；这里兜底清理文件
  try {
    const dir = join(sandboxRoot(), "singbox")
    await rm(join(dir, `${id}.json`), { force: true })
    await rm(join(dir, `${id}.log`), { force: true })
    await rm(join(dir, `${id}.work`), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  return true
}

// 开发环境：手动注入二进制路径（解包 deb 后的真实 QA）
export function devInjectBinaries(opts: { chrome?: string; xvfb?: string; x11vnc?: string; singbox?: string }) {
  if (opts.chrome) BIN_CANDIDATES.chrome.unshift(opts.chrome)
  if (opts.xvfb) BIN_CANDIDATES.xvfb.unshift(opts.xvfb)
  if (opts.x11vnc) BIN_CANDIDATES.x11vnc.unshift(opts.x11vnc)
  if (opts.singbox) BIN_CANDIDATES.singbox.unshift(opts.singbox)
  binCache = null
  modeCache = null
}
