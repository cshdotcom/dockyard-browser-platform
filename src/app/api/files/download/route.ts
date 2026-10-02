import { NextRequest } from "next/server"
import { createReadStream, promises as fsp } from "fs"
import path from "path"
import { Readable } from "stream"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { BizError, ErrorCode } from "@/lib/errors"

// 文件下载：GET /api/files/download?id=<FileMeta id>
// 权限分级（服务端强制）：
//   BACKUP            → 仅 SUPER_ADMIN
//   PROFILE / 个人文件 → 所有者本人
//   工作区附件        → 所有者 / ADMIN+ / 被共享用户（未撤销未过期）/ GROUP_ADMIN 且工作区归属其管理的组
//   shareTo 名单命中  → 放行
// 安全：storageKey 路径穿越防护（归一化后必须落在 storageLocalPath 内）+ 30次/分钟限流 + FILE_DOWNLOAD 审计
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()

    if (!rateLimit(`file-dl:${ctx.userId}`, 30, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "下载过于频繁，请稍后再试")
    }

    const id = req.nextUrl.searchParams.get("id")?.trim()
    if (!id) throw new BizError(ErrorCode.NOT_FOUND, "缺少文件 id 参数")

    const meta = await db.fileMeta.findUnique({ where: { id } })
    if (!meta || meta.deletedAt || meta.purgedAt) {
      throw new BizError(ErrorCode.NOT_FOUND, "文件不存在或已被清理")
    }

    // ---- 权限分级 ----
    const isSuper = ctx.role === "SUPER_ADMIN"
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const isOwner = meta.userId === ctx.userId || meta.createdByUserId === ctx.userId

    let allowed = false
    let denyReason = ""

    if (meta.category === "BACKUP") {
      // 备份文件仅超管可下载（含整库敏感数据）
      allowed = isSuper
      denyReason = "备份文件仅超级管理员可下载"
    } else if (isOwner || isAdmin) {
      allowed = true
    } else if (meta.workspaceId) {
      // 工作区附件：所有者已在上面命中；此处校验 被共享 / 组管理员
      const share = await db.workspaceShare.findFirst({
        where: {
          workspaceId: meta.workspaceId,
          targetUserId: ctx.userId,
          revokedAt: null,
          OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
        },
        select: { id: true },
      })
      if (share) {
        allowed = true
      } else if (ctx.role === "GROUP_ADMIN") {
        const ws = await db.browserWorkspace.findUnique({
          where: { id: meta.workspaceId },
          select: { groupId: true },
        })
        if (ws?.groupId) {
          const member = await db.groupUser.findFirst({
            where: { groupId: ws.groupId, userId: ctx.userId },
            select: { id: true },
          })
          if (member) allowed = true
        }
      }
      if (!allowed) denyReason = "无该工作区附件的下载权限"
    } else {
      // 定向共享名单（shareTo JSON: { userIds?: string[] }）
      const shareTo = (meta.shareTo as { userIds?: string[] } | null) || null
      if (shareTo?.userIds?.includes(ctx.userId)) {
        allowed = true
      } else {
        denyReason = "无该文件的下载权限"
      }
    }

    if (!allowed) throw new BizError(ErrorCode.FORBIDDEN, denyReason || "无下载权限")

    // ---- 路径穿越防护 ----
    const root = path.resolve(ENV.storageLocalPath)
    const target = path.resolve(root, meta.storageKey)
    if (!target.startsWith(root + path.sep)) {
      // 归一化后逃逸出存储根目录 → 拒绝并留痕
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "FILE_DOWNLOAD", resourceType: "FILE",
        resourceId: meta.id, resourceName: meta.fileName,
        severity: "DANGER",
        after: { storageKey: meta.storageKey, blocked: "path-traversal" },
      })
      throw new BizError(ErrorCode.FORBIDDEN, "非法的文件路径")
    }

    let size = meta.size
    try {
      const st = await fsp.stat(target)
      if (!st.isFile()) throw new Error("not a regular file")
      size = st.size
    } catch {
      throw new BizError(ErrorCode.NOT_FOUND, "文件内容已不存在（可能已被清理）")
    }

    // ---- 审计（不阻塞下载主链路）----
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_DOWNLOAD", resourceType: "FILE",
      resourceId: meta.id, resourceName: meta.fileName,
      ownerUserId: meta.userId,
      after: { category: meta.category, sizeBytes: size },
    }).catch(() => {})

    // ---- 响应：RFC5987 双文件名（ASCII fallback + UTF-8 filename*）----
    const asciiFallback = meta.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "download.bin"
    const encodedName = encodeURIComponent(meta.fileName).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    const disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`

    const nodeStream = createReadStream(target)
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": meta.mime || "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
