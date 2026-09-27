import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { McpTasksTable, type McpTaskRow } from "./mcp-tasks-table"
import { MessageSquareCode, PlayCircle, CheckCircle2, Percent } from "lucide-react"

// MCP 任务管理视图（管理员）：只读监控 + 取消 / 重试入队（执行引擎在 /api/mcp）
export const metadata = { title: "MCP 任务" }

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

  // 发起用户 join
  const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean) as string[])]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(users.map((u) => [u.id, u.username]))

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
    username: r.userId ? usernameById.get(r.userId) || "-" : "-",
    createdAt: fmtDate(r.createdAt),
    finishedAt: r.finishedAt ? fmtDate(r.finishedAt) : null,
  }))

  const finished = statSuccess + statFailed
  const rate = finished > 0 ? Math.round((statSuccess / finished) * 1000) / 10 : 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MCP 任务</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全用户 MCP 批量任务监控：进度 / 子项 / 失败原因；执行引擎由 /api/mcp 负责，此处为管理视图
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="总任务数" value={statTotal} sub="全部用户" icon={<MessageSquareCode className="h-4 w-4" />} />
        <StatCard title="进行中" value={statRunning} sub="PENDING + RUNNING + PAUSED" icon={<PlayCircle className="h-4 w-4" />} tone={statRunning > 0 ? "warning" : "default"} />
        <StatCard title="成功完成" value={statSuccess} sub="SUCCESS" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="成功率" value={`${rate}%`} sub={`成功 ${statSuccess} / 已结束 ${finished}`} icon={<Percent className="h-4 w-4" />} tone={rate >= 90 ? "success" : rate >= 60 ? "warning" : "danger"} />
      </div>

      <McpTasksTable
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
