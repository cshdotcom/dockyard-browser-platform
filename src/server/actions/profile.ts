"use server"

// 个人中心动作：资料/界面偏好更新、登录设备自助管理（单条/全部下线）、受信任设备撤销
// 安全自助操作（下线设备）不做维护模式拦截，保证账号安全操作随时可用

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth, requirePermission, requireWritableMode, userGroupIds } from "@/lib/permissions"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"

// ---- 个人资料 ----
export async function updateProfileAction(input: unknown): Promise<ActionResult<{ displayName: string | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockEditProfile", "修改个人资料已被权限锁禁止")

    const p = zodValidate(
      z.object({
        displayName: z.string().max(64, "显示名最长 64 字符").optional().nullable(),
        theme: z.enum(["light", "dark", "system"]).optional(),
        pageSize: z.coerce.number().int().min(10).max(100).optional(),
      }),
      input
    )

    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw bizError(ErrorCode.NOT_FOUND, "用户不存在")

    // 合并旧偏好（保留未涉及字段）
    const oldPrefs = (user.preferences as Record<string, unknown>) || {}
    const newPrefs: Record<string, unknown> = { ...oldPrefs }
    if (p.theme) newPrefs.theme = p.theme
    if (p.pageSize) newPrefs.pageSize = p.pageSize

    await db.user.update({
      where: { id: ctx.userId },
      data: {
        displayName: p.displayName === undefined ? user.displayName : p.displayName || null,
        preferences: newPrefs as unknown as Prisma.InputJsonValue,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PROFILE_UPDATE",
      resourceType: "USER",
      resourceId: ctx.userId,
      resourceName: ctx.username,
      ownerUserId: ctx.userId,
      before: { displayName: user.displayName, preferences: oldPrefs },
      after: { displayName: p.displayName ?? user.displayName, preferences: newPrefs },
    })
    return { displayName: p.displayName ?? user.displayName ?? null }
  })
}

// ---- 登录设备管理 ----

// 撤销内部实现：会话 + 关联 refreshToken + 审计
async function revokeOneSession(params: {
  session: { id: string; userId: string; refreshTokenId: string | null; ip: string | null; deviceLabel: string | null; trusted: boolean }
  operator: { userId: string; username: string }
  reason: string
  detail: string
}) {
  const { session, operator, reason, detail } = params
  await db.loginSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  if (session.refreshTokenId) {
    await db.refreshToken.updateMany({ where: { id: session.refreshTokenId, revokedAt: null }, data: { revokedAt: new Date() } })
  }
  await writeAudit({
    operatorUserId: operator.userId,
    operatorName: operator.username,
    operationType: "SESSION_REVOKE",
    resourceType: "SESSION",
    resourceId: session.id,
    resourceName: session.deviceLabel || session.ip || session.id,
    ownerUserId: session.userId,
    before: { revokedAt: null, trusted: session.trusted, ip: session.ip },
    after: { revokedAt: new Date().toISOString(), revokedReason: reason },
    severity: "WARN",
  })
  await writeSecurityEvent({
    userId: session.userId,
    username: operator.username,
    eventType: "DEVICE_REVOKED",
    detail,
    ip: session.ip || undefined,
  })
}

export async function revokeMySessionAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ sid: zId }), input)

    if (p.sid === ctx.loginSessionId) {
      throw bizError(ErrorCode.PARAM_ERROR, "不能撤销当前正在使用的登录会话")
    }
    const session = await db.loginSession.findUnique({ where: { id: p.sid } })
    if (!session || session.userId !== ctx.userId) {
      throw bizError(ErrorCode.NOT_FOUND, "登录会话不存在")
    }
    if (session.revokedAt) return { id: p.sid } // 幂等

    await revokeOneSession({
      session,
      operator: { userId: ctx.userId, username: ctx.username },
      reason: "LOGOUT",
      detail: `用户主动下线设备（IP ${session.ip || "未知"}）`,
    })
    return { id: p.sid }
  })
}

export async function revokeAllMyOtherSessionsAction(): Promise<ActionResult<{ revoked: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const actives = await db.loginSession.findMany({
      where: { userId: ctx.userId, revokedAt: null },
    })
    const others = actives.filter((s) => s.id !== ctx.loginSessionId)
    let revoked = 0
    for (const s of others) {
      await revokeOneSession({
        session: s,
        operator: { userId: ctx.userId, username: ctx.username },
        reason: "LOGOUT",
        detail: `一键下线全部其他设备（IP ${s.ip || "未知"}）`,
      })
      revoked++
    }
    if (revoked === 0) throw bizError(ErrorCode.PARAM_ERROR, "没有可下线的其他设备会话")
    return { revoked }
  })
}

// ---- r23：下线（删除）已离线设备记录 ----
// 用户语义：对已下线/已过期的会话执行「下线」= 数据库直接删除该 LoginSession 行，
// 该设备cookie对应的 sessionHash 从此不被数据库承认（彻底踢出，而非仅软撤销标记）。
// 在线会话必须先撤销再删除（防误操作踢掉自己正在使用的设备）。
export async function deleteMySessionRecordAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ sids: z.array(zId).min(1, "至少选择一条记录").max(100, "单次最多100条") }), input)

    const sessions = await db.loginSession.findMany({ where: { id: { in: p.sids }, userId: ctx.userId } })
    const current = sessions.find((s) => s.id === ctx.loginSessionId)
    if (current && !current.revokedAt) {
      throw bizError(ErrorCode.PARAM_ERROR, "不能删除当前在线会话（请先下线其他设备）")
    }
    // 在线会话不允许直接删除（须先撤销）
    const active = sessions.filter((s) => !s.revokedAt && s.id !== ctx.loginSessionId && (!s.expiresAt || s.expiresAt > new Date()))
    if (active.length > 0) {
      throw bizError(ErrorCode.PARAM_ERROR, `${active.length} 条会话仍在线：请先「下线」再删除记录`)
    }
    const r = await db.loginSession.deleteMany({ where: { id: { in: p.sids }, userId: ctx.userId } })
    await writeSecurityEvent({
      userId: ctx.userId,
      username: ctx.username,
      eventType: "SESSION_RECORD_DELETE",
      success: true,
      detail: `删除 ${r.count} 条已下线/过期登录会话记录（cookie 彻底失效）`,
    })
    return { deleted: r.count }
  })
}

// ---- r23：一键清理全部已下线/过期会话记录（列表瘦身） ----
export async function deleteAllMyOfflineSessionsAction(): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const cutoff = new Date()
    // 只删已撤销或已过期的（不含当前会话与任何在线会话）
    const where = {
      userId: ctx.userId,
      AND: [
        { id: { not: ctx.loginSessionId || "___none___" } },
        { OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: cutoff } }] },
      ],
    }
    const r = await db.loginSession.deleteMany({ where })
    if (r.count === 0) throw bizError(ErrorCode.PARAM_ERROR, "没有可清理的已下线/过期记录")
    await writeSecurityEvent({
      userId: ctx.userId,
      username: ctx.username,
      eventType: "SESSION_RECORD_DELETE",
      success: true,
      detail: `一键清理 ${r.count} 条已下线/过期登录会话记录`,
    })
    return { deleted: r.count }
  })
}

// ---- r23：删除已撤销信任的受信任设备记录（列表瘦身） ----
export async function deleteMyRevokedTrustedDevicesAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ ids: z.array(zId).max(100).optional() }), input)
    const where: Record<string, unknown> = { userId: ctx.userId, revokedAt: { not: null } }
    if (p.ids && p.ids.length > 0) where.id = { in: p.ids }
    const r = await db.trustedDevice.deleteMany({ where })
    if (r.count === 0) throw bizError(ErrorCode.PARAM_ERROR, "没有可删除的已撤销信任设备记录")
    return { deleted: r.count }
  })
}

// ---- 受信任设备 ----
export async function revokeMyTrustedDeviceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ id: zId }), input)

    const device = await db.trustedDevice.findUnique({ where: { id: p.id } })
    if (!device || device.userId !== ctx.userId) throw bizError(ErrorCode.NOT_FOUND, "受信任设备不存在")
    if (device.revokedAt) return { id: device.id }

    await db.trustedDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TRUSTED_DEVICE_REVOKE",
      resourceType: "TRUSTED_DEVICE",
      resourceId: device.id,
      resourceName: device.label || device.id,
      ownerUserId: ctx.userId,
      before: { label: device.label, ip: device.ip, expiresAt: device.expiresAt.toISOString(), revokedAt: null },
      after: { revokedAt: new Date().toISOString() },
      severity: "WARN",
    })
    await writeSecurityEvent({
      userId: ctx.userId,
      username: ctx.username,
      eventType: "DEVICE_REVOKED",
      detail: `撤销受信任设备（${device.label || device.ip || device.deviceId}）`,
      ip: device.ip || undefined,
    })
    return { id: device.id }
  })
}

// ---- 公告已读 ----
export async function markAnnouncementReadAction(input: unknown): Promise<ActionResult<{ announcementId: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ announcementId: zId }), input)

    const ann = await db.announcement.findUnique({ where: { id: p.announcementId } })
    if (!ann || !ann.enabled) throw bizError(ErrorCode.NOT_FOUND, "公告不存在或已停用")

    // 可见性校验：GLOBAL / GROUP(我的组) / USER(定向我)
    if (ann.type === "GROUP") {
      const gids = await userGroupIds(ctx.userId)
      if (!ann.groupId || !gids.includes(ann.groupId)) throw bizError(ErrorCode.FORBIDDEN, "无权查看该公告")
    } else if (ann.type === "USER" && ann.userId !== ctx.userId) {
      throw bizError(ErrorCode.FORBIDDEN, "无权查看该公告")
    }

    await db.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: ann.id, userId: ctx.userId } },
      update: {},
      create: { announcementId: ann.id, userId: ctx.userId },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_READ",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      ownerUserId: ann.userId,
    })
    return { announcementId: ann.id }
  })
}
