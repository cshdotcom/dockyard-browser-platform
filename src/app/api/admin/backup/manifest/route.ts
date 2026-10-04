import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"

// ============================================================
// r36：备份下载地址清单（TXT）
// GET /api/admin/backup/manifest —— 仅超级管理员
// 输出纯文本清单：每份备份的 时间/类型/大小/校验和/加密/状态/多节点副本状态
//               + 全部下载地址（平台基址 + /api/files/download?id=…）
// 用途：灾难恢复场景打印留存（txt 随手归档，任何一条地址均可直接下载恢复包）
// ============================================================

interface ReplicaEntry { nodeUuid: string; state: string; skip?: string; at?: string }

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length)
}

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await requireAuth().catch(() => null)
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId }, { status: 401 })
  if (ctx.role !== "SUPER_ADMIN") {
    return NextResponse.json({ code: 40300, msg: "备份清单仅超级管理员可下载", traceId }, { status: 403 })
  }

  const records = await db.backupRecord.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  })
  const metaIds = records.map((r) => r.fileMetaId)
  const metas = metaIds.length
    ? await db.fileMeta.findMany({ where: { id: { in: metaIds } } })
    : []
  const metaById = new Map(metas.map((m) => [m.id, m]))
  const nodes = await db.workNode.findMany({ select: { nodeUuid: true, name: true, status: true } })
  const nodeName = new Map(nodes.map((n) => [n.nodeUuid, n.name]))

  // 平台基址（管理后台访问地址即下载地址基址；亦尊重 PUBLIC_BASE_URL 环境覆盖）
  const base = ENV.publicBaseUrl || req.nextUrl.origin
  const now = new Date()
  const tz = "Asia/Shanghai"
  const lines: string[] = []

  lines.push("================================================================")
  lines.push("  Dockyard 平台 · 备份下载地址清单（BACKUP MANIFEST）")
  lines.push("================================================================")
  lines.push(`生成时间：${now.toLocaleString("zh-CN", { timeZone: tz })}`)
  lines.push(`平台基址：${base}`)
  lines.push(`备份总数：${records.length} 份（磁盘上存在的 ${metas.filter((m) => !m.deletedAt && !m.purgedAt).length} 份可直接下载）`)
  lines.push(`多节点副本：${records.some((r) => r.replicasJson) ? "已启用（backup.pushNodes）" : "未启用（可在系统配置 → 备份容灾配置）"}`)
  lines.push("")
  lines.push("说明：")
  lines.push("  · 下载地址需超级管理员登录态（浏览器已登录直接点击/粘贴即可）")
  lines.push("  · 恢复：管理后台 → 备份恢复 → 选择对应备份（或直接调用 restoreBackupAction）")
  lines.push("  · 加密备份下载后仍为加密文件，恢复时自动解密（密钥=平台 ENCRYPTION_KEY）")
  lines.push("  · 多节点副本：Worker 节点 dfs-store/backups/ 下同名文件（sha256 与主副本一致）")
  lines.push("")
  lines.push("----------------------------------------------------------------")

  if (records.length === 0) {
    lines.push("（暂无备份记录——点击「立即备份」创建第一份）")
  }

  records.forEach((r, i) => {
    const m = metaById.get(r.fileMetaId)
    const exists = !!m && !m.deletedAt && !m.purgedAt
    const createdAt = new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: tz })
    lines.push("")
    lines.push(`[${String(i + 1).padStart(3, "0")}] ${m?.fileName || "(文件元数据已清理)"}`)
    lines.push(`     ${pad("创建时间", 10)}${createdAt}`)
    lines.push(`     ${pad("类型", 10)}${r.type === "FULL" ? "完整备份（FULL）" : "部分备份（PARTIAL/恢复前临时）"}`)
    lines.push(`     ${pad("大小", 10)}${fmtSize(r.sizeBytes)}`)
    lines.push(`     ${pad("SHA-256", 10)}${r.checksum || "-"}`)
    lines.push(`     ${pad("加密", 10)}${r.encrypted ? "是（AES-256-GCM）" : "否"}`)
    lines.push(`     ${pad("状态", 10)}${r.status}${exists ? "" : "  ⚠ 文件已被清理，仅存记录"}`)
    if (exists) {
      lines.push(`     ${pad("下载地址", 10)}${base}/api/files/download?id=${r.fileMetaId}`)
    }
    if (r.replicasJson) {
      try {
        const reps = JSON.parse(r.replicasJson) as ReplicaEntry[]
        if (reps.length > 0) {
          lines.push(`     ${pad("多节点副本", 10)}`)
          for (const rep of reps) {
            const nm = nodeName.get(rep.nodeUuid) || rep.nodeUuid
            const stateTxt = rep.state === "OK" ? "已落盘" : rep.state === "SENT" ? "推送中（等待节点回执）" : rep.state === "FAIL" ? "失败" : rep.state === "SKIP" ? `跳过（${rep.skip || "原因未记录"}）` : rep.state
            lines.push(`       - ${nm}（${rep.nodeUuid}）：${stateTxt}${rep.at ? ` @ ${new Date(rep.at).toLocaleString("zh-CN", { timeZone: tz })}` : ""}`)
          }
        }
      } catch { /* 副本 JSON 容错 */ }
    }
    lines.push("----------------------------------------------------------------")
  })

  lines.push("")
  lines.push(`本清单由 Dockyard 平台自动生成（共 ${records.length} 份备份）`)

  const body = lines.join("\r\n") + "\r\n"
  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username,
    operationType: "BACKUP_MANIFEST_EXPORT",
    resourceType: "BACKUP",
    after: { count: records.length, baseUrl: base },
    severity: "INFO",
  }).catch(() => null)

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="dockyard-backup-manifest-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}.txt"`,
      "Cache-Control": "no-store",
    },
  })
}
