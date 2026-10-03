"use server"

// ============================================================
// r31：权限中心 Server Actions（30 项权限锁三级分配）
//   · 全局：permission.globalLocks（SystemConfig；ADMIN 对非查看类锁豁免）
//   · 用户组：Group.policy.permissionLocks（组员任一命中即锁）
//   · 用户：User.permissionLocks（最高覆盖）
//   · 沙箱级策略（共享否决/录像覆盖/VNC 时长/硬件权限）在各行菜单，此处汇总深链
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, PERMISSION_LOCK_KEYS, type PermissionLockKey } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

const locksSchema = z.record(z.string().max(64), z.boolean())

function cleanLocks(raw: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!PERMISSION_LOCK_KEYS.includes(k as PermissionLockKey)) throw new Error(`未知权限锁键：${k}`)
    if (v === true) out[k] = true // 只存 true（锁死优先；false 等同未设置）
  }
  return out
}

// ---- 全局权限锁（permission.globalLocks） ----
export async function setGlobalPermissionLocksAction(input: unknown): Promise<ActionResult<{ updated: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ locks: locksSchema }), input)
    const cleaned = cleanLocks(p.locks)
    const { setConfigAction } = await import("./config")
    await setConfigAction({ key: "permission.globalLocks", value: cleaned, reason: "权限中心：全局权限锁矩阵更新" })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "PERMISSION_CENTER_GLOBAL", resourceType: "CONFIG",
      resourceName: "permission.globalLocks", severity: "WARN",
      after: { locks: Object.keys(cleaned).length },
    }).catch(() => null)
    return { updated: Object.keys(cleaned).length }
  })
}

// ---- 用户级权限锁（User.permissionLocks） ----
export async function setUserPermissionLocksAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ userId: z.string().max(64), locks: locksSchema }), input)
    const cleaned = cleanLocks(p.locks)
    const user = await db.user.findUnique({ where: { id: p.userId }, select: { id: true, username: true, deletedAt: true, permissionLocks: true } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")
    await db.user.update({ where: { id: user.id }, data: { permissionLocks: cleaned } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "PERMISSION_CENTER_USER", resourceType: "USER",
      resourceId: user.id, resourceName: user.username, severity: "WARN",
      before: { permissionLocks: (user.permissionLocks as Record<string, boolean> | null) || {} },
      after: { permissionLocks: cleaned },
    }).catch(() => null)
    return { id: user.id }
  })
}

// ---- 用户组级权限锁（Group.policy.permissionLocks；沿用 updateGroupLocksAction 语义的直达封装） ----
export async function setGroupPermissionLocksAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ groupId: z.string().max(64), locks: locksSchema }), input)
    const cleaned = cleanLocks(p.locks)
    const group = await db.group.findUnique({ where: { id: p.groupId }, select: { id: true, name: true, deletedAt: true, policy: true } })
    if (!group || group.deletedAt) throw new Error("用户组不存在或已删除")
    const policy = (group.policy as Record<string, unknown> | null) || {}
    await db.group.update({ where: { id: group.id }, data: { policy: { ...policy, permissionLocks: cleaned } } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "PERMISSION_CENTER_GROUP", resourceType: "GROUP",
      resourceId: group.id, resourceName: group.name, severity: "WARN",
      before: { permissionLocks: (policy.permissionLocks as Record<string, boolean> | null) || {} },
      after: { permissionLocks: cleaned },
    }).catch(() => null)
    return { id: group.id }
  })
}

// ---- 矩阵数据（全局锁 + 组 + 用户清单；搜索/上限） ----
export async function listPermissionTargetsAction(input: unknown): Promise<ActionResult<{
  globalLocks: Record<string, boolean>
  groups: Array<{ id: string; name: string; locks: Record<string, boolean> }>
  users: Array<{ id: string; username: string; displayName: string | null; role: string; locks: Record<string, boolean> }>
  lockKeys: string[]
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ keyword: z.string().max(64).optional() }), input)
    const { getConfig } = await import("@/lib/config")
    const globalLocks = (await getConfig<Record<string, boolean>>("permission.globalLocks", {})) || {}
    const kw = p.keyword?.trim()
    const [groups, users] = await Promise.all([
      db.group.findMany({
        where: { deletedAt: null, ...(kw ? { name: { contains: kw } } : {}) },
        select: { id: true, name: true, policy: true },
        orderBy: { name: "asc" },
        take: 100,
      }),
      db.user.findMany({
        where: {
          deletedAt: null,
          ...(kw ? { OR: [{ username: { contains: kw } }, { displayName: { contains: kw } }] } : {}),
        },
        select: { id: true, username: true, displayName: true, role: true, permissionLocks: true },
        orderBy: { username: "asc" },
        take: 200,
      }),
    ])
    return {
      globalLocks,
      groups: groups.map((g) => ({ id: g.id, name: g.name, locks: ((g.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | null) || {} })),
      users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, locks: (u.permissionLocks as Record<string, boolean> | null) || {} })),
      lockKeys: [...PERMISSION_LOCK_KEYS],
    }
  })
}
