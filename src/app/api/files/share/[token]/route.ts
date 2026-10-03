import { NextRequest } from "next/server"
import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { resolveDomainPath, throttledStream, readChunks } from "@/lib/file-explorer"

// ============================================================
// r28 分享链接访问：GET /api/files/share/[token]?mode=preview|download
//   PUBLIC  → 免登录可访问
//   LOGIN   → 任意登录用户
//   USERS   → 指定用户名单
// 控制：有效期（null=永久）/ 查看次数 / 下载次数 / 下载限速 / 撤销
// ============================================================

function denied(reason: string, status: number): Response {
  return new Response(JSON.stringify({ code: status, msg: reason }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const mode = req.nextUrl.searchParams.get("mode") === "download" ? "download" : "preview"
    if (!/^[a-f0-9]{48}$/.test(token)) return denied("链接格式非法", 400)

    const link = await db.fileShareLink.findUnique({ where: { token } })
    if (!link) return denied("分享不存在", 404)
    if (link.revokedAt) return denied("分享已被撤销", 403)
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return denied("分享已过期", 403)
    if (link.maxViews && link.viewCount >= link.maxViews) return denied("查看次数已达上限", 403)
    if (mode === "download" && link.maxDownloads && link.downloadCount >= link.maxDownloads) {
      return denied("下载次数已达上限", 403)
    }

    // ---- 权限模式 ----
    if (link.accessMode !== "PUBLIC") {
      const ctx = await getAuthContext().catch(() => null)
      if (!ctx) return denied("该分享需要登录后访问", 401)
      if (link.accessMode === "USERS") {
        const allow = (link.allowedUsers as { userIds?: string[] } | null)?.userIds || []
        if (!allow.includes(ctx.userId) && link.ownerUserId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
          return denied("您不在该分享的授权名单中", 403)
        }
      }
    }

    // ---- 解析文件 ----
    const owner = await db.user.findUnique({ where: { id: link.ownerUserId }, select: { id: true } })
    if (!owner) return denied("分享创建者已不存在", 404)
    const home = path.join(ENV.storageLocalPath, "home", link.ownerUserId)
    const roots = { ROOT_FS: "/", STORAGE: path.resolve(ENV.storageLocalPath), HOME: home }
    const { abs, ok } = resolveDomainPath(roots, link.domain as "STORAGE" | "HOME", link.filePath)
    if (!ok) return denied("分享路径非法", 403)

    const st = await fsp.stat(abs).catch(() => null)
    if (!st || st.isDirectory()) return denied("分享文件已不存在", 404)

    // ---- 计数 ----
    await db.fileShareLink.update({
      where: { id: link.id },
      data: {
        viewCount: { increment: 1 },
        ...(mode === "download" ? { downloadCount: { increment: 1 } } : {}),
        lastAccessAt: new Date(),
      },
    }).catch(() => null)

    void writeAudit({
      operationType: "FILE_SHARE_ACCESS", resourceType: "FILE", resourceName: link.fileName,
      after: { token: token.slice(0, 8) + "…", mode, shareMode: link.accessMode },
      severity: "INFO",
    }).catch(() => null)

    // ---- 流（下载限速） ----
    const kbps = mode === "download" ? (link.downloadKBps || 0) : 0
    const source = readChunks(abs, 256 * 1024)
    const stream = kbps > 0 ? throttledStream(source, kbps) : source

    const asciiFallback = link.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "share.bin"
    const disposition = mode === "download"
      ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(link.fileName)}`
      : `inline; filename="${asciiFallback}"`

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": st.size ? "application/octet-stream" : "text/plain",
        "Content-Length": String(st.size),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (e) {
    return denied("服务异常", 500)
  }
}
