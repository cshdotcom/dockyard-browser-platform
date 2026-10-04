// ============================================================
// r34：沙箱剪贴板真实落地通道
//
// 背景（用户报障根因）：
//   此前 /api/vnc-proxy/clipboard 为"模拟投递"（文本从未真正写入沙箱 X 剪贴板），
//   RFB 扩展剪贴板（QEMU 协议）对 x11vnc 类服务器不被支持/兼容性差 → 发送即断连。
//   用户感知：点发送/拉取 → 连接断开重连 → "什么都没传回来"。
//
// 方案（三级真实通道）：
//   1) 单容器内嵌沙箱（emb-*，All-In-One 生产形态）：平台与沙箱同容器，
//      直接以沙箱专用 Linux 用户运行 xclip（DISPLAY=:N）写入/读取 X CLIPBOARD；
//   2) 外部容器形态（docker: containerRef）：docker exec 容器内 xclip；
//   3) RFB 扩展剪贴板仅对"已确认支持"的服务器启用（客户端按服务端 caps 响应门控）。
//
// 隔离：每个沙箱独立 X 显示 → xclip 只作用于该沙箱的剪贴板，其他用户/沙箱零影响。
// ============================================================

import { spawn } from "child_process"
import { db } from "@/lib/db"
import { embeddedSandbox, embeddedSandboxAlive } from "@/lib/embedded-sandbox"

const MAX_CLIPBOARD_CHARS = 5000

export interface ClipboardChannelResult {
  ok: boolean
  channel: "embedded-xclip" | "docker-exec-xclip" | "unavailable"
  reason?: string
}

// 异步执行命令（不阻塞事件循环；超时强杀）
function runProcess(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* noop */ }
      finish(-1)
    }, opts.timeoutMs ?? 6000)
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8") })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
    child.on("error", () => { clearTimeout(timer); finish(-1) })
    child.on("close", (code) => { clearTimeout(timer); finish(code ?? -1) })
    if (opts.input !== undefined) {
      child.stdin.on("error", () => { /* EPIPE：xclip 守护形态下正常 */ })
      child.stdin.write(opts.input, "utf8")
    }
    child.stdin.end()
  })
}

// 内嵌沙箱：以沙箱专用用户运行（DISPLAY 归属一致；root 下 setpriv 降权）
async function runInEmbeddedSandbox(display: number, linuxUser: string | null, sandboxDir: string, cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: `:${display}`,
    XAUTHORITY: `${sandboxDir}/.Xauthority`,
    HOME: sandboxDir,
  }
  if (linuxUser && process.getuid?.() === 0) {
    return runProcess("setpriv", ["--reuid", linuxUser, "--regid", linuxUser, "--init-groups", "--", cmd, ...args], { env, input, timeoutMs: 6000 })
  }
  return runProcess(cmd, args, { env, input, timeoutMs: 6000 })
}

// 检测 xclip 可用性（结果缓存 60s）
let xclipAvailableCache: { value: boolean; at: number } | null = null
async function xclipAvailable(): Promise<boolean> {
  if (xclipAvailableCache && Date.now() - xclipAvailableCache.at < 60_000) return xclipAvailableCache.value
  const r = await runProcess("which", ["xclip"], { timeoutMs: 3000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }))
  const value = r.code === 0 && r.stdout.trim().length > 0
  xclipAvailableCache = { value, at: Date.now() }
  return value
}

// 解析工作区的运行时形态
async function resolveRuntime(ws: { containerRef: string | null; novncSessionId: string | null }) {
  const ref = ws.containerRef || ws.novncSessionId
  if (!ref) return { kind: "none" as const }
  if (ref.startsWith("emb-")) {
    const entry = await embeddedSandbox(ref)
    if (entry && embeddedSandboxAlive(entry)) {
      return { kind: "embedded" as const, display: entry.display, linuxUser: entry.linuxUser, sandboxDir: entry.sandboxDir }
    }
    return { kind: "none" as const }
  }
  return { kind: "docker" as const, container: ref }
}

// ============================================================
// 写入剪贴板（客户端 → 沙箱）
// ============================================================
export async function setSandboxClipboard(workspaceId: string, text: string): Promise<ClipboardChannelResult> {
  const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { containerRef: true, novncSessionId: true } })
  if (!ws) return { ok: false, channel: "unavailable", reason: "工作区不存在" }
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, MAX_CLIPBOARD_CHARS)
  if (!cleaned) return { ok: false, channel: "unavailable", reason: "内容为空" }
  const runtime = await resolveRuntime(ws)

  if (runtime.kind === "embedded") {
    if (!(await xclipAvailable())) return { ok: false, channel: "unavailable", reason: "镜像未安装 xclip（需 apt 包 xclip）" }
    // CLIPBOARD 选择区（Ctrl+V 粘贴语义）；同时写入 PRIMARY（中键粘贴语义）
    const r = await runInEmbeddedSandbox(runtime.display, runtime.linuxUser, runtime.sandboxDir, "xclip", ["-selection", "clipboard", "-in"], cleaned)
    if (r.code !== 0) {
      const r2 = await runInEmbeddedSandbox(runtime.display, runtime.linuxUser, runtime.sandboxDir, "xclip", ["-selection", "primary", "-in"], cleaned).catch(() => ({ code: -1, stdout: "", stderr: "" }))
      if (r2.code !== 0) return { ok: false, channel: "embedded-xclip", reason: `xclip 写入失败（exit=${r.code}${r.stderr ? `：${r.stderr.slice(0, 120)}` : ""}）` }
    }
    return { ok: true, channel: "embedded-xclip" }
  }

  if (runtime.kind === "docker") {
    // 外部容器形态：docker exec 容器内 xclip（浏览器镜像内 DISPLAY 由 supervisor 环境决定）
    const { dockerFetch } = await import("./external/docker")
    // 优先尝试容器默认 DISPLAY（:99 常见；浏览器镜像 supervisor 形态）
    const tryDisplays = [":99", ":0", ":1"]
    let lastErr = ""
    for (const disp of tryDisplays) {
      const execCreate = await dockerFetch(`/containers/${encodeURIComponent(runtime.container)}/exec`, {
        method: "POST",
        body: JSON.stringify({
          Cmd: ["sh", "-c", `command -v xclip >/dev/null 2>&1 && printf %s "$DY_CLIP_TEXT" | xclip -selection clipboard -in`],
          Env: [`DISPLAY=${disp}`, `DY_CLIP_TEXT=${cleaned.replace(/(["$`\\])/g, "\\$1")}`],
          AttachStdout: true, AttachStderr: true, User: "root",
        }),
      })
      if (!execCreate.ok) { lastErr = `exec create failed: HTTP ${execCreate.status}`; continue }
      const { Id } = (await execCreate.json()) as { Id: string }
      const start = await dockerFetch(`/exec/${Id}/start`, { method: "POST", body: JSON.stringify({ Detach: false, Tty: false }) })
      if (start.ok) return { ok: true, channel: "docker-exec-xclip" }
      lastErr = `exec start failed: HTTP ${start.status}`
    }
    return { ok: false, channel: "docker-exec-xclip", reason: lastErr || "容器内 xclip 不可用" }
  }

  return { ok: false, channel: "unavailable", reason: "沙箱未运行（仅运行中沙箱支持剪贴板通道）" }
}

// ============================================================
// 读取剪贴板（沙箱 → 客户端）
// ============================================================
export async function getSandboxClipboard(workspaceId: string): Promise<{ text: string | null; channel: string; reason?: string }> {
  const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { containerRef: true, novncSessionId: true } })
  if (!ws) return { text: null, channel: "unavailable", reason: "工作区不存在" }
  const runtime = await resolveRuntime(ws)

  if (runtime.kind === "embedded") {
    if (!(await xclipAvailable())) return { text: null, channel: "unavailable", reason: "镜像未安装 xclip" }
    // 优先 CLIPBOARD，回退 PRIMARY
    const r = await runInEmbeddedSandbox(runtime.display, runtime.linuxUser, runtime.sandboxDir, "xclip", ["-selection", "clipboard", "-out"])
    if (r.code === 0 && r.stdout) return { text: r.stdout.slice(0, MAX_CLIPBOARD_CHARS), channel: "embedded-xclip" }
    const r2 = await runInEmbeddedSandbox(runtime.display, runtime.linuxUser, runtime.sandboxDir, "xclip", ["-selection", "primary", "-out"]).catch(() => ({ code: -1, stdout: "", stderr: "" }))
    if (r2.code === 0 && r2.stdout) return { text: r2.stdout.slice(0, MAX_CLIPBOARD_CHARS), channel: "embedded-xclip(primary)" }
    return { text: null, channel: "embedded-xclip", reason: "沙箱剪贴板当前为空" }
  }

  if (runtime.kind === "docker") {
    const { dockerFetch } = await import("./external/docker")
    for (const disp of [":99", ":0", ":1"]) {
      const execCreate = await dockerFetch(`/containers/${encodeURIComponent(runtime.container)}/exec`, {
        method: "POST",
        body: JSON.stringify({ Cmd: ["sh", "-c", "xclip -selection clipboard -out 2>/dev/null || xclip -selection primary -out 2>/dev/null"], Env: [`DISPLAY=${disp}`], AttachStdout: true, AttachStderr: true, User: "root" }),
      }).catch(() => null)
      if (!execCreate || !execCreate.ok) continue
      const { Id } = (await execCreate.json()) as { Id: string }
      const start = await dockerFetch(`/exec/${Id}/start`, { method: "POST", body: JSON.stringify({ Detach: false, Tty: false }) })
      if (!start.ok) continue
      const body = await start.text().catch(() => "")
      if (body) return { text: body.slice(0, MAX_CLIPBOARD_CHARS), channel: "docker-exec-xclip" }
    }
    return { text: null, channel: "docker-exec-xclip", reason: "沙箱剪贴板为空或容器内无 xclip" }
  }

  return { text: null, channel: "unavailable", reason: "沙箱未运行" }
}
