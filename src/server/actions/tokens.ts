"use server"

// 我的 API 令牌（用户自助）：创建 / 编辑 / 删除(软删+回收站) / 启停
// 全局策略校验：token.maxPerUser / token.allowPermanent(仅 SUPER_ADMIN 豁免) / token.maxLifetimeDays
// 权限锁：blockCreateApiToken / blockEditTokenExpiry / blockDeleteResource
// 明文 token 仅创建时返回一次，库内只存 sha256 哈希
//
// r12 升级：权限级别（只读 READ_ONLY / 读写 READ_WRITE / 管理级 ADMIN）+ 功能范围 scope 白名单
// 安全约束：ADMIN 级别（掩码含管理位）仅平台管理员本人可授予 —— 封堵普通用户自助签发管理位令牌的提权路径
// scope 白名单：null/空 = 不限（全功能面）；非空 = 仅允许命中数组内 scope 的功能面

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth, requirePermission, requireWritableMode } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId, zPrecision } from "@/lib/validators"
import { generateApiToken, sha256 } from "@/lib/crypto"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"
import { TOKEN_PERM, TOKEN_SCOPES, normalizeScopes, levelOfMask, levelLabel } from "@/lib/token-scopes"

const IP_CIDR_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\/(?:[12]\d|[0-9]))?$/

// 权限级别 → 掩码
const LEVEL_MASK: Record<"READ_ONLY" | "READ_WRITE" | "ADMIN", number> = {
  READ_ONLY: TOKEN_PERM.READ,
  READ_WRITE: TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE,
  ADMIN: TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE | TOKEN_PERM.ADMIN,
}
const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

const tokenInputSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "令牌名称必填").max(64),
  // 权限级别：只读 / 读写 / 管理级（管理级仅平台管理员可授予）
  level: z.enum(["READ_ONLY", "READ_WRITE", "ADMIN"]),
  // 功能范围白名单：空数组 = 不限；否则仅允许勾选的功能面
  scopes: z.array(z.string().max(32)).max(8, "功能范围最多 8 项").optional().default([]),
  // null / "" = 永久有效；否则为 ISO 时间字符串
  expireAtIso: z.string().nullable().optional(),
  ipWhitelist: z.array(z.string().max(64)).max(20, "IP 白名单最多 20 条"),
  qps: zPrecision("QPS 限制", 0, 100000),
})

// 有效期策略校验（创建与编辑共用）
async function validateExpireAt(expireAtIso: string | null | undefined, role: string): Promise<Date | null> {
  if (expireAtIso === null || expireAtIso === undefined || expireAtIso === "") {
    const allowPermanent = await getConfigBool("token.allowPermanent", true)
    if (!allowPermanent && role !== "SUPER_ADMIN") {
      throw bizError(ErrorCode.PARAM_ERROR, "系统策略不允许普通用户创建永久 Token")
    }
    return null
  }
  const expireAt = new Date(expireAtIso)
  if (Number.isNaN(expireAt.getTime())) throw bizError(ErrorCode.PARAM_ERROR, "到期时间格式非法")
  if (expireAt.getTime() <= Date.now()) throw bizError(ErrorCode.PARAM_ERROR, "到期时间必须晚于当前时间")
  const maxDays = await getConfigNumber("token.maxLifetimeDays", 0)
  if (maxDays > 0 && expireAt.getTime() - Date.now() > maxDays * 86400_000) {
    throw bizError(ErrorCode.PARAM_ERROR, `系统策略限制 Token 有效期最长 ${maxDays} 天`)
  }
  return expireAt
}

// 级别 → 掩码 + 管理位防提权校验
function resolveMask(level: "READ_ONLY" | "READ_WRITE" | "ADMIN", role: string): number {
  if (level === "ADMIN" && !ADMIN_ROLES.has(role)) {
    throw bizError(ErrorCode.FORBIDDEN, "管理级令牌（含用户/令牌/强制管控等管理操作）仅平台管理员可授予")
  }
  return LEVEL_MASK[level]
}

// scope 白名单校验与规整：未知 key 直接报错（防止静默忽略造成「以为限制了实际没限制」）
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

export async function createApiTokenAction(input: unknown): Promise<ActionResult<{ id: string; token: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockCreateApiToken", "创建 API 令牌已被权限锁禁止")
    const p = zodValidate(tokenInputSchema, input)

    const expireAt = await validateExpireAt(p.expireAtIso ?? null, ctx.role)
    const mask = resolveMask(p.level, ctx.role)
    const scopes = resolveScopes(p.scopes || [])
    validateIpList(p.ipWhitelist)

    const maxPerUser = await getConfigNumber("token.maxPerUser", 10)
    const count = await db.apiToken.count({ where: { userId: ctx.userId, deletedAt: null } })
    if (count >= maxPerUser) {
      throw bizError(ErrorCode.QUOTA_EXCEEDED, `已达个人令牌数量上限（${maxPerUser} 个），请先删除不再使用的令牌`)
    }

    const plain = generateApiToken()
    const token = await db.apiToken.create({
      data: {
        userId: ctx.userId,
        name: p.name,
        tokenHash: sha256(plain),
        tokenPrefix: plain.slice(0, 8),
        permissionsMask: mask,
        scopes: scopes ? (scopes as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        ipWhitelist: p.ipWhitelist.length ? (p.ipWhitelist as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        qpsLimit: p.qps,
        expireAt,
        enabled: true,
        createdByUserId: ctx.userId,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_CREATE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: ctx.userId,
      after: {
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        level: p.level,
        permissionsMask: mask,
        scopes: scopes || "不限",
        expireAt: expireAt ? expireAt.toISOString() : "永久",
        qpsLimit: p.qps,
        ipWhitelistCount: p.ipWhitelist.length,
      },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})

    // 明文只返回这一次
    return { id: token.id, token: plain }
  })
}

export async function updateApiTokenAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(tokenInputSchema, input)
    if (!p.id) throw bizError(ErrorCode.PARAM_ERROR, "缺少令牌 ID")

    const before = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!before) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    if (before.userId !== ctx.userId) throw bizError(ErrorCode.FORBIDDEN, "只能操作自己的令牌")

    const expireAt = await validateExpireAt(p.expireAtIso ?? null, ctx.role)
    const mask = resolveMask(p.level, ctx.role)
    const scopes = resolveScopes(p.scopes || [])
    validateIpList(p.ipWhitelist)

    // 有效期变化 → 单独的权限锁拦截
    const expireChanged =
      (before.expireAt ? before.expireAt.toISOString() : null) !== (expireAt ? expireAt.toISOString() : null)
    if (expireChanged) {
      await requirePermission(ctx.userId, "blockEditTokenExpiry", "修改令牌有效期已被权限锁禁止")
    }

    await db.apiToken.update({
      where: { id: p.id },
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
      operationType: "TOKEN_UPDATE",
      resourceType: "TOKEN",
      resourceId: before.id,
      resourceName: p.name,
      ownerUserId: ctx.userId,
      before: {
        name: before.name,
        level: levelOfMask(before.permissionsMask),
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
        expireChanged,
      },
    })
    return { id: before.id }
  })
}

export async function deleteApiTokenAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockDeleteResource", "删除资源已被权限锁禁止")
    const p = zodValidate(z.object({ id: zId, reason: z.string().max(200).optional() }), input)

    const token = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!token) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    if (token.userId !== ctx.userId) throw bizError(ErrorCode.FORBIDDEN, "只能操作自己的令牌")

    await db.apiToken.update({ where: { id: token.id }, data: { deletedAt: new Date(), enabled: false } })
    await moveToRecycle({
      resourceType: "API_TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: ctx.userId,
      createdByUserId: token.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "USER",
      reason: p.reason || "用户删除令牌",
      operatorName: ctx.username,
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_DELETE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: ctx.userId,
      before: { name: token.name, tokenPrefix: token.tokenPrefix, level: levelLabel(token.permissionsMask), expireAt: token.expireAt ? token.expireAt.toISOString() : "永久" },
      after: { deleted: true, softDeleted: true },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { id: token.id }
  })
}

export async function toggleApiTokenAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ id: zId, enabled: z.boolean() }), input)

    const token = await db.apiToken.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!token) throw bizError(ErrorCode.NOT_FOUND, "令牌不存在或已删除")
    if (token.userId !== ctx.userId) throw bizError(ErrorCode.FORBIDDEN, "只能操作自己的令牌")
    if (token.enabled === p.enabled) return { id: token.id, enabled: p.enabled }

    await db.apiToken.update({ where: { id: token.id }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TOKEN_TOGGLE",
      resourceType: "TOKEN",
      resourceId: token.id,
      resourceName: token.name,
      ownerUserId: ctx.userId,
      before: { enabled: token.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: token.id, enabled: p.enabled }
  })
}
