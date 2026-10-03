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
//     700 权限互不可读；prlimit --nproc 按 UID 生效（进程数硬上限）——
//     仅独立用户形态启用；同用户模式跳过（见 createEmbeddedSandbox nproc 语义注释）
//   · 监督循环：浏览器任何形式退出（关闭窗口/崩溃/OOM/被杀）1 秒内同一 Profile 拉起
//   · USR1 → 浏览器进程级重启（策略刷新后即时生效通道，与容器模式语义一致）
//   · 状态落盘 state.json —— 平台重启后自动重新收养（re-adopt）存活沙箱
// ============================================================

import { spawn, spawnSync } from "child_process"
import net from "net"
import fs from "fs"
import { mkdir, readFile, writeFile, rm, readdir, stat, access, lstat, readlink } from "fs/promises"
import { join, dirname } from "path"
import { randomUUID } from "crypto"
import { ENV } from "./env"
import { EMBEDDED_CDP_PORT_RANGE, EMBEDDED_RFB_PORT_RANGE } from "./network-policy"
import type { BrowserHardeningInfo } from "./external/docker"

// ============================================================
// 运行时形态解析（BROWSER_RUNTIME=auto|embedded|docker|pool）
// ============================================================

export type BrowserRuntimeMode = "embedded" | "docker" | "pool" | "sim" | "external"

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
// r14 新增 external：EXTERNAL_BROWSER_URL 填写 → 外部浏览器分离部署形态
//   （浏览器镜像独立部署，平台只连接不编排；未填写 → 默认单容器内嵌）
export function resolveBrowserRuntimeMode(): { mode: BrowserRuntimeMode; reason: string } {
  if (modeCache) return modeCache
  const forced = (process.env.BROWSER_RUNTIME || "auto").toLowerCase()
  const bins = embeddedBinaries()
  const browserReady = !!(bins.chrome && bins.xvfb && bins.x11vnc)
  if (forced === "external") {
    modeCache = ENV.externalBrowserUrl
      ? { mode: "external", reason: "BROWSER_RUNTIME=external（外部浏览器分离部署）" }
      : { mode: "sim", reason: "BROWSER_RUNTIME=external 但 EXTERNAL_BROWSER_URL 未配置 → 演示模式" }
    return modeCache
  }
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
  // auto：外部浏览器地址显式填写 → 分离部署形态优先（用户显式配置优先于内嵌；
  // 未填写时默认单容器内嵌，零外部依赖）
  if (ENV.externalBrowserUrl) {
    modeCache = { mode: "external", reason: "auto：EXTERNAL_BROWSER_URL 已配置 → 外部浏览器分离部署" }
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
// Linux 沙箱用户（r24-e：每沙箱一个独立用户 dyu-<uuid8>-<uname6>）
//
// 架构（自研单容器多用户模型）：
//   · 后台（平台进程）以 root 运行；每个沙箱浏览器进程树以【沙箱专属用户】运行
//     —— 名字 = dyu-<工作区UUID前8位>-<所有者用户名前6位>，同一用户的不同沙箱
//     也是不同 Linux 账户 → Profile/下载/家目录 700 互不可读（即使同容器）；
//     仅 root（管理后台）可访问全部目录。
//   · UID 台账（storage/system/sandbox-users.json，随存储卷持久化）：
//     容器重建（/etc/passwd 重置但存储卷保留）时按台账原 UID 复活用户，
//     存储卷上既有文件属主零冲突；台账丢失时收养 passwd 现有 UID 反写台账。
//   · 非 root 环境（开发）：降级为同用户模式（隔离语义降级，进程链路不变）。
// ============================================================

// 兼容旧命名（每平台用户一个）：r24 之前的已收养沙箱仍以此名存在
function linuxUserFor(userId: string): string {
  return "dyu-" + Buffer.from(userId).toString("hex").slice(0, 8)
}

// r24-e：沙箱用户名（工作区 UUID + 所有者用户名 → Linux 账户名）
export function sandboxLinuxUserName(workspaceUuid: string, ownerUsername: string): string {
  const u8 = workspaceUuid.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8).padEnd(8, "0")
  const uname = (ownerUsername || "u").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "u"
  return `dyu-${u8}-${uname}` // ≤19 字符，Linux 用户名 32 上限内
}

// ---- UID 台账（持久化：容器重建后按原 UID 复活用户，属主零冲突）----
interface SandboxUserLedger {
  users: Record<string, { uid: number; workspaceUuid?: string; owner?: string; createdAt: number }>
  nextUid: number
}
const UID_MIN = 20000
const UID_MAX = 60000

function ledgerPath(): string {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "system", "sandbox-users.json")
}

const gLedger = globalThis as unknown as { __dySandboxUserLedgerOp?: Promise<unknown> }

function ledgerMutex<T>(op: () => Promise<T>): Promise<T> {
  const prev = gLedger.__dySandboxUserLedgerOp ?? Promise.resolve()
  const next = prev.then(op, op)
  gLedger.__dySandboxUserLedgerOp = next.catch(() => null)
  return next
}

async function loadLedger(): Promise<SandboxUserLedger> {
  try {
    const raw = await readFile(ledgerPath(), "utf8")
    const l = JSON.parse(raw) as SandboxUserLedger
    if (!l.users || typeof l.nextUid !== "number") throw new Error("bad ledger")
    if (l.nextUid < UID_MIN) l.nextUid = UID_MIN
    return l
  } catch {
    return { users: {}, nextUid: UID_MIN }
  }
}

async function saveLedger(l: SandboxUserLedger): Promise<void> {
  await mkdir(dirname(ledgerPath()), { recursive: true })
  // 0600 + 原子写（临时文件 + rename）：台账含用户映射，防半写损坏
  const tmp = `${ledgerPath()}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(l, null, 1), { mode: 0o600 })
  await fs.promises.rename(tmp, ledgerPath())
}

// passwd 现有 UID 查询（不存在返回 null）
function passwdUidOf(name: string): number | null {
  try {
    const s = fs.readFileSync("/etc/passwd", "utf8")
    const line = s.split("\n").find((l) => l.startsWith(`${name}:`))
    if (!line) return null
    const uid = Number(line.split(":")[2])
    return Number.isFinite(uid) && uid >= 1000 ? uid : null
  } catch {
    return null
  }
}

// 通用：按名确保用户存在（台账 UID 复活 / 新分配）；返回 null=不可用（非 root）
async function ensureUserByName(name: string, homeDir: string, meta?: { workspaceUuid?: string; owner?: string }): Promise<string | null> {
  const uid = process.getuid?.() ?? 0
  if (uid !== 0) return null // 非 root（开发环境）：同用户模式，隔离降级（真实进程链路不受影响）
  return ledgerMutex(async () => {
    try {
      const l = await loadLedger()
      const existing = passwdUidOf(name)
      if (existing != null) {
        // 用户已在（passwd 为权威）：台账缺失 → 收养反写；台账不一致 → 以 passwd 为准（文件属主既成事实）
        if (!l.users[name] || l.users[name].uid !== existing) {
          l.users[name] = { ...l.users[name], uid: existing, ...(meta || {}), createdAt: l.users[name]?.createdAt ?? Date.now() }
          await saveLedger(l)
        }
        return name
      }
      // 用户不在 passwd：
      //   a) 台账有 → 容器重建场景：按原 UID 复活（存储卷属主一致零冲突）
      //   b) 台账无 → 分配新 UID
      let targetUid = l.users[name]?.uid
      if (targetUid == null) {
        if (l.nextUid > UID_MAX) throw new Error("沙箱用户 UID 池耗尽（20000-60000）")
        targetUid = l.nextUid
        l.nextUid += 1
      }
      await mkdir(dirname(homeDir), { recursive: true })
      // -M：home 目录由存储卷统一管理（启动脚本按需创建归属）；-u 固定 UID
      let r = spawnSync("useradd", ["-M", "-d", homeDir, "-s", "/bin/sh", "-u", String(targetUid), name], { timeout: 10_000 })
      if (r.status !== 0) {
        // UID 被占用（台账与 passwd 脱同步的边角）：换新 UID 重试并记台账（属主修正由启动 chown 兜底）
        const alt = l.nextUid
        if (alt > UID_MAX) throw new Error("沙箱用户 UID 池耗尽（20000-60000）")
        r = spawnSync("useradd", ["-M", "-d", homeDir, "-s", "/bin/sh", "-u", String(alt), name], { timeout: 10_000 })
        if (r.status !== 0) return null
        targetUid = alt
        l.nextUid = alt + 1
      } else if (!l.users[name]) {
        l.nextUid = Math.max(l.nextUid, targetUid + 1)
      }
      l.users[name] = { uid: targetUid, ...(meta || {}), createdAt: l.users[name]?.createdAt ?? Date.now() }
      await saveLedger(l)
      return name
    } catch {
      return null
    }
  })
}

// r24-e：确保沙箱专属用户（工作区 UUID + 所有者用户名命名）
export async function ensureSandboxLinuxUser(workspaceUuid: string, ownerUsername: string): Promise<string | null> {
  const name = sandboxLinuxUserName(workspaceUuid, ownerUsername)
  const home = join(ENV.storageLocalPath.replace(/\/$/, ""), "homes", name)
  return ensureUserByName(name, home, { workspaceUuid, owner: ownerUsername })
}

// 兼容：每平台用户一个的旧方案（无 workspaceUuid 场景 / 旧沙箱收养）
async function ensureLinuxUser(userId: string): Promise<string | null> {
  const name = linuxUserFor(userId)
  const home = join(ENV.storageLocalPath.replace(/\/$/, ""), "homes", name)
  return ensureUserByName(name, home)
}

// 收养路径：按 state.json 的 linuxUser 复活用户（容器重建后；UID 台账优先）
async function ensureAdoptedUser(name: string, homeDir: string): Promise<string | null> {
  if (!name) return null
  return ensureUserByName(name, homeDir || join(ENV.storageLocalPath.replace(/\/$/, ""), "homes", name))
}

// ---- 账户信息查询（管理端展示：沙箱 ↔ Linux 账户 ↔ UID 映射）----
export function sandboxUserLedgerInfo(): Promise<{ users: { name: string; uid: number; workspaceUuid?: string; owner?: string; alive: boolean }[]; nextUid: number }> {
  return ledgerMutex(async () => {
    const l = await loadLedger()
    const users = Object.entries(l.users).map(([name, v]) => ({
      name,
      uid: v.uid,
      workspaceUuid: v.workspaceUuid,
      owner: v.owner,
      alive: passwdUidOf(name) != null,
    }))
    users.sort((a, b) => a.uid - b.uid)
    return { users, nextUid: l.nextUid }
  })
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
      // r24-e：容器重建场景——passwd 已重置但监督树仍在（存储卷持久）→
      // 按台账原 UID 复活沙箱专用用户（属主零冲突；监督进程仍以原 uid 运行不受影响）
      if (st.linuxUser && passwdUidOf(st.linuxUser) == null) {
        const home = join(ENV.storageLocalPath.replace(/\/$/, ""), "homes", st.linuxUser)
        await ensureAdoptedUser(st.linuxUser, home).catch(() => null)
      }
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
  imeEngine?: string | null // r24-c：启动即应用偏好输入法（fcitx5 引擎名，如 pinyin）
  kbLayout?: string | null // r24-c：启动即应用键盘布局（xkb 布局名，如 us/cn）
  clipboardEnabled?: boolean // r24-d：剪贴板策略（false=x11vnc -nosel -noclipboard，X 剪贴板不透传 VNC 端）
  workspaceUuid?: string | null // r24-e：工作区 UUID（沙箱专属 Linux 用户命名）
  ownerUsername?: string | null // r24-e：所有者用户名（沙箱专属 Linux 用户命名）
  // —— r27 ——
  exitGuard?: "normal" | "fullscreen" | "kiosk" // 防退出档位（模板/全局默认解析）
  fakeCamImage?: string | null // r29-e：虚拟摄像头恒定帧图片（沙箱内绝对路径；null=关闭）
  recording?: { enabled: boolean; fps: number; segmentSec: number; maxSec: number } // 会话录像（策略四级链命中后由业务层解析传入）
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
  recording?: { recordDir: string; fps: number; segmentSec: number; maxSec: number } | null // r27：录像下发参数（业务层据此注册会话）
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
    pidsLimit: linuxUser ? (spec.pidsLimit ?? 256) : 0, // 0 = 同用户模式已跳过 nproc（UID 共享计数不可用）
    pidsLimitMode: linuxUser ? ("prlimit-uid" as const) : ("skipped-shared-uid" as const),
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
    // —— r27 快照 ——
    recordingEnabled: !!spec.recording?.enabled,
    exitGuard: spec.exitGuard || "normal",
  } as BrowserHardeningInfo
}

function resolutionArgs(res: string): string[] {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(res || "")
  if (!m) return ["--window-size=1280,800"]
  return ["--window-position=0,0", `--window-size=${m[1]},${m[2]}`]
}

// r27-e：防退出档位 → chromium 启动参数（无 WM 环境，标题栏关闭/最小化按钮本就不存在）
//   normal    —— 现状（ExitWarningBubble 保持禁用，行为与历史一致）
//   fullscreen —— 全屏守卫：--start-fullscreen + 错误弹窗抑制 + Ctrl+Q 长按确认
//   kiosk     —— 信息亭最强档：--kiosk（无地址栏/无菜单 → 「更多菜单→退出」入口物理不存在）
// 任何档位下浏览器进程退出都由 supervisor 死循环 1s 同 Profile 拉起（终极兑底）
function exitGuardArgs(guard?: string): { args: string; features: string } {
  const g = guard || "normal"
  if (g === "kiosk") {
    return { args: "--kiosk --noerrdialogs --disable-infobars", features: "--enable-features=ExitWarningBubble" }
  }
  if (g === "fullscreen") {
    return { args: "--start-fullscreen --noerrdialogs", features: "--enable-features=ExitWarningBubble" }
  }
  return { args: "", features: "--disable-features=ExitWarningBubble" }
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
  // r25-d：前 2 秒 100ms 密集探测（x11vnc 正常 <1s 就绪）；随后 250ms 常规节奏
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!(await tcpProbe(port))) return true // 能连上 = x11vnc 已就绪
    await new Promise((r) => setTimeout(r, Date.now() - t0 < 2000 ? 100 : 250))
  }
  return false
}

// ---- r25-d 磁盘余量检查（启动前自检：空间不足直接拒绝，避免半途失败产生半残树） ----
function diskFreeMb(path: string): number | null {
  try {
    const r = spawnSync("df", ["-P", path], { timeout: 5_000 })
    if (r.status !== 0 || !r.stdout) return null
    const lines = String(r.stdout).split("\n")
    const cols = lines[1]?.trim().split(/\s+/)
    if (!cols || cols.length < 4) return null
    const kb = Number(cols[3])
    return Number.isFinite(kb) ? Math.round(kb / 1024) : null
  } catch {
    return null
  }
}

// ---- r25-d 陈旧 Chromium 单例锁清理 ----
// Profile 目录下的 SingletonLock/SingletonCookie/SingletonSocket 是指向 "<hostname>-<pid>"
// 的符号链接；容器重启/平台重启后旧 chromium 已死，但锁残留会让 Chromium 启动卡在
// 实例冲突分支（或反复重启）。仅当目标 pid 已死时移除（活锁不动，避免误伤并发会话）。
async function cleanStaleProfileLocks(profileDir: string): Promise<void> {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = join(profileDir, f)
    try {
      const l = await lstat(p)
      if (l.isSymbolicLink()) {
        const target = await readlink(p)
        const pid = Number(target.split("-").pop())
        if (!Number.isFinite(pid) || !procAlive(pid)) await rm(p, { force: true })
      } else {
        // 非符号链接形态 = 崩溃残留（正常应为符号链接），直接清理
        await rm(p, { force: true })
      }
    } catch {
      /* 不存在 → 无锁，跳过 */
    }
  }
}

// 每工作区在途互斥（r25-d：双击启动/并发请求不会创建两棵重复进程树）
const gStart = globalThis as unknown as { __dySandboxStartLock?: Map<string, Promise<EmbeddedSandboxHandle>> }

function handleFromEntry(entry: EmbeddedSandboxEntry, spec: EmbeddedSandboxSpec): EmbeddedSandboxHandle {
  return {
    id: entry.id,
    name: entry.id,
    rfb: { host: "127.0.0.1", port: entry.rfbPort },
    cdpPort: entry.cdpPort,
    display: entry.display,
    linuxUser: entry.linuxUser,
    simulated: false as const,
    hardening: embeddedHardeningSummary(spec, entry.linuxUser),
    recording: null, // 复用句柄（幂等）：录像由首次创建会话注册，不重复建档
  }
}

// ============================================================
// 沙箱创建（r25-d 零出错加固版）
// 主入口幂等 + 并发去重 + 三次重试 + 结构化诊断：
//   1. 同一工作区已有存活进程树 → 直接复用（绝不重复创建）
//   2. 同一工作区并发启动请求 → 共享同一次在途 Promise
//   3. 单次尝试失败（显示冲突/端口抢占/x11vnc 未就绪）→ 换新显示号/新端口自动重试
//   4. 三次均失败 → 汇总各次日志尾部 + 自检结论给出可操作错误信息
// ============================================================
export async function createEmbeddedSandbox(spec: EmbeddedSandboxSpec): Promise<EmbeddedSandboxHandle> {
  // ---- 幂等复用：同工作区健康树直接返回（启动重试/双击零重复）----
  if (spec.workspaceId) {
    await adoptEmbeddedSandboxes().catch(() => null)
    for (const e of registry().values()) {
      if (e.workspaceId === spec.workspaceId && embeddedSandboxAlive(e)) {
        return handleFromEntry(e, spec)
      }
    }
    // ---- 并发去重：同工作区在途创建共享同一 Promise ----
    const locks = (gStart.__dySandboxStartLock ??= new Map())
    const key = `ws:${spec.workspaceId}`
    const inFlight = locks.get(key)
    if (inFlight) return inFlight
    const p = createWithRetry(spec).finally(() => locks.delete(key))
    locks.set(key, p)
    return p
  }
  return createWithRetry(spec)
}

// 三次重试 + 结构化诊断（r25-d）
async function createWithRetry(spec: EmbeddedSandboxSpec): Promise<EmbeddedSandboxHandle> {
  const storage = ENV.storageLocalPath.replace(/\/$/, "")
  // 启动前磁盘自检（<200MB 直接拒绝，避免半途磁盘写满产生半残树）
  const freeMb = diskFreeMb(storage)
  if (freeMb != null && freeMb < 200) {
    throw new Error(`存储空间不足（剩余 ${freeMb}MB，沙箱启动需至少 200MB）：请清理文件存储/旧沙箱目录后重试`)
  }

  const attemptTails: string[] = []
  let lastErr = ""
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await attemptCreateEmbeddedSandbox(spec, attempt)
    } catch (e) {
      lastErr = (e as Error).message || String(e)
      attemptTails.push(`第 ${attempt} 次：${lastErr}`)
      // 容量类失败重试无意义（显示号/端口池耗尽）→ 直接汇总报错
      if (lastErr.includes("无可用虚拟显示编号") || lastErr.includes("无可用端口") || lastErr.includes("存储空间不足")) break
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt))
    }
  }
  // 结构化诊断：三次失败根因汇总 + 可操作建议（用户可看懂、管理员可排查）
  const hints: string[] = []
  if (/显示|display|Xvfb/i.test(lastErr)) hints.push("虚拟显示冲突（已自动换号重试 3 次仍失败）：请检查 /tmp/.X*-lock 残留")
  if (/x11vnc/i.test(lastErr)) hints.push("x11vnc 未就绪：请查看 storage/sandboxes/<id>/logs/x11vnc.log 与 supervisor.log")
  if (/权限|Permission|denied/i.test(lastErr)) hints.push("目录权限问题：容器需以 root 运行（沙箱目录 700 归属沙箱专用用户）")
  if (/组件缺失|chromium/i.test(lastErr)) hints.push("浏览器组件缺失：请检查镜像内 chromium/xvfb/x11vnc 安装完整")
  if (hints.length === 0) hints.push("请查看 storage/sandboxes/<沙箱ID>/logs/ 下 supervisor.log / x11vnc.log / chromium.log 排查")
  throw new Error(`沙箱启动失败（已自动重试 3 次）\n${attemptTails.join("\n")}\n排查建议：${hints.join("；")}`)
}

// 单次创建尝试（原主流程；每次重试均重新分配显示号/端口）
async function attemptCreateEmbeddedSandbox(spec: EmbeddedSandboxSpec, attempt: number): Promise<EmbeddedSandboxHandle> {
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
  // r25-d：清理陈旧 Chromium 单例锁（旧进程已死的 Singleton* 符号链接）
  // ——避免 Chromium 启动卡在实例冲突分支导致沙箱反复自愈循环
  await cleanStaleProfileLocks(profileDir).catch(() => null)

  const [display, rfbPort, cdpPort] = await Promise.all([allocateDisplay(), allocatePort(RFB_PORT_BASE), allocatePort(CDP_PORT_BASE)])
  // r24-e：优先每沙箱专属用户（dyu-<uuid8>-<uname6>）；无 UUID 场景回退每平台用户（兼容）
  const linuxUser = spec.workspaceUuid && spec.ownerUsername
    ? await ensureSandboxLinuxUser(spec.workspaceUuid, spec.ownerUsername)
    : await ensureLinuxUser(spec.userId)

  const resolution = spec.resolution || "1280x800"
  const pidsLimit = Math.max(64, Math.min(1024, spec.pidsLimit ?? 256))
  const memLimitMb = Math.max(256, spec.memLimitMb ?? 1024)
  const jsHeapMb = Math.max(128, Math.floor(memLimitMb / 2))

  // ---- 生成每沙箱 chromium 内层启动脚本（unshare -Urm 挂载命名空间内执行）----
  // bind 挂载每沙箱策略文件 → /etc/chromium/policies/managed/dockyard.json
  //（视图仅本进程树可见；宿主与其他沙箱不受影响，见文件头注释）
  //
  // 【nproc 语义修正（根因修复）】prlimit --nproc=<N> 按【UID】计数进程数：
  //   · 独立用户形态（容器内 dyu-<hash> 专用用户）：上限仅作用于该沙箱专用用户，语义正确；
  //   · 同用户模式（非 root 开发环境 / useradd 降级）：平台进程（dev 服务器、
  //     ws-hub、vnc-bridge 等）与沙箱共享同一 UID —— nproc 会把整个 UID 的
  //     全部进程计入上限，导致 chromium fork 失败 → 监督循环崩溃拉起死循环。
  //     此形态跳过 nproc（进程数隔离降级），资源面由内存上限
  //     （js-flags max-old-space-size + memLimitMb）兜底。
  const nprocExec = linuxUser
    ? `exec prlimit --nproc=${pidsLimit} --`
    : `# 同用户模式：跳过 prlimit --nproc（按 UID 计数会把平台共享进程计入上限）\n# 资源面由内存上限（js-flags max-old-space-size）兜底\nexec`
  const proxyArgs = spec.proxyUrl ? `--proxy-server=${spec.proxyUrl}` : ""
  // r27-e：防退出档位参数（fullscreen/kiosk 档 ExitWarningBubble 保持启用 → Ctrl+Q 需长按确认）
  const guard = exitGuardArgs(spec.exitGuard)
  // r27：录像参数（策略命中 → 进程树内 ffmpeg 分段录像；目录随 spec 预建并下发）
  const recordDir = spec.recording?.enabled
    ? join(storage, "recordings", spec.userId, id)
    : null
  if (recordDir) await mkdir(recordDir, { recursive: true }).catch(() => null)
  const recordEnv = spec.recording?.enabled
    ? {
        DY_RECORD_DIR: recordDir!,
        DY_RECORD_FPS: String(spec.recording.fps),
        DY_RECORD_SEGSEC: String(spec.recording.segmentSec),
        DY_RECORD_MAXSEC: String(spec.recording.maxSec || 0),
        DY_RECORD_SIZE: resolution,
      }
    : {}
  // r24-c：输入法环境（XIM/fcitx 通道；fcitx5 由监督脚本拉起，作用域=本沙箱显示）
  const imeEnv = `export XMODIFIERS="@im=fcitx"
export GTK_IM_MODULE="fcitx"
export QT_IM_MODULE="fcitx"
export SDL_IM_MODULE="fcitx"`
  const inner = `#!/bin/sh
# 由嵌入式沙箱引擎生成（沙箱 ${id}）
${imeEnv}
DY_POLICY_FILE="\${DY_POLICY_FILE:-}"
if [ -n "$DY_POLICY_FILE" ] && [ -f "$DY_POLICY_FILE" ]; then
  if [ -e /etc/chromium/policies/managed/dockyard.json ]; then
    mount --bind "$DY_POLICY_FILE" /etc/chromium/policies/managed/dockyard.json 2>>"$DY_LOG_DIR/policy.log" \\
      || echo "[emb] WARN: 策略挂载不可用（挂载命名空间受限）→ 以全局基线运行" >>"$DY_LOG_DIR/policy.log"
  else
    echo "[emb] WARN: /etc/chromium/policies/managed/dockyard.json 不存在 → 以全局基线运行" >>"$DY_LOG_DIR/policy.log"
  fi
fi
# r28: Chromium process-level sandbox enabled by default (renderer zero-syscall; virus page cannot read any local file).
# DY_CHROME_NOSANDBOX=1 -> fallback (auto-set once by outer supervisor on sandbox startup failure).
SANDBOX_FLAG=""
if [ "\${DY_CHROME_NOSANDBOX:-0}" = "1" ]; then SANDBOX_FLAG="--no-sandbox"; fi
# __DY_FAKE_CAM_BEGIN__
# r29-e: 虚拟摄像头（恒定帧注入）—— DY_FAKE_CAM_IMAGE 指向图片时启用
FAKE_CAM_FLAGS=""
if [ -n "\${DY_FAKE_CAM_IMAGE:-}" ] && [ -f "\${DY_FAKE_CAM_IMAGE}" ]; then
  FAKE_CAM_FLAGS="--use-fake-device-for-media-stream --use-file-for-fake-video-capture=\${DY_FAKE_CAM_IMAGE}"
fi
# __DY_FAKE_CAM_END__
${nprocExec} "${bins.chrome}" \\
  --user-data-dir="\${DY_PROFILE_DIR}" \\
  \${FAKE_CAM_FLAGS} \\
  \${SANDBOX_FLAG} --disable-gpu --no-first-run \\
  --disable-session-crashed-bubble --hide-crash-restore-bubble \\
  --restore-last-session ${resolutionArgs(resolution).join(" ")} ${guard.args} \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} \\
  --download.default_directory="\${DY_DOWNLOADS_DIR}" \\
  ${guard.features} --disable-dev-shm-usage \\
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
      // r24-e：沙箱身份标识（审计/台账追溯）
      DY_WORKSPACE_UUID: spec.workspaceUuid || "",
      DY_OWNER_USERNAME: spec.ownerUsername || "",
      // r24-c：输入法偏好（监督脚本 start_ime 后应用：fcitx5-remote -s / setxkbmap）
      DY_IME_ENGINE: spec.imeEngine || "",
      DY_KB_LAYOUT: spec.kbLayout || "",
      // r24-d：剪贴板策略（false → x11vnc 关闭 X 剪贴板向 VNC 端透传）
      DY_CLIPBOARD: spec.clipboardEnabled === false ? "0" : "1",
      // r27：录像下发（进程树内 ffmpeg 分段落盘）+ 防退出档位
      ...(recordEnv as Record<string, string>),
      DY_EXIT_GUARD: spec.exitGuard || "normal",
      // r29-e：虚拟摄像头恒定帧（重建/重启链路保持生效）
      ...(spec.fakeCamImage ? { DY_FAKE_CAM_IMAGE: spec.fakeCamImage } : {}),
    },
    detached: true, // 脱离平台进程组：平台重启不牵连沙箱（state.json 重新收养）
    stdio: ["ignore", fs.openSync(join(logDir, "supervisor.log"), "a"), fs.openSync(join(logDir, "supervisor.log"), "a")],
  })
  child.unref()

  // r25-d：首试给予更长就绪窗口（冷启动负载下 Xvfb+x11vnc 链路可能较慢）；重试轮缩短
  const ok = await waitRfbUp(rfbPort, attempt === 1 ? 30000 : 20000)
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
    recording: recordDir && spec.recording?.enabled
      ? { recordDir, fps: spec.recording.fps, segmentSec: spec.recording.segmentSec, maxSec: spec.recording.maxSec }
      : null,
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
