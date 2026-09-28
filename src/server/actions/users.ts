"use server"

// 用户管理 Server Actions：全部写操作 requireWritableMode + requireAdmin + zod + 审计 + 行为画像

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin, requireAuth } from "@/lib/permissions"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"
import { zodValidate, zId, zEmail, zUsername, validatePasswordPolicy, checkPasswordHistory, zPrecision } from "@/lib/validators"
import { hashPassword, maskSensitive, randomHex } from "@/lib/crypto"
import { regenerateBackupCodes } from "@/lib/totp"
import { getConfigBool } from "@/lib/config"

// ---- 公共 schema ----

const zQuota = z.object({
  sessions: zPrecision("会话配额", 0, 100000).optional(),
  novncSessions: zPrecision("NoVNC配额", 0, 100000).optional(),
  diskMb: zPrecision("磁盘配额", 0, 10000000).optional(),
})

const zRole = z.enum(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN", "USER"])

// 运行中浏览器会话检查（删除前置条件）
async function countRunningWorkspaces(userId: string): Promise<number> {
  return db.browserWorkspace.count({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["RUNNING", "CREATING", "IDLE"] },
    },
  })
}

// 撤销用户全部登录会话 + 刷新令牌（强制下线）
async function kickAllSessions(userId: string, reason: string) {
  const now = new Date()
  const sessions = await db.loginSession.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  })
  await db.loginSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  })
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  })
  return sessions.length
}

// 安全变更联动：按配置批量软删 ApiToken
async function invalidateApiTokensIfConfigured(userId: string): Promise<number> {
  const enabled = await getConfigBool("security.autoInvalidateTokensOnSecurityChange", false)
  if (!enabled) return 0
  const r = await db.apiToken.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: new Date(), enabled: false },
  })
  return r.count
}

function userBrief(u: { id: string; username: string; email?: string | null; role: string; enabled: boolean; frozen: boolean; displayName?: string | null; quota?: unknown }) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    enabled: u.enabled,
    frozen: u.frozen,
    quota: u.quota ?? null,
  }
}

// ---- 1. 新建用户 ----

const createUserSchema = z.object({
  username: zUsername,
  email: zEmail.optional().or(z.literal("").transform(() => undefined)),
  password: z.string().min(6, "密码至少6位").max(128),
  displayName: z.string().max(64).optional(),
  role: zRole.default("USER"),
  groupIds: z.array(zId).max(50).default([]),
  quota: zQuota.optional(),
})

export async function createUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(createUserSchema, input)

    // 用户名唯一（含软删用户占位）
    const dupUser = await db.user.findFirst({ where: { username: p.username } })
    if (dupUser) throw new Error(`用户名 ${p.username} 已存在`)
    if (p.email) {
      const dupEmail = await db.user.findFirst({ where: { email: p.email } })
      if (dupEmail) throw new Error(`邮箱 ${p.email} 已被占用`)
    }

    // 密码策略
    const pwCheck = await validatePasswordPolicy(p.password)
    if (!pwCheck.ok) throw new Error(pwCheck.message || "密码不符合策略")

    // 所属组校验
    const groups = p.groupIds.length
      ? await db.group.findMany({ where: { id: { in: p.groupIds }, deletedAt: null } })
      : []
    if (groups.length !== p.groupIds.length) throw new Error("部分所选用户组不存在或已删除")

    const user = await db.user.create({
      data: {
        username: p.username,
        email: p.email || null,
        displayName: p.displayName || null,
        passwordHash: await hashPassword(p.password),
        role: p.role,
        enabled: true,
        quota: p.quota ? { ...p.quota } : undefined,
      },
    })

    if (groups.length > 0) {
      await db.groupUser.createMany({
        data: groups.map((g) => ({ groupId: g.id, userId: user.id })),
      })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_CREATE",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      createdByUserId: ctx.userId,
      after: { ...userBrief(user), groupIds: groups.map((g) => g.id) },
    })
    await trackBehavior(ctx.userId, "CREATE")

    return { id: user.id }
  })
}

// ---- 2. 编辑用户（不传密码则不改密码） ----

const updateUserSchema = z.object({
  id: zId,
  email: zEmail.optional().or(z.literal("").transform(() => undefined)),
  displayName: z.string().max(64).optional().or(z.literal("").transform(() => undefined)),
  role: zRole,
  enabled: z.boolean(),
  frozen: z.boolean(),
  groupIds: z.array(zId).max(50).optional(), // 不传 = 不改组
  quota: zQuota.optional(),
  password: z.string().min(6).max(128).optional().or(z.literal("").transform(() => undefined)),
})

export async function updateUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(updateUserSchema, input)

    const before = await db.user.findUnique({ where: { id: p.id } })
    if (!before || before.deletedAt) throw new Error("用户不存在或已删除")

    if (p.email && p.email !== before.email) {
      const dupEmail = await db.user.findFirst({ where: { email: p.email, id: { not: p.id } } })
      if (dupEmail) throw new Error(`邮箱 ${p.email} 已被占用`)
    }

    const data: Record<string, unknown> = {
      email: p.email === undefined ? undefined : p.email || null,
      displayName: p.displayName === undefined ? undefined : p.displayName || null,
      role: p.role,
      enabled: p.enabled,
      frozen: p.frozen,
    }
    if (p.quota) data.quota = { ...p.quota }

    // 密码（可选）
    if (p.password) {
      const pwCheck = await validatePasswordPolicy(p.password)
      if (!pwCheck.ok) throw new Error(pwCheck.message || "密码不符合策略")
      const okHistory = await checkPasswordHistory(p.id, p.password)
      if (!okHistory) throw new Error("新密码与近期历史密码重复")
      data.passwordHash = await hashPassword(p.password)
    }

    const after = await db.user.update({ where: { id: p.id }, data })

    // 密码修改 → 全端下线
    if (p.password) await kickAllSessions(p.id, "PASSWORD_CHANGE")

    // 禁用/冻结联动：下线会话 + 按配置作废API令牌
    let invalidatedTokens = 0
    const nowDisabled = p.enabled === false && before.enabled === true
    const nowFrozen = p.frozen === true && before.frozen === false
    if (nowDisabled || nowFrozen) {
      await kickAllSessions(p.id, "ADMIN_KICK")
      invalidatedTokens = await invalidateApiTokensIfConfigured(p.id)
    }

    // 组变更（可选）
    let groupChange: { added: string[]; removed: string[] } | undefined
    if (p.groupIds) {
      const groups = p.groupIds.length
        ? await db.group.findMany({ where: { id: { in: p.groupIds }, deletedAt: null } })
        : []
      if (groups.length !== p.groupIds.length) throw new Error("部分所选用户组不存在或已删除")
      const existing = await db.groupUser.findMany({ where: { userId: p.id }, select: { groupId: true } })
      const existingIds = existing.map((e) => e.groupId)
      const toAdd = p.groupIds.filter((gid) => !existingIds.includes(gid))
      const toRemove = existingIds.filter((gid) => !p.groupIds!.includes(gid))
      if (toAdd.length) {
        await db.groupUser.createMany({
          data: toAdd.map((gid) => ({ groupId: gid, userId: p.id })),
        })
      }
      if (toRemove.length) {
        await db.groupUser.deleteMany({ where: { userId: p.id, groupId: { in: toRemove } } })
      }
      groupChange = { added: toAdd, removed: toRemove }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_UPDATE",
      resourceType: "USER",
      resourceId: after.id,
      resourceName: after.username,
      ownerUserId: after.id,
      before: userBrief(before),
      after: { ...userBrief(after), ...(groupChange ? { groupChange } : {}) },
      extra: {
        passwordChanged: !!p.password,
        apiTokensInvalidated: invalidatedTokens,
      },
    })
    await trackBehavior(ctx.userId, "CREATE")

    return { id: after.id }
  })
}

// ---- 3. 管理员重置密码（临时密码 + mustChangePassword） ----

export async function adminResetPasswordAction(input: unknown): Promise<ActionResult<{ tempPassword: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    const tempPassword = "Tmp-" + randomHex(6)
    const pwCheck = await validatePasswordPolicy(tempPassword)
    if (!pwCheck.ok) throw new Error(pwCheck.message || "临时密码不符合策略")

    const passwordHash = await hashPassword(tempPassword)
    await db.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    })
    // 记录历史密码（防复用）
    await db.passwordHistory.create({ data: { userId: id, passwordHash } })
    // 全端强制下线
    const kicked = await kickAllSessions(id, "PASSWORD_CHANGE")

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_PASSWORD_RESET",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      severity: "WARN",
      after: { mustChangePassword: true, sessionsKicked: kicked },
    })
    await writeSecurityEvent({
      userId: user.id,
      username: user.username,
      eventType: "PASSWORD_RESET_BY_ADMIN",
      success: true,
      detail: "管理员重置密码，全部会话已下线",
    })

    return { tempPassword }
  })
}

// ---- 4. 删除用户（软删除 + 运行中会话前置检查） ----

export async function deleteUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")
    if (user.id === ctx.userId) throw new Error("不能删除自己")

    const running = await countRunningWorkspaces(id)
    if (running > 0) throw new Error(`该用户存在 ${running} 个运行中浏览器会话，禁止删除（请先销毁其工作区）`)

    const now = new Date()
    await db.user.update({ where: { id }, data: { deletedAt: now, enabled: false, frozen: true } })
    // 撤销全部会话与刷新令牌；软删API令牌
    const kicked = await kickAllSessions(id, "ADMIN_KICK")
    const tokens = await db.apiToken.updateMany({
      where: { userId: id, deletedAt: null },
      data: { deletedAt: now, enabled: false },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_DELETE",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      severity: "WARN",
      before: userBrief(user),
      after: { deletedAt: now.toISOString(), sessionsKicked: kicked, apiTokensInvalidated: tokens.count },
    })
    await trackBehavior(ctx.userId, "DELETE")

    return { id: user.id }
  })
}

// ---- 5. 批量启用/禁用 ----

export async function batchSetUserStatusAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ ids: z.array(zId).min(1).max(500), enabled: z.boolean() }), input)

    const targets = await db.user.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw new Error("未找到有效用户")

    const r = await db.user.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { enabled: p.enabled },
    })

    // 禁用 → 全部下线 + 按配置作废令牌
    let kicked = 0
    let tokens = 0
    if (!p.enabled) {
      for (const t of targets) {
        kicked += await kickAllSessions(t.id, "ADMIN_KICK")
        tokens += await invalidateApiTokensIfConfigured(t.id)
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_BATCH_STATUS",
      resourceType: "USER",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), enabled: targets.map((t) => t.enabled) },
      after: { ids: targets.map((t) => t.id), enabled: p.enabled, sessionsKicked: kicked, apiTokensInvalidated: tokens },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return { affected: r.count }
  })
}

// ---- 6. 批量迁移用户组（替换语义） ----

export async function batchMoveGroupAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({ ids: z.array(zId).min(1).max(500), groupIds: z.array(zId).max(50).default([]) }),
      input
    )

    const targets = await db.user.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw new Error("未找到有效用户")

    const groups = p.groupIds.length
      ? await db.group.findMany({ where: { id: { in: p.groupIds }, deletedAt: null } })
      : []
    if (groups.length !== p.groupIds.length) throw new Error("部分所选用户组不存在或已删除")

    for (const t of targets) {
      await db.groupUser.deleteMany({ where: { userId: t.id } })
      if (groups.length > 0) {
        await db.groupUser.createMany({
          data: groups.map((g) => ({ groupId: g.id, userId: t.id })),
        })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_BATCH_MOVE_GROUP",
      resourceType: "USER",
      severity: "WARN",
      after: { ids: targets.map((t) => t.id), newGroupIds: groups.map((g) => g.id), newGroupNames: groups.map((g) => g.name) },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return { affected: targets.length }
  })
}

// ---- 7. 批量重置配额 ----

export async function batchResetQuotaAction(input: unknown): Promise<ActionResult<{ affected: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ ids: z.array(zId).min(1).max(500), quota: zQuota }), input)

    const targets = await db.user.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw new Error("未找到有效用户")

    await db.user.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { quota: { ...p.quota } },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_BATCH_RESET_QUOTA",
      resourceType: "USER",
      before: { ids: targets.map((t) => ({ id: t.id, quota: t.quota })) },
      after: { ids: targets.map((t) => t.id), quota: p.quota },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return { affected: targets.length }
  })
}

// ---- 8. 批量强制下线 / 单用户强制下线 ----

// 单条登录会话强制下线（在线会话管控页）
export async function kickLoginSessionAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { sessionId } = zodValidate(z.object({ sessionId: zId }), input)

    const session = await db.loginSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new Error("登录会话不存在")
    if (session.revokedAt) throw new Error("该会话已撤销")
    const sessionUser = await db.user.findUnique({ where: { id: session.userId }, select: { id: true, username: true } })

    const now = new Date()
    await db.loginSession.update({ where: { id: sessionId }, data: { revokedAt: now, revokedReason: "ADMIN_KICK" } })
    if (session.refreshTokenId) {
      await db.refreshToken.updateMany({ where: { id: session.refreshTokenId }, data: { revokedAt: now } })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SESSION_KICK",
      resourceType: "LOGIN_SESSION",
      resourceId: session.id,
      resourceName: sessionUser?.username || session.ip || session.id,
      ownerUserId: session.userId,
      severity: "WARN",
      before: { ip: session.ip, userAgent: session.userAgent, trusted: session.trusted, createdAt: session.createdAt },
      after: { revokedAt: new Date().toISOString(), reason: "ADMIN_KICK" },
    })
    await writeSecurityEvent({
      userId: session.userId,
      username: sessionUser?.username,
      eventType: "DEVICE_KICKED",
      success: true,
      detail: `管理员 ${ctx.username} 强制下线该设备会话（IP: ${session.ip || "未知"}）`,
      ip: session.ip || undefined,
      userAgent: session.userAgent || undefined,
    })

    return { id: session.id }
  })
}

export async function kickUserSessionsAction(input: unknown): Promise<ActionResult<{ kicked: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({ ids: z.array(zId).min(1).max(500) }),
      input
    )

    const targets = await db.user.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw new Error("未找到有效用户")

    let kicked = 0
    for (const t of targets) {
      kicked += await kickAllSessions(t.id, "ADMIN_KICK")
      await writeSecurityEvent({
        userId: t.id,
        username: t.username,
        eventType: "DEVICE_KICKED",
        success: true,
        detail: `管理员 ${ctx.username} 强制下线该用户全部会话`,
      })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SESSION_KICK",
      resourceType: "USER",
      severity: "WARN",
      after: { ids: targets.map((t) => t.id), usernames: targets.map((t) => t.username), sessionsKicked: kicked },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return { kicked }
  })
}

// ---- 9. 手动解锁账号 ----

export async function unlockUserAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    await db.user.update({ where: { id }, data: { lockedUntil: null, failedLoginCount: 0 } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_UNLOCK",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      before: { lockedUntil: user.lockedUntil, failedLoginCount: user.failedLoginCount },
      after: { lockedUntil: null, failedLoginCount: 0 },
    })
    await writeSecurityEvent({
      userId: user.id,
      username: user.username,
      eventType: "ACCOUNT_UNLOCKED",
      success: true,
      detail: `管理员 ${ctx.username} 手动解锁账号`,
    })

    return { id: user.id }
  })
}

// ---- 10. 强制2FA提示开关 ----

export async function setForce2faAction(input: unknown): Promise<ActionResult<{ id: string; force2faSetup: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId, force2faSetup: z.boolean() }), input)

    const user = await db.user.findUnique({ where: { id: p.id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    await db.user.update({ where: { id: p.id }, data: { force2faSetup: p.force2faSetup } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_FORCE_2FA",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      before: { force2faSetup: user.force2faSetup },
      after: { force2faSetup: p.force2faSetup },
      severity: "WARN",
    })

    return { id: user.id, force2faSetup: p.force2faSetup }
  })
}

// ---- 11. 重置2FA密钥（删除 TotpSecret + 备份码 + 关闭2FA） ----

export async function resetUserTotpAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    const totp = await db.totpSecret.deleteMany({ where: { userId: id } })
    const backup = await db.twoFactorBackupCode.deleteMany({ where: { userId: id } })
    await db.user.update({ where: { id }, data: { twoFactorEnabled: false, force2faSetup: false } })
    // 清空受信任设备（2FA重置后设备信任失效）
    const devices = await db.trustedDevice.deleteMany({ where: { userId: id } })
    // 全端下线，强制重新验证
    const kicked = await kickAllSessions(id, "SECURITY")

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_2FA_RESET",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      severity: "CRITICAL",
      before: { twoFactorEnabled: user.twoFactorEnabled },
      after: { twoFactorEnabled: false, totpDeleted: totp.count, backupCodesDeleted: backup.count, trustedDevicesDeleted: devices.count, sessionsKicked: kicked },
    })
    await writeSecurityEvent({
      userId: user.id,
      username: user.username,
      eventType: "TWO_FACTOR_RESET",
      success: true,
      detail: `管理员 ${ctx.username} 强制重置2FA密钥与备份码`,
    })

    return { id: user.id }
  })
}

// ---- 12. 清空受信任设备 ----

export async function clearTrustedDevicesAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    const r = await db.trustedDevice.deleteMany({ where: { userId: id } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_TRUSTED_DEVICE_CLEAR",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      before: { trustedDevices: r.count },
      after: { trustedDevices: 0 },
      severity: "WARN",
    })
    await writeSecurityEvent({
      userId: user.id,
      username: user.username,
      eventType: "TRUSTED_DEVICE_CLEARED",
      success: true,
      detail: `管理员 ${ctx.username} 清空全部受信任设备`,
    })

    return { deleted: r.count }
  })
}

// ---- 13. 重置备份码（返回一次性新码） ----

export async function resetBackupCodesAction(input: unknown): Promise<ActionResult<{ codes: string[] }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)

    const user = await db.user.findUnique({ where: { id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")
    if (!user.twoFactorEnabled) throw new Error("该用户未开启2FA，无需重置备份码")

    const codes = await regenerateBackupCodes(id)

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_2FA_BACKUP_RESET",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      severity: "WARN",
      after: { regenerated: codes.length },
    })
    await writeSecurityEvent({
      userId: user.id,
      username: user.username,
      eventType: "TWO_FACTOR_BACKUP_RESET",
      success: true,
      detail: `管理员 ${ctx.username} 重置2FA备份码`,
    })

    return { codes }
  })
}

// ---- 14. CSV 导入用户 ----

export interface CsvImportReport {
  total: number
  success: number
  failed: number
  updated: number
  errors: { line: number; message: string }[]
}

// 简易CSV行解析（支持双引号包裹与转义）
function parseCsvLine(line: string): string[] {
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

export async function importUsersCsvAction(input: unknown): Promise<ActionResult<CsvImportReport>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        text: z.string().min(1, "CSV内容为空").max(2_000_000, "CSV内容过大"),
        mode: z.enum(["skip", "update"]).default("skip"),
      }),
      input
    )

    const lines = p.text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const report: CsvImportReport = { total: 0, success: 0, failed: 0, updated: 0, errors: [] }

    // 表头校验
    if (lines.length < 2) throw new Error("CSV至少需要表头和一行数据")
    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
    const need = ["username", "email", "password", "displayname"]
    const missing = need.filter((n) => !header.includes(n))
    if (missing.length > 0) throw new Error(`表头缺少字段：${missing.join(" / ")}（要求：username,email,password,displayName）`)
    const colIdx = (name: string) => header.indexOf(name)

    for (let i = 1; i < lines.length; i++) {
      const lineNo = i + 1
      const cols = parseCsvLine(lines[i])
      const username = (cols[colIdx("username")] || "").toLowerCase()
      const email = cols[colIdx("email")] || ""
      const password = cols[colIdx("password")] || ""
      const displayName = cols[colIdx("displayname")] || ""
      report.total++

      try {
        const unameCheck = zUsername.safeParse(username)
        if (!unameCheck.success) throw new Error(unameCheck.error.issues[0]?.message || "用户名格式非法")
        if (email) {
          const emailCheck = zEmail.safeParse(email)
          if (!emailCheck.success) throw new Error("邮箱格式非法")
        }

        const existing = await db.user.findFirst({ where: { username } })
        if (existing) {
          if (existing.deletedAt) throw new Error("用户名已被软删除用户占用")
          if (p.mode === "skip") {
            report.errors.push({ line: lineNo, message: `用户 ${username} 已存在（skip模式跳过）` })
            report.failed++
            continue
          }
          // update模式：更新邮箱/显示名/密码（密码为空则不改）
          const data: Record<string, unknown> = {}
          if (email) data.email = email
          if (displayName) data.displayName = displayName
          if (password) {
            const pwCheck = await validatePasswordPolicy(password)
            if (!pwCheck.ok) throw new Error(pwCheck.message || "密码不符合策略")
            const okHistory = await checkPasswordHistory(existing.id, password)
            if (!okHistory) throw new Error("密码与近期历史密码重复")
            const passwordHash = await hashPassword(password)
            data.passwordHash = passwordHash
            await db.passwordHistory.create({ data: { userId: existing.id, passwordHash } })
            data.mustChangePassword = true
          }
          if (Object.keys(data).length > 0) {
            await db.user.update({ where: { id: existing.id }, data })
          }
          report.updated++
          report.success++
          continue
        }

        // 新建
        if (!password) throw new Error("新用户密码不能为空")
        const pwCheck = await validatePasswordPolicy(password)
        if (!pwCheck.ok) throw new Error(pwCheck.message || "密码不符合策略")
        if (email) {
          const dupEmail = await db.user.findFirst({ where: { email } })
          if (dupEmail) throw new Error(`邮箱 ${email} 已被占用`)
        }

        const user = await db.user.create({
          data: {
            username,
            email: email || null,
            displayName: displayName || null,
            passwordHash: await hashPassword(password),
            role: "USER",
            enabled: true,
          },
        })
        await writeAudit({
          operatorUserId: ctx.userId,
          operatorName: ctx.username,
          operationType: "USER_IMPORT_CREATE",
          resourceType: "USER",
          resourceId: user.id,
          resourceName: user.username,
          ownerUserId: user.id,
          after: maskSensitive({ username, email, displayName, line: lineNo }),
          extra: { importLine: lineNo },
        })
        report.success++
      } catch (e) {
        report.failed++
        report.errors.push({ line: lineNo, message: e instanceof Error ? e.message : "解析失败" })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_IMPORT_CSV",
      resourceType: "USER",
      severity: report.failed > 0 ? "WARN" : "INFO",
      after: { total: report.total, success: report.success, updated: report.updated, failed: report.failed, mode: p.mode },
      extra: { batchSize: report.total },
    })
    await trackBehavior(ctx.userId, "BATCH")

    return report
  })
}

// ---- 16. 用户级网络访问策略（管理员按用户控制：内网 / 容器安全位置）----
// 鉴权：SUPER_ADMIN / ADMIN 全量；GROUP_ADMIN 仅限本组成员；
//       普通用户调用直接 403（前端不渲染入口，后端强制拦截，防绕过）
export async function setUserNetworkPolicyAction(
  input: unknown,
): Promise<ActionResult<{ id: string; allowInternalNetwork: boolean | null; allowSecureLocationAccess: boolean | null; effective: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; source: string } }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const isGroupAdmin = ctx.role === "GROUP_ADMIN"
    if (!isAdmin && !isGroupAdmin) throw new Error("无权设置网络访问策略（需要管理员或组管理员权限）")

    const p = zodValidate(
      z.object({
        id: zId,
        allowInternalNetwork: z.boolean().nullable(), // null=继承所属组
        allowSecureLocationAccess: z.boolean().nullable(), // null=继承所属组
      }),
      input,
    )

    const user = await db.user.findUnique({ where: { id: p.id } })
    if (!user || user.deletedAt) throw new Error("用户不存在或已删除")

    // 组管理员范围校验：仅可操作本组成员
    if (isGroupAdmin && !isAdmin) {
      const { isGroupAdminOf } = await import("@/lib/permissions")
      if (!(await isGroupAdminOf(ctx.userId, user.id))) throw new Error("仅可为本组成员设置网络访问策略")
    }

    const before = {
      allowInternalNetwork: user.allowInternalNetwork,
      allowSecureLocationAccess: user.allowSecureLocationAccess,
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
      },
    })

    // 解析生效结果（含继承来源），供前端即时回显
    const { resolveNetworkPolicy } = await import("@/lib/network-policy")
    const effective = await resolveNetworkPolicy(user.id)

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_NETWORK_POLICY",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      ownerUserId: user.id,
      before,
      after: {
        allowInternalNetwork: p.allowInternalNetwork,
        allowSecureLocationAccess: p.allowSecureLocationAccess,
        effective,
      },
      severity: "WARN",
    })
    await writeSecurityEvent({
      userId: ctx.userId,
      username: ctx.username,
      eventType: "NETWORK_POLICY_CHANGE",
      success: true,
      detail: `管理员 ${ctx.username} 调整用户 ${user.username} 网络访问策略（内网:${p.allowInternalNetwork === null ? "继承" : p.allowInternalNetwork ? "允许" : "禁止"} / 安全位置:${p.allowSecureLocationAccess === null ? "继承" : p.allowSecureLocationAccess ? "允许" : "禁止"}）`,
    })

    return {
      id: user.id,
      allowInternalNetwork: p.allowInternalNetwork,
      allowSecureLocationAccess: p.allowSecureLocationAccess,
      effective: {
        allowInternalNetwork: effective.allowInternalNetwork,
        allowSecureLocationAccess: effective.allowSecureLocationAccess,
        source: effective.source,
      },
    }
  })
}
