import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { BizError, ErrorCode } from "@/lib/errors"

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

  // 音频抓取：优先嵌入沙箱（DISPLAY + pulse socket）；否则 docker exec 容器内抓
  const { spawn } = await import("node:child_process")
  let child: import("node:child_process").ChildProcess | null = null
  try {
    const { embeddedSandbox } = await import("@/lib/embedded-sandbox")
    const entry = await embeddedSandbox(ws.novncSessionId)
    if (entry) {
      const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${entry.display}` }
      // pulse 服务器路径探测：沙箱进程树内 PULSE_SERVER 由 embedded-sandbox 注入（Dockerfile 需装 pulseaudio）
      child = spawn("ffmpeg", [
        "-f", "pulse", "-fragment_size", "1024", "-i", "dockyard-mix.monitor",
        "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
        "-f", "webm", "pipe:1",
      ], { env, stdio: ["ignore", "pipe", "pipe"] as const })
    } else if (ws.containerRef) {
      child = spawn("docker", [
        "exec", "-i", ws.containerRef,
        "ffmpeg", "-f", "pulse", "-fragment_size", "1024", "-i", "dockyard-mix.monitor",
        "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
        "-f", "webm", "pipe:1",
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
