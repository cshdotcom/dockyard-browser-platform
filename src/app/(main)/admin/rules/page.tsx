import Link from "next/link"
import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { UaTable, type UaRow } from "./ua-table"
import { DomainRulesTable, type DomainRuleRow } from "./domain-rules-table"
import { EndpointRulesTable, type EndpointRuleRow } from "./endpoint-rules-table"
import { ModifyRulesTable, type ModifyRuleRow } from "./modify-rules-table"
import { MonitorSmartphone, Globe, Shuffle, CheckCircle2, CircleSlash, Info, Plug, ServerCog } from "lucide-react"
import { cn } from "@/lib/utils"

// 规则管理（管理员）：UA池 / 域名规则 / 端点级精确限制 / 请求篡改
export const metadata = { title: "规则管理" }

export default async function AdminRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = f.tab === "domain" ? "domain" : f.tab === "endpoint" ? "endpoint" : f.tab === "modify" ? "modify" : "ua"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">规则管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          浏览器指纹 UA 池 / 域名黑白规则 / 端点级精确限制（host:port）/ 请求篡改规则的统一维护（全部审计）
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        {[
          { key: "ua", label: "UA池" },
          { key: "domain", label: "域名规则" },
          { key: "endpoint", label: "端点级限制" },
          { key: "modify", label: "请求篡改" },
        ].map((t) => (
          <Link
            key={t.key}
            href={`/admin/rules?tab=${t.key}`}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              tab === t.key ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "ua" && <UaTab q={q} f={f} />}
      {tab === "domain" && <DomainTab q={q} f={f} />}
      {tab === "endpoint" && <EndpointTab q={q} f={f} />}
      {tab === "modify" && <ModifyTab q={q} f={f} />}
    </div>
  )
}

async function UaTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = {}
  if (q.keyword) {
    where.OR = [{ ua: { contains: q.keyword } }, { label: { contains: q.keyword } }]
  }
  if (f.category) where.category = f.category
  if (f.enabled) where.enabled = f.enabled === "true"

  const [rows, total, statTotal, statEnabled, statUsage, statMobile] = await Promise.all([
    db.uaRecord.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "usageCount", "label"], { createdAt: "desc" }),
    }),
    db.uaRecord.count({ where }),
    db.uaRecord.count(),
    db.uaRecord.count({ where: { enabled: true } }),
    db.uaRecord.aggregate({ _sum: { usageCount: true } }),
    db.uaRecord.count({ where: { category: "MOBILE" } }),
  ])

  const list: UaRow[] = rows.map((r) => ({
    id: r.id,
    ua: r.ua,
    label: r.label,
    category: r.category,
    enabled: r.enabled,
    usageCount: r.usageCount,
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="UA 总数" value={statTotal} sub="池内记录" icon={<MonitorSmartphone className="h-4 w-4" />} />
        <StatCard title="启用中" value={statEnabled} sub="可被调度" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="累计使用次数" value={statUsage._sum.usageCount || 0} sub="被模板/会话引用" icon={<Shuffle className="h-4 w-4" />} />
        <StatCard title="移动端 UA" value={statMobile} sub="MOBILE 类别" icon={<MonitorSmartphone className="h-4 w-4" />} />
      </div>
      <UaTable
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

async function DomainTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = {}
  if (q.keyword) {
    where.OR = [{ pattern: { contains: q.keyword } }, { note: { contains: q.keyword } }]
  }
  if (f.type) where.type = f.type
  if (f.enabled) where.enabled = f.enabled === "true"
  if (f.scopeType) where.scopeType = f.scopeType

  const [rows, total, statTotal, statBlack, statWhite, statEnabled, groupOpts, userOpts] = await Promise.all([
    db.domainRule.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "pattern"], { createdAt: "desc" }),
    }),
    db.domainRule.count({ where }),
    db.domainRule.count(),
    db.domainRule.count({ where: { type: "BLACK" } }),
    db.domainRule.count({ where: { type: "WHITE" } }),
    db.domainRule.count({ where: { enabled: true } }),
    db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, take: 200 }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true }, take: 500 }),
  ])

  const creators = await db.user.findMany({ select: { id: true, username: true }, take: 300 })
  const usernameById = new Map(creators.map((u) => [u.id, u.username]))
  const groupNameById = new Map(groupOpts.map((g) => [g.id, g.name]))

  const list: DomainRuleRow[] = rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    type: r.type,
    enabled: r.enabled,
    note: r.note,
    scopeType: r.scopeType || "GLOBAL",
    scopeLabel:
      (r.scopeType || "GLOBAL") === "GROUP" && r.groupId
        ? `组：${groupNameById.get(r.groupId) || r.groupId.slice(0, 8)}`
        : (r.scopeType || "GLOBAL") === "USER" && r.userId
          ? `用户：${usernameById.get(r.userId) || r.userId.slice(0, 8)}`
          : "全局",
    scopeTargetId: (r.scopeType === "GROUP" ? r.groupId : r.scopeType === "USER" ? r.userId : null) || null,
    createdByUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="规则总数" value={statTotal} sub="当前筛选" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="黑名单" value={statBlack} sub="BLACK" icon={<CircleSlash className="h-4 w-4" />} tone="danger" />
        <StatCard title="白名单" value={statWhite} sub="WHITE" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="生效中" value={statEnabled} sub="enabled" icon={<CheckCircle2 className="h-4 w-4" />} />
      </div>
      <div className="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          支持通配符：<code className="font-mono text-xs">*.example.com</code> 匹配全部子域；<code className="font-mono text-xs">example.com</code> 精确匹配。
          删除为物理删除（含审计）；如需临时停用请关闭启用开关。
        </div>
      </div>
      <DomainRulesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        groupOptions={groupOpts.map((g) => ({ id: g.id, name: g.name }))}
        userOptions={userOpts.map((u) => ({ id: u.id, name: u.username }))}
      />
    </div>
  )
}

async function EndpointTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = {}
  if (q.keyword) {
    where.OR = [{ pattern: { contains: q.keyword } }, { note: { contains: q.keyword } }]
  }
  if (f.type) where.type = f.type
  if (f.enabled) where.enabled = f.enabled === "true"
  if (f.scopeType) where.scopeType = f.scopeType

  const [rows, total, statTotal, statBlack, statWhite, statEnabled, statScoped, groupOpts, userOpts] = await Promise.all([
    db.networkEndpointRule.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "pattern"], { createdAt: "desc" }),
    }),
    db.networkEndpointRule.count({ where }),
    db.networkEndpointRule.count(),
    db.networkEndpointRule.count({ where: { type: "BLACK" } }),
    db.networkEndpointRule.count({ where: { type: "WHITE" } }),
    db.networkEndpointRule.count({ where: { enabled: true } }),
    db.networkEndpointRule.count({ where: { scopeType: { in: ["GROUP", "USER"] } } }),
    db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, take: 200 }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true }, take: 500 }),
  ])

  const creators = await db.user.findMany({ select: { id: true, username: true }, take: 300 })
  const usernameById = new Map(creators.map((u) => [u.id, u.username]))
  const groupNameById = new Map(groupOpts.map((g) => [g.id, g.name]))

  const list: EndpointRuleRow[] = rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    type: r.type,
    enabled: r.enabled,
    note: r.note,
    scopeType: r.scopeType || "GLOBAL",
    scopeLabel:
      (r.scopeType || "GLOBAL") === "GROUP" && r.groupId
        ? `组：${groupNameById.get(r.groupId) || r.groupId.slice(0, 8)}`
        : (r.scopeType || "GLOBAL") === "USER" && r.userId
          ? `用户：${usernameById.get(r.userId) || r.userId.slice(0, 8)}`
          : "全局",
    scopeTargetId: (r.scopeType === "GROUP" ? r.groupId : r.scopeType === "USER" ? r.userId : null) || null,
    createdByUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="端点规则总数" value={statTotal} sub="当前筛选" icon={<Plug className="h-4 w-4" />} />
        <StatCard title="封禁端点" value={statBlack} sub="BLACK（host:port）" icon={<CircleSlash className="h-4 w-4" />} tone="danger" />
        <StatCard title="放行例外" value={statWhite} sub="WHITE 例外" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="用户/组级规则" value={statScoped} sub="GROUP + USER 作用域" icon={<ServerCog className="h-4 w-4" />} tone="warning" />
      </div>
      <div className="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p>
            端点级精确限制：<code className="font-mono text-xs">10.0.0.5:8080</code> 精确端口、
            <code className="font-mono text-xs">192.168.1.0/24:443</code> CIDR 展开为通配、
            <code className="font-mono text-xs">*.corp.com:22</code> 域名+端口、
            <code className="font-mono text-xs">127.0.0.1:*</code> 任意端口、
            <code className="font-mono text-xs">host:80-90</code> 端口区间、
            <code className="font-mono text-xs">[::1]:9222</code> IPv6。
          </p>
          <p className="text-xs">
            内网整体放行时仍可封指定端点；禁止内网时 127.0.0.1 / localhost / ::1 全端口拦截（含全部环回形态）。
            规则经 Chromium 托管策略注入容器（与内网/域名策略合并写入同一份只读策略文件），新会话起生效。
          </p>
        </div>
      </div>
      <EndpointRulesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        groupOptions={groupOpts.map((g) => ({ id: g.id, name: g.name }))}
        userOptions={userOpts.map((u) => ({ id: u.id, name: u.username }))}
      />
    </div>
  )
}

async function ModifyTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ name: { contains: q.keyword } }, { matchPattern: { contains: q.keyword } }]
  }
  if (f.type) where.type = f.type
  if (f.enabled) where.enabled = f.enabled === "true"

  const [rows, total, statTotal, statEnabled, templates] = await Promise.all([
    db.browserModifyRule.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name"], { createdAt: "desc" }),
    }),
    db.browserModifyRule.count({ where }),
    db.browserModifyRule.count({ where: { deletedAt: null } }),
    db.browserModifyRule.count({ where: { deletedAt: null, enabled: true } }),
    db.browserTemplate.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
  ])

  const list: ModifyRuleRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    matchPattern: r.matchPattern,
    headerKey: r.headerKey,
    headerValue: r.headerValue,
    redirectUrl: r.redirectUrl,
    enabled: r.enabled,
    templateBinding: r.templateBinding,
    templateName: r.templateBinding ? templates.find((t) => t.id === r.templateBinding)?.name || null : null,
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="篡改规则总数" value={statTotal} sub="未软删" icon={<Shuffle className="h-4 w-4" />} />
        <StatCard title="生效中" value={statEnabled} sub="enabled" icon={<CheckCircle2 className="h-4 w-4" />} tone="success" />
        <StatCard title="绑定模板数" value={rows.filter((r) => r.templateBinding).length} sub="当前页统计" icon={<Globe className="h-4 w-4" />} />
      </div>
      <ModifyRulesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        templateOptions={templates.map((t) => ({ id: t.id, name: t.name }))}
      />
    </div>
  )
}
