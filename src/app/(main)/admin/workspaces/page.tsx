import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { effectiveRuntimeSec, fmtRuntime } from "@/lib/ws-lifecycle"
import { inspectContainer } from "@/lib/external/docker"
import { StatCard } from "@/components/shared/confirm"
import { WorkspacesTable, type AdminWorkspaceRow, type UserOption } from "./workspaces-table"
import { Globe, PlayCircle, MonitorCog, Terminal, TriangleAlert, Recycle, CalendarPlus } from "lucide-react"

// 工作区管控（管理员强制操作核心页）
// 增强列表：归属双用户 / 时间三列（创建·启动·最近活跃）/ 累计运行时长 / 容器健康 / 代理出口 /
// 策略快照摘要 / 删除记录（回收站来源）/ 批量筛选（用户·状态·模式·创建时间范围·活跃/回收站视图）/ 列显隐配置
export const metadata = { title: "工作区管控" }

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  // ---- 视图切换：活跃（默认） / 回收站（软删记录 + 删除来源） ----
  const view = f.view === "deleted" ? "deleted" : "active"

  const where: Record<string, unknown> = view === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ uuid: { contains: q.keyword } }, { name: { contains: q.keyword } }]
  }
  if (f.mode) where.mode = f.mode
  if (f.status) where.status = f.status
  if (f.user) where.userId = f.user
  if (f.proxy) where.proxyNodeId = f.proxy
  // 创建时间范围（YYYY-MM-DD → 当日边界）
  if (f.createdFrom || f.createdTo) {
    const range: Record<string, unknown> = {}
    if (f.createdFrom) range.gte = new Date(`${f.createdFrom}T00:00:00`)
    if (f.createdTo) range.lte = new Date(`${f.createdTo}T23:59:59`)
    where.createdAt = range
  }
  // 最近活跃时间范围
  if (f.activeFrom || f.activeTo) {
    const range: Record<string, unknown> = {}
    if (f.activeFrom) range.gte = new Date(`${f.activeFrom}T00:00:00`)
    if (f.activeTo) range.lte = new Date(`${f.activeTo}T23:59:59`)
    where.lastActiveAt = range
  }
  // 累计运行时长下限（分钟）——内存过滤（计算字段，SQL 无法直接表达）
  const runtimeMin = Number(f.runtimeMin) || 0

  const [rowsRaw, total, statTotal, statRunning, statCdp, statNovnc, statAbnormal, statDeleted, statToday, userOptions, proxyOptions] =
    await Promise.all([
      db.browserWorkspace.findMany({
        where,
        ...pageSkipTake(q),
        // 取 3 页数据用于运行时长下限的内存过滤（精确度/性能折中）
        orderBy: safeOrderBy(q, ["createdAt", "status", "name", "cdpCallCount", "startedAt", "runtimeAccumSec"], { createdAt: "desc" }),
      }),
      db.browserWorkspace.count({ where }),
      db.browserWorkspace.count({ where: { deletedAt: null } }),
      db.browserWorkspace.count({ where: { deletedAt: null, status: "RUNNING" } }),
      db.browserWorkspace.count({ where: { deletedAt: null, mode: "cdp_light" } }),
      db.browserWorkspace.count({ where: { deletedAt: null, mode: "novnc_full" } }),
      db.browserWorkspace.count({ where: { deletedAt: null, status: { in: ["ERROR", "FROZEN"] } } }),
      db.browserWorkspace.count({ where: { deletedAt: { not: null } } }),
      db.browserWorkspace.count({ where: { deletedAt: null, createdAt: { gte: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00") } } }),
      db.user.findMany({
        where: { deletedAt: null },
        select: { id: true, username: true, displayName: true, role: true },
        orderBy: { username: "asc" },
        take: 300,
      }),
      db.proxyNode.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 100 }),
    ])

  // ---- 内存 join：所有者/创建人/组/代理节点（含出口地址）/SingBox/Steel ----
  const userIds = [...new Set(rowsRaw.flatMap((r) => [r.userId, r.createdByUserId].filter(Boolean) as string[]))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(users.map((u) => [u.id, u.username]))

  const groupIds = [...new Set(rowsRaw.map((r) => r.groupId).filter(Boolean) as string[])]
  const groups = groupIds.length ? await db.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : []
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]))

  // 代理出口（名称 + 出口地址摘要）：internal_singbox → 实例 socks 地址；external → host:port
  const proxyIds = [...new Set(rowsRaw.map((r) => r.proxyNodeId).filter(Boolean) as string[])]
  const proxies = proxyIds.length ? await db.proxyNode.findMany({ where: { id: { in: proxyIds } }, select: { id: true, name: true, type: true, host: true, port: true, protocol: true, singboxInstanceId: true } }) : []
  const sbiIds = [...new Set(proxies.map((p) => p.singboxInstanceId).filter(Boolean) as string[])]
  const sbis = sbiIds.length ? await db.singboxInstance.findMany({ where: { id: { in: sbiIds } }, select: { id: true, name: true, socksAddr: true } }) : []
  const proxyById = new Map(
    proxies.map((p) => {
      let exit = ""
      let sbiName = ""
      if (p.type === "internal_singbox" && p.singboxInstanceId) {
        const sbi = sbis.find((s) => s.id === p.singboxInstanceId)
        if (sbi?.socksAddr) exit = `socks5://${sbi.socksAddr}`
        if (sbi) sbiName = sbi.name
      } else if (p.host && p.port) {
        exit = `${p.protocol === "http" ? "http" : "socks5"}://${p.host}:${p.port}`
      }
      return [p.id, { name: p.name, type: p.type, exit, sbiName }]
    }),
  )

  const steelIds = [...new Set(rowsRaw.map((r) => r.steelNodeId).filter(Boolean) as string[])]
  const steels = steelIds.length ? await db.steelNode.findMany({ where: { id: { in: steelIds } }, select: { id: true, name: true } }) : []
  const steelNameById = new Map(steels.map((s) => [s.id, s.name]))

  // ---- 回收站删除记录（软删视图：删除人/来源/原因/时间） ----
  const wsIds = rowsRaw.map((r) => r.id)
  const recycleRows = view === "deleted" && wsIds.length
    ? await db.recycleBin.findMany({ where: { resourceType: "WORKSPACE", resourceId: { in: wsIds }, restoredAt: null }, orderBy: { createdAt: "desc" } })
    : []
  const recycleByRes = new Map(recycleRows.map((r) => [r.resourceId, r]))
  const delUserIds = [...new Set(recycleRows.map((r) => r.deletedByUserId).filter(Boolean) as string[])]
  const delUsers = delUserIds.length ? await db.user.findMany({ where: { id: { in: delUserIds } }, select: { id: true, username: true } }) : []
  const delUsernameById = new Map(delUsers.map((u) => [u.id, u.username]))

  // ---- 容器健康（仅对带 containerRef 的行做 Docker inspect；模拟模式自动降级） ----
  const containerRefs = [...new Set(rowsRaw.map((r) => r.containerRef).filter(Boolean) as string[])].slice(0, 60)
  const containerInfo = new Map<string, { state: string; status: string }>()
  if (containerRefs.length) {
    const results = await Promise.allSettled(containerRefs.map((ref) => inspectContainer(ref)))
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) containerInfo.set(containerRefs[i], { state: r.value.state, status: r.value.status })
    })
  }

  // ---- 运行时长下限内存过滤（计算字段） ----
  const filtered = runtimeMin > 0 ? rowsRaw.filter((r) => effectiveRuntimeSec(r) >= runtimeMin * 60) : rowsRaw

  const list: AdminWorkspaceRow[] = filtered.map((r) => {
    const proxy = r.proxyNodeId ? proxyById.get(r.proxyNodeId) : undefined
    const policy = (r.networkPolicyJson as Record<string, unknown> | null) || null
    const recycle = view === "deleted" ? recycleByRes.get(r.id) : undefined
    const ci = r.containerRef ? containerInfo.get(r.containerRef) : undefined
    return {
      id: r.id,
      uuid: r.uuid,
      name: r.name,
      mode: r.mode,
      status: r.status,
      ownerUsername: usernameById.get(r.userId) || "-",
      creatorUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
      transferred: r.createdByUserId && r.createdByUserId !== r.userId,
      groupName: r.groupId ? groupNameById.get(r.groupId) || "-" : "-",
      proxyNodeName: proxy?.name || "-",
      proxyType: proxy?.type || "",
      proxyExit: proxy?.exit || "",
      singboxName: proxy?.sbiName || "-",
      steelNodeName: r.steelNodeId ? steelNameById.get(r.steelNodeId) || "-" : "-",
      ttlMinutes: r.ttlMinutes,
      idleTimeoutMinutes: r.idleTimeoutMinutes,
      cdpCallCount: r.cdpCallCount,
      novncConnCount: r.novncConnCount,
      hasNovncSession: !!r.novncSessionId,
      freezeReason: r.freezeReason,
      crashCategory: r.crashCategory,
      containerRef: r.containerRef || "",
      containerState: ci?.state || "",
      containerStatus: ci?.status || "",
      policySummary: {
        allowInternalNetwork: policy ? policy.allowInternalNetwork === true : false,
        allowSecureLocationAccess: policy ? policy.allowSecureLocationAccess === true : false,
        domainMode: (policy?.domainMode as string) || "",
        domainBlack: Array.isArray(policy?.domainBlack) ? (policy.domainBlack as unknown[]).length : 0,
        domainWhite: Array.isArray(policy?.domainWhite) ? (policy.domainWhite as unknown[]).length : 0,
        endpointBlack: Array.isArray(policy?.endpointBlack) ? (policy.endpointBlack as unknown[]).length : 0,
        endpointWhite: Array.isArray(policy?.endpointWhite) ? (policy.endpointWhite as unknown[]).length : 0,
      },
      runtimeSec: effectiveRuntimeSec(r),
      runtimeText: fmtRuntime(effectiveRuntimeSec(r)),
      createdAt: fmtDate(r.createdAt),
      startedAtText: r.startedAt ? fmtDate(r.startedAt) : "—",
      lastActiveAtText: r.lastActiveAt ? fmtDate(r.lastActiveAt) : "—",
      lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : "",
      deletedAtText: r.deletedAt ? fmtDate(r.deletedAt) : "",
      deletedByUsername: recycle?.deletedByUserId ? delUsernameById.get(recycle.deletedByUserId) || "-" : "",
      deletedByType: recycle?.deletedByType || "",
      deletedReason: recycle?.reason || "",
    }
  })

  // 资源转移目标用户选项（全部活跃用户）
  const transferTargets: UserOption[] = userOptions.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">工作区管控</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全平台工作区强制操作中枢：归属/运行时长/容器健康/策略快照/删除记录全景视图 + 停止/重启/回收/物理删除/VNC 断连/TTL 覆写/资源转移（全量审计）
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard title="总工作区" value={statTotal} sub={`今日新建 ${statToday}`} icon={<Globe className="h-4 w-4" />} />
        <StatCard title="运行中" value={statRunning} sub="RUNNING" icon={<PlayCircle className="h-4 w-4" />} tone="success" />
        <StatCard title="CDP 轻量" value={statCdp} sub="cdp_light" icon={<Terminal className="h-4 w-4" />} />
        <StatCard title="NoVNC 完整" value={statNovnc} sub="novnc_full" icon={<MonitorCog className="h-4 w-4" />} />
        <StatCard title="异常工作区" value={statAbnormal} sub="ERROR + FROZEN" icon={<TriangleAlert className="h-4 w-4" />} tone={statAbnormal > 0 ? "danger" : "success"} />
        <StatCard title="回收站" value={statDeleted} sub="软删可追溯" icon={<Recycle className="h-4 w-4" />} tone={statDeleted > 0 ? "warning" : "success"} />
        <StatCard title="今日新建" value={statToday} sub="00:00 以来" icon={<CalendarPlus className="h-4 w-4" />} />
      </div>

      <WorkspacesTable
        rows={list}
        total={runtimeMin > 0 ? list.length : total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        view={view}
        userOptions={userOptions.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role }))}
        proxyOptions={proxyOptions}
        transferTargets={transferTargets}
      />
    </div>
  )
}
