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
import { getConfigNumber, getConfigBool } from "@/lib/config"
import { fmtIdleBrief } from "@/lib/idle-policy"

// ---- schema ----

const zQuota = z.object({
  sessions: zPrecision("会话配额", 0, 100000).optional(),
  novncSessions: zPrecision("NoVNC配额", 0, 100000).optional(),
  diskMb: zPrecision("磁盘配额", 0, 10000000).optional(),
  proxyBandwidthMb: zPrecision("代理带宽配额(MB)", 0, 10000000).optional(),
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
function cleanQuota(q: { sessions?: number; novncSessions?: number; diskMb?: number; proxyBandwidthMb?: number }): Record<string, number> {
  const out: Record<string, number> = {}
  if (q.sessions !== undefined) out.sessions = q.sessions
  if (q.novncSessions !== undefined) out.novncSessions = q.novncSessions
  if (q.diskMb !== undefined) out.diskMb = q.diskMb
  if (q.proxyBandwidthMb !== undefined) out.proxyBandwidthMb = q.proxyBandwidthMb
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
  allowShare?: boolean | null
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
    allowShare: g.allowShare ?? null,
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
  allowShare: z.boolean().default(true), // r13c：组级共享开关（false=组内成员默认禁止共享工作区）
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
        allowShare: p.allowShare,
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
        allowShare: p.allowShare,
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
      },
      severity: "WARN",
      extra: { affectedMembers },
    })

    return { id: group.id, allowInternalNetwork: p.allowInternalNetwork, allowSecureLocationAccess: p.allowSecureLocationAccess, affectedMembers }
  })
}

// ---- r13c：组级共享开关（快捷切换；组管理员仅限自己管理的组） ----
export async function setGroupAllowShareAction(
  input: unknown,
): Promise<ActionResult<{ id: string; allowShare: boolean; affectedMembers: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const isGroupAdmin = ctx.role === "GROUP_ADMIN"
    if (!isAdmin && !isGroupAdmin) throw new Error("无权设置组级共享开关（需要管理员或组管理员权限）")

    const p = zodValidate(z.object({ id: zId, allowShare: z.boolean() }), input)
    const group = await db.group.findUnique({ where: { id: p.id } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    if (isGroupAdmin && !isAdmin) {
      const ga = await db.groupAdmin.findFirst({ where: { groupId: group.id, userId: ctx.userId } })
      if (!ga) throw new Error("仅可为自己管理的用户组设置共享开关")
    }

    const before = group.allowShare
    await db.group.update({ where: { id: group.id }, data: { allowShare: p.allowShare } })
    const affectedMembers = await db.groupUser.count({ where: { groupId: group.id } })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "GROUP_SHARE_SWITCH",
      resourceType: "GROUP", resourceId: group.id, resourceName: group.name,
      before: { allowShare: before }, after: { allowShare: p.allowShare, affectedMembers },
      severity: "WARN",
    })
    return { id: group.id, allowShare: p.allowShare, affectedMembers }
  })
}

// ---- r14（22-c）：组级闲置超时策略（四级链：沙箱>用户>组>全局）----
// minutes：null=继承全局默认，数值=显式覆盖（0=无限即永不闲置回收，上限 43200=30天）
// locked：true=组内成员创建/编辑工作区时不可自行调整闲置超时（用户级锁定优先；管理员不受限）
// 鉴权：SUPER_ADMIN / ADMIN
export interface GroupIdlePolicyView {
  minutes: number | null
  locked: boolean
  globalDefault: number
  affectedMembers: number
}

export async function getGroupIdlePolicyAction(
  input: unknown,
): Promise<ActionResult<GroupIdlePolicyView>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const group = await db.group.findUnique({
      where: { id: p.id },
      select: { id: true, name: true, idleTimeoutMinutes: true, idleTimeoutLocked: true, deletedAt: true },
    })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    const globalDefault = await getConfigNumber("workspace.defaultIdleTimeoutMin", 60)
    const affectedMembers = await db.groupUser.count({ where: { groupId: group.id } })
    return { minutes: group.idleTimeoutMinutes, locked: group.idleTimeoutLocked, globalDefault, affectedMembers }
  })
}

export async function setGroupIdleTimeoutAction(
  input: unknown,
): Promise<ActionResult<GroupIdlePolicyView>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: zId,
        minutes: z.number().int().min(0).max(43200).nullable(), // null=继承全局默认，0=无限
        locked: z.boolean(),
      }),
      input,
    )
    const group = await db.group.findUnique({
      where: { id: p.id },
      select: { id: true, name: true, idleTimeoutMinutes: true, idleTimeoutLocked: true, deletedAt: true },
    })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    const before = { idleTimeoutMinutes: group.idleTimeoutMinutes, idleTimeoutLocked: group.idleTimeoutLocked }
    await db.group.update({
      where: { id: group.id },
      data: { idleTimeoutMinutes: p.minutes, idleTimeoutLocked: p.locked },
    })
    const affectedMembers = await db.groupUser.count({ where: { groupId: group.id } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_IDLE_POLICY",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      before,
      after: {
        idleTimeoutMinutes: p.minutes,
        idleTimeoutLocked: p.locked,
        affectedMembers,
        note: `管理员 ${ctx.username} 调整用户组 ${group.name} 闲置超时策略（${before.idleTimeoutMinutes == null ? "继承全局默认" : fmtIdleBrief(before.idleTimeoutMinutes)} → ${p.minutes == null ? "继承全局默认" : fmtIdleBrief(p.minutes)}，锁定 ${before.idleTimeoutLocked ? "开" : "关"} → ${p.locked ? "开" : "关"}，影响成员 ${affectedMembers} 人）`,
      },
      severity: "WARN",
    })
    return { minutes: p.minutes, locked: p.locked, globalDefault: await getConfigNumber("workspace.defaultIdleTimeoutMin", 60), affectedMembers }
  })
}

// ---- r23：组级 API-Key 策略（组内成员默认基线；用户级可覆盖收紧） ----

export async function setGroupTokenPolicyAction(input: unknown): Promise<ActionResult<{ id: string; tokenPolicy: Record<string, unknown> | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: zId,
        // null=清除组级策略（成员完全走用户级/全局）；稀疏对象=仅设置出现的字段
        tokenPolicy: z
          .object({
            allowCreate: z.boolean().optional(),
            maxPerUser: z.number().int().min(0).max(10000).optional(),
            allowPermanent: z.boolean().optional(),
            maxLifetimeDays: z.number().int().min(0).max(3650).optional(),
            rateLimitPerMin: z.number().int().min(0).max(1000000).optional(),
            allowedScopes: z.array(z.string().max(32)).max(16).nullable().optional(),
          })
          .nullable(),
      }),
      input,
    )
    const group = await db.group.findUnique({ where: { id: p.id }, select: { id: true, name: true, tokenPolicy: true, deletedAt: true } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    const sanitized = p.tokenPolicy === null ? null : (Object.keys(p.tokenPolicy).length === 0 ? null : (p.tokenPolicy as Record<string, unknown>))
    await db.group.update({
      where: { id: group.id },
      data: { tokenPolicy: sanitized ? (JSON.parse(JSON.stringify(sanitized)) as Prisma.InputJsonValue) : Prisma.DbNull },
    })
    const affectedMembers = await db.groupUser.count({ where: { groupId: group.id } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_TOKEN_POLICY",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      before: { tokenPolicy: group.tokenPolicy ?? null },
      after: { tokenPolicy: sanitized, affectedMembers },
      severity: "WARN",
    })
    return { id: group.id, tokenPolicy: sanitized }
  })
}

export async function getGroupTokenPolicyAction(input: unknown): Promise<ActionResult<{
  id: string
  name: string
  groupPolicy: Record<string, unknown> | null
  affectedMembers: number
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const group = await db.group.findUnique({ where: { id: p.id }, select: { id: true, name: true, tokenPolicy: true, deletedAt: true } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    const affectedMembers = await db.groupUser.count({ where: { groupId: group.id } })
    return { id: group.id, name: group.name, groupPolicy: (group.tokenPolicy as Record<string, unknown> | null) ?? null, affectedMembers }
  })
}

// ============================================================
// r28b：用户组管理对齐用户管理 —— 组级 2FA 快捷管控 / 批量启停 /
//       批量移动父级 / CSV 导入（权限级别对齐现有组 actions：requireAdmin）
// ============================================================

// ---- r28b：组级强制 2FA 快捷开关（对齐用户管理 setForce2faAction）----
// 生效链路（lib/auth.ts force2faRequired，登录时判定）：用户自身开关 > 全局强制 > 所在组 force2fa
export async function setGroupForce2faAction(
  input: unknown,
): Promise<ActionResult<{ id: string; force2fa: boolean; affectedMembers: number; twoFactorReady: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId, force2fa: z.boolean() }), input)

    const group = await db.group.findUnique({ where: { id: p.id } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    await db.group.update({ where: { id: group.id }, data: { force2fa: p.force2fa } })

    // 生效面统计：组内全部成员数 + 已开通 2FA 成员数（已开通者不受强制提示影响）
    const memberIds = await db.groupUser.findMany({ where: { groupId: group.id }, select: { userId: true } })
    const [total, ready] = await Promise.all([
      db.user.count({ where: { id: { in: memberIds.map((m) => m.userId) }, deletedAt: null } }),
      db.user.count({ where: { id: { in: memberIds.map((m) => m.userId) }, deletedAt: null, twoFactorEnabled: true } }),
    ])

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_2FA_POLICY",
      resourceType: "GROUP",
      resourceId: group.id,
      resourceName: group.name,
      before: { force2fa: group.force2fa },
      after: { force2fa: p.force2fa },
      severity: "WARN",
      extra: { affectedMembers: total, twoFactorReady: ready },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return { id: group.id, force2fa: p.force2fa, affectedMembers: total, twoFactorReady: ready }
  })
}

// ---- r28b：查询组级 2FA 安全策略详情（安全策略弹窗只读数据）----
export async function getGroupSecurityPolicyAction(input: unknown): Promise<ActionResult<{
  id: string
  name: string
  force2fa: boolean
  memberCount: number
  twoFactorReady: number
  globalForce2fa: boolean
  groupInherit: boolean
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const group = await db.group.findUnique({ where: { id: p.id }, select: { id: true, name: true, force2fa: true, deletedAt: true } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")

    const memberIds = await db.groupUser.findMany({ where: { groupId: group.id }, select: { userId: true } })
    const [memberCount, twoFactorReady, globalForce2fa, groupInherit] = await Promise.all([
      db.user.count({ where: { id: { in: memberIds.map((m) => m.userId) }, deletedAt: null } }),
      db.user.count({ where: { id: { in: memberIds.map((m) => m.userId) }, deletedAt: null, twoFactorEnabled: true } }),
      getConfigBool("security.globalForce2fa", false),
      getConfigBool("security.groupInheritForce2fa", true),
    ])
    return {
      id: group.id,
      name: group.name,
      force2fa: group.force2fa,
      memberCount,
      twoFactorReady,
      globalForce2fa,
      groupInherit,
    }
  })
}

// ---- r28b：批量启用/禁用（对齐用户管理 batchSetUserStatusAction）----
export async function batchSetGroupStatusAction(
  input: unknown,
): Promise<ActionResult<{ affected: number; failed: { id: string; reason: string }[] }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        ids: z.array(zId).min(1, "至少选择一个用户组").max(500, "单批最多 500 个"),
        enabled: z.boolean(),
      }),
      input
    )

    const targets = await db.group.findMany({
      where: { id: { in: p.ids }, deletedAt: null },
      select: { id: true, name: true, enabled: true },
    })
    if (targets.length === 0) throw new Error("未找到有效用户组")

    const failed: { id: string; reason: string }[] = []
    let affected = 0
    for (const g of targets) {
      try {
        if (g.enabled === p.enabled) throw new Error(p.enabled ? "该组已是启用状态" : "该组已是禁用状态")
        await db.group.update({ where: { id: g.id }, data: { enabled: p.enabled } })
        affected++
      } catch (e) {
        failed.push({ id: g.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_BATCH_STATUS",
      resourceType: "GROUP",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), names: targets.map((t) => t.name), enabled: targets.map((t) => t.enabled) },
      after: { enabled: p.enabled, affected, failed },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")
    return { affected, failed }
  })
}

// ---- r28b：批量移动父级（对齐用户管理 batchMoveGroupAction 迁移语义的组对应物）----
// 逐组校验：新父组存在且未删除 / 不能是自己 / 不能是自己的后代（防循环）
export async function batchMoveGroupParentAction(
  input: unknown,
): Promise<ActionResult<{ affected: number; failed: { id: string; reason: string }[] }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        ids: z.array(zId).min(1, "至少选择一个用户组").max(500, "单批最多 500 个"),
        parentId: zId.nullable(), // null = 移为根节点
      }),
      input
    )

    const targets = await db.group.findMany({
      where: { id: { in: p.ids }, deletedAt: null },
      select: { id: true, name: true, parentId: true },
    })
    if (targets.length === 0) throw new Error("未找到有效用户组")

    // 新父组存在性校验（目标父组本身不能在被移动的组里——否则形成悬挂）
    const movingIds = new Set(targets.map((t) => t.id))
    let parentName: string | null = null
    if (p.parentId) {
      if (movingIds.has(p.parentId)) throw new Error("新父组不能是被移动的组之一（会形成循环层级）")
      const parent = await db.group.findFirst({ where: { id: p.parentId, deletedAt: null }, select: { id: true, name: true } })
      if (!parent) throw new Error("新父组不存在或已删除")
      parentName = parent.name
    }

    const failed: { id: string; reason: string }[] = []
    let affected = 0
    for (const g of targets) {
      try {
        if (p.parentId === g.id) throw new Error("父组不能是自己")
        if (g.parentId === p.parentId) throw new Error(p.parentId ? "该组已挂在该父组下" : "该组已是根节点")
        if (p.parentId) {
          const desc = await descendantIds(g.id)
          if (desc.has(p.parentId)) throw new Error("新父组是该组的后代（禁止循环层级）")
        }
        await db.group.update({ where: { id: g.id }, data: { parentId: p.parentId } })
        affected++
      } catch (e) {
        failed.push({ id: g.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_BATCH_MOVE",
      resourceType: "GROUP",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), names: targets.map((t) => t.name), parents: targets.map((t) => t.parentId) },
      after: { newParentId: p.parentId, newParentName: parentName, affected, failed },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")
    return { affected, failed }
  })
}

// ---- r28b：CSV 导入用户组（对齐用户管理 importUsersCsvAction）----
// 列：组名,父组名,描述（表头中英文均可；父组可引用库中已有组或本批次先建的组——
// 「父组必须先存在」语义天然阻断循环引用，仍保留导入后全图环检测安全网）

export interface GroupCsvImportReport {
  total: number
  success: number
  failed: number
  errors: { line: number; message: string }[]
}

// 表头列名归一（中文/英文别名 → 标准键）
const CSV_HEADER_ALIASES: Record<string, string> = {
  name: "name", "组名": "name", groupname: "name", group: "name",
  parentname: "parent", "父组": "parent", "父组名": "parent", parent: "parent",
  description: "desc", "描述": "desc", "说明": "desc", desc: "desc",
}

export async function importGroupsCsvAction(input: unknown): Promise<ActionResult<GroupCsvImportReport>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({ text: z.string().min(1, "CSV内容为空").max(1_000_000, "CSV内容过大") }),
      input
    )

    const lines = p.text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length < 2) throw new Error("CSV至少需要表头和一行数据")

    const header = parseCsvLineForGroups(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ""))
    const colIdx: Record<string, number> = {}
    for (let i = 0; i < header.length; i++) {
      const key = CSV_HEADER_ALIASES[header[i]]
      if (key && colIdx[key] === undefined) colIdx[key] = i
    }
    if (colIdx.name === undefined) {
      throw new Error('表头缺少「组名」列（要求：组名,父组名,描述 或 name,parentName,description）')
    }

    const report: GroupCsvImportReport = { total: 0, success: 0, failed: 0, errors: [] }
    const nameToId = new Map<string, string>()
    // 含软删除组：Group.name 为数据库级全局唯一索引（软删行仍占用），与 createGroupAction 重名语义一致
    const existing = await db.group.findMany({ select: { id: true, name: true } })
    for (const g of existing) nameToId.set(g.name, g.id)
    const createdIds: string[] = []

    for (let i = 1; i < lines.length; i++) {
      const lineNo = i + 1
      const cols = parseCsvLineForGroups(lines[i])
      const name = colIdx.name !== undefined ? (cols[colIdx.name] || "") : ""
      const parentName = colIdx.parent !== undefined ? (cols[colIdx.parent] || "").trim() : ""
      const description = colIdx.desc !== undefined ? (cols[colIdx.desc] || "").trim() : ""
      report.total++

      try {
        const nameCheck = z.string().min(2, "组名至少2位").max(64, "组名最长64位").safeParse(name)
        if (!nameCheck.success) throw new Error(nameCheck.error.issues[0]?.message || "组名非法")
        if (nameToId.has(name)) throw new Error("组名已存在（库中或本批次）")

        let parentId: string | null = null
        if (parentName) {
          if (parentName === name) throw new Error("父组不能是自己")
          parentId = nameToId.get(parentName) || null
          if (!parentId) throw new Error(`父组 ${parentName} 不存在（须在库中或本批次前部先声明）`)
        }

        const group = await db.group.create({
          data: {
            name,
            description: description || null,
            parentId,
            enabled: true,
            inheritParentQuota: true,
            createdByUserId: ctx.userId,
          },
        })
        nameToId.set(group.name, group.id)
        createdIds.push(group.id)
        report.success++
      } catch (e) {
        report.failed++
        report.errors.push({ line: lineNo, message: e instanceof Error ? e.message : "解析失败" })
      }
    }

    // 安全网：全图环检测（「父组必须先存在」已天然防环；检出极端场景即回滚本批创建）
    if (createdIds.length > 0) {
      const cycle = await detectGroupCycle()
      if (cycle) {
        await db.group.deleteMany({ where: { id: { in: createdIds } } })
        throw new Error(`导入会形成循环层级（环：${cycle}），已回滚本批全部 ${createdIds.length} 个新组`)
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_IMPORT_CSV",
      resourceType: "GROUP",
      severity: report.failed > 0 ? "WARN" : "INFO",
      after: { total: report.total, success: report.success, failed: report.failed },
      extra: { batchSize: report.total },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return report
  })
}

// 简易CSV行解析（支持双引号包裹与转义，与用户管理 CSV 导入同实现）
function parseCsvLineForGroups(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') {
        inQuote = true
      } else if (ch === ",") {
        out.push(cur)
        cur = ""
      } else {
        cur += ch
      }
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

// 全图环检测（DFS 三色标记；返回环节点名或 null）
async function detectGroupCycle(): Promise<string | null> {
  const all = await db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true, parentId: true } })
  const byId = new Map(all.map((g) => [g.id, g]))
  const state = new Map<string, number>() // 0=未访问 1=在当前路径 2=已完成
  const path: string[] = []
  const visit = (id: string): string | null => {
    const st = state.get(id) ?? 0
    if (st === 1) {
      const idx = path.indexOf(id)
      return path.slice(idx).map((p) => byId.get(p)?.name || p).join(" -> ")
    }
    if (st === 2) return null
    state.set(id, 1)
    path.push(id)
    const parent = byId.get(id)?.parentId
    if (parent && byId.has(parent)) {
      const found = visit(parent)
      if (found) return found
    }
    path.pop()
    state.set(id, 2)
    return null
  }
  for (const g of all) {
    const found = visit(g.id)
    if (found) return found
  }
  return null
}
