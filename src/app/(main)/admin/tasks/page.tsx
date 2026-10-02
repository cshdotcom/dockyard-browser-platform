import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { TaskTabs } from "./task-tabs"
import { TasksTable, type TaskRow } from "./tasks-table"
import { TaskLogsTable, type TaskLogRow } from "./task-logs-table"
import { Clock, PlayCircle, Timer, TriangleAlert } from "lucide-react"

// 定时任务管理（管理员）：任务列表（r23-b：分页/搜索/筛选/排序/批量操作/自定义任务 CRUD）/ 执行日志（日期范围/触发类型/清理）
export const metadata = { title: "定时任务" }

// 任务列表允许的排序字段白名单（防注入）
const TASK_SORT_FIELDS = ["name", "code", "lastExecuteAt", "nextRunAt", "avgDurationMs"]
const LOG_SORT_FIELDS = ["startAt", "durationMs", "itemsProcessed"]
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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
  const focusParam = Array.isArray(sp.focus) ? sp.focus[0] : sp.focus
  const focus = focusParam && typeof focusParam === "string" ? focusParam : undefined

  // ---- 顶部统计（全库口径，不随筛选变化） ----
  const dayAgo = new Date(Date.now() - 86400_000)
  const [exec24h, failed24h, avg24h, totalTasks, enabledTasks, customTasks, taskOptions] = await Promise.all([
    db.scheduleTaskLog.count({ where: { startAt: { gte: dayAgo } } }),
    db.scheduleTaskLog.count({ where: { startAt: { gte: dayAgo }, status: { in: ["FAILED", "TIMEOUT"] } } }),
    db.scheduleTaskLog.aggregate({ where: { startAt: { gte: dayAgo }, durationMs: { not: null } }, _avg: { durationMs: true } }),
    db.scheduleTask.count(),
    db.scheduleTask.count({ where: { enabled: true } }),
    db.scheduleTask.count({ where: { isCustom: true } }),
    db.scheduleTask.findMany({ select: { code: true, name: true, isCustom: true }, orderBy: { code: "asc" } }),
  ])
  const avg24hMs = avg24h._avg.durationMs

  const stats = (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard title="任务总数" value={totalTasks} sub={`启用 ${enabledTasks} 个 · 自定义 ${customTasks} 个`} icon={<Clock className="h-4 w-4" />} />
      <StatCard title="24h 执行次数" value={exec24h} sub="含 CRON + 手动" icon={<PlayCircle className="h-4 w-4" />} />
      <StatCard title="24h 平均耗时" value={avg24hMs != null ? `${(avg24hMs / 1000).toFixed(2)}s` : "-"} sub="近24h完成执行的平均时长" icon={<Timer className="h-4 w-4" />} />
      <StatCard title="24h 失败/超时" value={failed24h} sub="FAILED + TIMEOUT" icon={<TriangleAlert className="h-4 w-4" />} tone={failed24h > 0 ? "danger" : "success"} />
    </div>
  )

  if (tab === "logs") {
    // ---- 执行日志页签（r23-b：+ 日期范围 + 触发类型筛选） ----
    const where: Record<string, unknown> = {}
    if (q.keyword) where.taskCode = { contains: q.keyword }
    else if (f.taskCode) where.taskCode = f.taskCode
    if (f.status) where.status = f.status
    if (f.triggerType === "CRON" || f.triggerType === "MANUAL") where.triggerType = f.triggerType
    const startAtRange: Record<string, Date> = {}
    if (DATE_RE.test(f.logFrom || "")) {
      const d = new Date(`${f.logFrom}T00:00:00`)
      if (Number.isFinite(d.getTime())) startAtRange.gte = d
    }
    if (DATE_RE.test(f.logTo || "")) {
      const d = new Date(`${f.logTo}T23:59:59.999`)
      if (Number.isFinite(d.getTime())) startAtRange.lte = d
    }
    if (Object.keys(startAtRange).length > 0) where.startAt = startAtRange

    const [rows, total] = await Promise.all([
      db.scheduleTaskLog.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, LOG_SORT_FIELDS, { startAt: "desc" }),
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
            平台后台任务调度中心：任务启停 / 手动执行 / cron 编辑 / 自定义任务 / 批量操作 / 执行日志检索（日期范围 / 触发方式 / 状态 / 错误堆栈）
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
            taskOptions={taskOptions.map((t) => ({
              label: `${t.code}（${t.name}）${t.isCustom ? " · 自定义" : ""}`,
              value: t.code,
            }))}
          />
        </TaskTabs>
      </div>
    )
  }

  // ---- 任务列表页签（默认；r23-b：分页 + 搜索 + 筛选 + 排序） ----
  const where: Record<string, unknown> = {}
  const kw = q.keyword?.trim()
  if (kw) where.OR = [{ name: { contains: kw } }, { code: { contains: kw } }, { description: { contains: kw } }]
  if (f.taskEnabled === "enabled") where.enabled = true
  else if (f.taskEnabled === "disabled") where.enabled = false
  if (f.taskKind === "custom") where.isCustom = true
  else if (f.taskKind === "builtin") where.isCustom = false
  // lastResult 形如 "SUCCESS 摘要…" / "FAILED 原因…"
  if (f.taskStatus === "success") where.lastResult = { contains: "SUCCESS" }
  else if (f.taskStatus === "failed") where.lastResult = { contains: "FAILED" }

  const [rows, total] = await Promise.all([
    db.scheduleTask.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, TASK_SORT_FIELDS, { code: "asc" }),
    }),
    db.scheduleTask.count({ where }),
  ])

  // 创建人用户名映射（ScheduleTask.createdByUserId 无外键关联，手工回查）
  const creatorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))]
  const creators = creatorIds.length > 0
    ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } })
    : []
  const creatorMap = new Map(creators.map((u) => [u.id, u.username]))

  const taskRows: TaskRow[] = rows.map((t) => ({
    code: t.code,
    id: t.code, // DataTable 需要 id
    name: t.name,
    isCustom: t.isCustom,
    taskType: t.taskType,
    description: t.description,
    createdByUsername: t.createdByUserId ? (creatorMap.get(t.createdByUserId) ?? null) : null,
    cronExpr: t.cronExpr,
    enabled: t.enabled,
    timeoutSec: t.timeoutSec,
    dependsOn: t.dependsOn,
    consecutiveFails: t.consecutiveFails,
    lastExecuteAt: t.lastExecuteAt ? fmtDate(t.lastExecuteAt) : null,
    lastResult: t.lastResult,
    avgDurationMs: t.avgDurationMs,
    nextRunAt: t.nextRunAt ? fmtDate(t.nextRunAt) : null,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">定时任务</h1>
        <p className="text-sm text-muted-foreground mt-1">
          平台后台任务调度中心：任务启停 / 手动执行 / cron 编辑 / 自定义任务 / 批量操作 / 执行日志检索（日期范围 / 触发方式 / 状态 / 错误堆栈）
        </p>
      </div>
      {stats}
      <TaskTabs tab="list">
        <TasksTable
          rows={taskRows}
          total={total}
          page={q.page}
          pageSize={q.pageSize}
          keyword={q.keyword}
          sortField={q.sortField}
          sortOrder={q.sortOrder}
          filters={f}
          focus={focus}
        />
      </TaskTabs>
    </div>
  )
}
