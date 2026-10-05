import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { resolveNetworkPoliciesBatch } from "@/lib/network-policy"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { UsersTable, type AdminUserRow } from "./users-table"
import { Users, ShieldCheck, UserCheck, MonitorSmartphone } from "lucide-react"

// 用户管理（管理员）：RSC 分页列表 + 全量管理操作
export const metadata = { title: "用户管理" }

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  // ---- 筛选构造 ----
  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [
      { username: { contains: q.keyword } },
      { email: { contains: q.keyword } },
      { id: { contains: q.keyword } },
    ]
  }
  if (f.role) where.role = f.role
  if (f.enabled) where.enabled = f.enabled === "true"
  if (f.frozen) where.frozen = f.frozen === "true"
  if (f.twoFactor) where.twoFactorEnabled = f.twoFactor === "true"
  if (f.locked === "true") where.lockedUntil = { gt: new Date() }
  // r33：多用户筛选（管理员界面勾选多个用户 → ids 过滤）
  const idsFilter = (f.ids || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (idsFilter.length > 0) where.id = { in: idsFilter }
  // r37：用户组筛选（多选组 → 组员 id 集；与多用户筛选取交集）
  const groupsFilter = (f.groups || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (groupsFilter.length > 0) {
    const members = await db.groupUser.findMany({ where: { groupId: { in: groupsFilter } }, select: { userId: true } })
    const groupMemberIds = [...new Set(members.map((m) => m.userId))]
    const combined = idsFilter.length > 0 ? groupMemberIds.filter((id) => idsFilter.includes(id)) : groupMemberIds
    where.id = { in: combined.length ? combined : ["__none__"] } // 组无成员/交集为空 → 空结果
  }
  if (f.createdFrom || f.createdTo) {
    where.createdAt = {
      ...(f.createdFrom ? { gte: new Date(f.createdFrom) } : {}),
      ...(f.createdTo ? { lte: new Date(`${f.createdTo}T23:59:59`) } : {}),
    }
  }
  if (f.lastLoginFrom || f.lastLoginTo) {
    where.lastLoginAt = {
      ...(f.lastLoginFrom ? { gte: new Date(f.lastLoginFrom) } : {}),
      ...(f.lastLoginTo ? { lte: new Date(`${f.lastLoginTo}T23:59:59`) } : {}),
    }
  }

  const [rows, total, statAll, statAdmin, statEnabled, statOnline, groups] = await Promise.all([
    db.user.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "username", "lastLoginAt", "email"], { createdAt: "desc" }),
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarPath: true,
        role: true,
        enabled: true,
        frozen: true,
        emailVerified: true,
        mustChangePassword: true,
        twoFactorEnabled: true,
        force2faSetup: true,
        allowInternalNetwork: true,
        allowSecureLocationAccess: true,
        vncSessionMaxMinutes: true,
        shareAllowed: true,
        guestShareAllowed: true,
        lockedUntil: true,
        failedLoginCount: true,
        quota: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
        // r33：存储配额 + 沙箱最大时长
        storageQuotaMb: true, managedPolicyOverrides: true,
        storagePolicy: true,
        maxTtlMinutes: true,
        allowUnlimitedTtl: true,
      },
    }),
    db.user.count({ where }),
    db.user.count({ where: { deletedAt: null } }),
    db.user.count({ where: { deletedAt: null, role: { in: ["SUPER_ADMIN", "ADMIN"] } } }),
    db.user.count({ where: { deletedAt: null, enabled: true } }),
    db.loginSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    db.group.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ])

  // 当前页用户所属组（无外键关联，内存组装）
  const userIds = rows.map((r) => r.id)
  const memberships = userIds.length
    ? await db.groupUser.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, groupId: true },
      })
    : []
  const involvedGroupIds = [...new Set(memberships.map((m) => m.groupId))]
  const involvedGroups = involvedGroupIds.length
    ? await db.group.findMany({ where: { id: { in: involvedGroupIds }, deletedAt: null }, select: { id: true, name: true } })
    : []
  const groupNameById = new Map(involvedGroups.map((g) => [g.id, g.name]))
  const groupsByUser = new Map<string, string[]>()
  for (const m of memberships) {
    const gname = groupNameById.get(m.groupId)
    if (!gname) continue
    const arr = groupsByUser.get(m.userId) || []
    arr.push(gname)
    groupsByUser.set(m.userId, arr)
  }

  // 当前页用户生效网络策略（批量解析：沙箱覆盖 > 用户覆盖 > 组继承 > 全局默认；用户列表按用户维度）
  const netPolicies = await resolveNetworkPoliciesBatch(userIds.map((uid) => ({ userId: uid })))

  // r33：当前页用户存储用量（FileMeta 统一口径：录像+截图+云盘）
  const storageUsageRows = userIds.length
    ? await db.fileMeta.groupBy({ by: ["userId"], where: { userId: { in: userIds }, deletedAt: null, purgedAt: null, category: { not: "AVATAR" } }, _sum: { size: true } })
    : []
  const storageUsageMbByUser = new Map(storageUsageRows.map((r) => [r.userId, Math.round(((r._sum.size || 0) / (1024 * 1024)) * 10) / 10]))

  const list: AdminUserRow[] = rows.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    hasAvatar: !!u.avatarPath,
    role: u.role,
    enabled: u.enabled,
    frozen: u.frozen,
    emailVerified: u.emailVerified,
    mustChangePassword: u.mustChangePassword,
    twoFactorEnabled: u.twoFactorEnabled,
    force2faSetup: u.force2faSetup,
    lockedUntil: u.lockedUntil ? fmtDate(u.lockedUntil) : null,
    failedLoginCount: u.failedLoginCount,
    quota: (u.quota as Record<string, number | null> | null) || null,
    lastLoginAt: u.lastLoginAt ? fmtDate(u.lastLoginAt) : null,
    lastLoginIp: u.lastLoginIp,
    createdAt: fmtDate(u.createdAt),
    groups: groupsByUser.get(u.id) || [],
    allowInternalNetwork: u.allowInternalNetwork,
    vncSessionMaxMinutes: u.vncSessionMaxMinutes ?? null,
    allowSecureLocationAccess: u.allowSecureLocationAccess,
    shareAllowed: u.shareAllowed ?? null,
    guestShareAllowed: u.guestShareAllowed ?? null,
    netPolicy: netPolicies.get(u.id) || null,
    storageQuotaMb: u.storageQuotaMb ?? null,
    storagePolicy: (u.storagePolicy as AdminUserRow["storagePolicy"]) || null,
    maxTtlMinutes: u.maxTtlMinutes ?? null,
    allowUnlimitedTtl: u.allowUnlimitedTtl ?? null,
    storageUsageMb: storageUsageMbByUser.get(u.id) ?? 0,
    managedPolicyOverrides: (u as { managedPolicyOverrides?: string | null }).managedPolicyOverrides ?? null,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用户管理</h1>
          <p className="text-sm text-muted-foreground mt-1">
            全平台账号全生命周期管控：创建 / 编辑 / 批量操作 / 2FA管控 / CSV导入导出
          </p>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="总用户数" value={statAll} sub="不含软删除" icon={<Users className="h-4 w-4" />} />
        <StatCard title="管理员" value={statAdmin} sub="SUPER_ADMIN + ADMIN" icon={<ShieldCheck className="h-4 w-4" />} />
        <StatCard title="启用账号" value={statEnabled} sub={`${statAll - statEnabled} 个已禁用`} icon={<UserCheck className="h-4 w-4" />} tone="success" />
        <StatCard title="在线会话" value={statOnline} sub="当前活跃登录会话" icon={<MonitorSmartphone className="h-4 w-4" />} />
      </div>

      <UsersTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        groupOptions={groups.map((g) => ({ id: g.id, name: g.name }))}
        viewerRole={ctx.role}
      />
    </div>
  )
}
