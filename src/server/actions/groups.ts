"use server"

// 用户组管理 Server Actions：树形组织 / 组员 / 组管理员 / 代理绑定 / 权限锁 / 复制与导入

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin, requireAuth } from "@/lib/permissions"
import { PERMISSION_LOCK_KEYS, type PermissionLockKey } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"
import { zodValidate, zId, zPrecision } from "@/lib/validators"

// ---- schema ----

const zQuota = z.object({
  sessions: zPrecision("会话配额", 0, 100000).optional(),
  novncSessions: zPrecision("NoVNC配额", 0, 100000).optional(),
  diskMb: zPrecision("磁盘配额", 0, 10000000).optional(),
})

// 获取某组的全部后代ID（防循环）
async function descendantIds(groupId: string): Promise<Set<string>> {
  const all = await db.group.findMany({ where: { deletedAt: null }, select: { id: true, parentId: true } })
  const childrenMap = new Map<string, string[]>()
  for (const g of all) {
    if (g.parentId) {
      const arr = childrenMap.get(g.parentId) || []
      arr.push(g.id)
      childrenMap.set(g.parentId, arr)
    }
  }
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const child of childrenMap.get(cur) || []) {
      if (!result.has(child)) {
        result.add(child)
        queue.push(child)
      }
    }
  }
  return result
}


// 清理配额对象（去除undefined键，规范为JSON输入）
function cleanQuota(q: { sessions?: number; novncSessions?: number; diskMb?: number }): Record<string, number> {
  const out: Record<string, number> = {}
  if (q.sessions !== undefined) out.sessions = q.sessions
  if (q.novncSessions !== undefined) out.novncSessions = q.novncSessions
  if (q.diskMb !== undefined) out.diskMb = q.diskMb
  return out
}

function groupBrief(g: {
  id: string
  name: string
  description?: string | null
  parentId?: string | null
  enabled: boolean
  inheritParentQuota: boolean
  quota?: unknown
  reservedQuota?: unknown
  tags?: unknown
  force2fa: boolean
  policy?: unknown
  allowInternalNetwork?: boolean | null
  allowSecureLocationAccess?: boolean | null
  vncSessionMaxMinutes?: number | null
}) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    parentId: g.parentId,
    enabled: g.enabled,
    inheritParentQuota: g.inheritParentQuota,
    quota: g.quota ?? null,
    reservedQuota: g.reservedQuota ?? null,
    tags: g.tags ?? null,
    force2fa: g.force2fa,
    policy: g.policy ?? null,
    allowInternalNetwork: g.allowInternalNetwork ?? null,
    allowSecureLocationAccess: g.allowSecureLocationAccess ?? null,
    vncSessionMaxMinutes: g.vncSessionMaxMinutes ?? null,
  }
}

// ---- 1. 新建组 ----

const createGroupSchema = z.object({
  name: z.string().min(2, "组名至少2位").max(64),
  description: z.string().max(255).optional(),
  parentId: zId.optional(),
  enabled: z.boolean().default(true),
  inheritParentQuota: z.boolean().default(true),
  quota: zQuota.optional(),
  reservedQuota: zQuota.optional(),
  force2fa: z.boolean().default(false),
  tags: z.array(z.string().max(32)).max(20).default([]),
  allowInternalNetwork: z.boolean().default(false), // 组级网络策略：允许访问内网
  allowSecureLocationAccess: z.boolean().default(false), // 组级网络策略：允许访问容器内安全位置
  vncSessionMaxMinutes: z.number().int().min(0).max(43200).nullable().optional(), // 组级 VNC 连接总时长上限（分钟，null=继承全局，0=不限）
})

export async function createGroupAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(createGroupSchema, input)

    const dup = await db.group.findFirst({ where: { name: p.name } })
    if (dup) throw new Error(`组名 ${p.name} 已存在`)
    if (p.parentId) {
      const parent = await db.group.findFirst({ where: { id: p.parentId, deletedAt: null } })
      if (!parent) throw new Error("父组不存在或已删除")
    }

    const group = await db.group.create({
      data: {
        name: p.name,
        description: p.description || null,
        parentId: p.parentId || null,
        enabled: p.enabled,
        inheritParentQuota: p.inheritParentQuota,
        quota: p.quota ? { ...p.quota } : undefined,
        reservedQuota: p.reservedQuota ? { ...p.reservedQuota } : undefined,
        force2fa: p.force2fa,
        tags: p.tags.length > 0 ? p.tags : undefined,
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
        vncSessionMaxMinutes: p.vncSessionMaxMinutes ?? null,
        createdByUserId: ctx.userId,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_CREATE",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      createdByUserId: ctx.userId,
      after: groupBrief(group),
    })
    await trackBehavior(ctx.userId, "CREATE")

    return { id: group.id }
  })
}

// ---- 2. 编辑组（含父组防循环校验） ----

const updateGroupSchema = createGroupSchema.extend({ id: zId })

export async function updateGroupAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(updateGroupSchema, input)

    const before = await db.group.findUnique({ where: { id: p.id } })
    if (!before || before.deletedAt) throw new Error("用户组不存在或已删除")

    const dup = await db.group.findFirst({ where: { name: p.name, id: { not: p.id } } })
    if (dup) throw new Error(`组名 ${p.name} 已存在`)

    if (p.parentId) {
      if (p.parentId === p.id) throw new Error("父组不能选择自己")
      const parent = await db.group.findFirst({ where: { id: p.parentId, deletedAt: null } })
      if (!parent) throw new Error("父组不存在或已删除")
      const desc = await descendantIds(p.id)
      if (desc.has(p.parentId)) throw new Error("父组不能是自己的后代（禁止循环层级）")
    }

    const after = await db.group.update({
      where: { id: p.id },
      data: {
        name: p.name,
        description: p.description || null,
        parentId: p.parentId || null,
        enabled: p.enabled,
        inheritParentQuota: p.inheritParentQuota,
        quota: p.quota ? (cleanQuota(p.quota) as Prisma.InputJsonValue) : Prisma.DbNull,
        reservedQuota: p.reservedQuota ? (cleanQuota(p.reservedQuota) as Prisma.InputJsonValue) : Prisma.DbNull,
        force2fa: p.force2fa,
        tags: p.tags.length > 0 ? p.tags : Prisma.DbNull,
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
        vncSessionMaxMinutes: p.vncSessionMaxMinutes ?? null,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_UPDATE",
      resourceType: "GROUP",
      resourceId: after.id,
      resourceName: after.name,
      before: groupBrief(before),
      after: groupBrief(after),
    })

    return { id: after.id }
  })
}

// ---- 3. 删除组（多重前置检查） ----

export async function deleteGroupAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const group = await db.group.findUnique({ where: { id } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    const [userCount, childCount, proxyCount, runningSessions] = await Promise.all([
      db.groupUser.count({ where: { groupId: id } }),
      db.group.count({ where: { parentId: id, deletedAt: null } }),
      db.groupProxy.count({ where: { groupId: id } }),
      db.browserWorkspace.count({
        where: { groupId: id, deletedAt: null, status: { in: ["RUNNING", "CREATING", "IDLE"] } },
      }),
    ])

    const blockers: string[] = []
    if (userCount > 0) blockers.push(`组内仍有 ${userCount} 名成员`)
    if (childCount > 0) blockers.push(`存在 ${childCount} 个子组`)
    if (proxyCount > 0) blockers.push(`已绑定 ${proxyCount} 个代理节点`)
    if (runningSessions > 0) blockers.push(`存在 ${runningSessions} 个运行中浏览器会话`)
    if (blockers.length > 0) throw new Error(`禁止删除：${blockers.join("；")}`)

    await db.group.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } })
    await db.groupProxy.deleteMany({ where: { groupId: id } })
    await db.groupAdmin.deleteMany({ where: { groupId: id } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_DELETE",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      severity: "WARN",
      before: groupBrief(group),
      after: { deletedAt: new Date().toISOString() },
    })
    await trackBehavior(ctx.userId, "DELETE")

    return { id: group.id }
  })
}

// ---- 4. 组员管理（批量添加/移除） ----

export async function setGroupUsersAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        groupId: zId,
        userIds: z.array(zId).min(1).max(500),
        op: z.enum(["add", "remove"]),
      }),
      input
    )

    const group = await db.group.findUnique({ where: { id: p.groupId } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    const users = await db.user.findMany({ where: { id: { in: p.userIds }, deletedAt: null } })
    if (users.length !== p.userIds.length) throw new Error("部分用户不存在或已删除")

    let affected = 0
    if (p.op === "add") {
      // SQLite 不支持 skipDuplicates：先过滤已存在关系
      const existing = await db.groupUser.findMany({
        where: { groupId: p.groupId, userId: { in: p.userIds } },
        select: { userId: true },
      })
      const existingIds = new Set(existing.map((e) => e.userId))
      const toAdd = p.userIds.filter((uid) => !existingIds.has(uid))
      if (toAdd.length > 0) {
        const r = await db.groupUser.createMany({
          data: toAdd.map((uid) => ({ groupId: p.groupId, userId: uid })),
        })
        affected = r.count
      }
    } else {
      const r = await db.groupUser.deleteMany({ where: { groupId: p.groupId, userId: { in: p.userIds } } })
      affected = r.count
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: p.op === "add" ? "GROUP_USER_ADD" : "GROUP_USER_REMOVE",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      before: { userIds: p.userIds },
      after: { op: p.op, affected },
      extra: { batchSize: p.userIds.length },
    })
    if (p.userIds.length >= 10) await trackBehavior(ctx.userId, "BATCH")

    return { affected }
  })
}

// ---- 5. 组管理员管理（绑定/解绑/开关） ----

export async function setGroupAdminAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        groupId: zId,
        userId: zId,
        op: z.enum(["bind", "unbind"]),
        canModifyQuota: z.boolean().default(true),
      }),
      input
    )

    const group = await db.group.findUnique({ where: { id: p.groupId } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    const user = await db.user.findUnique({ where: { id: p.userId } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    if (p.op === "bind") {
      // 确保该用户在组内（组管理员应属于该组）
      const inGroup = await db.groupUser.findUnique({ where: { groupId_userId: { groupId: p.groupId, userId: p.userId } } })
      if (!inGroup) {
        await db.groupUser.create({ data: { groupId: p.groupId, userId: p.userId } })
      }
      await db.groupAdmin.upsert({
        where: { groupId_userId: { groupId: p.groupId, userId: p.userId } },
        update: { canModifyQuota: p.canModifyQuota },
        create: { groupId: p.groupId, userId: p.userId, canModifyQuota: p.canModifyQuota },
      })
      // 提升角色为 GROUP_ADMIN（若当前为普通用户）
      if (user.role === "USER") {
        await db.user.update({ where: { id: user.id }, data: { role: "GROUP_ADMIN" } })
      }
    } else {
      await db.groupAdmin.deleteMany({ where: { groupId: p.groupId, userId: p.userId } })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: p.op === "bind" ? "GROUP_ADMIN_BIND" : "GROUP_ADMIN_UNBIND",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      after: { targetUserId: p.userId, targetUsername: user.username, canModifyQuota: p.canModifyQuota, op: p.op },
    })

    return { affected: 1 }
  })
}

// ---- 6. 组代理绑定 ----

export async function setGroupProxyAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        groupId: zId,
        proxyNodeIds: z.array(zId).min(1).max(50),
        op: z.enum(["bind", "unbind"]),
      }),
      input
    )

    const group = await db.group.findUnique({ where: { id: p.groupId } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    const nodes = await db.proxyNode.findMany({ where: { id: { in: p.proxyNodeIds }, deletedAt: null } })
    if (nodes.length !== p.proxyNodeIds.length) throw new Error("部分代理节点不存在或已删除")

    let affected = 0
    if (p.op === "bind") {
      const existing = await db.groupProxy.findMany({
        where: { groupId: p.groupId, proxyNodeId: { in: p.proxyNodeIds } },
        select: { proxyNodeId: true },
      })
      const existingIds = new Set(existing.map((e) => e.proxyNodeId))
      const toAdd = p.proxyNodeIds.filter((nid) => !existingIds.has(nid))
      if (toAdd.length > 0) {
        const r = await db.groupProxy.createMany({
          data: toAdd.map((nid) => ({ groupId: p.groupId, proxyNodeId: nid })),
        })
        affected = r.count
      }
    } else {
      const r = await db.groupProxy.deleteMany({ where: { groupId: p.groupId, proxyNodeId: { in: p.proxyNodeIds } } })
      affected = r.count
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: p.op === "bind" ? "GROUP_PROXY_BIND" : "GROUP_PROXY_UNBIND",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      after: { op: p.op, proxyNodeIds: p.proxyNodeIds, proxyNames: nodes.map((n) => n.name), affected },
    })

    return { affected }
  })
}

// ---- 7. 组复制（配额/组员/代理绑定 → 新组） ----

export async function copyGroupAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId, newName: z.string().min(2).max(64) }), input)

    const source = await db.group.findUnique({ where: { id: p.id } })
    if (!source || source.deletedAt) throw new Error("源用户组不存在或已删除")
    const dup = await db.group.findFirst({ where: { name: p.newName } })
    if (dup) throw new Error(`组名 ${p.newName} 已存在`)

    const newGroup = await db.group.create({
      data: {
        name: p.newName,
        description: source.description ? `${source.description}（复制自 ${source.name}）` : `复制自 ${source.name}`,
        parentId: source.parentId,
        enabled: source.enabled,
        inheritParentQuota: source.inheritParentQuota,
        quota: (source.quota ?? undefined) as Prisma.InputJsonValue | undefined,
        reservedQuota: (source.reservedQuota ?? undefined) as Prisma.InputJsonValue | undefined,
        tags: (source.tags ?? undefined) as Prisma.InputJsonValue | undefined,
        force2fa: source.force2fa,
        policy: (source.policy ?? undefined) as Prisma.InputJsonValue | undefined,
        createdByUserId: ctx.userId,
      },
    })

    // 复制组员
    const members = await db.groupUser.findMany({ where: { groupId: source.id } })
    if (members.length > 0) {
      await db.groupUser.createMany({
        data: members.map((m) => ({ groupId: newGroup.id, userId: m.userId })),
      })
    }
    // 复制代理绑定
    const proxies = await db.groupProxy.findMany({ where: { groupId: source.id } })
    if (proxies.length > 0) {
      await db.groupProxy.createMany({
        data: proxies.map((gp) => ({ groupId: newGroup.id, proxyNodeId: gp.proxyNodeId })),
      })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_COPY",
      resourceType: "GROUP",
      resourceId: newGroup.id,
      resourceName: newGroup.name,
      after: {
        sourceGroupId: source.id,
        sourceGroupName: source.name,
        copiedUsers: members.length,
        copiedProxies: proxies.length,
        quota: source.quota,
      },
    })
    await trackBehavior(ctx.userId, "CREATE")

    return { id: newGroup.id }
  })
}

// ---- 8. 权限锁（组级16项开关） ----

const updateLocksSchema = z.object({
  groupId: zId,
  locks: z.record(z.string(), z.boolean()),
})

export async function updateGroupLocksAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(updateLocksSchema, input)

    const group = await db.group.findUnique({ where: { id: p.groupId } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    // 只允许合法键，值必须是布尔
    const cleaned: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(p.locks)) {
      if (!PERMISSION_LOCK_KEYS.includes(k as PermissionLockKey)) throw new Error(`未知权限锁键：${k}`)
      cleaned[k] = v === true
    }

    const beforePolicy = (group.policy as Record<string, unknown> | null) || {}
    const beforeLocks = (beforePolicy.permissionLocks as Record<string, boolean> | null) || {}
    const newPolicy = { ...beforePolicy, permissionLocks: cleaned }

    await db.group.update({ where: { id: p.groupId }, data: { policy: newPolicy as Prisma.InputJsonValue } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_POLICY_LOCKS_UPDATE",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      severity: "WARN",
      before: { permissionLocks: beforeLocks },
      after: { permissionLocks: cleaned },
    })

    return { id: group.id }
  })
}

// ---- 9. 导入组JSON ----

export interface GroupImportReport {
  total: number
  success: number
  failed: number
  errors: { line: number; message: string }[]
}

interface ImportGroupItem {
  name: string
  description?: string
  parentName?: string
  enabled?: boolean
  inheritParentQuota?: boolean
  quota?: { sessions?: number; novncSessions?: number; diskMb?: number }
  reservedQuota?: { sessions?: number; novncSessions?: number; diskMb?: number }
  force2fa?: boolean
  tags?: string[]
  permissionLocks?: Record<string, boolean>
  userIds?: string[]
  proxyNodeIds?: string[]
}

export async function importGroupsJsonAction(input: unknown): Promise<ActionResult<GroupImportReport>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({ text: z.string().min(2, "JSON内容为空").max(1_000_000) }),
      input
    )

    let items: ImportGroupItem[]
    try {
      const parsed = JSON.parse(p.text)
      items = Array.isArray(parsed) ? parsed : (parsed.groups as ImportGroupItem[])
      if (!Array.isArray(items)) throw new Error("结构错误")
    } catch {
      throw new Error("JSON解析失败：应为组对象数组或 { groups: [...] }")
    }

    const report: GroupImportReport = { total: items.length, success: 0, failed: 0, errors: [] }
    const nameToId = new Map<string, string>()
    const existing = await db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true } })
    for (const g of existing) nameToId.set(g.name, g.id)

    // 依次创建（父组按名称引用，允许引用本批次先创建的）
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      try {
        const nameCheck = z.string().min(2).max(64).safeParse(item.name)
        if (!nameCheck.success) throw new Error("组名非法（2-64字符）")
        if (nameToId.has(item.name)) throw new Error("组名已存在")

        let parentId: string | null = null
        if (item.parentName) {
          if (item.parentName === item.name) throw new Error("父组不能是自己")
          parentId = nameToId.get(item.parentName) || null
          if (!parentId) throw new Error(`父组 ${item.parentName} 不存在（须在数组前部先声明）`)
        }

        const policy = item.permissionLocks
          ? ({ permissionLocks: item.permissionLocks } as Prisma.InputJsonValue)
          : undefined

        const group = await db.group.create({
          data: {
            name: item.name,
            description: item.description || null,
            parentId,
            enabled: item.enabled ?? true,
            inheritParentQuota: item.inheritParentQuota ?? true,
            quota: (item.quota ?? undefined) as Prisma.InputJsonValue | undefined,
            reservedQuota: (item.reservedQuota ?? undefined) as Prisma.InputJsonValue | undefined,
            force2fa: item.force2fa ?? false,
            tags: item.tags && item.tags.length > 0 ? item.tags : undefined,
            policy,
            createdByUserId: ctx.userId,
          },
        })
        nameToId.set(group.name, group.id)

        // 组员
        if (Array.isArray(item.userIds) && item.userIds.length > 0) {
          const users = await db.user.findMany({ where: { id: { in: item.userIds }, deletedAt: null } })
          if (users.length > 0) {
            await db.groupUser.createMany({
              data: users.map((u) => ({ groupId: group.id, userId: u.id })),
            })
          }
        }
        // 代理绑定
        if (Array.isArray(item.proxyNodeIds) && item.proxyNodeIds.length > 0) {
          const nodes = await db.proxyNode.findMany({ where: { id: { in: item.proxyNodeIds }, deletedAt: null } })
          if (nodes.length > 0) {
            await db.groupProxy.createMany({
              data: nodes.map((n) => ({ groupId: group.id, proxyNodeId: n.id })),
            })
          }
        }

        report.success++
      } catch (e) {
        report.failed++
        report.errors.push({ line: i + 1, message: e instanceof Error ? e.message : "导入失败" })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_IMPORT_JSON",
      resourceType: "GROUP",
      severity: report.failed > 0 ? "WARN" : "INFO",
      after: { total: report.total, success: report.success, failed: report.failed },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return report
  })
}

// ---- 组级网络访问策略（管理员按用户组控制：内网 / 容器安全位置，成员默认继承）----
// 鉴权：SUPER_ADMIN / ADMIN 全量；GROUP_ADMIN 仅限自己管理的组；普通用户 403（前端不渲染入口）
export async function setGroupNetworkPolicyAction(
  input: unknown,
): Promise<ActionResult<{ id: string; allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; affectedMembers: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const isGroupAdmin = ctx.role === "GROUP_ADMIN"
    if (!isAdmin && !isGroupAdmin) throw new Error("无权设置组级网络访问策略（需要管理员或组管理员权限）")

    const p = zodValidate(
      z.object({
        id: zId,
        allowInternalNetwork: z.boolean(),
        allowSecureLocationAccess: z.boolean(),
      }),
      input,
    )

    const group = await db.group.findUnique({ where: { id: p.id } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    // 组管理员范围校验：仅可操作自己管理的组
    if (isGroupAdmin && !isAdmin) {
      const ga = await db.groupAdmin.findFirst({ where: { groupId: group.id, userId: ctx.userId } })
      if (!ga) throw new Error("仅可为自己管理的用户组设置网络访问策略")
    }

    const before = {
      allowInternalNetwork: group.allowInternalNetwork,
      allowSecureLocationAccess: group.allowSecureLocationAccess,
    }

    await db.group.update({
      where: { id: group.id },
      data: {
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
        vncSessionMaxMinutes: p.vncSessionMaxMinutes ?? null,
      },
    })

    // 影响面统计：组内未做用户级覆盖的成员数（策略调整即时影响其新会话）
    const memberIds = await db.groupUser.findMany({ where: { groupId: group.id }, select: { userId: true } })
    const affectedMembers = await db.user.count({
      where: {
        id: { in: memberIds.map((m) => m.userId) },
        deletedAt: null,
        allowInternalNetwork: null,
        allowSecureLocationAccess: null,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_NETWORK_POLICY",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      before,
      after: {
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
        vncSessionMaxMinutes: p.vncSessionMaxMinutes ?? null,
      },
      severity: "WARN",
      extra: { affectedMembers },
    })

    return { id: group.id, allowInternalNetwork: p.allowInternalNetwork, allowSecureLocationAccess: p.allowSecureLocationAccess, affectedMembers }
  })
}
