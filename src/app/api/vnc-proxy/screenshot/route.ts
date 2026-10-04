import { NextRequest } from "next/server"
import { promises as fsp } from "fs"
import path from "node:path"
import crypto from "node:crypto"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { BizError, ErrorCode } from "@/lib/errors"
import { resolveStoragePolicy, checkStorageQuota } from "@/lib/storage-quota"

// ============================================================
// r28 VNC 截图：POST /api/vnc-proxy/screenshot
// { workspaceId, imageBase64 (dataURL 或裸 base64, PNG/JPEG/WebP), note? }
// 权限：工作区所有者 / 被共享用户(OPERATE) / ADMIN+ —— 与 VNC 取票同权
// 行为：落盘 storage/screenshots/<userId>/ → FileMeta(category=SCREENSHOT)
//       占用户云盘配额 → 站内信（SCREENSHOT_DONE，直达 /files?focus=<id>）
// 限流：30 次/分钟/用户；单图 ≤ 8MB
// ============================================================

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"])

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()
    if (!rateLimit(`shot:${ctx.userId}`, 30, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "截图过于频繁，请稍后再试")
    }

    const body = (await req.json().catch(() => ({}))) as {
      workspaceId?: string
      imageBase64?: string
      note?: string
    }
    if (!body.workspaceId || !body.imageBase64) throw new BizError(ErrorCode.PARAM_ERROR, "缺少 workspaceId 或 imageBase64")

    // ---- 权限：与 VNC 取票同权（所有者 / 共享 OPERATE / ADMIN+）----
    const ws = await db.browserWorkspace.findFirst({ where: { id: body.workspaceId, deletedAt: null } })
    if (!ws) throw new BizError(ErrorCode.NOT_FOUND, "工作区不存在")
    let allowed = ctx.userId === ws.userId || ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    if (!allowed) {
      const share = await db.workspaceShare.findFirst({
        where: {
          workspaceId: ws.id,
          targetUserId: ctx.userId,
          revokedAt: null,
          permission: "OPERATE",
          OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
        },
      })
      if (share) allowed = true
    }
    if (!allowed) throw new BizError(ErrorCode.FORBIDDEN, "无该沙箱的截图权限")

    // r33：存储配额执行链 —— 截图入库开关（录像/截图/云盘统一口径；配额校验在解码后执行）
    const stPolicy = await resolveStoragePolicy(ws.userId)
    if (!stPolicy.screenshotAllowed) {
      throw new BizError(ErrorCode.FORBIDDEN, `管理员已禁用截图入库（${stPolicy.switchSourceLabel}）；截图仍可本地保存，不占用云盘空间`)
    }

    // ---- 图片解码（dataURL 或裸 base64；MIME 白名单）----
    let mime = "image/png"
    let raw: string = body.imageBase64
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(body.imageBase64.trim())
    if (m) {
      mime = m[1].toLowerCase()
      raw = m[2]
    }
    if (!ALLOWED_MIME.has(mime)) throw new BizError(ErrorCode.PARAM_ERROR, "仅支持 PNG / JPEG / WebP 截图")
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 0) throw new BizError(ErrorCode.PARAM_ERROR, "截图数据为空")
    if (buf.length > MAX_IMAGE_BYTES) throw new BizError(ErrorCode.PARAM_ERROR, "截图超过 8MB 上限")

    // 魔数校验（防伪装）
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
    const isWebp = buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP"
    if (!isPng && !isJpeg && !isWebp) throw new BizError(ErrorCode.PARAM_ERROR, "图片内容校验失败（魔数不匹配）")

    // r33：截图配额校验（真实字节数已知后执行）
    const stQuota = await checkStorageQuota(ws.userId, buf.length, "screenshot")
    if (!stQuota.ok) {
      throw new BizError(ErrorCode.FORBIDDEN, stQuota.reason || "存储配额不足，无法保存截图")
    }

    // ---- 落盘：storage/screenshots/<userId>/<ts>-<rand>.<ext> ----
    const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp"
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.${ext}`
    const storageKey = `screenshots/${ctx.userId}/${fileName}`
    const abs = path.join(ENV.storageLocalPath, storageKey)
    if (!path.resolve(abs).startsWith(path.resolve(ENV.storageLocalPath))) throw new BizError(ErrorCode.FORBIDDEN, "非法路径")
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, buf, { mode: 0o640 })

    // ---- FileMeta（占用户云盘配额；用户在 /files 可见可管理）----
    const display = `${ws.name}-截图-${new Date().toLocaleString("zh-CN", { hour12: false })}.${ext}`
    const meta = await db.fileMeta.create({
      data: {
        fileName: display,
        storageKey,
        size: buf.length,
        mime,
        category: "SCREENSHOT",
        userId: ctx.userId,
        virusScanned: true,
        createdByUserId: ctx.userId,
      },
    })

    // ---- 站内信（截图完成 → 直达云盘对应文件）----
    await db.notice
      .create({
        data: {
          userId: ctx.userId,
          title: `截图完成：${ws.name}`,
          content: `沙箱「${ws.name}」的截图已保存到你的云盘（${(buf.length / 1024).toFixed(0)} KB）。可在线预览、下载或分享。`,
          type: "SCREENSHOT_DONE",
          link: `/files?focus=${meta.id}`,
          sourceType: "SCREENSHOT",
          sourceKey: meta.id,
        },
      })
      .catch(() => {})

    // ---- 审计 ----
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "VNC_SCREENSHOT",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      after: { fileId: meta.id, storageKey, bytes: buf.length, mime },
    }).catch(() => {})

    // r32：适配远端 apiHandler 新签名（() => Promise<Response>）
    return Response.json({
      code: 0,
      msg: "ok",
      data: { fileId: meta.id, fileName: display, sizeBytes: buf.length, url: `/files?focus=${meta.id}` },
      traceId: crypto.randomUUID(),
    })
  })
}
