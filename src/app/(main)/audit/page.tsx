import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { AuditTable, type AuditRow } from "../admin/audit/audit-table"
import { History, Activity, ShieldCheck, TriangleAlert } from "lucide-react"

// ============================================================
// 最近操作审计（所有登录用户，权限分级）：
//   · 普通用户（USER）—— 只能看到自己的操作审计（server 端强制 operatorUserId=自己，
//     任何筛选/搜索都无法越权查看他人记录）
//   · 管理员（SUPER_ADMIN/ADMIN/GROUP_ADMIN）—— 全量记录 + 按操作人/类型/资源/时间
//     筛选与关键词搜索（与 /admin/audit 一致的数据面）
//   · 回滚按钮仅管理员可见（布尔态/策略/配额类变更可一键恢复 before 快照）
// ============================================================

export const metadata = { title: "最近操作审计" }

function toDate(v?: string): Date | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export default async function MyAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  // 权限分级：普通用户强制只看自己（服务端约束，前端无法绕过）
  const isPrivileged = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN" || ctx.role === "GROUP_ADMIN"

  const from = toDate(f.from) || new Date(Date.now() - 7 * 86400_000)
  const toRaw = toDate(f.to)
  const to = toRaw ? new Date(toRaw.getTime() + 86399_000) : new Date()

  const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } }
  if (!isPrivileged) {
    where.operatorUserId = ctx.userId
  } else {
    // 管理员：支持目标操作人筛选
    if (f.operator) where.operatorName = { contains: f.operator }
  }
  if (q.keyword) {
    const kw = { contains: q.keyword }
    where.OR = isPrivileged
      ? [{ operatorName: kw }, { resourceName: kw }, { operationType: kw }]
      : [{ resourceName: kw }, { operationType: kw }, { resourceType: kw }]
  }
  if (f.operationType) where.operationType = { contains: f.operationType }
  if (f.resourceType) where.resourceType = { contains: f.resourceType }
  if (f.resourceId) where.resourceId = { contains: f.resourceId }
  if (f.severity) where.severity = f.severity

  const [rows, total, mineTotal, mineWarn, mineRecent24h] = await Promise.all([
    db.auditLog.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "operationType", "severity"], { createdAt: "desc" }),
    }),
    db.auditLog.count({ where }),
    db.auditLog.count({ where: { operatorUserId: ctx.userId } }),
    db.auditLog.count({ where: { operatorUserId: ctx.userId, severity: { in: ["WARN", "CRITICAL", "DANGER"] } } }),
    db.auditLog.count({ where: { operatorUserId: ctx.userId, createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
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
        <h1 className="text-2xl font-semibold tracking-tight">最近操作审计</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isPrivileged
            ? "管理员视角：全平台操作审计（含其他用户），支持筛选与搜索；布尔态/策略/配额类变更可在详情中一键回滚"
            : "仅展示你自己账号的操作记录（数据面在服务端按账号隔离，无法查看他人记录）"}
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title={isPrivileged ? "当前筛选结果" : "我的操作记录"} value={total} sub={isPrivileged ? "时间/操作人/资源维度" : "最近 7 天默认窗口"} icon={<History className="h-4 w-4" />} />
        <StatCard title="我的累计操作" value={mineTotal} sub="全部历史（不可篡改）" icon={<Activity className="h-4 w-4" />} />
        <StatCard title="最近 24h" value={mineRecent24h} sub="我的操作" icon={<ShieldCheck className="h-4 w-4" />} tone="success" />
        <StatCard title="我的 WARN+ 记录" value={mineWarn} sub="警告及以上级别" icon={<TriangleAlert className="h-4 w-4" />} tone={mineWarn > 0 ? "warning" : "success"} />
      </div>

      <AuditTable tab="audit" auditRows={list} total={total} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} mine={!isPrivileged} showRollback={isPrivileged} />
    </div>
  )
}
