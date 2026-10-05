"use server"

// ============================================================
// r38：硬件透传访问申请 + 管理员监控（静默/申请双模式的完整闭环）
//
// 用户侧：
//   createHardwareRequestAction   —— 提交申请（沙箱级/账号级 + 理由）
//   listMyHardwareRequestsAction  —— 我的申请历史 + 当前生效授权
// 管理侧（登录门 + 审计）：
//   listHardwareRequestsAdminAction —— 待审批队列 + 近期已决
//   decideHardwareRequestAction     —— 批准（可设有效期）/ 拒绝 / 撤销
//   hardwareMonitorAction           —— 监控总览（按权限统计/活跃授权/审计流）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { bizError, ErrorCode } from "@/lib/errors"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { HARDWARE_PERMS, HARDWARE_PERM_IDS } from "@/lib/hardware-perms"
import { writeAudit } from "@/lib/audit"

const PERM_LABEL = new Map(HARDWARE_PERMS.map((p) => [p.id, p.label]))

// ---------------- 用户：提交申请 ----------------
export async function createHardwareRequestAction(input: unknown): Promise<ActionResult<{ id: string; mode: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(
      z.object({
        permId: z.string().min(1).max(64),
        workspaceId: zId.optional().nullable(),
        reason: z.string().max(500).optional(),
      }),
      input,
    )
    if (!HARDWARE_PERM_IDS.includes(p.permId)) {
      throw bizError(ErrorCode.PARAM_ERROR, `未知硬件权限项：${p.permId}`)
    }
    if (p.workspaceId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.workspaceId }, select: { userId: true } })
      if (!ws) throw bizError(ErrorCode.NOT_FOUND, "沙箱不存在")
      if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
        throw bizError(ErrorCode.FORBIDDEN, "只能为自己的沙箱提交申请")
      }
    }
    const dup = await db.hardwareAccessRequest.findFirst({
      where: {
        userId: ctx.userId,
        permId: p.permId,
        workspaceId: p.workspaceId ?? null,
        mode: { in: ["PENDING", "GRANTED"] },
      },
      select: { id: true, mode: true },
    })
    if (dup) {
      throw bizError(ErrorCode.CONFLICT, dup.mode === "PENDING" ? "该权限已有待审批的申请" : "该权限已处于授权生效中（可在到期后重新申请）")
    }
    const req = await db.hardwareAccessRequest.create({
      data: {
        userId: ctx.userId,
        workspaceId: p.workspaceId ?? null,
        permId: p.permId,
        reason: p.reason || null,
        mode: "PENDING",
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "HARDWARE_REQUEST_CREATE",
      resourceType: "HARDWARE_REQUEST",
      resourceId: req.id,
      resourceName: `硬件申请 ${PERM_LABEL.get(p.permId) ?? p.permId}`,
      severity: "INFO",
      after: { permId: p.permId, workspaceId: p.workspaceId ?? null, reason: p.reason ?? null },
    })
    return { id: req.id, mode: req.mode }
  })
}

// ---------------- 用户：我的申请 + 生效授权 ----------------
export interface HardwareRequestItem {
  id: string; permId: string; permLabel: string; workspaceId: string | null; mode: string
  reason: string | null; decidedByName: string | null; decisionNote: string | null
  expiresAt: string | null; createdAt: string
}

export async function listMyHardwareRequestsAction(): Promise<ActionResult<{
  requests: HardwareRequestItem[]
  granted: Array<{ permId: string; permLabel: string; expiresAt: string | null }>
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const reqs = await db.hardwareAccessRequest.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    const now = new Date()
    const grantedMap = new Map<string, { expiresAt: string | null }>()
    for (const r of reqs) {
      if (r.mode === "GRANTED" && (!r.expiresAt || r.expiresAt > now)) {
        grantedMap.set(r.permId, { expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null })
      }
    }
    const requests: HardwareRequestItem[] = reqs.map((r) => ({
      id: r.id,
      permId: r.permId,
      permLabel: PERM_LABEL.get(r.permId) ?? r.permId,
      workspaceId: r.workspaceId,
      mode: r.mode,
      reason: r.reason,
      decidedByName: r.decidedByName,
      decisionNote: r.decisionNote,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }))
    return {
      requests,
      granted: Array.from(grantedMap.entries()).map(([permId, v]) => ({
        permId,
        permLabel: PERM_LABEL.get(permId) ?? permId,
        expiresAt: v.expiresAt,
      })),
    }
  })
}

// ---------------- 管理员：审批队列 + 近期已决 ----------------
export async function listHardwareRequestsAdminAction(input?: unknown): Promise<ActionResult<{
  pending: Array<{
    id: string; userId: string; username: string; displayName: string | null
    workspaceId: string | null; workspaceName: string | null
    permId: string; permLabel: string; reason: string | null; createdAt: string
  }>
  recent: Array<{
    id: string; username: string; permId: string; permLabel: string; mode: string
    decidedByName: string | null; decisionNote: string | null; expiresAt: string | null
    decidedAt: string | null; createdAt: string
  }>
  stats: { pending: number; active: number; expiredToday: number }
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ take: z.number().int().min(1).max(200).optional() }).partial(), input ?? {})

    const pendingRows = await db.hardwareAccessRequest.findMany({
      where: { mode: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: p.take ?? 50,
    })
    const recentRows = await db.hardwareAccessRequest.findMany({
      where: { mode: { not: "PENDING" } },
      orderBy: { updatedAt: "desc" },
      take: p.take ?? 50,
    })
    const userIds = Array.from(new Set([...pendingRows, ...recentRows].map((r) => r.userId)))
    const wsIds = Array.from(new Set([...pendingRows, ...recentRows].map((r) => r.workspaceId).filter((x): x is string => !!x)))
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const workspaces = wsIds.length
      ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } })
      : []
    const userMap = new Map(users.map((u) => [u.id, u]))
    const wsMap = new Map(workspaces.map((w) => [w.id, w]))

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const [activeCount, expiredToday] = await Promise.all([
      db.hardwareAccessRequest.count({ where: { mode: "GRANTED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
      db.hardwareAccessRequest.count({ where: { mode: "GRANTED", expiresAt: { lt: now, gte: todayStart } } }),
    ])

    return {
      pending: pendingRows.map((r) => {
        const u = userMap.get(r.userId)
        const w = r.workspaceId ? wsMap.get(r.workspaceId) : null
        return {
          id: r.id,
          userId: r.userId,
          username: u?.username ?? "未知用户",
          displayName: u?.displayName ?? null,
          workspaceId: r.workspaceId,
          workspaceName: w?.name ?? null,
          permId: r.permId,
          permLabel: PERM_LABEL.get(r.permId) ?? r.permId,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
        }
      }),
      recent: recentRows.map((r) => {
        const u = userMap.get(r.userId)
        return {
          id: r.id,
          username: u?.username ?? "未知",
          permId: r.permId,
          permLabel: PERM_LABEL.get(r.permId) ?? r.permId,
          mode: r.mode,
          decidedByName: r.decidedByName,
          decisionNote: r.decisionNote,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          decidedAt: r.updatedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        }
      }),
      stats: { pending: pendingRows.length, active: activeCount, expiredToday },
    }
  })
}

// ---------------- 管理员：批准 / 拒绝 / 撤销 ----------------
export async function decideHardwareRequestAction(input: unknown): Promise<ActionResult<{ id: string; mode: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: zId,
        decision: z.enum(["GRANTED", "DENIED", "REVOKED"]),
        note: z.string().max(500).optional(),
        expireHours: z.number().int().min(1).max(24 * 365).optional(),
      }),
      input,
    )
    const req = await db.hardwareAccessRequest.findUnique({ where: { id: p.id } })
    if (!req) throw bizError(ErrorCode.NOT_FOUND, "申请不存在")
    if (p.decision === "GRANTED" && req.mode !== "PENDING") {
      throw bizError(ErrorCode.CONFLICT, `当前状态 ${req.mode} 不可批准（仅 PENDING 可批准）`)
    }
    if (p.decision === "DENIED" && req.mode !== "PENDING") {
      throw bizError(ErrorCode.CONFLICT, `当前状态 ${req.mode} 不可拒绝`)
    }
    if (p.decision === "REVOKED" && req.mode !== "GRANTED") {
      throw bizError(ErrorCode.CONFLICT, `当前状态 ${req.mode} 不可撤销（仅已授权可撤销）`)
    }
    const expiresAt = p.decision === "GRANTED" && p.expireHours ? new Date(Date.now() + p.expireHours * 3600_000) : req.expiresAt
    const updated = await db.hardwareAccessRequest.update({
      where: { id: p.id },
      data: {
        mode: p.decision,
        decidedBy: ctx.userId,
        decidedByName: ctx.username,
        decisionNote: p.note || null,
        ...(p.decision === "GRANTED" ? { expiresAt: expiresAt ?? null } : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: `HARDWARE_REQUEST_${p.decision}`,
      resourceType: "HARDWARE_REQUEST",
      resourceId: p.id,
      resourceName: `硬件申请 ${PERM_LABEL.get(req.permId) ?? req.permId}（${req.userId}）`,
      severity: p.decision === "GRANTED" ? "WARN" : "INFO",
      before: { mode: req.mode, expiresAt: req.expiresAt?.toISOString() ?? null },
      after: { mode: p.decision, expiresAt: updated.expiresAt?.toISOString() ?? null, note: p.note ?? null },
    })
    return { id: updated.id, mode: updated.mode }
  })
}

// ---------------- 管理员：硬件监控总览 ----------------
export async function hardwareMonitorAction(): Promise<ActionResult<{
  perms: Array<{ permId: string; permLabel: string; group: string; activeGrants: number; danger: boolean }>
  activeGrants: Array<{
    id: string; username: string; displayName: string | null; workspaceId: string | null
    workspaceName: string | null; permId: string; permLabel: string
    expiresAt: string | null; decidedByName: string | null; grantedAt: string
  }>
  recentAudit: Array<{ at: string; operator: string; op: string; target: string; severity: string }>
  pendingCount: number
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const now = new Date()
    const grants = await db.hardwareAccessRequest.findMany({
      where: { mode: "GRANTED", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { updatedAt: "desc" },
      take: 200,
    })
    const userIds = Array.from(new Set(grants.map((g) => g.userId)))
    const wsIds = Array.from(new Set(grants.map((g) => g.workspaceId).filter((x): x is string => !!x)))
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const workspaces = wsIds.length
      ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } })
      : []
    const [pendingCount, auditRows] = await Promise.all([
      db.hardwareAccessRequest.count({ where: { mode: "PENDING" } }),
      db.auditLog.findMany({
        where: { operationType: { startsWith: "HARDWARE" } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { createdAt: true, operatorName: true, operationType: true, resourceName: true, severity: true },
      }),
    ])
    const userMap = new Map(users.map((u) => [u.id, u]))
    const wsMap = new Map(workspaces.map((w) => [w.id, w]))

    const permStats = new Map<string, number>()
    for (const g of grants) permStats.set(g.permId, (permStats.get(g.permId) ?? 0) + 1)

    return {
      perms: HARDWARE_PERMS.map((d) => ({
        permId: d.id,
        permLabel: d.label,
        group: d.group,
        danger: !!d.danger,
        activeGrants: permStats.get(d.id) ?? 0,
      })),
      activeGrants: grants.map((g) => {
        const u = userMap.get(g.userId)
        const w = g.workspaceId ? wsMap.get(g.workspaceId) : null
        return {
          id: g.id,
          username: u?.username ?? "未知",
          displayName: u?.displayName ?? null,
          workspaceId: g.workspaceId,
          workspaceName: w?.name ?? null,
          permId: g.permId,
          permLabel: PERM_LABEL.get(g.permId) ?? g.permId,
          expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
          decidedByName: g.decidedByName,
          grantedAt: g.updatedAt.toISOString(),
        }
      }),
      recentAudit: auditRows.map((a) => ({
        at: a.createdAt.toISOString(),
        operator: a.operatorName ?? "系统",
        op: a.operationType,
        target: a.resourceName ?? "",
        severity: a.severity,
      })),
      pendingCount,
    }
  })
}
