import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { WorkspacesTable, type AdminWorkspaceRow, type UserOption } from "./workspaces-table"
import { Globe, PlayCircle, MonitorCog, Terminal, TriangleAlert } from "lucide-react"

// 工作区管控（管理员强制操作核心页）
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

  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ uuid: { contains: q.keyword } }, { name: { contains: q.keyword } }]
  }
  if (f.mode) where.mode = f.mode
  if (f.status) where.status = f.status
  if (f.owner) {
    // 按所有者用户名筛选（无外键，先查用户集合）
    const ownerUsers = await db.user.findMany({
      where: { username: { contains: f.owner }, deletedAt: null },
      select: { id: true },
    })
    where.userId = { in: ownerUsers.map((u) => u.id).concat("__none__") }
  }

  const [rows, total, statTotal, statRunning, statCdp, statNovnc, statAbnormal] = await Promise.all([
    db.browserWorkspace.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "status", "name", "cdpCallCount"], { createdAt: "desc" }),
    }),
    db.browserWorkspace.count({ where }),
    db.browserWorkspace.count({ where: { deletedAt: null } }),
    db.browserWorkspace.count({ where: { deletedAt: null, status: "RUNNING" } }),
    db.browserWorkspace.count({ where: { deletedAt: null, mode: "cdp_light" } }),
    db.browserWorkspace.count({ where: { deletedAt: null, mode: "novnc_full" } }),
    db.browserWorkspace.count({ where: { deletedAt: null, status: { in: ["ERROR", "FROZEN"] } } }),
  ])

  // ---- 内存 join：所有者/创建人/组/代理/SingBox/Steel ----
  const userIds = [...new Set(rows.flatMap((r) => [r.userId, r.createdByUserId].filter(Boolean) as string[]))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(users.map((u) => [u.id, u.username]))

  const groupIds = [...new Set(rows.map((r) => r.groupId).filter(Boolean) as string[])]
  const groups = groupIds.length ? await db.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : []
  const groupNameById = new Map(groups.map((g) => [g.id, g.name]))

  const proxyIds = [...new Set(rows.map((r) => r.proxyNodeId).filter(Boolean) as string[])]
  const proxies = proxyIds.length ? await db.proxyNode.findMany({ where: { id: { in: proxyIds } }, select: { id: true, name: true } }) : []
  const proxyNameById = new Map(proxies.map((p) => [p.id, p.name]))

  const sbiIds = [...new Set(rows.map((r) => r.singboxInstanceId).filter(Boolean) as string[])]
  const sbis = sbiIds.length ? await db.singboxInstance.findMany({ where: { id: { in: sbiIds } }, select: { id: true, name: true } }) : []
  const sbiNameById = new Map(sbis.map((s) => [s.id, s.name]))

  const steelIds = [...new Set(rows.map((r) => r.steelNodeId).filter(Boolean) as string[])]
  const steels = steelIds.length ? await db.steelNode.findMany({ where: { id: { in: steelIds } }, select: { id: true, name: true } }) : []
  const steelNameById = new Map(steels.map((s) => [s.id, s.name]))

  const list: AdminWorkspaceRow[] = rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    name: r.name,
    mode: r.mode,
    status: r.status,
    ownerUsername: usernameById.get(r.userId) || "-",
    creatorUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
    groupName: r.groupId ? groupNameById.get(r.groupId) || "-" : "-",
    proxyNodeName: r.proxyNodeId ? proxyNameById.get(r.proxyNodeId) || "-" : "-",
    singboxName: r.singboxInstanceId ? sbiNameById.get(r.singboxInstanceId) || "-" : "-",
    steelNodeName: r.steelNodeId ? steelNameById.get(r.steelNodeId) || "-" : "-",
    ttlMinutes: r.ttlMinutes,
    idleTimeoutMinutes: r.idleTimeoutMinutes,
    cdpCallCount: r.cdpCallCount,
    novncConnCount: r.novncConnCount,
    hasNovncSession: !!r.novncSessionId,
    freezeReason: r.freezeReason,
    createdAt: fmtDate(r.createdAt),
  }))

  // 资源转移目标用户选项
  const transferTargets: UserOption[] = await db.user
    .findMany({
      where: { deletedAt: null, enabled: true, frozen: false },
      select: { id: true, username: true, displayName: true, role: true },
      orderBy: { username: "asc" },
      take: 200,
    })
    .then((us) => us.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role })))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">工作区管控</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全平台工作区强制操作中枢：停止 / 重启 / 回收 / 物理删除 / VNC 断连 / TTL 覆写 / 资源转移（全量审计）
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard title="总工作区" value={statTotal} sub="全部用户 · 不含回收站" icon={<Globe className="h-4 w-4" />} />
        <StatCard title="运行中" value={statRunning} sub="RUNNING" icon={<PlayCircle className="h-4 w-4" />} tone="success" />
        <StatCard title="CDP 轻量" value={statCdp} sub="cdp_light" icon={<Terminal className="h-4 w-4" />} />
        <StatCard title="NoVNC 完整" value={statNovnc} sub="novnc_full" icon={<MonitorCog className="h-4 w-4" />} />
        <StatCard title="异常工作区" value={statAbnormal} sub="ERROR + FROZEN" icon={<TriangleAlert className="h-4 w-4" />} tone={statAbnormal > 0 ? "danger" : "success"} />
      </div>

      <WorkspacesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        transferTargets={transferTargets}
      />
    </div>
  )
}
