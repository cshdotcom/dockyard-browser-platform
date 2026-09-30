import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { SessionsTable, type AdminSessionRow } from "./sessions-table"
import { MonitorSmartphone, ShieldCheck, Clock, UserCheck } from "lucide-react"

// 在线会话管控（管理员）：全部活跃 LoginSession + 强制下线
export const metadata = { title: "在线会话管控" }

export default async function AdminSessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)

  const now = new Date()
  const where: Record<string, unknown> = {
    revokedAt: null,
    expiresAt: { gt: now },
  }
  // 用户名搜索（无外键关联：先查用户ID集合）
  if (q.keyword) {
    const matched = await db.user.findMany({
      where: { username: { contains: q.keyword }, deletedAt: null },
      select: { id: true },
      take: 500,
    })
    where.userId = { in: matched.map((m) => m.id) }
  }
  if (q.filters.trusted) where.trusted = q.filters.trusted === "true"

  const [rows, total, totalActiveUsers, trustedCount, recentKicks] = await Promise.all([
    db.loginSession.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "lastActiveAt", "expiresAt"], { lastActiveAt: "desc" }),
    }),
    db.loginSession.count({ where }),
    db.loginSession.findMany({ where: { revokedAt: null, expiresAt: { gt: now } }, select: { userId: true }, distinct: ["userId"] }),
    db.loginSession.count({ where: { revokedAt: null, expiresAt: { gt: now }, trusted: true } }),
    db.securityEvent.count({
      where: { eventType: "DEVICE_KICKED", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    }),
  ])

  // 关联用户信息（内存组装）
  const sessionUserIds = [...new Set(rows.map((r) => r.userId))]
  const sessionUsers = sessionUserIds.length
    ? await db.user.findMany({ where: { id: { in: sessionUserIds } }, select: { id: true, username: true, displayName: true, role: true } })
    : []
  const userById = new Map(sessionUsers.map((u) => [u.id, u]))

  const list: AdminSessionRow[] = rows.map((s) => ({
    id: s.id,
    userId: s.userId,
    username: userById.get(s.userId)?.username || "未知用户",
    displayName: userById.get(s.userId)?.displayName ?? null,
    role: userById.get(s.userId)?.role || "USER",
    ip: s.ip,
    userAgent: s.userAgent,
    deviceLabel: s.deviceLabel,
    trusted: s.trusted,
    rememberMe: s.rememberMe,
    loginAt: fmtDate(s.createdAt),
    lastActiveAt: fmtDate(s.lastActiveAt),
    expiresAt: fmtDate(s.expiresAt),
    idleTimeoutMin: Math.round((s.idleTimeoutSec || 1800) / 60),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">在线会话管控</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全平台活跃登录会话：单条强制下线 / 一键下线该用户全部设备；操作全程审计
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="活跃会话" value={total} sub="未撤销且未过期" icon={<MonitorSmartphone className="h-4 w-4" />} />
        <StatCard title="在线用户" value={totalActiveUsers.length} sub="去重后活跃账号" icon={<UserCheck className="h-4 w-4" />} tone="success" />
        <StatCard title="受信任设备会话" value={trustedCount} sub="跳过2FA的设备" icon={<ShieldCheck className="h-4 w-4" />} />
        <StatCard title="24h 强制下线次数" value={recentKicks} sub="安全事件 DEVICE_KICKED" icon={<Clock className="h-4 w-4" />} tone={recentKicks > 0 ? "warning" : "default"} />
      </div>

      <SessionsTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
      />
    </div>
  )
}
