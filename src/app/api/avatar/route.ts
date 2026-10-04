import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { mkdir, writeFile, rm } from "fs/promises"
import { join, dirname } from "path"
import { ENV } from "@/lib/env"

// ============================================================
// 用户头像：上传（POST）与读取（GET）
//   · 存储：用户独立空间 storage/avatars/<userId>/avatar.webp（每用户目录隔离）
//   · 处理：sharp 统一缩放 256x256 居中裁剪 + WebP 压缩（原图不落盘）
//   · 限制：≤5MB、PNG/JPEG/WebP/GIF、上传后即时生效（avatarUpdatedAt 失效缓存）
//   · 读取：GET /api/avatar?userId=xxx（公开头像展示，登录态可见；ETag 长缓存）
//   · 删除：DELETE /api/avatar（恢复默认首字母头像）
// ============================================================

const MAX_SIZE = 5 * 1024 * 1024
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"]

function avatarDir(userId: string) {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "avatars", userId)
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId }, { status: 401 })

  // 限速：每用户 10 次/分钟（防高频写盘）
  if (!rateLimit(`avatarup:${ctx.userId}`, 10, 60_000).allowed) {
    return NextResponse.json({ code: 40329, msg: "上传过于频繁，请稍后再试", traceId }, { status: 429 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ code: 40001, msg: "缺少文件字段 file", traceId }, { status: 400 })
  }
  // r35：管理员替指定用户上传头像（targetUserId 仅 ADMIN/SUPER_ADMIN 可用；审计分别记录操作者与目标）
  const rawTarget = String(form?.get("targetUserId") || "").trim()
  let targetUserId = ctx.userId
  if (rawTarget && rawTarget !== ctx.userId) {
    if (ctx.role !== "ADMIN" && ctx.role !== "SUPER_ADMIN") {
      return NextResponse.json({ code: 40301, msg: "仅管理员可替他人上传头像", traceId }, { status: 403 })
    }
    const target = await db.user.findUnique({ where: { id: rawTarget }, select: { id: true, deletedAt: true } })
    if (!target || target.deletedAt) {
      return NextResponse.json({ code: 40401, msg: "目标用户不存在或已删除", traceId }, { status: 404 })
    }
    targetUserId = target.id
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ code: 40001, msg: "头像文件超过 5MB 上限", traceId }, { status: 400 })
  }
  const mime = file.type || ""
  if (!ALLOWED_MIME.includes(mime)) {
    return NextResponse.json({ code: 40001, msg: `不支持的图片格式（${mime || "未知"}），请使用 PNG/JPEG/WebP/GIF`, traceId }, { status: 400 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  // sharp 统一处理：256x256 居中裁剪 + WebP（q82）
  let webp: Buffer
  try {
    const sharp = (await import("sharp")).default
    webp = await sharp(bytes)
      .rotate() // EXIF 方向纠正
      .resize(256, 256, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer()
  } catch {
    return NextResponse.json({ code: 40001, msg: "图片解析失败（文件可能损坏或非真实图片）", traceId }, { status: 400 })
  }
  if (webp.length > 512 * 1024) {
    return NextResponse.json({ code: 40001, msg: "处理后头像仍超过 512KB，请更换更简单的图片", traceId }, { status: 400 })
  }

  // 写入用户独立空间（目录 = 用户 ID，天然隔离）
  const dir = avatarDir(targetUserId)
  const path = join(dir, "avatar.webp")
  await mkdir(dir, { recursive: true })
  await writeFile(path, webp, { mode: 0o600 })

  const relPath = `avatars/${targetUserId}/avatar.webp`
  await db.user.update({
    where: { id: targetUserId },
    data: { avatarPath: relPath, avatarUpdatedAt: new Date() },
  })
  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: targetUserId === ctx.userId ? "PROFILE_AVATAR_UPLOAD" : "USER_AVATAR_ADMIN_SET",
    resourceType: "USER",
    resourceId: targetUserId,
    resourceName: ctx.username,
    after: { bytes: webp.length, format: "webp", size: "256x256", onBehalfOf: targetUserId !== ctx.userId },
  })

  return NextResponse.json({ code: 0, msg: "头像已更新", data: { url: `/api/avatar?userId=${targetUserId}`, size: webp.length }, traceId })
}

export async function DELETE(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId }, { status: 401 })

  await rm(avatarDir(ctx.userId), { recursive: true, force: true }).catch(() => {})
  await db.user.update({
    where: { id: ctx.userId },
    data: { avatarPath: null, avatarUpdatedAt: null },
  })
  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: "PROFILE_AVATAR_REMOVE",
    resourceType: "USER",
    resourceId: ctx.userId,
    resourceName: ctx.username,
  })
  return NextResponse.json({ code: 0, msg: "已恢复默认头像", traceId })
}

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  // 头像读取：登录可见（公开页面引用头像需要登录态；匿名仅允许 /login 注册页场景的首字母兜底）
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId }, { status: 401 })

  const userId = req.nextUrl.searchParams.get("userId") || ctx.userId
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(userId)) {
    return NextResponse.json({ code: 40001, msg: "参数错误", traceId }, { status: 400 })
  }

  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { avatarPath: true, avatarUpdatedAt: true } })
  if (!user?.avatarPath) {
    return NextResponse.json({ code: 40400, msg: "该用户未设置头像", traceId }, { status: 404 })
  }

  // 防路径穿越：校验相对路径形态
  if (!/^avatars\/[A-Za-z0-9_-]+\/avatar\.webp$/.test(user.avatarPath)) {
    return NextResponse.json({ code: 40400, msg: "头像不存在", traceId }, { status: 404 })
  }

  const abs = join(ENV.storageLocalPath.replace(/\/$/, ""), user.avatarPath)
  let bytes: Buffer
  try {
    bytes = await (await import("fs/promises")).readFile(abs)
  } catch {
    return NextResponse.json({ code: 40400, msg: "头像文件不存在", traceId }, { status: 404 })
  }

  const etag = `"av-${userId}-${user.avatarUpdatedAt?.getTime() ?? 0}"`
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } })
  }
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=86400, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
  })
}
