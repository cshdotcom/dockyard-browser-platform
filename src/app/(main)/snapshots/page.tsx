import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { getConfigNumber } from "@/lib/config"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate, fmtBytes } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { Camera, HardDrive, Layers, Package } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SnapshotsTable, type SnapshotRow } from "./snapshots-table"

// 快照管理：自己的 + 可见共享快照；统计卡片（总数/总大小/磁盘配额使用）
export const metadata = { title: "快照管理" }

export default async function SnapshotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  const gids = await userGroupIds(ctx.userId)

  // 可见范围：自己的 / GLOBAL / 我所在组 GROUP（与模板一致的可见性模型）
  const visibility = {
    OR: [
      { scope: "GLOBAL" },
      { scope: "GROUP", groupId: { in: gids } },
      { userId: ctx.userId },
    ],
  }
  const where: Record<string, unknown> = { deletedAt: null }
  if (f.scope) where.scope = f.scope
  if (q.keyword) {
    where.AND = [
      visibility,
      { OR: [{ name: { contains: q.keyword } }] },
    ]
  } else {
    Object.assign(where, visibility)
  }

  const [rows, total, myTotal, totalSizeAgg, diskUsedAgg, quotaPerUserMb] = await Promise.all([
    db.browserProfileSnapshot.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "sizeBytes", "expireAt"], { createdAt: "desc" }),
    }),
    db.browserProfileSnapshot.count({ where }),
    db.browserProfileSnapshot.count({ where: { userId: ctx.userId, deletedAt: null } }),
    db.browserProfileSnapshot.aggregate({ where: { userId: ctx.userId, deletedAt: null }, _sum: { sizeBytes: true } }),
    db.fileMeta.aggregate({ where: { userId: ctx.userId, deletedAt: null }, _sum: { size: true } }),
    getConfigNumber("storage.quotaPerUserMb", 2048),
  ])

  const mySizeBytes = totalSizeAgg._sum.sizeBytes || 0
  const diskUsedBytes = diskUsedAgg._sum.size || 0
  const diskUsedMb = diskUsedBytes / (1024 * 1024)
  const diskPct = Math.min(100, Math.round((diskUsedMb / Math.max(quotaPerUserMb, 1)) * 100))

  // 来源工作区名称（内存 join）
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter((v): v is string => !!v))]
  const workspaces = workspaceIds.length
    ? await db.browserWorkspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true, status: true } })
    : []
  const wsMap = new Map<string, { name: string; status: string }>(workspaces.map((w): [string, { name: string; status: string }] => [w.id, { name: w.name, status: w.status }]))

  const now = Date.now()
  const list: SnapshotRow[] = rows.map((s) => {
    const ws = s.workspaceId ? wsMap.get(s.workspaceId) : undefined
    return {
      id: s.id,
      name: s.name,
      scope: s.scope,
      scopeLabel: s.scope === "PRIVATE" ? "私有" : s.scope === "GROUP" ? "组共享" : "全局",
      sizeBytes: s.sizeBytes,
      sizeLabel: fmtBytes(s.sizeBytes),
      workspaceName: ws?.name || (s.workspaceId ? "已删除工作区" : "—"),
      workspaceStatus: ws?.status || null,
      isOwner: s.userId === ctx.userId,
      expireAt: s.expireAt ? fmtDate(s.expireAt) : "永不过期",
      expireAtIso: s.expireAt ? s.expireAt.toISOString() : null,
      expired: !!s.expireAt && s.expireAt.getTime() <= now,
      createdAt: fmtDate(s.createdAt),
    }
  })

  // 创建快照候选：自己 RUNNING 状态的 cdp_light 工作区
  const runnableWorkspaces = await db.browserWorkspace.findMany({
    where: { userId: ctx.userId, mode: "cdp_light", status: "RUNNING", deletedAt: null },
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">快照管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          浏览器配置快照（Cookie / LocalStorage / 指纹配置），可从运行中的工作区导出生成
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="可见快照" value={total} sub={`当前筛选 ${total} 条`} icon={<Camera className="h-4 w-4" />} />
        <StatCard title="我的快照" value={myTotal} sub={`共 ${fmtBytes(mySizeBytes)}`} icon={<Package className="h-4 w-4" />} />
        <StatCard title="我的快照总大小" value={fmtBytes(mySizeBytes)} sub="未删除快照合计" icon={<Layers className="h-4 w-4" />} tone="success" />
        <StatCard
          title="磁盘配额使用"
          value={`${diskUsedMb.toFixed(1)} MB`}
          sub={`上限 ${quotaPerUserMb} MB · ${diskPct}%`}
          icon={<HardDrive className="h-4 w-4" />}
          tone={diskPct >= 90 ? "danger" : diskPct >= 70 ? "warning" : "default"}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> 磁盘配额用量
          </CardTitle>
          <CardDescription>个人全部文件（含快照归档、上传文件）对比全局配额 storage.quotaPerUserMb</CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={diskPct} className="h-2.5" aria-label={`磁盘配额使用 ${diskPct}%`} />
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            {fmtBytes(diskUsedBytes)} / {quotaPerUserMb} MB · {diskPct}%{diskPct >= 90 ? "（接近上限，请清理过期快照）" : ""}
          </p>
        </CardContent>
      </Card>

      <SnapshotsTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        runnableWorkspaces={runnableWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
      />
    </div>
  )
}
