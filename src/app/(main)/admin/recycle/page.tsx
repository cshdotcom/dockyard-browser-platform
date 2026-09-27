import Link from "next/link"
import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { RecycleTable, type RecycleRow } from "./recycle-table"
import { Recycle, RotateCcw, Lock, Trash2, Info } from "lucide-react"
import { cn } from "@/lib/utils"

// 回收站（管理员）：未恢复 / 已恢复 双页签 + 全量管理操作
export const metadata = { title: "回收站" }

export default async function AdminRecyclePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = f.tab === "restored" ? "restored" : "pending"

  const where: Record<string, unknown> = tab === "restored" ? { restoredAt: { not: null } } : { restoredAt: null }
  if (q.keyword) {
    where.OR = [
      { resourceName: { contains: q.keyword } },
      { resourceId: { contains: q.keyword } },
    ]
  }
  if (f.resourceType) where.resourceType = f.resourceType
  if (f.deletedByType) where.deletedByType = f.deletedByType
  if (f.owner) {
    const owners = await db.user.findMany({ where: { username: { contains: f.owner } }, select: { id: true } })
    where.ownerUserId = { in: owners.map((u) => u.id).concat("__none__") }
  }
  if (f.creator) {
    const creators = await db.user.findMany({ where: { username: { contains: f.creator } }, select: { id: true } })
    where.createdByUserId = { in: creators.map((u) => u.id).concat("__none__") }
  }

  const [rows, total, statPending, statLocked, statDueSoon, statAllTypes] = await Promise.all([
    db.recycleBin.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "purgeAt", "recoverDeadline"], { createdAt: "desc" }),
    }),
    db.recycleBin.count({ where }),
    db.recycleBin.count({ where: { restoredAt: null } }),
    db.recycleBin.count({ where: { restoredAt: null, locked: true } }),
    db.recycleBin.count({ where: { restoredAt: null, locked: false, purgeAt: { lt: new Date(Date.now() + 86400_000) } } }),
    db.recycleBin.findMany({ where: { restoredAt: null }, select: { resourceType: true } }),
  ])

  // ---- 内存 join：删除人/所有者/创建人用户名 ----
  const userIds = [...new Set(rows.flatMap((r) => [r.deletedByUserId, r.ownerUserId, r.createdByUserId].filter(Boolean) as string[]))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(users.map((u) => [u.id, u.username]))

  const typeCounts: Record<string, number> = {}
  for (const t of statAllTypes) typeCounts[t.resourceType] = (typeCounts[t.resourceType] || 0) + 1

  const list: RecycleRow[] = rows.map((r) => ({
    id: r.id,
    resourceType: r.resourceType,
    resourceName: r.resourceName,
    resourceId: r.resourceId,
    ownerUsername: r.ownerUserId ? usernameById.get(r.ownerUserId) || "-" : "-",
    creatorUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
    deletedByUsername: r.deletedByUserId ? usernameById.get(r.deletedByUserId) || "-" : "-",
    deletedByType: r.deletedByType,
    reason: r.reason,
    locked: r.locked,
    recoverDeadline: r.recoverDeadline ? fmtDate(r.recoverDeadline) : null,
    purgeAt: r.purgeAt ? fmtDate(r.purgeAt) : null,
    restoredAt: r.restoredAt ? fmtDate(r.restoredAt) : null,
    createdAt: fmtDate(r.createdAt),
  }))

  const typeBadges = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">回收站</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全站删除资源的封存与处置中枢：恢复 / 物理清除 / 锁定保护 / 延期 / 一键清空
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="待处置条目" value={statPending} sub="未恢复" icon={<Recycle className="h-4 w-4" />} />
        <StatCard title="锁定保护" value={statLocked} sub="禁止自动过期/用户恢复" icon={<Lock className="h-4 w-4" />} tone={statLocked > 0 ? "warning" : "default"} />
        <StatCard title="24h 内到期清除" value={statDueSoon} sub="未锁定" icon={<Trash2 className="h-4 w-4" />} tone={statDueSoon > 0 ? "danger" : "default"} />
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">封存类型分布</p>
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {typeBadges.length > 0 ? (
              typeBadges.map(([t, c]) => (
                <span key={t} className="text-xs rounded-md border px-1.5 py-0.5 bg-muted/50">{t} ×{c}</span>
              ))
            ) : (
              <span className="text-2xl font-semibold tabular-nums text-foreground">0</span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p><span className="font-medium text-foreground">物理删除不可恢复。</span>单条清除与一键清空将执行数据库硬删除。</p>
          <p><span className="font-medium text-foreground">锁定保护期间</span>禁止自动过期删除、用户恢复与用户删除，仅管理员可解锁。</p>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b">
        <Link
          href={`/admin/recycle?tab=pending`}
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "pending" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          待处置（未恢复）
        </Link>
        <Link
          href={`/admin/recycle?tab=restored`}
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "restored" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          已恢复
        </Link>
      </div>

      <RecycleTable
        tab={tab}
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
      />
    </div>
  )
}
