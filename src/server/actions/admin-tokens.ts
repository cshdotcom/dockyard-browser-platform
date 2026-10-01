"use server"

// 管理员代管：用户 API 密钥（在用户管理内直接为用户创建/查看/修改 API 密钥）
// ADMIN / SUPER_ADMIN：全量操作；GROUP_ADMIN：仅可查看自己管辖组内成员的密钥（不可改）
// 管理级（ADMIN 位）令牌：仅当目标用户本身是平台管理员时才允许授予
// 明文 token 仅创建时返回一次；库内只存 sha256 哈希；全程写不可篡改审计（含操作者与归属者）

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth, requireWritableMode, adminGroupIds } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId, zPrecision } from "@/lib/validators"
import { generateApiToken, sha256 } from "@/lib/crypto"
import { getConfigNumber } from "@/lib/config"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"
import { TOKEN_PERM, TOKEN_SCOPES, normalizeScopes, levelLabel } from "@/lib/token-scopes"

const IP_CIDR_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\/(?:[12]\d|[0-9]))?$/
const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

const LEVEL_MASK: Record<"READ_ONLY" | "READ_WRITE" | "ADMIN", number> = {
  READ_ONLY: TOKEN_PERM.READ,
  READ_WRITE: TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE,
  ADMIN: TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE | TOKEN_PERM.ADMIN,
}

const adminTokenInputSchema = z.object({
  userId: zId,
  name: z.string().min(1, "令牌名称必填").max(64),
  level: z.enum(["READ_ONLY", "READ_WRITE", "ADMIN"]),
  scopes: z.array(z.string().max(32)).max(8, "功能范围最多 8 项").optional().default([]),
  expireAtIso: z.string().nullable().optional(), // null/"" = 永久
  ipWhitelist: z.array(z.string().max(64)).max(20, "IP 白名单最多 20 条"),
  qps: zPrecision("QPS 限制", 0, 100000),
})

const adminTokenUpdateSchema = adminTokenInputSchema.extend({
  id: zId,
  // 保持目标用户不可变更：更新时以令牌归属为准，忽略传入 userId 的差异
})

// ---- 权限断言：管理员对目标用户的令牌操作权限 ----
async function assertTokenAdminAccess(
  ctx: { userId: string; username: string; role: string },
  targetUserId: string,
  mode: "view" | "manage",
): Promise<void> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return
  if (ctx.role === "GROUP_ADMIN" && mode === "view") {
    // 目标用户须在自己管辖的组内
    const groupIds = await adminGroupIds(ctx.userId)
    if (groupIds.length > 0) {
      const inGroup = await db.groupUser.findFirst({ where: { userId: targetUserId, groupId: { in: groupIds } } })
      if (inGroup) return
    }
    throw bizError(ErrorCode.FORBIDDEN, "仅可查看自己管辖组内成员的 API 密钥")
  }
  throw bizError(ErrorCode.FORBIDDEN, "需要平台管理员权限")
}

async function loadTargetUser(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, username: true, role: true, enabled: true, deletedAt: true } })
  if (!user || user.deletedAt) throw bizError(ErrorCode.NOT_FOUND, "目标用户不存在或已删除")
  return user
}

function resolveMask(level: "READ_ONLY" | "READ_WRITE" | "ADMIN", targetRole: string): number {
  if (level === "ADMIN" && !ADMIN_ROLES.has(targetRole)) {
    throw bizError(ErrorCode.FORBIDDEN, "管理级令牌仅可授予平台管理员账号（目标用户不是管理员）")
  }
  return LEVEL_MASK[level]
}

function resolveScopes(input: string[]): string[] | null {
  const validKeys = new Set(TOKEN_SCOPES.map((s) => s.key as string))
  for (const s of input) {
    if (!validKeys.has(s)) {
      throw bizError(ErrorCode.PARAM_ERROR, `未知功能范围：${s}（可用：${[...validKeys].join(" / ")}）`)
    }
  }
  return normalizeScopes(input)
}

function validateIpList(list: string[]) {
  for (const item of list) {
    if (!IP_CIDR_RE.test(item)) {
      throw bizError(ErrorCode.PARAM_ERROR, `IP 白名单格式非法：${item}（支持单 IP 或 CIDR 段）`)
    }
  }
}

// ============================================================
// 1. 查看用户当前 API 密钥（含配置与调用统计）
// ============================================================
export async function adminListUserApiTokensAction(input: unknown): Promise<ActionResult<{
  items: {
    id: string
    name: string
    tokenPrefix: string
    level: string
    levelLabel: string
    permissionsMask: number
    scopes: string[] | null
    ipWhitelist: string[] | null
    qpsLimit: number
    expireAt: string | null
    enabled: boolean
    callCount: number
    failCount: number
    lastCallAt: string | null
    createdByAdmin: boolean
    createdAt: string
  }[]
  summary: { total: number; enabled: number; expired: number; totalCalls: number }
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ userId: zId }), input)
    const target = await loadTargetUser(p.userId)
    await assertTokenAdminAccess(ctx, target.id, "view")

    const rows = await db.apiToken.findMany({
      where: { userId: target.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
    })
    const now = new Date()
    const items = rows.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix,
      level: (t.permissionsMask & TOKEN_PERM.ADMIN) !== 0 ? "ADMIN" : t.permissionsMask === LEVEL_MASK.READ_ONLY ? "READ_ONLY" : "READ_WRITE",
      levelLabel: levelLabel(t.permissionsMask),
      permissionsMask: t.permissionsMask,
      scopes: normalizeScopes(t.scopes),
      ipWhitelist: Array.isArray(t.ipWhitelist) ? (t.ipWhitelist as string[]) : null,
      qpsLimit: t.qpsLimit,
      expireAt: t.expireAt ? t.expireAt.toISOString() : null,
      enabled: t.enabled,
      callCount: t.callCount,
      failCount: t.failCount,
      lastCallAt: t.lastCallAt ? t.lastCallAt.toISOString() : null,
      createdByAdmin: !!t.createdByUserId && t.createdByUserId !== t.userId,
      createdAt: t.createdAt.toISOString(),
    }))
    return {
      items,
      summary: {
        total: items.length,
        enabled: items.filter((i) => i.enabled).length,
        expired: items.filter((i) => i.expireAt && i.expireAt < now.toISOString()).length,
        totalCalls: items.reduce((acc, i) => acc + i.callCount, 0),
      },
    }
  })
}

// ============================================================
// 2. 管理员为用户手动创建 API 密钥（明文仅返回一次）
// ============================================================
export async function adminCreateUserApiTokenAction(input: unknown): Promise<ActionResult<{ id: string; token: string; tokenPrefix: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(adminTokenInputSchema, input)
    const target = await loadTargetUser(p.userId)
    await assertTokenAdminAccess(ctx, target.id, "manage")
    if (!target.enabled) throw bizError(ErrorCode.PARAM_ERROR, "目标用户已被禁用，无法创建 API 密钥")

    const mask = resolveMask(p.level, target.role)
    const scopes = resolveScopes(p.scopes || [])
    validateIpList(p.ipWhitelist)

    let expireAt: Date | null = null
    if (p.expireAtIso) {
      expireAt = new Date(p.expireAtIso)
      if (Number.isNaN(expireAt.getTime())) throw bizError(ErrorCode.PARAM_ERROR, "到期时间格式非法")
      if (expireAt.getTime() <= Date.now()) throw bizError(ErrorCode.PARAM_ERROR, "到期时间必须晚于当前时间")
    }

    // 数量上限策略（管理员代创建同样计入目标用户配额）
    const maxPerUser = await getConfigNumber("token.maxPerUser", 10)
    const count = await db.apiToken.count({ where: { userId: target.id, deletedAt: null } })
    if (count >= maxPerUser) {
      throw bizError(ErrorCode.QUOTA_EXCEEDED, `目标用户已达令牌数量上限（${maxPerUser} 个）`)
    }

    const plain = generateApiToken()
    const token = await db.apiToken.create({
      data: {
        userId: target.id,
        name: p.name,
        tokenHash: sha256(plain),
        tokenPrefix: plain.slice(0, 8),
        permissionsMask: mask,
        scopes: scopes ? (scopes as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        ipWhitelist: p.ipWhitelist.length ? (p.ipWhitelist as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        qpsLimit: p.qps,
        expireAt,
        enabled: true,
        createdByUserId: ctx.userId, // 记录操作管理员
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_ADMIN_CREATE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: target.id,
      after: {
        targetUser: target.username,
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        level: p.level,
        permissionsMask: mask,
        scopes: scopes || "不限",
        expireAt: expireAt ? expireAt.toISOString() : "永久",
        qpsLimit: p.qps,
        ipWhitelistCount: p.ipWhitelist.length,
      },
      severity: "WARN", // 管理员代签发密钥属敏感操作
    })
    await trackBehavior(target.id, "CREATE").catch(() => {})

    return { id: token.id, token: plain, tokenPrefix: token.tokenPrefix }
  })
}

// ============================================================
// 3. 管理员修改用户 API 密钥配置（名称/级别/功能范围/IP/QPS/有效期）
// ============================================================
export async function adminUpdateUserApiTokenAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(adminTokenUpdateSchema, input)
    if (!p.id) throw bizError(ErrorCode.PARAM_ERROR, "缺少令牌 ID")

    const before = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!before) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    await assertTokenAdminAccess(ctx, before.userId, "manage")
    const target = await loadTargetUser(before.userId)

    const mask = resolveMask(p.level, target.role)
    const scopes = resolveScopes(p.scopes || [])
    validateIpList(p.ipWhitelist)

    let expireAt: Date | null = null
    if (p.expireAtIso) {
      expireAt = new Date(p.expireAtIso)
      if (Number.isNaN(expireAt.getTime())) throw bizError(ErrorCode.PARAM_ERROR, "到期时间格式非法")
      if (expireAt.getTime() <= Date.now()) throw bizError(ErrorCode.PARAM_ERROR, "到期时间必须晚于当前时间")
    }

    await db.apiToken.update({
      where: { id: before.id },
      data: {
        name: p.name,
        permissionsMask: mask,
        scopes: scopes ? (scopes as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        ipWhitelist: p.ipWhitelist.length ? (p.ipWhitelist as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        qpsLimit: p.qps,
        expireAt,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_ADMIN_UPDATE",
      resourceType: "TOKEN",
      resourceId: before.id,
      resourceName: p.name,
      ownerUserId: before.userId,
      before: {
        name: before.name,
        level: levelLabel(before.permissionsMask),
        permissionsMask: before.permissionsMask,
        scopes: before.scopes ?? "不限",
        expireAt: before.expireAt ? before.expireAt.toISOString() : "永久",
        qpsLimit: before.qpsLimit,
        ipWhitelist: before.ipWhitelist,
      },
      after: {
        name: p.name,
        level: p.level,
        permissionsMask: mask,
        scopes: scopes || "不限",
        expireAt: expireAt ? expireAt.toISOString() : "永久",
        qpsLimit: p.qps,
        ipWhitelist: p.ipWhitelist,
      },
      severity: "WARN",
    })
    return { id: before.id }
  })
}

// ============================================================
// 4. 管理员启/停用用户 API 密钥
// ============================================================
export async function adminToggleUserApiTokenAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ id: zId, enabled: z.boolean() }), input)

    const token = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!token) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    await assertTokenAdminAccess(ctx, token.userId, "manage")
    if (token.enabled === p.enabled) return { id: token.id, enabled: p.enabled }

    await db.apiToken.update({ where: { id: token.id }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_ADMIN_TOGGLE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: token.userId,
      before: { enabled: token.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: token.id, enabled: p.enabled }
  })
}

// ============================================================
// 5. 管理员吊销（软删除）用户 API 密钥 → 回收站
// ============================================================
export async function adminDeleteUserApiTokenAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ id: zId, reason: z.string().max(200).optional() }), input)

    const token = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!token) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    await assertTokenAdminAccess(ctx, token.userId, "manage")

    await db.apiToken.update({ where: { id: token.id }, data: { deletedAt: new Date(), enabled: false } })
    await moveToRecycle({
      resourceType: "API_TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: token.userId,
      createdByUserId: token.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: p.reason || "管理员吊销令牌",
      operatorName: ctx.username,
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_ADMIN_DELETE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: token.userId,
      before: { name: token.name, tokenPrefix: token.tokenPrefix, level: levelLabel(token.permissionsMask), expireAt: token.expireAt ? token.expireAt.toISOString() : "永久" },
      after: { deleted: true, softDeleted: true, revokedByAdmin: true },
      severity: "WARN",
    })
    return { id: token.id }
  })
}
