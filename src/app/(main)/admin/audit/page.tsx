import { db } from "@/lib/db"
import { requireRole } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { AuditTable, type AuditRow, type SecurityRow } from "./audit-table"
import { ScrollText, ShieldAlert, Activity, TriangleAlert } from "lucide-react"

// 审计日志与安全事件（SUPER_ADMIN/ADMIN/GROUP_ADMIN 只读查询）
export const metadata = { title: "审计日志" }

function toDate(v?: string): Date | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = f.tab === "security" ? "security" : "audit"

  const from = toDate(f.from) || new Date(Date.now() - 7 * 86400_000)
  const toRaw = toDate(f.to)
  const to = toRaw ? new Date(toRaw.getTime() + 86399_000) : new Date()

  if (tab === "security") {
    // ---- 安全事件页签 ----
    const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } }
    if (q.keyword) where.OR = [{ username: { contains: q.keyword } }, { detail: { contains: q.keyword } }]
    if (f.eventType) where.eventType = { contains: f.eventType }
    if (f.success) where.success = f.success === "true"

    const [rows, total, eventCount24h, failedCount24h] = await Promise.all([
      db.securityEvent.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["createdAt", "eventType"], { createdAt: "desc" }),
      }),
      db.securityEvent.count({ where }),
      db.securityEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
      db.securityEvent.count({ where: { success: false, createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
    ])

    const list: SecurityRow[] = rows.map((e) => ({
      id: e.id,
      userId: e.userId,
      username: e.username,
      eventType: e.eventType,
      success: e.success,
      ip: e.ip,
      userAgent: e.userAgent,
      detail: e.detail,
      traceId: e.traceId,
      createdAt: fmtDate(e.createdAt),
    }))

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">审计日志</h1>
          <p className="text-sm text-muted-foreground mt-1">
            只读安全视图：登录 / 2FA / 密码 / 设备等安全事件全量检索（不可篡改）
          </p>
        </div>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="安全事件总数" value={total} sub="当前筛选范围" icon={<ShieldAlert className="h-4 w-4" />} />
          <StatCard title="24h 事件" value={eventCount24h} sub="最近一天" icon={<Activity className="h-4 w-4" />} />
          <StatCard title="24h 失败事件" value={failedCount24h} sub="失败登录/验证" icon={<TriangleAlert className="h-4 w-4" />} tone={failedCount24h > 0 ? "danger" : "success"} />
          <StatCard title="当前页签" value="安全事件" sub="切换页签查看审计日志" icon={<ScrollText className="h-4 w-4" />} />
        </div>
        <AuditTable tab="security" securityRows={list} total={total} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} />
      </div>
    )
  }

  // ---- 审计日志页签 ----
  const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } }
  if (q.keyword) {
    where.OR = [
      { operatorName: { contains: q.keyword } },
      { resourceName: { contains: q.keyword } },
      { operationType: { contains: q.keyword } },
    ]
  }
  if (f.operator) where.operatorName = { contains: f.operator }
  if (f.operationType) where.operationType = { contains: f.operationType }
  if (f.resourceType) where.resourceType = { contains: f.resourceType }
  if (f.resourceId) where.resourceId = { contains: f.resourceId }
  if (f.severity) where.severity = f.severity

  const [rows, total, totalAudit, warnCount, criticalCount] = await Promise.all([
    db.auditLog.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "operationType", "severity"], { createdAt: "desc" }),
    }),
    db.auditLog.count({ where }),
    db.auditLog.count(),
    db.auditLog.count({ where: { severity: "WARN" } }),
    db.auditLog.count({ where: { severity: { in: ["CRITICAL", "DANGER"] } } }),
  ])

  const list: AuditRow[] = rows.map((a) => ({
    id: a.id,
    traceId: a.traceId,
    operatorUserId: a.operatorUserId,
    operatorName: a.operatorName,
    operationType: a.operationType,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    resourceName: a.resourceName,
    ownerUserId: a.ownerUserId,
    createdByUserId: a.createdByUserId,
    clientIp: a.clientIp,
    severity: a.severity,
    beforeJson: a.beforeJson,
    afterJson: a.afterJson,
    extraJson: a.extraJson,
    createdAt: fmtDate(a.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">审计日志</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全平台操作审计（只插入不可改删）：支持按资源ID追踪完整操作链路 / JSON diff / CSV导出
        </p>
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="审计记录总数" value={totalAudit} sub="全量（不可篡改）" icon={<ScrollText className="h-4 w-4" />} />
        <StatCard title="当前筛选结果" value={total} sub="时间/操作人/资源维度" icon={<Activity className="h-4 w-4" />} />
        <StatCard title="WARN 级记录" value={warnCount} sub="全量警告级" icon={<TriangleAlert className="h-4 w-4" />} tone="warning" />
        <StatCard title="CRITICAL 级记录" value={criticalCount} sub="全量严重级" icon={<ShieldAlert className="h-4 w-4" />} tone={criticalCount > 0 ? "danger" : "default"} />
      </div>
      <AuditTable tab="audit" auditRows={list} total={total} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} />
    </div>
  )
}
