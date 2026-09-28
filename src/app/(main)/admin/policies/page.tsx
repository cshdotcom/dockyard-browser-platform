import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { fmtDate } from "@/lib/utils-server"
import { PolicyDeployCenter, type DeploymentRow, type TargetOptionUser, type TargetOptionGroup, type TemplateRow } from "./deploy-center"
import { ShieldCheck, Users, Layers, Undo2 } from "lucide-react"

// 策略下发中心（管理员）：按用户/用户组批量下发访问控制策略包 + 批次历史 + 回滚
export const metadata = { title: "策略下发中心" }

export default async function AdminPoliciesPage() {
  const ctx = await requireAdmin()

  const [deployments, templates, targetOptions, statTotal, statUsers, statGroups, statRollback] = await Promise.all([
    db.policyDeployment.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.policyTemplate.findMany({ where: { deletedAt: null }, orderBy: [{ builtin: "desc" }, { createdAt: "desc" }], take: 100 }),
    (async () => {
      const [groups, users, memberships] = await Promise.all([
        db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true, parentId: true }, take: 200 }),
        db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true, displayName: true, role: true }, take: 500 }),
        db.groupUser.findMany({ select: { userId: true, groupId: true } }),
      ])
      const groupById = new Map(groups.map((g) => [g.id, g]))
      const groupsByUser = new Map<string, string[]>()
      for (const m of memberships) {
        const arr = groupsByUser.get(m.userId) || []
        arr.push(m.groupId)
        groupsByUser.set(m.userId, arr)
      }
      const memberCount = new Map<string, number>()
      for (const m of memberships) memberCount.set(m.groupId, (memberCount.get(m.groupId) || 0) + 1)
      const groupPath = (gid: string): string => {
        const names: string[] = []
        let cursor: string | null = gid
        const seen = new Set<string>()
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor)
          const g = groupById.get(cursor)
          if (!g) break
          names.unshift(g.name)
          cursor = g.parentId
        }
        return names.join(" / ")
      }
      return {
        groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: memberCount.get(g.id) || 0, path: groupPath(g.id) })),
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          role: u.role,
          groupNames: (groupsByUser.get(u.id) || []).map((gid) => groupById.get(gid)?.name).filter(Boolean) as string[],
        })),
      }
    })(),
    db.policyDeployment.count(),
    db.user.count({ where: { deletedAt: null } }),
    db.group.count({ where: { deletedAt: null } }),
    db.policyDeployment.count({ where: { status: "ROLLED_BACK" } }),
  ])

  const creatorIds = [...new Set(deployments.map((r) => r.createdByUserId).filter(Boolean) as string[])]
  const creators = creatorIds.length ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } }) : []
  const usernameById = new Map(creators.map((c) => [c.id, c.username]))

  const deploymentRows: DeploymentRow[] = deployments.map((r) => {
    let bundle: Record<string, unknown> = {}
    try { bundle = JSON.parse(r.bundleJson) } catch { /* 兼容 */ }
    let results: DeploymentRow["results"] = null
    try { results = r.resultsJson ? JSON.parse(r.resultsJson) : null } catch { results = null }
    return {
      id: r.id,
      name: r.name,
      note: r.note,
      status: r.status,
      totalTargets: r.totalTargets,
      successTargets: r.successTargets,
      failedTargets: r.failedTargets,
      createdByUsername: r.createdByUserId ? usernameById.get(r.createdByUserId) || "-" : "-",
      deployedAt: r.deployedAt ? fmtDate(r.deployedAt) : null,
      rolledBackAt: r.rolledBackAt ? fmtDate(r.rolledBackAt) : null,
      bundle,
      results,
    }
  })

  const templateRows: TemplateRow[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    builtin: t.builtin,
    bundle: t.bundleJson ? JSON.parse(t.bundleJson) : null,
  }))

  const stats = [
    { title: "下发批次", value: statTotal, sub: "含历史", icon: <Layers className="h-4 w-4" /> },
    { title: "可选用户", value: statUsers, sub: "全部活跃用户", icon: <Users className="h-4 w-4" /> },
    { title: "可选用户组", value: statGroups, sub: "树形组织", icon: <ShieldCheck className="h-4 w-4" /> },
    { title: "已回滚批次", value: statRollback, sub: "快照恢复", icon: <Undo2 className="h-4 w-4" /> },
  ]

  return (
    <PolicyDeployCenter
      deployments={deploymentRows}
      templates={templateRows}
      targetGroups={targetOptions.groups as TargetOptionGroup[]}
      targetUsers={targetOptions.users as TargetOptionUser[]}
      stats={stats}
    />
  )
}
