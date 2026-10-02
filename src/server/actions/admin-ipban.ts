"use server"

// r23：IP 封禁管理（管理员后台）
// · 列表：封禁中/历史计数记录，支持搜索（IP/原因）+ 状态筛选 + 分页
// · 手动封禁（立即生效，可指定时长；0=视为长期）
// · 手动解封（清零计数）
// · 删除记录（清理误报/过期数据）
// 权限：SUPER_ADMIN / ADMIN；全部写审计

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { manualBanIp, manualUnbanIp } from "@/lib/ip-ban"
import { bizError, ErrorCode } from "@/lib/errors"

const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

// ---- 1. 列表（分页 + 搜索 + 状态筛选） ----
export async function listIpBansAction(input: unknown): Promise<ActionResult<{
  items: {
    id: string
    ip: string
    source: string
    failCount: number
    firstFailAt: string | null
    lastFailAt: string | null
    bannedUntil: string | null
    remainMinutes: number | null
    reason: string | null
    note: string | null
    unbannedAt: string | null
    updatedAt: string
  }[]
  total: number
  page: number
  pageSize: number
  stats: { banned: number; counting: number }
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(
      z.object({
        q: z.string().max(100).optional().default(""),
        status: z.enum(["all", "banned", "counting"]).optional().default("all"),
        page: z.number().int().min(1).max(10000).optional().default(1),
        pageSize: z.number().int().min(5).max(100).optional().default(20),
      }),
      input
    )
    const where: Record<string, unknown> = {}
    if (p.q) {
      const kw = { contains: p.q }
      where.OR = [{ ip: kw }, { reason: kw }, { note: kw }]
    }
    const now = new Date()
    if (p.status === "banned") where.bannedUntil = { gt: now }
    if (p.status === "counting") where.AND = [{ OR: [{ bannedUntil: null }, { bannedUntil: { lte: now } }] }, { failCount: { gt: 0 } }]

    const [rows, total, banned, counting] = await Promise.all([
      db.ipBanRecord.findMany({
        where,
        orderBy: [{ bannedUntil: "desc" }, { lastFailAt: "desc" }],
        skip: (p.page - 1) * p.pageSize,
        take: p.pageSize,
      }),
      db.ipBanRecord.count({ where }),
      db.ipBanRecord.count({ where: { bannedUntil: { gt: now } } }),
      db.ipBanRecord.count({ where: { failCount: { gt: 0 }, OR: [{ bannedUntil: null }, { bannedUntil: { lte: now } }] } }),
    ])

    const items = rows.map((r) => {
      const active = r.bannedUntil && r.bannedUntil.getTime() > now.getTime()
      return {
        id: r.id,
        ip: r.ip,
        source: r.source,
        failCount: r.failCount,
        firstFailAt: r.firstFailAt?.toISOString() ?? null,
        lastFailAt: r.lastFailAt?.toISOString() ?? null,
        bannedUntil: r.bannedUntil?.toISOString() ?? null,
        remainMinutes: active ? Math.max(1, Math.ceil((r.bannedUntil!.getTime() - now.getTime()) / 60_000)) : null,
        reason: r.reason,
        note: r.note,
        unbannedAt: r.unbannedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      }
    })
    return { items, total, page: p.page, pageSize: p.pageSize, stats: { banned, counting } }
  })
}

// ---- 2. 手动封禁 ----
export async function manualBanIpAction(input: unknown): Promise<ActionResult<{ ip: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        ip: z.string().regex(IP_RE, "IP 格式非法"),
        minutes: z.number().int().min(0).max(525600), // 0=长期（100年）
        reason: z.string().min(2).max(200),
        note: z.string().max(200).optional(),
      }),
      input
    )
    const row = await manualBanIp(p.ip, p.minutes, p.reason, ctx.userId, p.note)
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "IP_BAN_MANUAL",
      resourceType: "SECURITY",
      resourceId: row.id,
      resourceName: p.ip,
      after: { ip: p.ip, minutes: p.minutes, reason: p.reason },
      severity: "WARN",
    })
    return { ip: p.ip }
  })
}

// ---- 3. 手动解封 ----
export async function manualUnbanIpAction(input: unknown): Promise<ActionResult<{ ip: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: zId,
        note: z.string().max(200).optional(),
      }),
      input
    )
    const row = await db.ipBanRecord.findUnique({ where: { id: p.id } })
    if (!row) throw bizError(ErrorCode.NOT_FOUND, "封禁记录不存在")
    await manualUnbanIp(row.ip, ctx.userId, p.note)
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "IP_UNBAN_MANUAL",
      resourceType: "SECURITY",
      resourceId: row.id,
      resourceName: row.ip,
      before: { bannedUntil: row.bannedUntil?.toISOString() ?? null },
      after: { unbanned: true, note: p.note ?? null },
      severity: "INFO",
    })
    return { ip: row.ip }
  })
}

// ---- 4. 删除记录（清理历史计数/误报） ----
export async function deleteIpBanRecordAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ ids: z.array(zId).min(1).max(200) }), input)
    const active = await db.ipBanRecord.findMany({ where: { id: { in: p.ids }, bannedUntil: { gt: new Date() } }, select: { id: true, ip: true } })
    if (active.length > 0) {
      throw bizError(ErrorCode.PARAM_ERROR, `存在封禁生效中的记录（${active.map((a) => a.ip).join("、")}），请先解封再删除`)
    }
    const r = await db.ipBanRecord.deleteMany({ where: { id: { in: p.ids } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "IP_BAN_RECORD_DELETE",
      resourceType: "SECURITY",
      resourceId: p.ids.join(","),
      after: { deleted: r.count },
      severity: "INFO",
    })
    return { deleted: r.count }
  })
}
