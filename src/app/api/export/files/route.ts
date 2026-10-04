import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { csvEscape, fmtDate, fmtBytes } from "@/lib/utils-server"
import { buildFilesWhere } from "@/app/(main)/admin/files/where"

// ============================================================
// 文件存储 CSV 导出：GET /api/export/files?category=&userId=&node=&keyword=
// r28a：
//   · requireAdmin 鉴权 + EXPORT 审计
//   · 复用管理端列表当前筛选 where（category / userId / keyword / 节点；缺省主节点）
//   · 流式 CSV（500 行/批拉取 → ReadableStream 分块输出，避免大表一次性进内存）
//   · RFC5987 中文文件名（filename*=UTF-8''… + ASCII fallback）
//   · 导出列：文件名 / 大小 / 类型 / 归属 / 节点 / 分享状态 / 创建时间
// ============================================================

const BATCH_SIZE = 500

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAdmin()

    const sp = req.nextUrl.searchParams
    const where = buildFilesWhere({
      category: sp.get("category") || undefined,
      userId: sp.get("userId") || undefined,
      keyword: sp.get("keyword") || undefined,
      node: sp.get("node") || undefined,
    })

    // ---- 预取映射（用户名 / 节点名 / 有效分享状态） ----
    const [users, nodes, total, activeShares] = await Promise.all([
      db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true }, take: 5000 }),
      db.browserNode.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, take: 500 }),
      db.fileMeta.count({ where }),
      db.fileShare.findMany({
        where: { revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
        select: { fileIds: true, folderKey: true },
        take: 5000,
      }),
    ])
    const usernameById = new Map(users.map((u) => [u.id, u.username]))
    const nodeNameById = new Map(nodes.map((n) => [n.id, n.name]))

    // 文件级分享计数（fileIds 白名单）+ 文件夹前缀（导出行时前缀匹配计数）
    const shareCountByFileId = new Map<string, number>()
    const folderPrefixes: string[] = []
    for (const s of activeShares) {
      if (Array.isArray(s.fileIds)) {
        for (const fid of s.fileIds as string[]) shareCountByFileId.set(fid, (shareCountByFileId.get(fid) || 0) + 1)
      } else if (s.folderKey) {
        folderPrefixes.push(s.folderKey)
      }
    }

    const headers = ["文件名", "大小(字节)", "大小(可读)", "类型", "归属用户", "存储节点", "分享状态", "创建时间", "文件ID"]

    const encoder = new TextEncoder()
    let skip = 0
    let exported = 0
    let done = false

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // BOM（Excel UTF-8 识别）+ 表头
        controller.enqueue(encoder.encode("\uFEFF" + headers.join(",") + "\n"))
      },
      async pull(controller) {
        if (done) return
        try {
          const batch = await db.fileMeta.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip,
            take: BATCH_SIZE,
            select: {
              id: true, fileName: true, size: true, category: true, userId: true,
              storageNodeId: true, storageKey: true, createdAt: true,
            },
          })
          skip += batch.length

          const lines: string[] = []
          for (const f of batch) {
            const shareCount =
              (shareCountByFileId.get(f.id) || 0) +
              folderPrefixes.filter((p) => f.storageKey.startsWith(`${p}/`)).length
            const row = [
              f.fileName,
              String(f.size),
              fmtBytes(f.size),
              f.category,
              f.userId ? usernameById.get(f.userId) || f.userId : "",
              f.storageNodeId ? nodeNameById.get(f.storageNodeId) || f.storageNodeId : "主节点",
              shareCount > 0 ? `已分享(${shareCount})` : "未分享",
              fmtDate(f.createdAt),
              f.id,
            ]
            lines.push(row.map(csvEscape).join(","))
          }
          if (lines.length > 0) {
            controller.enqueue(encoder.encode(lines.join("\n") + "\n"))
            exported += lines.length
          }
          if (batch.length < BATCH_SIZE) {
            done = true
            controller.close()
          }
        } catch (e) {
          done = true
          controller.error(e)
        }
      },
    })

    // ---- 审计（导出动作；导出行数以计数为准） ----
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EXPORT",
      resourceType: "FILE",
      severity: "WARN",
      after: {
        count: total,
        exportFormat: "csv",
        filters: {
          category: sp.get("category") || null,
          userId: sp.get("userId") || null,
          node: sp.get("node") || "master(default)",
          keyword: sp.get("keyword") || null,
        },
        streamed: true,
      },
    })

    const ts = Date.now()
    const asciiFallback = `dockyard-files-${ts}.csv`
    const encodedName = encodeURIComponent(`dockyard-文件存储-${ts}.csv`).replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())

    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
