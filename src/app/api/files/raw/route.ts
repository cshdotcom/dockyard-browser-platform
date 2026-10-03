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
import { resolveDomainPath, generateThumbnail, throttledStream, readChunks, dirSize } from "@/lib/file-explorer"
import { randomBytes } from "crypto"

// ============================================================
// r28 文件原始内容路由：预览（inline）/ 下载（attachment）/ 目录动态 zip
//   GET /api/files/raw?domain=HOME&path=xx&mode=preview|download|zip
// 安全：域解析（穿越拒绝）+ ROOT_FS/STORAGE 仅管理员 + 限速（用户级 > 全局）+ 审计
// ============================================================

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
}

function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  return MIME_MAP[`.${ext}`] || "application/octet-stream"
}

async function userTransferKBps(userId: string): Promise<number> {
  const cfgKb = await (await import("@/lib/config")).getConfigNumber("files.transferKBps", 0)
  const user = await db.user.findUnique({ where: { id: userId }, select: { fileTransferKBps: true } })
  // 用户级 0=不限；null=继承全局（全局 0=不限）
  if (user?.fileTransferKBps != null) return user.fileTransferKBps
  return cfgKb
}

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()
    const sp = req.nextUrl.searchParams
    const domain = (sp.get("domain") || "HOME") as "ROOT_FS" | "STORAGE" | "HOME"
    const filePath = sp.get("path") || ""
    const mode = sp.get("mode") || "preview" // preview | download | zip
    const adminOnly = domain === "ROOT_FS" || domain === "STORAGE"
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if (adminOnly && !isAdmin) throw new BizError(ErrorCode.FORBIDDEN, "该域仅管理员可访问")

    if (!rateLimit(`file-raw:${ctx.userId}`, 60, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "访问过于频繁，请稍后再试")
    }

    const home = path.join(ENV.storageLocalPath, "home", ctx.userId)
    const roots = { ROOT_FS: "/", STORAGE: path.resolve(ENV.storageLocalPath), HOME: home }
    const { abs, ok } = resolveDomainPath(roots, domain, filePath)
    if (!ok) throw new BizError(ErrorCode.FORBIDDEN, "非法路径")

    const st = await fsp.stat(abs).catch(() => null)
    if (!st) throw new BizError(ErrorCode.NOT_FOUND, "文件不存在")

    // ---- 目录：动态 zip 打包下载 ----
    if (st.isDirectory()) {
      if (mode !== "zip") throw new BizError(ErrorCode.PARAM_ERROR, "目录请使用 zip 模式下载")
      void writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "FILE_DOWNLOAD", resourceType: "FILE", resourceName: path.basename(abs),
        after: { domain, path: filePath, mode: "dir-zip" }, severity: "INFO",
      }).catch(() => null)
      const zipName = `${path.basename(abs) || "archive"}.zip`
      // 流式 zip：临时文件后回传（目录打包必须落盘；清理放 finally）
      const tmpZip = path.join((await import("os")).tmpdir(), `dy-dl-${Date.now()}-${randomBytes(4).toString("hex")}.zip`)
      const { zipPaths } = await import("@/lib/file-explorer")
      const r = await zipPaths([abs], tmpZip)
      if (!r.ok) throw new BizError(ErrorCode.PARAM_ERROR, r.error || "打包失败")
      const size = (await fsp.stat(tmpZip)).size
      const stream = readChunks(tmpZip, 256 * 1024)
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipName.replace(/[^\x20-\x7E]/g, "_")}"`,
          "Content-Length": String(size),
        },
      })
    }

    if (mode !== "preview" && mode !== "download") throw new BizError(ErrorCode.PARAM_ERROR, "非法 mode")

    // ---- 缩略图（图片/视频） ----
    const thumb = sp.get("thumb")
    if (thumb === "1" && mode === "preview") {
      const ext = path.extname(abs).toLowerCase()
      const isMedia = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mkv|mov)$/i.test(ext)
      if (isMedia) {
        const kind = /\.(mp4|webm|mkv|mov)$/i.test(ext) ? "video" : "image"
        const t = await generateThumbnail(abs, kind)
        if (t.ok && t.thumbAbs) {
          const buf = await fsp.readFile(t.thumbAbs)
          await fsp.rm(t.thumbAbs, { force: true }).catch(() => null)
          return new Response(new Uint8Array(buf), {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" },
          })
        }
      }
      throw new BizError(ErrorCode.NOT_FOUND, "该文件类型无缩略图")
    }

    const mime = mimeOf(path.basename(abs))
    const name = path.basename(abs)
    const size = st.size

    // ---- 限速（下载才限速；预览不限） ----
    const kbps = mode === "download" ? await userTransferKBps(ctx.userId) : 0

    // ---- 审计 ----
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: mode === "download" ? "FILE_DOWNLOAD" : "FILE_VIEW", resourceType: "FILE", resourceName: name,
      after: { domain, path: filePath, sizeBytes: size, throttledKBps: kbps }, severity: "INFO",
    }).catch(() => null)

    const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "download.bin"
    const disposition = mode === "download"
      ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
      : `inline; filename="${asciiFallback}"`

    const source = readChunks(abs, 256 * 1024)
    const stream = kbps > 0 ? throttledStream(source, kbps) : source

    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(size),
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
