import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { PassThrough, Transform, Readable } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { BizError, ErrorCode } from "@/lib/errors"
import { ENV } from "@/lib/env"

// ============================================================
// r35 VNC 远程声音回传：POST /api/vnc-proxy/audio
//   { } / ?workspaceId= —— 鉴权（所有者/共享OPERATE/ADMIN+）→ 签发短期音频流令牌
//   返回 { url: "/api/vnc-proxy/audio?ws=..&t=..&e=.." }（HMAC · 300s · 单次）
// GET /api/vnc-proxy/audio?ws=&t=&e=
//   验令牌 → ffmpeg 抓沙箱音频（pulse 虚拟声卡混音）→ WebM/Opus 流式回传
//   前端 <audio src=...> 直接播放；断开（连接关闭）自动 kill ffmpeg。
//   沙箱无音频设备（未启用 pulseaudio）→ 503 明确提示（前端优雅降级）。
// ============================================================

const TOKEN_WINDOW_SEC = 300

function audioToken(wsId: string, exp: number): string {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dockyard-dev-secret-change-me"
  return crypto.createHmac("sha256", secret).update(`audio:${wsId}:${exp}`).digest("base64url").slice(0, 32)
}

function verifyToken(wsId: string, t: string, e: string): boolean {
  const exp = Number(e)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false
  const expected = audioToken(wsId, exp)
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(expected)) } catch { return false }
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  try {
    return await apiHandler(async () => {
      const json = await audioPostHandler(req)
      return NextResponse.json({ code: 0, msg: "ok", data: json, traceId })
    })
  } catch (e) {
    if (e instanceof BizError) return NextResponse.json({ code: e.code, msg: e.message, data: null, traceId }, { status: 400 })
    return NextResponse.json({ code: 50000, msg: e instanceof Error ? e.message : "内部错误", data: null, traceId }, { status: 500 })
  }
}

// ============================================================
// r36：Docker Engine API exec 流式音频（远程 Docker 部署形态）
// exec create → exec start（Detach:false，非 TTY）→ 响应体为 Docker 8 字节帧
// 复用流：[streamType(1) | 0(3) | payloadSize(4 BE)] + payload。
// 解复用 stdout(1) 帧归一为 ChildProcess 形态（stderr(2) 归集供错误诊断）。
// ============================================================

// 8 字节帧协议解复用（Docker attach stream format）
class DockerExecDemux extends Transform {
  private buf = Buffer.alloc(0)
  constructor(
    private readonly out: PassThrough,
    private readonly err: PassThrough,
  ) {
    super()
  }
  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 8) {
      const streamType = this.buf[0]
      const size = this.buf.readUInt32BE(4)
      if (this.buf.length < 8 + size) break
      const payload = this.buf.subarray(8, 8 + size)
      this.buf = this.buf.subarray(8 + size)
      if (streamType === 2) this.err.write(payload)
      else this.out.write(payload) // stdout(1) 与未知类型均按 stdout 透传
    }
    cb()
  }
}

async function spawnDockerExecStream(containerRef: string, ffmpegArgs: string[]): Promise<ChildProcess | null> {
  try {
    const base = ENV.dockerApiUrl.replace(/\/$/, "")
    if (!base) return null
    // 1) exec create（容器内 ffmpeg；pulse 环境由容器 supervisor 注入 PID1，
    //    exec 新进程需显式传 PULSE_SERVER/XDG_RUNTIME_DIR）
    const createRes = await fetch(`${base}/containers/${encodeURIComponent(containerRef)}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
        Env: ["PULSE_SERVER=/tmp/pulse/pulse/native", "XDG_RUNTIME_DIR=/tmp/pulse"],
        Cmd: ["ffmpeg", ...ffmpegArgs],
      }),
    })
    if (!createRes.ok) return null
    const execInfo = (await createRes.json().catch(() => null)) as { Id?: string } | null
    if (!execInfo?.Id) return null

    // 2) exec start（流式响应体 = 帧复用流）
    const startRes = await fetch(`${base}/exec/${execInfo.Id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false, Tty: false }),
    })
    if (!startRes.ok || !startRes.body) return null

    // 3) web ReadableStream → 原生流 → 解复用
    const native = Readable.fromWeb(startRes.body as Parameters<typeof Readable.fromWeb>[0])
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    native.pipe(new DockerExecDemux(stdout, stderr))

    // 归一 ChildProcess 形态（EventEmitter 提供 on/once；下游 firstChunk/流式回传/kill 零改动）
    const emitter = new (await import("node:events")).EventEmitter()
    const pseudo = Object.assign(emitter, {
      stdout,
      stderr,
      kill: (sig?: string) => {
        void sig
        try { native.destroy() } catch { /* noop */ }
        try { void fetch(`${base}/exec/${execInfo.Id}`, { method: "DELETE" }) } catch { /* noop */ }
        stdout.destroy()
        stderr.destroy()
      },
    }) as unknown as ChildProcess
    // 上游断流（exec 退出/连接断开）→ 下游流关闭 + close 事件（firstChunk 等待/回传收口）
    native.on("close", () => { stdout.end(); stderr.end(); emitter.emit("close") })
    native.on("error", () => { stdout.destroy(); emitter.emit("close") })
    return pseudo
  } catch {
    return null
  }
}

async function audioPostHandler(req: NextRequest): Promise<{ url: string; expiresInSec: number }> {
  {
    const ctx = await requireAuth()
    if (!rateLimit(`vnc-audio:${ctx.userId}`, 10, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "音频通道请求过于频繁")
    }
    const body = (await req.json().catch(() => ({}))) as { workspaceId?: string }
    const wsId = body.workspaceId || req.nextUrl.searchParams.get("workspaceId") || ""
    if (!wsId) throw new BizError(ErrorCode.PARAM_ERROR, "缺少 workspaceId")

    const ws = await db.browserWorkspace.findFirst({ where: { id: wsId, deletedAt: null } })
    if (!ws) throw new BizError(ErrorCode.NOT_FOUND, "工作区不存在")
    if (ws.mode !== "novnc_full") throw new BizError(ErrorCode.PARAM_ERROR, "仅 VNC 完整模式支持声音回传")
    if (ws.status !== "RUNNING") throw new BizError(ErrorCode.RESOURCE_IN_USE, "工作区未在运行")

    // 权限：与 VNC 取票同权（所有者 / 共享 OPERATE / ADMIN+）
    let allowed = ctx.userId === ws.userId || ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    if (!allowed) {
      const share = await db.workspaceShare.findFirst({
        where: {
          workspaceId: ws.id, targetUserId: ctx.userId, revokedAt: null, permission: "OPERATE",
          OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
        },
      })
      if (share) allowed = true
    }
    if (!allowed) throw new BizError(ErrorCode.FORBIDDEN, "无该沙箱的音频权限")

    const exp = Math.floor(Date.now() / 1000) + TOKEN_WINDOW_SEC
    const url = `/api/vnc-proxy/audio?ws=${ws.id}&t=${audioToken(ws.id, exp)}&e=${exp}`
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "VNC_AUDIO_START", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      ownerUserId: ws.userId, after: { tokenWindowSec: TOKEN_WINDOW_SEC },
    }).catch(() => {})
    return { url, expiresInSec: TOKEN_WINDOW_SEC }
  }
}

export async function GET(req: NextRequest) {
  const wsId = req.nextUrl.searchParams.get("ws") || ""
  const t = req.nextUrl.searchParams.get("t") || ""
  const e = req.nextUrl.searchParams.get("e") || ""
  const traceId = crypto.randomUUID()
  const respond = (body: Record<string, unknown>, status = 200) =>
    NextResponse.json({ ...body, traceId }, { status })

  if (!wsId || !t || !e || !verifyToken(wsId, t, e)) {
    return respond({ code: 40101, msg: "音频令牌无效或已过期（请重新点击声音按钮）" }, 401)
  }
  const ws = await db.browserWorkspace.findFirst({ where: { id: wsId, deletedAt: null } })
  if (!ws || ws.status !== "RUNNING" || !ws.novncSessionId) {
    return respond({ code: 40901, msg: "会话不在运行中" }, 409)
  }

  // 音频抓取：优先嵌入沙箱（每沙箱独立 pulse socket）；否则 Docker API exec 容器内抓
  // r36 修复：
  //   · 嵌入式：PULSE_SERVER 指向该沙箱专属 socket（此前未传 → 永远拨错默认路径 → 503）
  //   · 容器形态：改走 Docker Engine API exec（此前依赖宿主机 docker CLI——
  //     DOCKER_API_URL 远程部署形态宿主机无 docker 命令 → 音频永远不可用）
  //   · 镜像/沙箱侧 pulse 虚拟声卡（dockyard-mix）已在 supervisor/镜像补齐
  const { spawn } = await import("node:child_process")
  let child: import("node:child_process").ChildProcess | null = null
  const FFMPEG_ARGS = [
    "-nostats", "-loglevel", "error",
    "-f", "pulse", "-fragment_size", "1024", "-i", "dockyard-mix.monitor",
    "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
    "-f", "webm", "pipe:1",
  ]
  try {
    const { embeddedSandbox } = await import("@/lib/embedded-sandbox")
    const entry = await embeddedSandbox(ws.novncSessionId)
    if (entry) {
      // 每沙箱独立 pulse socket（embedded supervisor 建卡写入 pulse-socket 文件）
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (entry.pulseSocket) {
        env.PULSE_SERVER = entry.pulseSocket
        env.XDG_RUNTIME_DIR = entry.pulseSocket.replace(/\/pulse\/native$/, "")
      }
      child = spawn("ffmpeg", FFMPEG_ARGS, { env, stdio: ["ignore", "pipe", "pipe"] as const })
    } else if (ws.containerRef && ENV.dockerApiUrl) {
      // Docker Engine API exec：二进制流经 8 字节帧协议解复用（仅取 stdout 流）
      child = await spawnDockerExecStream(ws.containerRef, FFMPEG_ARGS)
    } else if (ws.containerRef) {
      // 兜底：本机 docker CLI（同机部署且未配置 DOCKER_API_URL 时）
      child = spawn("docker", [
        "exec", "-i",
        "-e", "PULSE_SERVER=/tmp/pulse/pulse/native",
        "-e", "XDG_RUNTIME_DIR=/tmp/pulse",
        ws.containerRef,
        "ffmpeg", ...FFMPEG_ARGS,
      ], { stdio: ["ignore", "pipe", "pipe"] as const })
    }
  } catch {
    child = null
  }

  if (!child || !child.stdout) {
    return respond({ code: 50301, msg: "该沙箱暂无音频能力（未启用 pulseaudio 虚拟声卡）" }, 503)
  }

  // ffmpeg 启动失败（无 pulse 设备）→ 首个 stderr 输出映射为 503
  const stderrBuf: string[] = []
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf.push(d.toString())
  })
  child.on("error", () => { /* spawn 失败在 firstChunk 等待里处理 */ })

  // 等待首包（900ms 内无数据 → 判定失败；正常则开始流式）
  const firstChunk = await new Promise<Buffer | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 900)
    child!.stdout!.once("data", (d: Buffer) => { clearTimeout(timer); resolve(d) })
    child!.once("close", () => { clearTimeout(timer); resolve(null) })
  })
  if (!firstChunk) {
    try { child.kill("SIGKILL") } catch { /* 已退出 */ }
    return respond({ code: 50301, msg: `音频抓取失败：沙箱内无可用音频设备（${stderrBuf.join("").slice(0, 160) || "pulse 不可达"}）` }, 503)
  }

  // 流式回传：webm/opus（Chrome <audio> 原生流式播放）；客户端断开 → kill ffmpeg
  const theChild = child
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(firstChunk))
      theChild.stdout!.on("data", (d: Buffer) => {
        try { controller.enqueue(new Uint8Array(d)) } catch { /* 已取消 */ }
      })
      theChild.stdout!.once("end", () => { try { controller.close() } catch { /* 已关闭 */ } })
      theChild.once("close", () => { try { controller.close() } catch { /* 已关闭 */ } })
    },
    cancel() {
      try { theChild.kill("SIGTERM") } catch { /* 忽略 */ }
      setTimeout(() => { try { theChild.kill("SIGKILL") } catch { /* 忽略 */ } }, 1500)
    },
  })

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "audio/webm",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  })
}
