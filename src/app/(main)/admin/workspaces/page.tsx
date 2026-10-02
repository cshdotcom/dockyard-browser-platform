import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { effectiveRuntimeSec, fmtRuntime } from "@/lib/ws-lifecycle"
import { inspectContainer } from "@/lib/external/docker"
import { StatCard } from "@/components/shared/confirm"
import { WorkspacesTable, type AdminWorkspaceRow, type UserOption } from "./workspaces-table"
import { SharesTable, type AdminShareRow } from "./shares-table"
import { Globe, PlayCircle, MonitorCog, Terminal, TriangleAlert, Recycle, CalendarPlus, Share2 } from "lucide-react"

// 工作区管控（管理员强制操作核心页）
// 增强列表：归属双用户 / 时间三列（创建·启动·最近活跃）/ 累计运行时长 / 容器健康 / 代理出口 /
// 策略快照摘要 / 删除记录（回收站来源）/ 批量筛选（用户·状态·模式·创建时间范围·活跃/回收站视图）/ 列显隐配置
// r13c：新增「共享关系」总列表视图 —— 全平台共享关系全景 + 精确撤销（单人/批量/整工作区）+ 沙箱级禁共享否决
// r14（22-c）：用户筛选作用域 —— 默认仅显示管理员自己的工作区；可搜索多选指定用户 / 全选看全部
export const metadata = { title: "工作区管控" }

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  // ---- 视图切换：活跃（默认） / 回收站（软删记录 + 删除来源）/ 共享关系（r13c 总列表） ----
  const view = f.view === "deleted" ? "deleted" : f.view === "shares" ? "shares" : "active"

  // ============================ 共享关系总列表视图（r13c） ============================
  if (view === "shares") {
    const kw = (q.keyword || "").trim()
    const shareStatus = f.shareStatus || "all" // all | active | revoked | expired
    const sharePermission = f.sharePermission || ""

    // 关键词预筛（工作区名/uuid → id 集；用户名 → id 集；所有者名 → 其工作区 id 集）
    let wsIdsByKw: string[] | null = null
    let userIdsByKw: string[] | null = null
    if (kw) {
      const [kws, kusers] = await Promise.all([
        db.browserWorkspace.findMany({ where: { OR: [{ name: { contains: kw } }, { uuid: { contains: kw } }] }, select: { id: true }, take: 800 }),
        db.user.findMany({ where: { username: { contains: kw } }, select: { id: true }, take: 800 }),
      ])
      // 所有者用户名匹配 → 其名下工作区
      let ownerWsIds: string[] = []
      if (kusers.length) {
        const owned = await db.browserWorkspace.findMany({ where: { userId: { in: kusers.map((u) => u.id) } }, select: { id: true }, take: 800 })
        ownerWsIds = owned.map((w) => w.id)
      }
      wsIdsByKw = [...new Set([...kws.map((w) => w.id), ...ownerWsIds])]
      userIdsByKw = kusers.map((u) => u.id)
    }

    const now = new Date()
    const shareWhere: Record<string, unknown> = {}
    if (shareStatus === "active") shareWhere.revokedAt = null
    else if (shareStatus === "revoked") shareWhere.revokedAt = { not: null }
    else if (shareStatus === "expired") { shareWhere.revokedAt = null; shareWhere.expireAt = { lt: now } }
    if (sharePermission) shareWhere.permission = sharePermission
    // 23-a：共享创建时间范围筛选（YYYY-MM-DD；非法格式直接忽略）
    const shareDateRe = /^\d{4}-\d{2}-\d{2}$/
    const shareFrom = shareDateRe.test((f.shareFrom || "").trim()) ? (f.shareFrom || "").trim() : ""
    const shareTo = shareDateRe.test((f.shareTo || "").trim()) ? (f.shareTo || "").trim() : ""
    if (shareFrom || shareTo) {
      const createdAtRange: Record<string, unknown> = {}
      if (shareFrom) createdAtRange.gte = new Date(`${shareFrom}T00:00:00`)
      if (shareTo) createdAtRange.lte = new Date(`${shareTo}T23:59:59`)
      shareWhere.createdAt = createdAtRange
    }
    if (kw) {
      const clauses: Record<string, unknown>[] = []
      if (wsIdsByKw && wsIdsByKw.length) clauses.push({ workspaceId: { in: wsIdsByKw } })
      if (userIdsByKw && userIdsByKw.length) clauses.push({ targetUserId: { in: userIdsByKw } })
      shareWhere.AND = [{ OR: clauses.length ? clauses : [{ id: "__none__" }] }]
    }

    const [shareRowsRaw, shareTotal, statSharesActive, statSharesRevoked, statSharesExpired, statVeto, shareStatWorkspaces] =
      await Promise.all([
        db.workspaceShare.findMany({
          where: shareWhere,
          ...pageSkipTake(q),
          orderBy: safeOrderBy(q, ["createdAt"], { createdAt: "desc" }) as Record<string, "asc" | "desc">,
        }),
        db.workspaceShare.count({ where: shareWhere }),
        db.workspaceShare.count({ where: { revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: now } }] } }),
        db.workspaceShare.count({ where: { revokedAt: { not: null } } }),
        db.workspaceShare.count({ where: { revokedAt: null, expireAt: { lt: now } } }),
        db.browserWorkspace.count({ where: { deletedAt: null, shareDisabled: true } }),
        db.workspaceShare.groupBy({ by: ["workspaceId"], where: { revokedAt: null }, _count: { _all: true } }),
      ])

    // 内存 join：工作区（名/uuid/所有者/否决开关/状态）+ 被共享者 + 共享发起人
    const swsIds = [...new Set(shareRowsRaw.map((s) => s.workspaceId))]
    const sws = swsIds.length
      ? await db.browserWorkspace.findMany({ where: { id: { in: swsIds } }, select: { id: true, name: true, uuid: true, userId: true, shareDisabled: true, status: true, mode: true } })
      : []
    const tIds = [...new Set(shareRowsRaw.map((s) => s.targetUserId))]
    const sTargets = tIds.length
      ? await db.user.findMany({ where: { id: { in: tIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const cIds = [...new Set(shareRowsRaw.map((s) => s.createdByUserId).filter(Boolean) as string[])]
    const sCreators = cIds.length
      ? await db.user.findMany({ where: { id: { in: cIds } }, select: { id: true, username: true } })
      : []
    const wsById = new Map(sws.map((w) => [w.id, w]))
    const targetById = new Map(sTargets.map((u) => [u.id, u]))
    const creatorById = new Map(sCreators.map((u) => [u.id, u]))
    const ownerIds = [...new Set(sws.map((w) => w.userId))]
    const owners = ownerIds.length ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, username: true } }) : []
    const ownerById = new Map(owners.map((u) => [u.id, u]))

    const shareRows: AdminShareRow[] = shareRowsRaw.map((s) => {
      const w = wsById.get(s.workspaceId)
      const t = targetById.get(s.targetUserId)
      const expired = !s.revokedAt && !!s.expireAt && s.expireAt.getTime() < now.getTime()
      const status = s.revokedAt ? "revoked" : expired ? "expired" : "active"
      return {
        id: s.id,
        workspaceId: s.workspaceId,
        workspaceName: w?.name || "（已删除工作区）",
        workspaceUuid: w?.uuid || "",
        workspaceStatus: w?.status || "",
        workspaceMode: w?.mode || "",
        ownerUsername: w ? ownerById.get(w.userId)?.username || "-" : "-",
        targetUsername: t?.username || "-",
        targetDisplayName: t?.displayName || null,
        permission: s.permission,
        status,
        shareDisabled: w?.shareDisabled || false,
        expireAt: s.expireAt ? fmtDate(s.expireAt) : "",
        revokedAt: s.revokedAt ? fmtDate(s.revokedAt) : "",
        createdAt: fmtDate(s.createdAt),
        createdByUsername: s.createdByUserId ? creatorById.get(s.createdByUserId)?.username || "-" : "-",
        activeSharesOfWs: shareStatWorkspaces.find((g) => g.workspaceId === s.workspaceId)?._count._all ?? 0,
      }
    })

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">共享关系总列表</h1>
          <p className="text-sm text-muted-foreground mt-1">
            全平台工作区共享关系全景：精确到「共享给谁」的撤销（单人/批量/整工作区）、沙箱级禁共享否决、四级管控（全局/用户组/用户/沙箱）状态一目了然
          </p>
        </div>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard title="生效中共享" value={statSharesActive} sub="被共享者可访问" icon={<Share2 className="h-4 w-4" />} tone="success" />
          <StatCard title="已撤销" value={statSharesRevoked} sub="审计保留" icon={<Recycle className="h-4 w-4" />} />
          <StatCard title="已过期" value={statSharesExpired} sub="到期自动失效" icon={<CalendarPlus className="h-4 w-4" />} />
          <StatCard title="禁共享沙箱" value={statVeto} sub="沙箱级否决" icon={<TriangleAlert className="h-4 w-4" />} tone={statVeto > 0 ? "warning" : "success"} />
          <StatCard title="筛选结果" value={shareTotal} sub="当前条件匹配" icon={<Globe className="h-4 w-4" />} />
        </div>
        <SharesTable
          rows={shareRows}
          total={shareTotal}
          page={q.page}
          pageSize={q.pageSize}
          keyword={q.keyword}
          filters={f}
        />
      </div>
    )
  }
  // ============================ /共享关系总列表视图 ============================

  const where: Record<string, unknown> = view === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ uuid: { contains: q.keyword } }, { name: { contains: q.keyword } }]
  }
  if (f.mode) where.mode = f.mode
  if (f.status) where.status = f.status
  // r14（22-c）：用户筛选作用域（三级）：
  //   scope=all（全选）→ 全部用户；scope=custom + users=多选 ID → 所选用户；
  //   默认（无参数）→ 仅当前管理员自己的工作区；旧版单选 user 参数兼容
  const userScope: "all" | "custom" | "legacy" | "mine" =
    f.scope === "all" ? "all" : f.scope === "custom" && f.users ? "custom" : f.user ? "legacy" : "mine"
  const usersParam = (f.users || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (userScope === "all") {
    // 全选：不过滤用户（显示全部）
  } else if (userScope === "custom" && usersParam.length) {
    where.userId = { in: usersParam }
  } else if (userScope === "legacy" && f.user) {
    where.userId = f.user
  } else {
    where.userId = ctx.userId // 默认：仅显示管理员自己的工作区
  }
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

  // ---- 内存 join：所有者/创建人/组/代理节点（含出口地址）/SingBox/浏览器节点 ----
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

  const browserNodeIds = [...new Set(rowsRaw.map((r) => r.browserNodeId).filter(Boolean) as string[])]
  const browserNodes = browserNodeIds.length ? await db.browserNode.findMany({ where: { id: { in: browserNodeIds } }, select: { id: true, name: true } }) : []
  const browserNodeNameById = new Map(browserNodes.map((s) => [s.id, s.name]))

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
      transferred: !!r.createdByUserId && r.createdByUserId !== r.userId,
      groupName: r.groupId ? groupNameById.get(r.groupId) || "-" : "-",
      proxyNodeName: proxy?.name || "-",
      proxyType: proxy?.type || "",
      proxyExit: proxy?.exit || "",
      singboxName: proxy?.sbiName || "-",
      browserNodeName: r.browserNodeId ? browserNodeNameById.get(r.browserNodeId) || "-" : "-",
      ttlMinutes: r.ttlMinutes,
      vncSessionMaxMinutes: r.vncSessionMaxMinutes ?? null,
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

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
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
        currentAdmin={{ id: ctx.userId, username: ctx.username }}
      />
    </div>
  )
}
