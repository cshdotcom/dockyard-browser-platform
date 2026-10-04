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

// ============================================================
// r33：批量授权（多用户 + 多用户组 → 权限锁矩阵批量子量下发）
// 需求：管理员可批量为单个/多个用户或用户组「增加创建和操作实例沙箱功能」，
//       并支持完整颗粒度控制（30 项锁逐项三态）。
// 语义（updates 为稀疏三态映射，逐键执行）：
//   true  = 锁定（禁止该能力）
//   false = 解锁（开启该能力；写入时从锁集合移除该键）
//   null  = 不变（跳过） —— UI 上三态开关「保持不变/解锁/锁定」
// 合并模式：
//   merge（默认）= 在目标现有锁集合上叠加 updates（只改动提交的键）
//   replace      = 以 updates 为完整快照整体替换（未提交键视为解锁清除）
// 授权感知：对「创建/操作沙箱」相关键解锁时向用户发站内信（可感知开通）
// ============================================================
const SANDBOX_GRANT_KEYS: PermissionLockKey[] = [
  "blockCreateWorkspace", "blockModifyWorkspace", "blockBatchOps", "blockModifyResourceExpiry",
  "blockSwitchVncMode", "blockCustomVncResolution", "blockShareWorkspace", "blockRefreshVncKey",
  "blockRestartInstance",
]

export async function batchSetPermissionLocksAction(input: unknown): Promise<ActionResult<{
  userCount: number
  groupCount: number
  noticesSent: number
  appliedKeys: string[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({
      userIds: z.array(z.string().max(64)).max(500, "单批最多 500 个用户").default([]),
      groupIds: z.array(z.string().max(64)).max(200, "单批最多 200 个用户组").default([]),
      updates: z.record(z.string().max(64), z.boolean().nullable()), // key → true=锁 / false=解锁 / null=不变
      mode: z.enum(["merge", "replace"]).default("merge"),
      notify: z.boolean().default(true),
    }), input)
    if (p.userIds.length === 0 && p.groupIds.length === 0) throw new Error("请选择至少一个用户或用户组")
    if (Object.keys(p.updates).length === 0) throw new Error("请至少设置一项权限变更")

    // 校验键合法 + 收集实际提交键
    const submittedKeys: PermissionLockKey[] = []
    for (const k of Object.keys(p.updates)) {
      if (!PERMISSION_LOCK_KEYS.includes(k as PermissionLockKey)) throw new Error(`未知权限锁键：${k}`)
      submittedKeys.push(k as PermissionLockKey)
    }

    const mergeLocks = (current: Record<string, boolean> | null | undefined): Record<string, boolean> => {
      const base = p.mode === "replace" ? {} : { ...(current || {}) }
      for (const k of submittedKeys) {
        const v = p.updates[k]
        if (v === null || v === undefined) continue // 不变
        if (v === true) base[k] = true
        else delete base[k] // 解锁
      }
      return base
    }

    let noticesSent = 0
    // ---- 用户组批量子量 ----
    for (const gid of p.groupIds) {
      const group = await db.group.findUnique({ where: { id: gid }, select: { id: true, name: true, deletedAt: true, policy: true } })
      if (!group || group.deletedAt) continue
      const policy = (group.policy as Record<string, unknown> | null) || {}
      const next = mergeLocks((policy.permissionLocks as Record<string, boolean> | null) || undefined)
      await db.group.update({ where: { id: group.id }, data: { policy: { ...policy, permissionLocks: next } } })
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "PERMISSION_CENTER_BATCH", resourceType: "GROUP",
        resourceId: group.id, resourceName: group.name, severity: "WARN",
        before: { permissionLocks: (policy.permissionLocks as Record<string, boolean> | null) || {} },
        after: { permissionLocks: next, submittedKeys, mode: p.mode },
      }).catch(() => null)
    }

    // ---- 用户批量子量 + 授权感知通知 ----
    for (const uid of p.userIds) {
      const user = await db.user.findUnique({ where: { id: uid }, select: { id: true, username: true, deletedAt: true, permissionLocks: true } })
      if (!user || user.deletedAt) continue
      const next = mergeLocks((user.permissionLocks as Record<string, boolean> | null) || undefined)
      await db.user.update({ where: { id: user.id }, data: { permissionLocks: next } })
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "PERMISSION_CENTER_BATCH", resourceType: "USER",
        resourceId: user.id, resourceName: user.username, severity: "WARN",
        before: { permissionLocks: (user.permissionLocks as Record<string, boolean> | null) || {} },
        after: { permissionLocks: next, submittedKeys, mode: p.mode },
      }).catch(() => null)

      // 授权感知：创建/操作沙箱相关键被解锁（原锁 true → 现无）时站内信告知
      if (p.notify) {
        const prev = (user.permissionLocks as Record<string, boolean> | null) || {}
        const grantedNow = SANDBOX_GRANT_KEYS.filter((k) => prev[k] === true && next[k] !== true)
        if (grantedNow.length > 0) {
          await db.notice.create({
            data: {
              userId: user.id,
              title: "管理员已为你开通沙箱相关权限",
              content: `管理员已为你解锁以下能力：${grantedNow.map(lockLabel).join("、")}。你现在可以在「工作区」创建并操作浏览器沙箱。`,
              type: "SYSTEM",
              link: "/workspaces",
              sourceType: "USER",
              sourceKey: user.id,
              senderUserId: ctx.userId,
            },
          }).catch(() => null)
          noticesSent++
        }
      }
    }

    return { userCount: p.userIds.length, groupCount: p.groupIds.length, noticesSent, appliedKeys: submittedKeys }
  })
}

function lockLabel(key: string): string {
  const labels: Record<string, string> = {
    blockCreateWorkspace: "创建沙箱", blockModifyWorkspace: "修改沙箱配置", blockBatchOps: "批量操作",
    blockModifyResourceExpiry: "调整资源时效", blockSwitchVncMode: "切换 VNC 模式", blockCustomVncResolution: "自定义分辨率",
    blockShareWorkspace: "共享沙箱", blockRefreshVncKey: "刷新 VNC 密钥",
  }
  return labels[key] || key
}
