import { NextRequest } from "next/server"
import { createReadStream, promises as fsp } from "fs"
import path from "path"
import { Readable } from "stream"
import { apiHandler } from "@/lib/api"
import { authorizeShareDownload } from "@/lib/file-share"
import { BizError, ErrorCode } from "@/lib/errors"

// r28 公开分享下载/预览流：GET /api/share/download/<token>?file=<id>&key=<访客密钥>&inline=1
// · VIEW 型分享拒绝下载（仅预览走 inline=1）
// · 归属校验（文件必须在该分享清单/文件夹内）+ 路径穿越防护（在 lib 内完成）
// · Range 分片流（视频/音频拖动进度条）
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return apiHandler(async () => {
    const { token } = await params
    const fileId = req.nextUrl.searchParams.get("file")?.trim()
    const key = req.nextUrl.searchParams.get("key") || undefined
    const inline = req.nextUrl.searchParams.get("inline") === "1"
    if (!fileId) throw new BizError(ErrorCode.NOT_FOUND, "缺少 file 参数")

    const { meta, target } = await authorizeShareDownload(token, fileId, key)

    let size = meta.size
    try {
      const st = await fsp.stat(target)
      if (!st.isFile()) throw new Error("not a regular file")
      size = st.size
    } catch {
      throw new BizError(ErrorCode.NOT_FOUND, "文件内容已不存在（可能已被清理）")
    }

    // RFC5987 双文件名（ASCII fallback + UTF-8 filename*）
    const asciiFallback = meta.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'") || "download.bin"
    const encodedName = encodeURIComponent(meta.fileName).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`

    // Range 分片（视频/音频预览拖动进度条）
    const rangeHeader = req.headers.get("range")
    if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
      const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-")
      const start = startStr ? Number(startStr) : 0
      const end = endStr ? Math.min(Number(endStr), size - 1) : size - 1
      if (start <= end && start < size) {
        const stream = createReadStream(target, { start, end })
        const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
        return new Response(webStream, {
          status: 206,
          headers: {
            "Content-Type": meta.mime || "application/octet-stream",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Disposition": disposition,
            "Cache-Control": "private, no-store",
          },
        })
      }
    }

    const stream = createReadStream(target)
    const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": meta.mime || "application/octet-stream",
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
