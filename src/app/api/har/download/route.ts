import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { BizError, ErrorCode } from "@/lib/errors"

// HAR 导出下载：GET /api/har/download?recordId=<HarRecord id>
// 权限（服务端强制三重校验）：工作区所有者 / ADMIN 及以上 / 被共享用户（未撤销未过期）
// 产物：HAR 1.2 规范 JSON 附件（Content-Disposition attachment）
// 安全：12次/分钟限流 + FILE_DOWNLOAD 审计
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()

    if (!rateLimit(`har-dl:${ctx.userId}`, 12, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "下载过于频繁，请稍后再试")
    }

    const recordId = req.nextUrl.searchParams.get("recordId")?.trim()
    if (!recordId) throw new BizError(ErrorCode.NOT_FOUND, "缺少 recordId 参数")

    const record = await db.harRecord.findUnique({ where: { id: recordId } })
    if (!record || record.deletedAt || !record.harJson) {
      throw new BizError(ErrorCode.NOT_FOUND, "HAR 记录不存在或已被清理")
    }

    const ws = await db.browserWorkspace.findUnique({
      where: { id: record.workspaceId },
      select: { id: true, name: true, uuid: true, userId: true, deletedAt: true },
    })
    if (!ws || ws.deletedAt) {
      throw new BizError(ErrorCode.NOT_FOUND, "关联工作区已不存在")
    }

    // ---- 三重权限校验：所有者 / 管理员 / 被共享 ----
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const isOwner = ws.userId === ctx.userId || record.userId === ctx.userId
    let allowed = isOwner || isAdmin
    if (!allowed) {
      const share = await db.workspaceShare.findFirst({
        where: {
          workspaceId: record.workspaceId,
          targetUserId: ctx.userId,
          revokedAt: null,
          OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
        },
        select: { id: true },
      })
      allowed = Boolean(share)
    }
    if (!allowed) throw new BizError(ErrorCode.FORBIDDEN, "无该 HAR 记录的下载权限")

    // ---- 审计（不阻塞主链路）----
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_DOWNLOAD", resourceType: "FILE",
      resourceId: record.id, resourceName: `HAR · ${ws.name}`,
      ownerUserId: ws.userId,
      after: { kind: "har", workspaceId: ws.id, sizeBytes: record.sizeBytes },
    }).catch(() => {})

    // ---- HAR 1.2 JSON 附件（RFC5987 双文件名，含工作区标识）----
    const safeWsName = (ws.name || "workspace").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "workspace"
    const fileName = `${safeWsName}-${ws.uuid.slice(0, 8)}.har`
    const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'")
    const encodedName = encodeURIComponent(fileName).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    const disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`

    const body = record.harJson
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": disposition,
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
