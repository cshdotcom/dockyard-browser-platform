import Link from "next/link"
import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { RiskListTable, type RiskRuleRow } from "./risk-list-table"
import { BehaviorTable, type BehaviorRow } from "./behavior-table"
import { ShieldAlert, ListChecks, Clock, ShieldCheck, Users, Flame, Activity } from "lucide-react"
import { cn } from "@/lib/utils"

// 风控与画像（管理员）：黑白名单 / 行为画像
export const metadata = { title: "风控与画像" }

export default async function AdminRiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = f.tab === "profile" ? "profile" : "list"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">风控与画像</h1>
        <p className="text-sm text-muted-foreground mt-1">
          IP / UA / 设备黑白名单管控与用户行为画像分析：异常高频操作自动风控触发
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        <Link
          href="/admin/risk?tab=list"
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "list" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          黑白名单
        </Link>
        <Link
          href="/admin/risk?tab=profile"
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "profile" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          行为画像
        </Link>
      </div>

      {tab === "list" ? <ListTab q={q} f={f} /> : <ProfileTab q={q} f={f} />}
    </div>
  )
}

async function ListTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = {}
  if (q.keyword) {
    where.OR = [{ value: { contains: q.keyword } }, { note: { contains: q.keyword } }]
  }
  if (f.type) where.type = f.type
  if (f.mode) where.mode = f.mode
  if (f.expired === "true") where.expiresAt = { lt: new Date() }
  if (f.expired === "false") where.OR = [{ expiresAt: null }, { expiresAt: { gte: new Date() } }]

  const [rows, total, statTotal, statTemp, statPermanent, statExpired, creators] = await Promise.all([
    db.riskListRule.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "expiresAt", "value"], { createdAt: "desc" }),
    }),
    db.riskListRule.count({ where }),
    db.riskListRule.count(),
    db.riskListRule.count({ where: { mode: "TEMP" } }),
    db.riskListRule.count({ where: { mode: "PERMANENT" } }),
    db.riskListRule.count({ where: { mode: "TEMP", expiresAt: { lt: new Date() } } }),
    db.user.findMany({ select: { id: true, username: true }, take: 300 }),
  ])
  const usernameById = new Map(creators.map((u) => [u.id, u.username]))

  const list: RiskRuleRow[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    note: r.note,
    mode: r.mode,
    expiresAt: r.expiresAt ? fmtDate(r.expiresAt) : null,
    expired: r.mode === "TEMP" && !!r.expiresAt && r.expiresAt.getTime() < Date.now(),
    createdByUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="规则总数" value={statTotal} sub="全部黑白名单" icon={<ListChecks className="h-4 w-4" />} />
        <StatCard title="临时规则" value={statTemp} sub="到期自动解封" icon={<Clock className="h-4 w-4" />} />
        <StatCard title="永久规则" value={statPermanent} sub="需手动删除" icon={<ShieldCheck className="h-4 w-4" />} />
        <StatCard title="已过期待清理" value={statExpired} sub="可手动解封" icon={<Flame className="h-4 w-4" />} tone={statExpired > 0 ? "warning" : "default"} />
      </div>
      <RiskListTable
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

async function ProfileTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = {}
  if (q.keyword) {
    const users = await db.user.findMany({ where: { username: { contains: q.keyword } }, select: { id: true } })
    where.userId = { in: users.map((u) => u.id).concat("__none__") }
  }
  if (f.riskOnly === "true") where.riskTriggers = { gt: 0 }

  const [rows, total, statUsers, statRiskTriggers, statAbnormal] = await Promise.all([
    db.userBehaviorProfile.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["riskTriggers", "abnormalOps", "resourcesCreated", "resourcesDeleted", "mcpCalls", "updatedAt"], { riskTriggers: "desc" }),
    }),
    db.userBehaviorProfile.count({ where }),
    db.userBehaviorProfile.count(),
    db.userBehaviorProfile.aggregate({ _sum: { riskTriggers: true } }),
    db.userBehaviorProfile.aggregate({ _sum: { abnormalOps: true } }),
  ])

  const userIds = rows.map((r) => r.userId)
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, role: true, enabled: true } }) : []
  const userById = new Map(users.map((u) => [u.id, u]))

  const list: BehaviorRow[] = rows.map((r) => {
    const u = userById.get(r.userId)
    return {
      id: r.id,
      userId: r.userId,
      username: u?.username || "-",
      role: u?.role || "-",
      enabled: u?.enabled ?? false,
      resourcesCreated: r.resourcesCreated,
      resourcesDeleted: r.resourcesDeleted,
      resourcesRestored: r.resourcesRestored,
      mcpCalls: r.mcpCalls,
      vncDurationMin: r.vncDurationMin,
      batchOps: r.batchOps,
      abnormalOps: r.abnormalOps,
      riskTriggers: r.riskTriggers,
      updatedAt: fmtDate(r.updatedAt),
    }
  })

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="画像用户数" value={statUsers} sub="已产生行为数据的用户" icon={<Users className="h-4 w-4" />} />
        <StatCard title="风控触发总数" value={statRiskTriggers._sum.riskTriggers || 0} sub="riskTriggers 汇总" icon={<ShieldAlert className="h-4 w-4" />} tone={(statRiskTriggers._sum.riskTriggers || 0) > 0 ? "danger" : "success"} />
        <StatCard title="异常操作总数" value={statAbnormal._sum.abnormalOps || 0} sub="abnormalOps 汇总" icon={<Activity className="h-4 w-4" />} tone={(statAbnormal._sum.abnormalOps || 0) > 0 ? "warning" : "success"} />
      </div>
      <BehaviorTable
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
