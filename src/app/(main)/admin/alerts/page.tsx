import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { AlertTabs } from "./alert-tabs"
import { AlertsTable, type AlertRow } from "./alerts-table"
import { AlertRulesTable, type AlertRuleRow } from "./alert-rules-table"
import { WebhookRulesTable, type WebhookRuleRow, type WebhookDeliveryRow } from "./webhook-rules-table"
import { NoticesTable, type NoticeRow } from "./notices-table"
import { StatCard } from "@/components/shared/confirm"
import { Bell, TriangleAlert, ShieldAlert, Inbox } from "lucide-react"

// 告警中心（管理员）：告警列表 / 告警规则 / Webhook 规则 / 站内通知
export const metadata = { title: "告警中心" }

const TABS = ["list", "rules", "webhooks", "notices"] as const
type Tab = (typeof TABS)[number]

export default async function AdminAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab: Tab = (TABS as readonly string[]).includes(f.tab) ? (f.tab as Tab) : "list"

  const dayAgo = new Date(Date.now() - 86400_000)
  // 顶部统计：今日告警数 / 待处理数 / PENDING CRITICAL 数（与页签无关，常驻展示）
  const [todayCount, pendingCount, pendingCriticalCount] = await Promise.all([
    db.alert.count({ where: { createdAt: { gte: dayAgo } } }),
    db.alert.count({ where: { handleStatus: "PENDING" } }),
    db.alert.count({ where: { handleStatus: "PENDING", level: "CRITICAL" } }),
  ])

  const stats = (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard title="24h 告警数" value={todayCount} sub="最近一天新增告警" icon={<Bell className="h-4 w-4" />} />
      <StatCard title="待处理告警" value={pendingCount} sub="handleStatus=PENDING" icon={<TriangleAlert className="h-4 w-4" />} tone={pendingCount > 0 ? "warning" : "success"} />
      <StatCard title="待处理 CRITICAL" value={pendingCriticalCount} sub="严重级未处理" icon={<ShieldAlert className="h-4 w-4" />} tone={pendingCriticalCount > 0 ? "danger" : "success"} />
      <StatCard title="站内通知" value="-" sub="见「站内通知」页签" icon={<Inbox className="h-4 w-4" />} />
    </div>
  )

  // ---- 页签1：告警列表 ----
  if (tab === "list") {
    const where: Record<string, unknown> = {}
    if (f.level) where.level = f.level
    if (f.handleStatus) where.handleStatus = f.handleStatus
    if (q.keyword) where.OR = [{ title: { contains: q.keyword } }, { content: { contains: q.keyword } }]

    const [rows, total] = await Promise.all([
      db.alert.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["triggerAt", "createdAt", "level"], { triggerAt: "desc" }),
      }),
      db.alert.count({ where }),
    ])

    // 处理人 / 资源归属人用户名（内存 join）
    const userIds = [...new Set([...rows.map((r) => r.handledByUserId).filter((v): v is string => !!v), ...rows.map((r) => r.ownerUserId).filter((v): v is string => !!v)])]
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
    const userMap = new Map(users.map((u) => [u.id, u.username]))

    const list: AlertRow[] = rows.map((a) => ({
      id: a.id,
      title: a.title,
      level: a.level,
      content: a.content,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      ownerName: a.ownerUserId ? userMap.get(a.ownerUserId) || a.ownerUserId : null,
      triggerAt: fmtDate(a.triggerAt),
      handleStatus: a.handleStatus,
      handledByName: a.handledByUserId ? userMap.get(a.handledByUserId) || a.handledByUserId : null,
      handledAt: a.handledAt ? fmtDate(a.handledAt) : null,
      dedupeKey: a.dedupeKey,
      traceId: a.traceId,
    }))

    return (
      <PageShell stats={stats}>
        <AlertTabs tab="list">
          <AlertsTable rows={list} total={total} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} />
        </AlertTabs>
      </PageShell>
    )
  }

  // ---- 页签2：告警规则 ----
  if (tab === "rules") {
    const where: Record<string, unknown> = {}
    if (f.level) where.level = f.level
    if (f.enabled) where.enabled = f.enabled === "true"
    if (q.keyword) where.OR = [{ name: { contains: q.keyword } }, { conditionsJson: { contains: q.keyword } }]

    const [rows, total] = await Promise.all([
      db.alertRule.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["createdAt", "updatedAt", "name"], { updatedAt: "desc" }),
      }),
      db.alertRule.count({ where }),
    ])

    const list: AlertRuleRow[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      conditionsJson: r.conditionsJson,
      level: r.level,
      silenceWindowMin: r.silenceWindowMin,
      webhookEnabled: r.webhookEnabled,
      enabled: r.enabled,
      createdAt: fmtDate(r.createdAt),
      updatedAt: fmtDate(r.updatedAt),
    }))

    return (
      <PageShell stats={stats}>
        <AlertTabs tab="rules">
          <AlertRulesTable rows={list} total={total} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} />
        </AlertTabs>
      </PageShell>
    )
  }

  // ---- 页签3：Webhook 规则 + 投递记录 ----
  if (tab === "webhooks") {
    const where: Record<string, unknown> = { deletedAt: null }
    if (f.enabled) where.enabled = f.enabled === "true"
    if (q.keyword) where.OR = [{ name: { contains: q.keyword } }, { url: { contains: q.keyword } }]

    const [rows, total, deliveries, groups] = await Promise.all([
      db.webhookRule.findMany({
        where,
        ...pageSkipTake(q),
        orderBy: safeOrderBy(q, ["createdAt", "name", "failCount"], { createdAt: "desc" }),
      }),
      db.webhookRule.count({ where }),
      db.webhookDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ])

    const ruleList: WebhookRuleRow[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      secret: r.secret,
      events: Array.isArray(r.events) ? (r.events as string[]) : [],
      groupId: r.groupId,
      enabled: r.enabled,
      failCount: r.failCount,
      createdAt: fmtDate(r.createdAt),
    }))

    const deliveryList: WebhookDeliveryRow[] = deliveries.map((d) => ({
      id: d.id,
      url: d.url,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      sentAt: d.sentAt ? fmtDate(d.sentAt) : null,
      createdAt: fmtDate(d.createdAt),
    }))

    return (
      <PageShell stats={stats}>
        <AlertTabs tab="webhooks">
          <WebhookRulesTable
            rows={ruleList}
            total={total}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            deliveries={deliveryList}
            groupOptions={groups.map((g) => ({ id: g.id, name: g.name }))}
          />
        </AlertTabs>
      </PageShell>
    )
  }

  // ---- 页签4：站内通知（只读） ----
  const noticeWhere: Record<string, unknown> = {}
  if (f.type) noticeWhere.type = f.type
  if (f.read === "true") noticeWhere.readAt = { not: null }
  if (f.read === "false") noticeWhere.readAt = null
  if (q.keyword) noticeWhere.OR = [{ title: { contains: q.keyword } }, { content: { contains: q.keyword } }]

  const [noticeRows, noticeTotal] = await Promise.all([
    db.notice.findMany({
      where: noticeWhere,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "type"], { createdAt: "desc" }),
    }),
    db.notice.count({ where: noticeWhere }),
  ])

  const noticeUserIds = [...new Set(noticeRows.map((n) => n.userId))]
  const noticeUsers = noticeUserIds.length ? await db.user.findMany({ where: { id: { in: noticeUserIds } }, select: { id: true, username: true } }) : []
  const noticeUserMap = new Map(noticeUsers.map((u) => [u.id, u.username]))

  const noticeList: NoticeRow[] = noticeRows.map((n) => ({
    id: n.id,
    username: noticeUserMap.get(n.userId) || n.userId,
    title: n.title,
    content: n.content,
    type: n.type,
    readAt: n.readAt ? fmtDate(n.readAt) : null,
    createdAt: fmtDate(n.createdAt),
  }))

  return (
    <PageShell stats={stats}>
      <AlertTabs tab="notices">
        <NoticesTable rows={noticeList} total={noticeTotal} page={q.page} pageSize={q.pageSize} keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder} filters={f} />
      </AlertTabs>
    </PageShell>
  )
}

function PageShell({ stats, children }: { stats: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">告警中心</h1>
        <p className="text-sm text-muted-foreground mt-1">
          告警处置 / 告警规则 / Webhook 投递 / 站内通知：全平台风险事件的发现、分级、静默与外发通道
        </p>
      </div>
      {stats}
      {children}
    </div>
  )
}
