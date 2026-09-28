import { db } from "@/lib/db"
import { requireAdmin, PERMISSION_LOCK_KEYS } from "@/lib/permissions"
import { fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { GroupsTree, type AdminGroupNode } from "./groups-tree"
import { FolderTree, Users2, Network, ShieldAlert } from "lucide-react"

// 用户组管理（管理员）：树形组织 / 组员 / 组管理员 / 代理绑定 / 权限锁
export const metadata = { title: "用户组管理" }

export default async function AdminGroupsPage() {
  await requireAdmin()

  const [groups, memberships, groupAdmins, groupProxies, allUsers, proxyNodes] = await Promise.all([
    db.group.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } }),
    db.groupUser.findMany({
      select: { groupId: true, userId: true },
      take: 5000,
    }),
    db.groupAdmin.findMany({
      select: { groupId: true, userId: true, canModifyQuota: true },
    }),
    db.groupProxy.findMany({
      select: { groupId: true, proxyNodeId: true },
    }),
    db.user.findMany({
      where: { deletedAt: null },
      select: { id: true, username: true, displayName: true, email: true, enabled: true },
      orderBy: { username: "asc" },
    }),
    db.proxyNode.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    }),
  ])

  const activeUserIds = new Set(allUsers.map((u) => u.id))

  // 组装聚合数据（无外键关联，内存组装并过滤已删除用户/节点）
  const membersByGroup = new Map<string, { userId: string; username: string }[]>()
  const usernameById = new Map(allUsers.map((u) => [u.id, u.username]))
  for (const m of memberships) {
    if (!activeUserIds.has(m.userId)) continue
    const arr = membersByGroup.get(m.groupId) || []
    if (arr.length < 500) arr.push({ userId: m.userId, username: usernameById.get(m.userId) || m.userId })
    membersByGroup.set(m.groupId, arr)
  }
  const adminsByGroup = new Map<string, { userId: string; username: string; canModifyQuota: boolean }[]>()
  for (const a of groupAdmins) {
    if (!activeUserIds.has(a.userId)) continue
    const arr = adminsByGroup.get(a.groupId) || []
    arr.push({ userId: a.userId, username: usernameById.get(a.userId) || a.userId, canModifyQuota: a.canModifyQuota })
    adminsByGroup.set(a.groupId, arr)
  }
  const proxyById = new Map(proxyNodes.map((p) => [p.id, p]))
  const proxiesByGroup = new Map<string, { id: string; name: string; status: string }[]>()
  for (const gp of groupProxies) {
    const node = proxyById.get(gp.proxyNodeId)
    if (!node) continue
    const arr = proxiesByGroup.get(gp.groupId) || []
    arr.push({ id: node.id, name: node.name, status: node.status })
    proxiesByGroup.set(gp.groupId, arr)
  }

  // 构建树（内存组装）
  const nodes: AdminGroupNode[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    parentId: g.parentId,
    enabled: g.enabled,
    inheritParentQuota: g.inheritParentQuota,
    quota: (g.quota as Record<string, number | null> | null) || null,
    reservedQuota: (g.reservedQuota as Record<string, number | null> | null) || null,
    tags: Array.isArray(g.tags) ? (g.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    force2fa: g.force2fa,
    allowInternalNetwork: g.allowInternalNetwork,
    allowSecureLocationAccess: g.allowSecureLocationAccess,
    policy: (g.policy as Record<string, unknown> | null) || null,
    userCount: (membersByGroup.get(g.id) || []).length,
    proxyBindings: (proxiesByGroup.get(g.id) || []).map((p) => p.name),
    members: membersByGroup.get(g.id) || [],
    admins: adminsByGroup.get(g.id) || [],
    proxies: proxiesByGroup.get(g.id) || [],
    createdAt: fmtDate(g.createdAt),
    children: [],
  }))

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const roots: AdminGroupNode[] = []
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(n)
    } else {
      roots.push(n)
    }
  }

  const totalUsers = memberships.length
  const totalAdminBinds = groupAdmins.length
  const totalProxyBinds = groupProxies.length
  const lockCount = nodes.filter((n) => {
    const locks = ((n.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | undefined) || {}
    return Object.values(locks).some((v) => v === true)
  }).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">用户组管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          树形组织架构：配额继承 / 组员与组管理员 / 代理节点绑定 / 组级权限锁 / 复制与导入
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="用户组总数" value={groups.length} sub="树形层级组织" icon={<FolderTree className="h-4 w-4" />} />
        <StatCard title="组成员关系" value={totalUsers} sub="组-用户绑定总数" icon={<Users2 className="h-4 w-4" />} />
        <StatCard title="代理绑定" value={totalProxyBinds} sub={`组-代理节点绑定 / ${totalAdminBinds} 组管理员`} icon={<Network className="h-4 w-4" />} />
        <StatCard title="启用权限锁的组" value={lockCount} sub="组级细粒度锁定" icon={<ShieldAlert className="h-4 w-4" />} tone={lockCount > 0 ? "warning" : "default"} />
      </div>

      <GroupsTree
        roots={roots}
        allNodes={nodes}
        lockKeys={[...PERMISSION_LOCK_KEYS]}
        userOptions={allUsers.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, email: u.email, enabled: u.enabled }))}
        proxyOptions={proxyNodes.map((p) => ({ id: p.id, name: p.name, status: p.status }))}
      />
    </div>
  )
}
