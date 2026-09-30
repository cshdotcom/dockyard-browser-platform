import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate, fmtBytes } from "@/lib/utils-server"
import { getConfigNumber } from "@/lib/config"
import { StatCard } from "@/components/shared/confirm"
import { BackupsTable, type BackupRow } from "./backups-table"
import { DatabaseBackup, History, HardDrive, Layers } from "lucide-react"

// 备份恢复管理（管理员可查看/备份，仅超级管理员可恢复）
export const metadata = { title: "备份恢复" }

export default async function AdminBackupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  const where: Record<string, unknown> = {}
  if (f.type) where.type = f.type
  if (f.status) where.status = f.status
  if (q.keyword) where.OR = [{ fileMetaId: { contains: q.keyword } }, { id: { contains: q.keyword } }]

  const [rows, total, retentionCount, allCount] = await Promise.all([
    db.backupRecord.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "sizeBytes", "type", "status"], { createdAt: "desc" }),
    }),
    db.backupRecord.count({ where }),
    getConfigNumber("backup.retentionCount", 7),
    db.backupRecord.count({ where: { status: { not: "FAILED" } } }),
  ])

  // 备份文件元数据（内存 join）
  const fileMetaIds = [...new Set(rows.map((r) => r.fileMetaId))]
  const fileMetas = fileMetaIds.length
    ? await db.fileMeta.findMany({ where: { id: { in: fileMetaIds } }, select: { id: true, fileName: true, deletedAt: true } })
    : []
  const fileMetaById = new Map(fileMetas.map((fm) => [fm.id, fm]))

  // 创建人用户名
  const creatorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))]
  const creators = creatorIds.length
    ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } })
    : []
  const creatorMap = new Map(creators.map((c) => [c.id, c.username]))

  const list: BackupRow[] = rows.map((b) => {
    const fm = fileMetaById.get(b.fileMetaId)
    return {
      id: b.id,
      fileMetaId: b.fileMetaId,
      fileName: fm?.fileName || b.fileMetaId,
      fileDeleted: !!fm?.deletedAt,
      type: b.type,
      encrypted: b.encrypted,
      sizeBytes: b.sizeBytes,
      sizeText: fmtBytes(b.sizeBytes),
      checksum: b.checksum,
      status: b.status,
      createdByUserId: b.createdByUserId,
      creatorName: b.createdByUserId ? creatorMap.get(b.createdByUserId) || b.createdByUserId : "系统",
      createdAt: fmtDate(b.createdAt),
    }
  })

  // 统计卡片：备份总数 / 最近一次 / 总占用
  const lastBackup = await db.backupRecord.findFirst({ orderBy: { createdAt: "desc" } })
  const totalSizeAgg = await db.backupRecord.aggregate({ _sum: { sizeBytes: true } })
  const oldCount = Math.max(0, allCount - retentionCount)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">备份恢复</h1>
        <p className="text-sm text-muted-foreground mt-1">
          SQLite 全库备份（可选 AES-256-GCM 加密）/ 保留策略 / 高危恢复（强确认 + 全程 CRITICAL 审计）
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="备份总数" value={allCount} sub={`当前筛选 ${total} 条`} icon={<DatabaseBackup className="h-4 w-4" />} />
        <StatCard title="最近一次备份" value={lastBackup ? fmtDate(lastBackup.createdAt) : "从未备份"} sub={lastBackup ? `${lastBackup.type} · ${fmtBytes(lastBackup.sizeBytes)}` : "建议立即执行首次备份"} icon={<History className="h-4 w-4" />} />
        <StatCard title="备份总占用" value={fmtBytes(totalSizeAgg._sum.sizeBytes || 0)} sub="含加密备份密文体积" icon={<HardDrive className="h-4 w-4" />} />
        <StatCard title="超出保留策略" value={oldCount} sub={`保留份数 ${retentionCount} 份，多余 ${oldCount} 份待清理`} icon={<Layers className="h-4 w-4" />} tone={oldCount > 0 ? "warning" : "success"} />
      </div>

      <BackupsTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        canRestore={ctx.role === "SUPER_ADMIN"}
        retentionCount={retentionCount}
        oldCount={oldCount}
      />
    </div>
  )
}
