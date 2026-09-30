import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { McpTasksTable, type McpTaskRow } from "./mcp-tasks-table"
import { McpDashboardCharts, type McpStatusSlice, type McpTrendPoint, type McpCodeBar, type McpUserBar } from "./mcp-dashboard-charts"
import { MessageSquareCode, PlayCircle, CheckCircle2, Percent, Timer, Layers3 } from "lucide-react"

// MCP 任务管理视图（管理员）：只读监控 + 取消 / 重试入队（执行引擎在 /api/mcp）
// 看板增强：状态分布环形图 / 14天趋势 / 操作类型Top / 发起用户Top / 平均耗时 / 子项汇总
export const metadata = { title: "MCP 任务" }

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#64748b",
  RUNNING: "#0d9488",
  PAUSED: "#d97706",
  SUCCESS: "#059669",
  PARTIAL: "#ca8a04",
  FAILED: "#dc2626",
  ROLLED_BACK: "#8b5cf6",
  CANCELLED: "#94a3b8",
}

export default async function AdminMcpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  const where: Record<string, unknown> = {}
  if (q.keyword) {
    where.OR = [{ taskUuid: { contains: q.keyword } }, { name: { contains: q.keyword } }, { code: { contains: q.keyword } }]
  }
  if (f.status) where.status = f.status
  if (f.priority) where.priority = f.priority
  if (f.userId) where.userId = f.userId

  const [rows, total, statTotal, statRunning, statSuccess, statFailed] = await Promise.all([
    db.mcpTask.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "status", "priority", "progress", "finishedAt"], { createdAt: "desc" }),
    }),
    db.mcpTask.count({ where }),
    db.mcpTask.count(),
    db.mcpTask.count({ where: { status: { in: ["PENDING", "RUNNING", "PAUSED"] } } }),
    db.mcpTask.count({ where: { status: "SUCCESS" } }),
    db.mcpTask.count({ where: { status: { in: ["FAILED", "PARTIAL", "ROLLED_BACK"] } } }),
  ])

  // ---- 看板聚合（全量任务，不受列表筛选影响，反映平台整体画像）----
  const [statusGroups, codeGroups, userGroups, recentTasks, finishedAgg, itemAgg, userOptions] = await Promise.all([
    db.mcpTask.groupBy({ by: ["status"], _count: { _all: true } }),
    db.mcpTask.groupBy({ by: ["code"], _count: { _all: true } }),
    db.mcpTask.groupBy({ by: ["userId"], _count: { _all: true } }),
    db.mcpTask.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 14 * 24 * 3600 * 1000) } },
      select: { createdAt: true, finishedAt: true, status: true },
      take: 2000,
    }),
    db.mcpTask.findMany({
      where: { finishedAt: { not: null } },
      select: { createdAt: true, finishedAt: true, progress: true },
      take: 2000,
    }),
    db.mcpTask.aggregate({ _sum: { totalItems: true, successItems: true, failedItems: true } }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true }, take: 500 }),
  ])

  // 发起用户 join
  const userIds = [...new Set(userGroups.map((g) => g.userId).filter(Boolean) as string[])]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(users.map((u) => [u.id, u.username]))
  const userOptionsMap = new Map(userOptions.map((u) => [u.id, u.username]))

  const statusData: McpStatusSlice[] = statusGroups
    .map((g) => ({ status: g.status, count: g._count._all, color: STATUS_COLORS[g.status] || "#94a3b8" }))
    .sort((a, b) => b.count - a.count)

  const trendData: McpTrendPoint[] = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.now() - (13 - i) * 24 * 3600 * 1000)
    const key = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
    return { day: key, created: 0, finished: 0 }
  })
  const trendIndex = new Map(trendData.map((p) => [p.day, p]))
  for (const t of recentTasks) {
    const ck = `${String(t.createdAt.getMonth() + 1).padStart(2, "0")}-${String(t.createdAt.getDate()).padStart(2, "0")}`
    const point = trendIndex.get(ck)
    if (point) point.created++
    if (t.finishedAt) {
      const fk = `${String(t.finishedAt.getMonth() + 1).padStart(2, "0")}-${String(t.finishedAt.getDate()).padStart(2, "0")}`
      const fp = trendIndex.get(fk)
      if (fp) fp.finished++
    }
  }

  const codeData: McpCodeBar[] = codeGroups
    .map((g) => ({ code: g.code, count: g._count._all, success: 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const userData: McpUserBar[] = userGroups
    .map((g) => ({ username: g.userId ? usernameById.get(g.userId) || g.userId.slice(0, 8) : "(系统)", count: g._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // 平均耗时 / 平均进度（已结束任务）
  const finishedCount = finishedAgg.length
  const avgDurationMs = finishedCount > 0
    ? finishedAgg.reduce((acc, t) => acc + (t.finishedAt!.getTime() - t.createdAt.getTime()), 0) / finishedCount
    : 0
  const avgProgress = finishedCount > 0 ? finishedAgg.reduce((acc, t) => acc + t.progress, 0) / finishedCount : 0

  const list: McpTaskRow[] = rows.map((r) => ({
    id: r.id,
    taskUuid: r.taskUuid,
    name: r.name,
    code: r.code,
    priority: r.priority,
    status: r.status,
    progress: r.progress,
    totalItems: r.totalItems,
    successItems: r.successItems,
    failedItems: r.failedItems,
    username: r.userId ? userOptionsMap.get(r.userId) || "-" : "-",
    createdAt: fmtDate(r.createdAt),
    finishedAt: r.finishedAt ? fmtDate(r.finishedAt) : null,
  }))

  const finished = statSuccess + statFailed
  const rate = finished > 0 ? Math.round((statSuccess / finished) * 1000) / 10 : 0
  const fmtDur = avgDurationMs > 0 ? (avgDurationMs >= 60_000 ? `${Math.round(avgDurationMs / 6000) / 10} 分` : `${Math.round(avgDurationMs / 100) / 10} 秒`) : "—"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MCP 任务</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全用户 MCP 批量任务监控：进度 / 子项 / 失败原因；执行引擎由 /api/mcp 负责，此处为管理视图
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard title="总任务数" value={statTotal} sub="全部用户" icon={<MessageSquareCode className="h-4 w-4" />} />
        <StatCard title="进行中" value={statRunning} sub="PENDING + RUNNING + PAUSED" icon={<PlayCircle className="h-4 w-4" />} tone={statRunning > 0 ? "warning" : "default"} />
        <StatCard title="成功完成" value={statSuccess} sub="SUCCESS" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="成功率" value={`${rate}%`} sub={`成功 ${statSuccess} / 已结束 ${finished}`} icon={<Percent className="h-4 w-4" />} tone={rate >= 90 ? "success" : rate >= 60 ? "warning" : "danger"} />
        <StatCard title="平均耗时" value={fmtDur} sub={`${finishedCount} 个已结束任务`} icon={<Timer className="h-4 w-4" />} />
        <StatCard
          title="子项汇总"
          value={(itemAgg._sum.totalItems || 0) + (itemAgg._sum.successItems || 0) + (itemAgg._sum.failedItems || 0)}
          sub={`成功 ${(itemAgg._sum.successItems || 0)} · 失败 ${(itemAgg._sum.failedItems || 0)} · 总计 ${(itemAgg._sum.totalItems || 0)}`}
          icon={<Layers3 className="h-4 w-4" />}
        />
      </div>

      <McpDashboardCharts statusData={statusData} trendData={trendData} codeData={codeData} userData={userData} />

      <McpTasksTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        userOptions={userOptions.map((u) => ({ id: u.id, name: u.username }))}
      />
    </div>
  )
}
