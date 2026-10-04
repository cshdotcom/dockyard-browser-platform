import { NextRequest } from "next/server"
import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { BizError, ErrorCode } from "@/lib/errors"
import { resolveDomainPath, isWriteDenied } from "@/lib/file-explorer"
import { checkStorageQuota, notifyStorageWatermark, resolveStoragePolicy } from "@/lib/storage-quota"

// ============================================================
// r28 文件管理器上传：POST /api/files/upload-explorer (multipart)
//   FormData: file, domain=ROOT_FS|STORAGE|HOME, dir=域内相对路径
// 安全：域权限（ROOT_FS/STORAGE 仅管理员）+ 穿越拒绝 + 敏感目录拒写
//      + 文件名清洗 + 上传大小上限（配置 files.maxUploadMB）
// ============================================================

const MAX_NAME = 255

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\0\r\n]/g, "").replace(/[/\\]/g, "_")
  return base.slice(0, MAX_NAME) || "upload.bin"
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()
    if (!rateLimit(`file-up:${ctx.userId}`, 20, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "上传过于频繁，请稍后再试")
    }

    const form = await req.formData().catch(() => null)
    if (!form) throw new BizError(ErrorCode.PARAM_ERROR, "无效的表单数据")
    const file = form.get("file")
    if (!(file instanceof File)) throw new BizError(ErrorCode.PARAM_ERROR, "缺少文件字段")
    const domain = (String(form.get("domain") || "HOME")) as "ROOT_FS" | "STORAGE" | "HOME" | "RECORDING" | "SCREENSHOT"
    const dir = String(form.get("dir") || "")

    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((domain === "ROOT_FS" || domain === "STORAGE") && !isAdmin) {
      throw new BizError(ErrorCode.FORBIDDEN, "该域仅管理员可上传")
    }

    const { getConfigNumber, getConfig } = await import("@/lib/config")
    const maxMb = await getConfigNumber("files.maxUploadMB", 512)
    if (file.size > maxMb * 1024 * 1024) {
      throw new BizError(ErrorCode.PARAM_ERROR, `文件超过上传上限 ${maxMb}MB`)
    }

    // r33：存储配额执行链 —— 功能开关 + 总配额/分类子配额校验（管理员豁免配额但受总开关约束）
    const policy = await resolveStoragePolicy(ctx.userId)
    if (!policy.uploadAllowed) {
      throw new BizError(ErrorCode.FORBIDDEN, `管理员已禁用云盘上传（${policy.switchSourceLabel}）；已有文件仍可下载`)
    }
    if (!isAdmin) {
      const quota = await checkStorageQuota(ctx.userId, file.size, "upload")
      if (!quota.ok) {
        // 站内信留痕（去重） + 拒绝
        await db.notice.create({
          data: {
            userId: ctx.userId,
            title: "上传被拒绝：存储配额不足",
            content: quota.reason || "存储配额不足",
            type: "ALERT",
            link: "/files",
            sourceType: "FILE",
            sourceKey: ctx.userId,
          },
        }).catch(() => {})
        throw new BizError(ErrorCode.FORBIDDEN, quota.reason || "存储配额不足")
      }
    }

    const name = sanitizeName(file.name)
    const lower = name.toLowerCase()
    const denyList = await getConfig("files.denyExts", "")
    const denyExts = String(denyList || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (denyExts.length > 0 && denyExts.some((ext) => lower.endsWith(ext))) {
      throw new BizError(ErrorCode.FORBIDDEN, `禁止上传 ${denyExts.join("/")} 类型文件`)
    }

    const home = path.join(ENV.storageLocalPath, "home", ctx.userId)
    const roots = { ROOT_FS: "/", STORAGE: path.resolve(ENV.storageLocalPath), HOME: home, RECORDING: path.join(ENV.storageLocalPath, "recordings", ctx.userId), SCREENSHOT: path.join(ENV.storageLocalPath, "screenshots", ctx.userId) }
    const { abs: dirAbs, ok } = resolveDomainPath(roots, domain, dir)
    if (!ok) throw new BizError(ErrorCode.FORBIDDEN, "非法路径")
    const destAbs = path.join(dirAbs, name)
    if (isWriteDenied(domain, destAbs, ENV.storageLocalPath)) {
      throw new BizError(ErrorCode.FORBIDDEN, "敏感目录禁止上传")
    }

    await fsp.mkdir(dirAbs, { recursive: true }).catch(() => null)

    const buf = Buffer.from(await file.arrayBuffer())
    await fsp.writeFile(destAbs, buf)

    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_UPLOAD", resourceType: "FILE", resourceName: name, severity: "INFO",
      after: { domain, dir, sizeBytes: file.size, mime: file.type },
    }).catch(() => null)

    // r33：上传成功后水位预警（异步、去重）
    void notifyStorageWatermark(ctx.userId).catch(() => null)

    return Response.json({ code: 0, msg: "ok", data: { fileName: name, sizeBytes: file.size } })
  })
}
