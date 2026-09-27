import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { maskSensitive } from "@/lib/crypto"

interface ExportGroup {
  name: string
  description: string | null
  parentName: string | null
  enabled: boolean
  inheritParentQuota: boolean
  quota: Record<string, number | null> | null
  reservedQuota: Record<string, number | null> | null
  force2fa: boolean
  tags: string[]
  permissionLocks: Record<string, boolean>
  userIds: string[]
  proxyNodeIds: string[]
  admins: { userId: string; canModifyQuota: boolean }[]
}

// 用户组JSON导出：GET /api/export/groups（完整组配置含组员/代理绑定，可直接供导入使用）
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireAdmin()

    const [groups, memberships, groupAdmins, groupProxies, allUsers, allProxyNodes] = await Promise.all([
      db.group.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "asc" } }),
      db.groupUser.findMany({
        select: { groupId: true, userId: true },
      }),
      db.groupAdmin.findMany({
        select: { groupId: true, userId: true, canModifyQuota: true },
      }),
      db.groupProxy.findMany({
        select: { groupId: true, proxyNodeId: true },
      }),
      db.user.findMany({ where: { deletedAt: null }, select: { id: true } }),
      db.proxyNode.findMany({ where: { deletedAt: null }, select: { id: true } }),
    ])

    const activeUserIds = new Set(allUsers.map((u) => u.id))
    const activeProxyIds = new Set(allProxyNodes.map((p) => p.id))

    const membersByGroup = new Map<string, string[]>()
    for (const m of memberships) {
      if (!activeUserIds.has(m.userId)) continue
      const arr = membersByGroup.get(m.groupId) || []
      arr.push(m.userId)
      membersByGroup.set(m.groupId, arr)
    }
    const adminsByGroup = new Map<string, { userId: string; canModifyQuota: boolean }[]>()
    for (const a of groupAdmins) {
      if (!activeUserIds.has(a.userId)) continue
      const arr = adminsByGroup.get(a.groupId) || []
      arr.push({ userId: a.userId, canModifyQuota: a.canModifyQuota })
      adminsByGroup.set(a.groupId, arr)
    }
    const proxiesByGroup = new Map<string, string[]>()
    for (const gp of groupProxies) {
      if (!activeProxyIds.has(gp.proxyNodeId)) continue
      const arr = proxiesByGroup.get(gp.groupId) || []
      arr.push(gp.proxyNodeId)
      proxiesByGroup.set(gp.groupId, arr)
    }
    const nameById = new Map(groups.map((g) => [g.id, g.name]))

    const items: ExportGroup[] = groups.map((g) => {
      const policy = (g.policy as Record<string, unknown> | null) || {}
      const tags = Array.isArray(g.tags) ? (g.tags as unknown[]).filter((t): t is string => typeof t === "string") : []
      return {
        name: g.name,
        description: g.description,
        parentName: g.parentId ? nameById.get(g.parentId) || null : null,
        enabled: g.enabled,
        inheritParentQuota: g.inheritParentQuota,
        quota: (g.quota as Record<string, number | null> | null) || null,
        reservedQuota: (g.reservedQuota as Record<string, number | null> | null) || null,
        force2fa: g.force2fa,
        tags,
        permissionLocks: (policy.permissionLocks as Record<string, boolean> | undefined) || {},
        userIds: membersByGroup.get(g.id) || [],
        proxyNodeIds: proxiesByGroup.get(g.id) || [],
        admins: adminsByGroup.get(g.id) || [],
      }
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EXPORT",
      resourceType: "GROUP",
      severity: "WARN",
      after: maskSensitive({ count: items.length }),
      extra: { exportFormat: "json" },
    })

    const payload = { exportedAt: new Date().toISOString(), total: items.length, groups: items }
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="dockyard-groups-${Date.now()}.json"`,
      },
    })
  })
}
