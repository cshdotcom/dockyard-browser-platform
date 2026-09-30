import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { TaskTabs } from "./task-tabs"
import { TasksTable, type TaskRow } from "./tasks-table"
import { TaskLogsTable, type TaskLogRow } from "./task-logs-table"
import { Clock, PlayCircle, Timer, TriangleAlert } from "lucide-react"

// 定时任务管理（管理员）：任务列表 / 执行日志
export const metadata = { title: "定时任务" }

export default async function AdminTasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = f.tab === "logs" ? "logs" : "list"

  const tasks = await db.scheduleTask.findMany({ orderBy: { code: "asc" } })
  const dayAgo = new Date(Date.now() - 86400_000)
  const [exec24h, failed24h] = await Promise.all([
    db.scheduleTaskLog.count({ where: { startAt: { gte: dayAgo } } }),
    db.scheduleTaskLog.count({ where: { startAt: { gte: dayAgo }, status: { in: ["FAILED", "TIMEOUT"] } } }),
  ])

  const taskRows: TaskRow[] = tasks.map((t) => ({
    code: t.code,
    id: t.code, // DataTable 需要 id
    name: t.name,
    cronExpr: t.cronExpr,
    enabled: t.enabled,
    timeoutSec: t.timeoutSec,
    dependsOn: t.dependsOn,
    consecutiveFails: t.consecutiveFails,
    lastExecuteAt: t.lastExecuteAt ? fmtDate(t.lastExecuteAt) : null,
    lastResult: t.lastResult,
    avgDurationMs: t.avgDurationMs,
  }))

  const stats = (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard title="任务总数" value={tasks.length} sub={`启用 ${tasks.filter((t) => t.enabled).length} 个`} icon={<Clock className="h-4 w-4" />} />
      <StatCard title="24h 执行次数" value={exec24h} sub="含 CRON + 手动" icon={<PlayCircle className="h-4 w-4" />} />
      <StatCard title="24h 平均耗时" value="-" sub="见任务列表平均耗时列" icon={<Timer className="h-4 w-4" />} />
      <StatCard title="24h 失败/超时" value={failed24h} sub="FAILED + TIMEOUT" icon={<TriangleAlert className="h-4 w-4" />} tone={failed24h > 0 ? "danger" : "success"} />
    </div>
  )

  if (tab === "logs") {
    // ---- 执行日志页签 ----
    const where: Record<string, unknown> = {}
    if (f.taskCode) where.taskCode = f.taskCode
    if (f.status) where.status = f.status
    if (q.keyword) where.taskCode = { contains: q.keyword }

    const [rows, total] = await Promise.all([
      db.scheduleTaskLog.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["startAt", "durationMs", "itemsProcessed"], { startAt: "desc" }),
      }),
      db.scheduleTaskLog.count({ where }),
    ])

    const logRows: TaskLogRow[] = rows.map((l) => ({
      id: l.id,
      taskCode: l.taskCode,
      triggerType: l.triggerType,
      status: l.status,
      startAt: fmtDate(l.startAt),
      endAt: l.endAt ? fmtDate(l.endAt) : null,
      durationMs: l.durationMs,
      itemsProcessed: l.itemsProcessed,
      summary: l.summary,
      errorStack: l.errorStack,
    }))

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">定时任务</h1>
          <p className="text-sm text-muted-foreground mt-1">
            平台后台任务调度中心：任务启停 / 手动执行 / cron 编辑 / 执行日志检索（触发方式 / 状态 / 耗时 / 错误堆栈）
          </p>
        </div>
        {stats}
        <TaskTabs tab="logs">
          <TaskLogsTable
            rows={logRows}
            total={total}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            taskOptions={tasks.map((t) => ({ label: `${t.code}（${t.name}）`, value: t.code }))}
          />
        </TaskTabs>
      </div>
    )
  }

  // ---- 任务列表页签（默认） ----
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">定时任务</h1>
        <p className="text-sm text-muted-foreground mt-1">
          平台后台任务调度中心：任务启停 / 手动执行 / cron 编辑 / 执行日志检索（触发方式 / 状态 / 耗时 / 错误堆栈）
        </p>
      </div>
      {stats}
      <TaskTabs tab="list">
        <TasksTable rows={taskRows} />
      </TaskTabs>
    </div>
  )
}
