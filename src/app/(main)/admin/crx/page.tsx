import { db } from "@/lib/db"
import { requireRole } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { CrxPanel, type CrxPluginRow, type CrxStatusRow, type CrxGrayRow, type CrxBlockRow, type CrxAuditRow, type CrxWorkspaceOption, type CrxRefMap } from "./crx-panel"
import { Puzzle, CheckCircle2, TriangleAlert, GitBranch, ShieldBan } from "lucide-react"

// ============================================================
// CRX 插件管控中心（企业浏览器后台 · 浏览&扩展审计&策略管控）
// 页签：插件库（含回收站）/ 沙箱插件状态（安装调度）/ 灰度任务 / 黑名单 / 扩展审计
// RBAC：SUPER_ADMIN 全量；ADMIN 可管理插件库与策略（不可彻底删除/灰度回滚）；
//      GROUP_ADMIN / AUDITOR 只读
// ============================================================

export const metadata = { title: "CRX 插件管控" }

export default async function CrxAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN", "AUDITOR"])
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = ["library", "status", "gray", "blocklist", "audit", "recycle"].includes(f.tab || "") ? f.tab! : "library"
  const canManage = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  const isSuper = ctx.role === "SUPER_ADMIN"

  // ---- 插件库（含回收站页签的数据源切换）----
  const keyword = q.keyword || ""
  const libWhere: Record<string, unknown> = tab === "recycle" ? { deletedAt: { not: null } } : { deletedAt: null }
  if (keyword) {
    libWhere.OR = [
      { crxId: { contains: keyword } },
      { name: { contains: keyword } },
      { zhNote: { contains: keyword } },
    ]
  }
  if (f.highRisk === "true") libWhere.highRisk = true
  if (f.enabled) libWhere.enabled = f.enabled === "true"

  const [plugins, totalPlugins, totalActive, totalHighRisk, totalDisabled] = await Promise.all([
    db.crxPlugin.findMany({
      where: libWhere,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name"], { createdAt: "desc" }),
    }),
    db.crxPlugin.count({ where: libWhere }),
    db.crxPlugin.count({ where: { deletedAt: null, enabled: true } }),
    db.crxPlugin.count({ where: { deletedAt: null, highRisk: true } }),
    db.crxPlugin.count({ where: { deletedAt: null, enabled: false } }),
  ])

  // 引用关系（每个插件被哪些作用域引用 —— 计数 + 明细）
  const crxIds = plugins.map((p) => p.crxId)
  const [refEntries, grayTasks, installAgg, blockEntries, statuses, grayList, workspaces] = await Promise.all([
    db.crxPolicyEntry.findMany({
      where: { crxId: { in: crxIds }, deletedAt: null },
      select: { id: true, crxId: true, scopeType: true, scopeId: true, note: true, lockedVersion: true, updateUrl: true },
    }),
    db.crxGrayTask.findMany({ where: { status: { in: ["PENDING", "ROLLING"] } }, select: { entriesJson: true, name: true, status: true } }),
    db.crxInstallStatus.groupBy({ by: ["state"], _count: { _all: true } }),
    db.crxBlocklistEntry.findMany({ orderBy: { createdAt: "desc" } }),
    db.crxInstallStatus.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }),
    db.crxGrayTask.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.browserWorkspace.findMany({
      where: { deletedAt: null, status: { in: ["RUNNING", "IDLE", "STOPPED"] } },
      select: { id: true, name: true, status: true, userId: true, crxInheritEnabled: true, crxBlocklistExempt: true },
      take: 100,
      orderBy: { updatedAt: "desc" },
    }),
  ])

  // 沙箱状态页筛选
  const statusWhere: Record<string, unknown> = {}
  if (f.state) statusWhere.state = f.state
  if (keyword) statusWhere.OR = [{ crxId: { contains: keyword } }, { workspaceId: { contains: keyword } }]
  const filteredStatuses = f.state || keyword
    ? await db.crxInstallStatus.findMany({ where: statusWhere, orderBy: { updatedAt: "desc" }, take: 200 })
    : statuses

  // 工作区归属用户名映射（状态页显示）
  const wsUserIds = Array.from(new Set(workspaces.map((w) => w.userId)))
  const wsUsers = await db.user.findMany({ where: { id: { in: wsUserIds } }, select: { id: true, username: true } }).catch(() => [])
  const wsNameMap = new Map(workspaces.map((w) => [w.id, w]))
  const userMap = new Map(wsUsers.map((u) => [u.id, u.username]))

  // 扩展审计页（CRX_ 前缀操作日志）
  const auditWhere: Record<string, unknown> = { operationType: { startsWith: "CRX_" } }
  if (f.operationType) auditWhere.operationType = { startsWith: "CRX_", contains: f.operationType }
  if (keyword) {
    auditWhere.AND = [{ OR: [{ operatorName: { contains: keyword } }, { resourceId: { contains: keyword } }, { resourceName: { contains: keyword } }] }]
  }
  const [auditLogs, auditTotal] = await Promise.all([
    tab === "audit"
      ? db.auditLog.findMany({ where: auditWhere, ...pageSkipTake(q), orderBy: safeOrderBy(q, ["createdAt"], { createdAt: "desc" }) })
      : Promise.resolve([]),
    tab === "audit" ? db.auditLog.count({ where: auditWhere }) : Promise.resolve(0),
  ])

  const stateCount = (s: string) => installAgg.find((x) => x.state === s)?._count._all ?? 0

  const pluginRows: CrxPluginRow[] = plugins.map((p) => ({
    id: p.id,
    crxId: p.crxId,
    name: p.name,
    description: p.description || "",
    zhNote: p.zhNote || "",
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    permissions: Array.isArray(p.permissions) ? (p.permissions as string[]) : [],
    updateUrl: p.updateUrl,
    backupUpdateUrl: p.backupUpdateUrl || "",
    lockedVersion: p.lockedVersion || "",
    allowIncognito: p.allowIncognito,
    allowUserDisable: p.allowUserDisable,
    highRisk: p.highRisk,
    highRiskReason: Array.isArray(p.highRiskReason) ? (p.highRiskReason as string[]) : [],
    enabled: p.enabled,
    docUrl: p.docUrl || "",
    createdByName: p.createdByName || "",
    updatedByName: p.updatedByName || "",
    updatedAt: fmtDate(p.updatedAt),
    deletedAt: p.deletedAt ? fmtDate(p.deletedAt) : null,
    deletedByName: p.deletedByName || "",
  }))

  const statusRows: CrxStatusRow[] = filteredStatuses.map((s) => {
    const ws = wsNameMap.get(s.workspaceId)
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      workspaceName: ws?.name || s.workspaceId.slice(0, 8) + "…",
      workspaceStatus: ws?.status || "",
      crxId: s.crxId,
      state: s.state,
      sourceUsed: s.sourceUsed || "",
      currentVersion: s.currentVersion || "",
      attempts: s.attempts,
      lastErrorCode: s.lastErrorCode || "",
      lastCheckedAt: s.lastCheckedAt ? fmtDate(s.lastCheckedAt) : "",
      updatedAt: fmtDate(s.updatedAt),
    }
  })

  const grayRows: CrxGrayRow[] = grayList.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    batchSize: t.batchSize,
    total: t.total,
    progressed: t.progressed,
    successCount: t.successCount,
    failCount: t.failCount,
    rollbackReason: t.rollbackReason || "",
    createdByName: t.createdByName || "",
    createdAt: fmtDate(t.createdAt),
    entries: JSON.parse(t.entriesJson) as Array<{ crxId: string }>,
  }))

  const blockRows: CrxBlockRow[] = blockEntries.map((b) => ({
    id: b.id,
    scopeType: b.scopeType,
    scopeId: b.scopeId || "",
    crxId: b.crxId,
    note: b.note || "",
    createdByName: b.createdByName || "",
    createdAt: fmtDate(b.createdAt),
  }))

  const auditRows: CrxAuditRow[] = auditLogs.map((a) => ({
    id: a.id,
    operatorName: a.operatorName || "",
    operationType: a.operationType,
    resourceId: a.resourceId || "",
    resourceName: a.resourceName || "",
    severity: a.severity,
    afterJson: a.afterJson || "",
    createdAt: fmtDate(a.createdAt),
  }))

  const wsOptions: CrxWorkspaceOption[] = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    status: w.status,
    ownerName: userMap.get(w.userId) || "",
    crxInheritEnabled: w.crxInheritEnabled,
    crxBlocklistExempt: w.crxBlocklistExempt,
  }))

  // r13c：批量策略下发目标选项（用户组含成员数 / 用户）
  const [groupRows, memberAgg, userRows] = await Promise.all([
    db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    db.groupUser.groupBy({ by: ["groupId"], _count: { _all: true } }),
    db.user.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, username: true, displayName: true }, orderBy: { username: "asc" }, take: 300 }),
  ])
  const memberCountMap = new Map(memberAgg.map((m) => [m.groupId, m._count._all]))
  const groupOptions = groupRows.map((g) => ({ id: g.id, name: g.name, memberCount: memberCountMap.get(g.id) || 0 }))
  const userOptions = userRows.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }))

  const refMap: CrxRefMap = {}
  for (const r of refEntries) {
    if (!refMap[r.crxId]) refMap[r.crxId] = []
    refMap[r.crxId].push({ entryId: r.id, scopeType: r.scopeType, scopeId: r.scopeId || "", note: r.note || "", lockedVersion: r.lockedVersion || "", updateUrl: r.updateUrl || "" })
  }
  // 灰度任务引用
  for (const t of grayTasks) {
    try {
      const entries = JSON.parse(t.entriesJson) as Array<{ crxId: string }>
      for (const e of entries) {
        if (!refMap[e.crxId]) refMap[e.crxId] = []
        refMap[e.crxId].push({ scopeType: "GRAY", scopeId: t.name, note: `灰度 ${t.status}`, lockedVersion: "", updateUrl: "" })
      }
    } catch { /* 忽略损坏数据 */ }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-teal-600" /> CRX 插件管控中心
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          企业浏览器扩展全生命周期管控：插件库 / 五级策略下发（沙箱单插件覆盖源与版本）/ 安装调度降级重试 / 灰度回滚 / 黑名单 / 不可篡改审计。
          全部基于 Chromium Managed Preferences 原生策略（零内核 Patch，后台不存 CRX 二进制）。
        </p>
      </div>
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="插件库（启用）" value={totalActive} sub={`回收站外启用插件 / 筛选结果 ${totalPlugins}`} icon={<CheckCircle2 className="h-4 w-4" />} />
        <StatCard title="高危插件" value={totalHighRisk} sub="高危权限自动标记" icon={<TriangleAlert className="h-4 w-4" />} tone="warning" />
        <StatCard title="已安装/已下发" value={stateCount("INSTALLED") + stateCount("POLICY_APPLIED")} sub={`失败 ${stateCount("ALL_FAILED") + stateCount("PRIMARY_FAILED")} · 降级重试 ${stateCount("BACKUP_RETRY")}`} icon={<GitBranch className="h-4 w-4" />} tone="default" />
        <StatCard title="黑名单条目" value={blockEntries.length} sub="全局/组/用户/沙箱四级" icon={<ShieldBan className="h-4 w-4" />} tone="danger" />
      </div>
      <CrxPanel
        tab={tab}
        pluginRows={pluginRows}
        totalPlugins={totalPlugins}
        page={q.page}
        pageSize={q.pageSize}
        keyword={keyword}
        filters={f}
        statusRows={statusRows}
        grayRows={grayRows}
        blockRows={blockRows}
        auditRows={auditRows}
        auditTotal={auditTotal}
        wsOptions={wsOptions}
        refMap={refMap}
        canManage={canManage}
        isSuper={isSuper}
        role={ctx.role}
        groupOptions={groupOptions}
        userOptions={userOptions}
      />
    </div>
  )
}
