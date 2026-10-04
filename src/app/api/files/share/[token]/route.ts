import { NextRequest } from "next/server"
import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { resolveDomainPath, throttledStream, readChunks, zipPaths } from "@/lib/file-explorer"

// ============================================================
// r28 分享链接访问；r31 全面增强（支撑 /share/[token] 预览页）
//   GET /api/files/share/[token]
//     ?mode=preview|download          单文件流（Content-Type 按扩展名；支持 Range 206 拖动）
//     ?op=list&path=<相对子路径>       文件夹分享：目录列表（JSON；防穿越）
//     ?op=zip&path=<相对子路径>        打包下载（整目录或所选多文件 &names=a,b）
//   PUBLIC → 免登录可访问；LOGIN → 任意登录用户；USERS → 指定用户/用户组名单
//   控制：有效期（null=永久）/ 查看次数 / 下载次数 / 下载限速 / 撤销
// ============================================================

function denied(reason: string, status: number): Response {
  return new Response(JSON.stringify({ code: status, msg: reason }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

// 扩展名 → Content-Type（预览模式正确渲染：图片/视频/音频/PDF/文本）
function contentTypeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || ""
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
    pdf: "application/pdf",
    txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
    log: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
    json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  }
  return map[ext] || "application/octet-stream"
}

// ---- 权限模式（r31：USERS 名单支持 用户 ∪ 用户组）----
async function checkAccess(link: {
  accessMode: string
  allowedUsers: unknown
  ownerUserId: string
}): Promise<{ ok: true } | { ok: false; status: number; msg: string }> {
  if (link.accessMode === "PUBLIC") return { ok: true }
  const ctx = await getAuthContext().catch(() => null)
  if (!ctx) return { ok: false, status: 401, msg: "该分享需要登录后访问" }
  if (link.accessMode === "LOGIN") return { ok: true }
  // USERS：用户名单 ∪ 组名单（组员可访问）
  const allow = (link.allowedUsers as { userIds?: string[]; groupIds?: string[] } | null) || {}
  if (ctx.userId === link.ownerUserId || ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return { ok: true }
  if ((allow.userIds || []).includes(ctx.userId)) return { ok: true }
  const gids = allow.groupIds || []
  if (gids.length > 0) {
    const inGroup = await db.groupUser.findFirst({ where: { userId: ctx.userId, groupId: { in: gids } }, select: { id: true } })
    if (inGroup) return { ok: true }
  }
  return { ok: false, status: 403, msg: "您不在该分享的授权名单中" }
}

// ---- 链接状态（过期/撤销/次数）----
async function checkLinkState(link: {
  revokedAt: Date | null
  expiresAt: Date | null
  maxViews: number | null
  viewCount: number
  maxDownloads: number | null
  downloadCount: number
}, isDownload: boolean): Promise<string | null> {
  if (link.revokedAt) return "分享已被撤销"
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return "分享已过期"
  if (link.maxViews && link.viewCount >= link.maxViews) return "查看次数已达上限"
  if (isDownload && link.maxDownloads && link.downloadCount >= link.maxDownloads) return "下载次数已达上限"
  return null
}

interface ShareEntry {
  name: string
  rel: string
  isDir: boolean
  size: number
  mtime: string
  kind: string
}

function kindOfShare(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || ""
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) return "image"
  if (["mp4", "webm", "mkv", "mov"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio"
  if (ext === "pdf") return "pdf"
  if (["txt", "md", "log", "csv", "json", "xml", "html", "htm", "css", "js", "ts", "py", "sh", "yml", "yaml", "ini", "conf"].includes(ext)) return "text"
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive"
  return "binary"
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const op = req.nextUrl.searchParams.get("op")
    if (!/^[a-f0-9]{48}$/.test(token)) return denied("链接格式非法", 400)

    const link = await db.fileShareLink.findUnique({ where: { token } })
    if (!link) return denied("分享不存在", 404)

    const isDownload = op === "zip" || req.nextUrl.searchParams.get("mode") === "download"
    const stateErr = await checkLinkState(link, isDownload)
    if (stateErr) return denied(stateErr, 403)

    const access = await checkAccess(link)
    if (!access.ok) return denied(access.msg, access.status)

    // ---- 解析分享根 ----
    const home = path.join(ENV.storageLocalPath, "home", link.ownerUserId)
    const roots = { ROOT_FS: "/", STORAGE: path.resolve(ENV.storageLocalPath), HOME: home }
    const rootRes = resolveDomainPath(roots, link.domain as "STORAGE" | "HOME", link.filePath)
    if (!rootRes.ok) return denied("分享路径非法", 403)
    const rootAbs = rootRes.abs
    const rootStat = await fsp.stat(rootAbs).catch(() => null)
    if (!rootStat) return denied("分享文件已不存在", 404)

    // ============================================================
    // op=list：文件夹分享目录浏览（JSON；子路径限制在分享根内）
    // ============================================================
    if (op === "list") {
      if (!rootStat.isDirectory()) return denied("该分享不是文件夹", 400)
      const sub = req.nextUrl.searchParams.get("path") || ""
      const subRes = resolveDomainPath(roots, link.domain as "STORAGE" | "HOME", path.posix.join(link.filePath, sub))
      if (!subRes.ok) return denied("子路径非法", 400)
      // 防穿越：最终路径必须在分享根内
      if (!subRes.abs.startsWith(rootAbs + path.sep) && subRes.abs !== rootAbs) return denied("路径越界", 403)
      const st = await fsp.stat(subRes.abs).catch(() => null)
      if (!st || !st.isDirectory()) return denied("目录不存在", 404)
      const dirents = await fsp.readdir(subRes.abs, { withFileTypes: true }).catch(() => [])
      const entries: ShareEntry[] = []
      for (const d of dirents) {
        if (d.name.startsWith(".")) continue // 隐藏文件不外显
        const abs = path.join(subRes.abs, d.name)
        const s = await fsp.stat(abs).catch(() => null)
        if (!s) continue
        entries.push({
          name: d.name,
          rel: path.posix.join(sub, d.name),
          isDir: d.isDirectory(),
          size: s.isDirectory() ? 0 : s.size,
          mtime: s.mtime.toISOString(),
          kind: d.isDirectory() ? "dir" : kindOfShare(d.name),
        })
      }
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      // 目录浏览计一次查看（单次列表会话内多次进入不重复计数由前端控制：仅根路径计数）
      if (!sub) {
        await db.fileShareLink.update({
          where: { id: link.id },
          data: { viewCount: { increment: 1 }, lastAccessAt: new Date() },
        }).catch(() => null)
      }
      return Response.json({
        code: 0,
        data: {
          entries,
          rel: sub,
          parentRel: sub ? path.posix.dirname(sub) : "",
          share: {
            fileName: link.fileName,
            isDir: true,
            accessMode: link.accessMode,
            expiresAt: link.expiresAt?.toISOString() || null,
            viewCount: link.viewCount,
            downloadCount: link.downloadCount,
            maxViews: link.maxViews,
            maxDownloads: link.maxDownloads,
            note: link.note,
          },
        },
      })
    }

    // ============================================================
    // op=zip：动态打包下载（整目录 / 所选多文件）
    // ============================================================
    if (op === "zip") {
      if (!rootStat.isDirectory()) return denied("该分享不是文件夹", 400)
      const sub = req.nextUrl.searchParams.get("path") || ""
      const namesParam = req.nextUrl.searchParams.get("names") || ""
      const subRes = resolveDomainPath(roots, link.domain as "STORAGE" | "HOME", path.posix.join(link.filePath, sub))
      if (!subRes.ok) return denied("子路径非法", 400)
      if (!subRes.abs.startsWith(rootAbs + path.sep) && subRes.abs !== rootAbs) return denied("路径越界", 403)

      let absList: string[] = []
      if (namesParam) {
        // 多选文件（逗号分隔；逐个校验防穿越）
        for (const n of namesParam.split(",").slice(0, 100)) {
          if (!n || n.includes("/") || n.includes("..")) continue
          const abs = path.join(subRes.abs, n)
          if (!abs.startsWith(rootAbs)) continue
          if (await fsp.stat(abs).catch(() => null)) absList.push(abs)
        }
      } else {
        absList = [subRes.abs] // 整目录打包
      }
      if (absList.length === 0) return denied("没有可下载的有效文件", 404)

      // 临时归档（流式发送后清理）
      const tmpDir = path.join(ENV.storageLocalPath, "tmp", "share-zip")
      await fsp.mkdir(tmpDir, { recursive: true }).catch(() => null)
      const dest = path.join(tmpDir, `${token.slice(0, 12)}-${Date.now()}.zip`)
      const r = await zipPaths(absList, dest)
      if (!r.ok) {
        await fsp.rm(dest, { force: true }).catch(() => null)
        return denied(r.error || "打包失败", 500)
      }
      const zst = await fsp.stat(dest).catch(() => null)
      if (!zst) return denied("打包产物异常", 500)

      await db.fileShareLink.update({
        where: { id: link.id },
        data: { downloadCount: { increment: 1 }, lastAccessAt: new Date() },
      }).catch(() => null)
      void writeAudit({
        operationType: "FILE_SHARE_DOWNLOAD", resourceType: "FILE", resourceName: link.fileName,
        after: { token: token.slice(0, 8) + "…", mode: "zip", files: absList.length, size: zst.size },
        severity: "INFO",
      }).catch(() => null)

      const zipName = `${link.fileName || "share"}.zip`
      // 流结束后自动清理临时归档（generator finally 钩子）
      const srcWithCleanup = (async function* () {
        try {
          for await (const chunk of readChunks(dest, 256 * 1024)) yield chunk
        } finally {
          await fsp.rm(dest, { force: true }).catch(() => null)
        }
      })()
      return new Response(srcWithCleanup as unknown as ReadableStream, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(zst.size),
          "Content-Disposition": `attachment; filename="${zipName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
          "Cache-Control": "private, no-store",
        },
      })
    }

    // ============================================================
    // 单文件流（preview inline / download attachment；Range 206 支持）
    // 根是文件 → 直接流；根是文件夹 → ?path=<rel> 定位夹内单文件
    // ============================================================
    let targetAbs = rootAbs
    let targetName = link.fileName
    let targetStat = rootStat
    if (req.nextUrl.searchParams.get("path")) {
      const sub = req.nextUrl.searchParams.get("path") || ""
      const subRes = resolveDomainPath(roots, link.domain as "STORAGE" | "HOME", path.posix.join(link.filePath, sub))
      if (!subRes.ok || (!subRes.abs.startsWith(rootAbs + path.sep) && subRes.abs !== rootAbs)) return denied("路径越界", 403)
      const st = await fsp.stat(subRes.abs).catch(() => null)
      if (!st) return denied("文件不存在", 404)
      targetAbs = subRes.abs
      targetName = path.basename(subRes.abs)
      targetStat = st
    }
    if (!targetStat.isFile()) {
      // 根是文件夹 → 重定向到预览页（直接访问 API 的旧链接场景）
      return Response.redirect(new URL(`/share/${token}`, req.nextUrl.origin), 302)
    }

    const mode = req.nextUrl.searchParams.get("mode") === "download" ? "download" : "preview"
    const contentType = contentTypeOf(targetName)

    // Range 支持（视频/音频拖动进度条）
    const rangeHeader = req.headers.get("range")
    let start = 0
    let end = targetStat.size - 1
    let partial = false
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      if (m) {
        if (m[1]) start = Number(m[1])
        if (m[2]) end = Math.min(Number(m[2]), targetStat.size - 1)
        if (!m[1] && m[2]) { start = targetStat.size - Number(m[2]); end = targetStat.size - 1 } // 后缀范围
        partial = true
      }
    }
    if (start > end || start < 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${targetStat.size}` } })
    }

    // 计数（Range 后续请求不重复计数：仅首段/完整请求）
    if (!partial) {
      await db.fileShareLink.update({
        where: { id: link.id },
        data: {
          viewCount: { increment: 1 },
          ...(mode === "download" ? { downloadCount: { increment: 1 } } : {}),
          lastAccessAt: new Date(),
        },
      }).catch(() => null)
      void writeAudit({
        operationType: "FILE_SHARE_ACCESS", resourceType: "FILE", resourceName: targetName,
        after: { token: token.slice(0, 8) + "…", mode, shareMode: link.accessMode, sub: req.nextUrl.searchParams.get("path") || "" },
        severity: "INFO",
      }).catch(() => null)
    }

    const kbps = mode === "download" ? (link.downloadKBps || 0) : 0
    const length = end - start + 1
    const asciiFallback = targetName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "share.bin"
    const disposition = mode === "download"
      ? `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(targetName)}`
      : `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(targetName)}`

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    }
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${targetStat.size}`

    // 读取指定区间（skip 到 start，读取 length 字节）
    const source = await (async function* () {
      const fh = await fsp.open(targetAbs, "r")
      try {
        const buf = Buffer.alloc(Math.min(256 * 1024, length))
        let remaining = length
        let pos = start
        while (remaining > 0) {
          const toRead = Math.min(buf.length, remaining)
          const { bytesRead } = await fh.read(buf, 0, toRead, pos)
          if (bytesRead <= 0) break
          yield buf.subarray(0, bytesRead)
          pos += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await fh.close().catch(() => null)
      }
    })()
    const stream = kbps > 0 ? throttledStream(source, kbps) : source

    return new Response(stream as unknown as ReadableStream, {
      status: partial ? 206 : 200,
      headers,
    })
  } catch {
    return denied("服务异常", 500)
  }
}
