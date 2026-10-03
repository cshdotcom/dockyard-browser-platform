import { NextRequest } from "next/server"
import { createReadStream, promises as fsp } from "fs"
import { Readable } from "stream"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { recordingAbsPath, verifyPlaybackToken } from "@/lib/recording"
import { BizError, ErrorCode } from "@/lib/errors"

// ============================================================
// r27：VNC 会话录像回放 / 下载
// GET /api/recordings/stream/<id>?token=<签名票据>      → HTML5 <video> 流式回放
// GET /api/recordings/stream/<id>?token=...&download=1  → 附件下载
// GET /api/recordings/stream/<id>                       → 同源 Cookie 会话鉴权（<video> 同源自动携带）
// 鉴权（双通道）：
//   1. Cookie 会话（requireAuth）→ 实时 RBAC（所有者/组管理员/ADMIN+；用户端可见性开关）
//   2. 签名票据（playbackRecordingAction 签发，60 秒时效）→ 票据绑定用户 + 回放对象
// 支持 HTTP Range（206 分片）—— 播放器可拖动进度条；下载走完整 200。
// 审计：回放/下载均留痕（RECORDING_VIEW / RECORDING_DOWNLOAD）。
// ============================================================

export async function GET(req: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const { id } = await ctxParams.params
    const token = req.nextUrl.searchParams.get("token")?.trim() || ""
    const download = req.nextUrl.searchParams.get("download") === "1"

    // ---- 鉴权通道 1：签名票据（回放动作签发；60 秒时效）----
    let auth: { userId: string; username: string; role: string } | null = null
    if (token) {
      const v = verifyPlaybackToken(token)
      if (!v) throw new BizError(ErrorCode.FORBIDDEN, "回放票据无效或已过期，请重新打开回放")
      const u = await db.user.findFirst({
        where: { id: v.userId, deletedAt: null, enabled: true },
        select: { id: true, username: true, role: true },
      })
      if (u && v.recordingId === id) auth = { userId: u.id, username: u.username, role: u.role }
    } else {
      // ---- 鉴权通道 2：同源 Cookie 会话 → 实时 RBAC ----
      const ctx = await requireAuth()
      auth = { userId: ctx.userId, username: ctx.username, role: ctx.role }
    }
    if (!auth) throw new BizError(ErrorCode.FORBIDDEN, "回放票据对应的用户已不可用")

    if (!rateLimit(`rec-stream:${auth.userId}`, download ? 30 : 240, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "访问过于频繁，请稍后再试")
    }

    const rec = await db.vncRecording.findUnique({ where: { id } })
    if (!rec || rec.deletedAt) throw new BizError(ErrorCode.NOT_FOUND, "录像不存在或已在回收站")

    // ---- RBAC：所有者 / 组管理员（所辖组） / ADMIN+ ----
    const isAdmin = auth.role === "SUPER_ADMIN" || auth.role === "ADMIN"
    if (!isAdmin && rec.userId !== auth.userId) {
      if (auth.role === "GROUP_ADMIN") {
        const ws = await db.browserWorkspace.findUnique({ where: { id: rec.workspaceId }, select: { groupId: true } })
        const member = ws?.groupId
          ? await db.groupUser.findFirst({ where: { groupId: ws.groupId, userId: auth.userId }, select: { id: true } })
          : null
        if (!member) throw new BizError(ErrorCode.FORBIDDEN, "无该录像的查看权限（非所辖用户组）")
      } else {
        throw new BizError(ErrorCode.FORBIDDEN, "无该录像的查看权限")
      }
    }
    // 用户端可见性开关（仅影响所有者本人的 Cookie 通道；管理员签发的票据不受限）
    if (!isAdmin && auth.role !== "GROUP_ADMIN" && rec.userId === auth.userId && !token) {
      const { getConfigBool } = await import("@/lib/config")
      const visible = await getConfigBool("vnc.recordingUserVisible", true)
      if (!visible) throw new BizError(ErrorCode.FORBIDDEN, "管理员已关闭用户端录像可见性")
    }

    // ---- 路径解析（storageKey 白名单格式 → 物理文件，杜绝穿越）----
    const target = rec.storageKey ? recordingAbsPath(rec.storageKey) : null
    if (!target) throw new BizError(ErrorCode.NOT_FOUND, "录像文件路径缺失（分段未落盘）")
    const st = await fsp.stat(target).catch(() => null)
    if (!st || !st.isFile()) throw new BizError(ErrorCode.NOT_FOUND, "录像文件已不存在（可能已被物理清除）")
    if (st.size < 1024) {
      // fMP4 数据仍在编码缓冲（仅 ftyp 头落盘）→ 分段滚动/停止后即可回放
      throw new BizError(ErrorCode.NOT_FOUND, "录像正在写入中（分段滚动后即可回放，通常数秒至一个分段时长）")
    }

    const fileName = `${rec.workspaceName}-seg${rec.segmentIndex + 1}-${new Date(rec.startedAt).toISOString().slice(0, 10)}.mp4`

    // ---- 审计 + 计数（不阻塞主链路）----
    void db.vncRecording
      .update({
        where: { id },
        data: download
          ? { downloadCount: { increment: 1 }, lastDownloadAt: new Date() }
          : { viewCount: { increment: 1 }, lastViewedAt: new Date() },
      })
      .catch(() => {})
    void writeAudit({
      operatorUserId: auth.userId,
      operatorName: auth.username,
      operationType: download ? "RECORDING_DOWNLOAD" : "RECORDING_VIEW",
      resourceType: "RECORDING",
      resourceId: id,
      resourceName: rec.workspaceName,
      ownerUserId: rec.userId,
      after: { segment: rec.segmentIndex, sizeBytes: st.size, via: token ? "signed-token" : "cookie-session" },
    }).catch(() => {})

    // ---- 下载模式：完整 200 + RFC5987 双文件名 ----
    if (download) {
      const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "recording.mp4"
      const encodedName = encodeURIComponent(fileName).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
      const nodeStream = createReadStream(target)
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(st.size),
          "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      })
    }

    // ---- 回放模式：HTTP Range（206 分片流，播放器可拖动进度条）----
    const rangeHeader = req.headers.get("range") || ""
    const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (rangeMatch) {
      const start = rangeMatch[1] ? Number(rangeMatch[1]) : 0
      const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), st.size - 1) : st.size - 1
      if (Number.isFinite(start) && start <= end && start < st.size) {
        const nodeStream = createReadStream(target, { start, end })
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
        return new Response(webStream, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${st.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=60",
            "X-Content-Type-Options": "nosniff",
          },
        })
      }
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } })
    }
    const nodeStream = createReadStream(target)
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(st.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}

export const dynamic = "force-dynamic"
