"use server"

// 工作区管控（管理员强制操作核心页）：停止/重启/回收/物理删除/断开VNC/改TTL/资源转移 + 全量批量
// 全部真实调用自研会话引擎/NoVNC 适配器；审计记录 ownerUserId + createdByUserId

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId, zPrecision, zUsername } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, requireRole, requireWritableMode, type AuthContext } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { moveToRecycle } from "@/lib/recycle"
import { encrypt } from "@/lib/crypto"
import { trackBehavior } from "@/lib/risk"
import { createSession, destroySession } from "@/lib/external/browser-session"
import { createNovncSession, destroyNovncSession, disconnectNovncClients } from "@/lib/external/novnc"

type Workspace = {
  id: string
  uuid: string
  name: string
  mode: string
  status: string
  userId: string
  createdByUserId: string | null
  proxyNodeId: string | null
  browserNodeId: string | null
  templateId: string | null
  profileSnapshotId: string | null
  browserSessionId: string | null
  novncSessionId: string | null
  ttlMinutes: number
  idleTimeoutMinutes: number
  novncConnCount: number
  expireAt: Date | null
  freezeReason: string | null
  startedAt: Date | null
  runtimeAccumSec: number
}

async function getWorkspace(id: string): Promise<Workspace> {
  const ws = await db.browserWorkspace.findUnique({ where: { id } })
  if (!ws || ws.deletedAt) throw new Error("工作区不存在或已在回收站")
  return ws as Workspace
}

// 工作区代理 URL 组装：internal_singbox → singboxInstance.socksAddr；external → host:port
async function buildProxyUrl(proxyNodeId: string | null): Promise<string | undefined> {
  if (!proxyNodeId) return undefined
  const node = await db.proxyNode.findUnique({ where: { id: proxyNodeId } })
  if (!node || node.deletedAt || node.status === "DISABLED") return undefined
  if (node.type === "internal_singbox") {
    if (!node.singboxInstanceId) return undefined
    const sbi = await db.singboxInstance.findUnique({ where: { id: node.singboxInstanceId } })
    if (!sbi || sbi.deletedAt || !sbi.socksAddr) return undefined
    return `socks5://${sbi.socksAddr}`
  }
  if (!node.host || !node.port) return undefined
  return `${node.protocol === "http" ? "http" : "socks5"}://${node.host}:${node.port}`
}

// 销毁底层会话（停止/删除/重启前置）
async function destroyUnderlying(ws: Workspace): Promise<string[]> {
  const destroyed: string[] = []
  if (ws.mode === "cdp_light" && ws.browserSessionId) {
    await destroySession(ws.browserSessionId)
    destroyed.push(`browser:${ws.browserSessionId}`)
  }
  if (ws.novncSessionId) {
    await destroyNovncSession(ws.novncSessionId)
    destroyed.push(`novnc:${ws.novncSessionId}`)
  }
  return destroyed
}

// ============================================================
// 1. 强制停止
// ============================================================
export async function forceStopWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await getWorkspace(id)
    const destroyed = await destroyUnderlying(ws)
    const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
    const updated = await db.browserWorkspace.update({
      where: { id },
      data: { status: "STOPPED", freezeReason: null, browserSessionId: null, cdpUrl: null, novncSessionId: null, novncConnCount: 0, startedAt: null, runtimeAccumSec: { increment: runtimeDelta } },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_STOP",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { status: ws.status, mode: ws.mode },
      after: { status: updated.status, destroyedSessions: destroyed },
    })
    await raiseAlert({
      title: "工作区被管理员强制停止",
      level: "WARN",
      content: `工作区 ${ws.name}（${ws.uuid}）被管理员 ${ctx.username} 强制停止，底层会话已销毁`,
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      ownerUserId: ws.userId,
      dedupeKey: `ws-force-stop-${ws.id}`,
    })
    return { id, status: updated.status }
  })
}

// ============================================================
// 2. 强制重启（保留快照/模板/代理配置 → 销毁再按原配置重建）
// ============================================================
async function coreRestart(ctx: AuthContext, ws: Workspace): Promise<void> {
  await destroyUnderlying(ws)
  const proxyUrl = await buildProxyUrl(ws.proxyNodeId)
  const ttl = ws.ttlMinutes > 0 ? ws.ttlMinutes : undefined
  if (ws.mode === "cdp_light") {
    const session = await createSession({ proxyUrl, ttlMinutes: ttl })
    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: { status: "RUNNING", browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, freezeReason: null, crashCategory: null, startedAt: new Date() },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_RESTART",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { status: ws.status, browserSessionId: ws.browserSessionId },
      after: { status: "RUNNING", browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, proxyUrl: proxyUrl || null, profileSnapshotId: ws.profileSnapshotId, templateId: ws.templateId, simulated: session.simulated },
    })
  } else {
    const session = await createNovncSession({ proxyUrl, ttlMinutes: ttl })
    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        novncSessionId: session.novncSessionId,
        novncSecret: encrypt(session.secret),
        novncConnCount: 0,
        freezeReason: null,
        crashCategory: null,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_RESTART",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { status: ws.status, novncSessionId: ws.novncSessionId },
      after: { status: "RUNNING", novncSessionId: session.novncSessionId, proxyUrl: proxyUrl || null, profileSnapshotId: ws.profileSnapshotId, templateId: ws.templateId, simulated: session.simulated },
    })
  }
}

export async function forceRestartWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await getWorkspace(id)
    try {
      await coreRestart(ctx, ws)
    } catch (e) {
      await db.browserWorkspace.update({ where: { id }, data: { status: "ERROR", crashCategory: "RESTART_FAILED" } })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "ADMIN_FORCE_RESTART",
        resourceType: "WORKSPACE",
        resourceId: ws.id,
        resourceName: ws.name,
        ownerUserId: ws.userId,
        createdByUserId: ws.createdByUserId,
        severity: "WARN",
        after: { status: "ERROR", crashCategory: "RESTART_FAILED", error: e instanceof Error ? e.message : String(e) },
      })
      throw new Error(`重建会话失败：${e instanceof Error ? e.message : String(e)}`)
    }
    return { id, status: "RUNNING" }
  })
}

// ============================================================
// 3. 强制移入回收站
// ============================================================
export async function forceRecycleWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await getWorkspace(id)
    const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
    await db.browserWorkspace.update({ where: { id }, data: { deletedAt: new Date(), status: "STOPPED", browserSessionId: null, cdpUrl: null, novncSessionId: null, startedAt: null, runtimeAccumSec: { increment: runtimeDelta } } })
    await moveToRecycle({
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: `管理员强制移入回收站（原状态 ${ws.status}）`,
      operatorName: ctx.username,
    })
    return { id }
  })
}

// ============================================================
// 4. 强制彻底物理删除（前置：销毁全部底层会话 + 关联数据清理）
// ============================================================
export async function forcePurgeWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    // 回收站中的工作区也允许物理清除（含软删记录）
    const ws = await db.browserWorkspace.findUnique({ where: { id } })
    if (!ws) throw new Error("工作区不存在")
    // 前置检查：同步销毁关联 VNC / 浏览器会话（尽力而为，失败不阻断库内清理）
    const destroyed: string[] = []
    if (ws.browserSessionId) {
      try {
        await destroySession(ws.browserSessionId)
        destroyed.push(`browser:${ws.browserSessionId}`)
      } catch { /* 会话可能已不存在 */ }
    }
    if (ws.novncSessionId) {
      try {
        await destroyNovncSession(ws.novncSessionId)
        destroyed.push(`novnc:${ws.novncSessionId}`)
      } catch { /* 会话可能已不存在 */ }
    }
    // 关联数据：共享授权同步删除
    await db.workspaceShare.deleteMany({ where: { workspaceId: id } })
    // 回收站残留条目同步清理（避免悬挂快照）
    await db.recycleBin.deleteMany({ where: { resourceType: "WORKSPACE", resourceId: id, restoredAt: null } })
    await db.browserWorkspace.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_PURGE",
      resourceType: "WORKSPACE",
      resourceId: id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "DANGER",
      before: { uuid: ws.uuid, name: ws.name, mode: ws.mode, status: ws.status, deletedAt: ws.deletedAt },
      after: { purged: true, destroyedSessions: destroyed, sharesRemoved: true },
    })
    await raiseAlert({
      title: "工作区被管理员彻底物理删除",
      level: "CRITICAL",
      content: `工作区 ${ws.name}（${ws.uuid}）被管理员 ${ctx.username} 强制物理删除，不可恢复`,
      resourceType: "WORKSPACE",
      resourceId: id,
      ownerUserId: ws.userId,
    })
    return { id }
  })
}

// ============================================================
// 5. 强制断开 VNC 全部客户端（实例保留）
// ============================================================
export async function forceDisconnectVncAction(input: unknown): Promise<ActionResult<{ id: string; clients: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await getWorkspace(id)
    if (ws.mode !== "novnc_full") throw new Error("仅 NoVNC 全功能模式工作区支持该操作")
    if (!ws.novncSessionId) throw new Error("该工作区当前没有活跃的 NoVNC 会话")
    await disconnectNovncClients(ws.novncSessionId)
    const updated = await db.browserWorkspace.update({ where: { id }, data: { novncConnCount: 0 } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_DISCONNECT_VNC",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { novncSessionId: ws.novncSessionId, novncConnCount: ws.novncConnCount },
      after: { novncConnCount: updated.novncConnCount, sessionKept: true },
    })
    return { id, clients: 0 }
  })
}

// ============================================================
// 6. 强制修改 TTL / 闲置超时
// ============================================================
export async function forceUpdateTtlAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId, ttlMinutes: zPrecision("TTL", 0, 525600), idleTimeoutMinutes: zPrecision("闲置超时", 1, 525600) }), input)
    const ws = await getWorkspace(p.id)
    const expireAt = p.ttlMinutes > 0 ? new Date(Date.now() + p.ttlMinutes * 60_000) : null
    const updated = await db.browserWorkspace.update({
      where: { id: p.id },
      data: { ttlMinutes: p.ttlMinutes, idleTimeoutMinutes: p.idleTimeoutMinutes, expireAt },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_FORCE_UPDATE_TTL",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { ttlMinutes: ws.ttlMinutes, idleTimeoutMinutes: ws.idleTimeoutMinutes, expireAt: ws.expireAt },
      after: { ttlMinutes: updated.ttlMinutes, idleTimeoutMinutes: updated.idleTimeoutMinutes, expireAt: updated.expireAt },
    })
    return { id: p.id }
  })
}

// ============================================================
// 7. 资源转移（所有者变更，创建人不变）
// ============================================================
export async function transferWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; newOwnerUserId: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId, targetUsername: zUsername }), input)
    const ws = await getWorkspace(p.id)
    const target = await db.user.findUnique({ where: { username: p.targetUsername } })
    if (!target || target.deletedAt) throw new Error("目标用户不存在")
    if (!target.enabled) throw new Error("目标用户已被禁用")
    if (target.frozen) throw new Error("目标用户已被冻结")
    if (target.id === ws.userId) throw new Error("目标用户已是该工作区所有者")
    const oldOwner = await db.user.findUnique({ where: { id: ws.userId }, select: { username: true } })
    const updated = await db.browserWorkspace.update({ where: { id: p.id }, data: { userId: target.id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "RESOURCE_TRANSFER",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: target.id,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { ownerUserId: ws.userId, ownerUsername: oldOwner?.username },
      after: { ownerUserId: updated.userId, ownerUsername: target.username },
    })
    return { id: p.id, newOwnerUserId: target.id }
  })
}

// ============================================================
// 批量强制操作（逐条 try/catch，全部审计 + 行为画像 BATCH）
// ============================================================
interface BatchResult {
  successCount: number
  failCount: number
  failures: { id: string; reason: string }[]
}

const batchSchema = z.object({
  ids: z.array(zId).min(1, "请选择工作区"),
  op: z.enum(["STOP", "RESTART", "RECYCLE", "PURGE", "TTL", "TRANSFER"]),
  ttlMinutes: zPrecision("TTL", 0, 525600).optional(),
  idleTimeoutMinutes: zPrecision("闲置超时", 1, 525600).optional(),
  targetUsername: zUsername.optional(),
})

export async function batchWorkspaceAction(input: unknown): Promise<ActionResult<BatchResult>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(batchSchema, input)
    if (p.op === "TTL" && (p.ttlMinutes === undefined || p.idleTimeoutMinutes === undefined)) throw new Error("批量修改 TTL 需要填写 TTL 与闲置超时")
    if (p.op === "TRANSFER" && !p.targetUsername) throw new Error("批量转移需要填写目标用户名")

    const failures: { id: string; reason: string }[] = []
    let successCount = 0
    for (const id of p.ids) {
      try {
        let res: { code: number; msg: string }
        if (p.op === "STOP") {
          res = await forceStopWorkspaceAction({ id })
        } else if (p.op === "RESTART") {
          res = await forceRestartWorkspaceAction({ id })
        } else if (p.op === "RECYCLE") {
          res = await forceRecycleWorkspaceAction({ id })
        } else if (p.op === "PURGE") {
          res = await forcePurgeWorkspaceAction({ id })
        } else if (p.op === "TTL") {
          res = await forceUpdateTtlAction({ id, ttlMinutes: p.ttlMinutes, idleTimeoutMinutes: p.idleTimeoutMinutes })
        } else {
          res = await transferWorkspaceAction({ id, targetUsername: p.targetUsername })
        }
        if (res.code !== 0) {
          failures.push({ id, reason: res.msg || "操作失败" })
        } else {
          successCount++
        }
      } catch (e) {
        failures.push({ id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await trackBehavior(ctx.userId, "BATCH")
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_WORKSPACE_BATCH",
      resourceType: "WORKSPACE",
      severity: p.op === "PURGE" ? "DANGER" : "WARN",
      extra: { op: p.op, ids: p.ids, successCount, failCount: failures.length, failures, ttlMinutes: p.ttlMinutes, idleTimeoutMinutes: p.idleTimeoutMinutes, targetUsername: p.targetUsername },
    })
    return { successCount, failCount: failures.length, failures }
  })
}

// ---- 沙箱级 VNC 会话时长策略（三级：沙箱 > 用户 > 用户组 > 全局默认；0=不限）----
// 语义：票据 60 秒时效 = 取票→建连窗口；本字段 = 连接总时长上限（到期服务端强制断开 + 客户端倒计时提示）
export async function setWorkspaceVncLimitAction(input: unknown): Promise<ActionResult<{ id: string; vncSessionMaxMinutes: number | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])
    const p = zodValidate(z.object({
      id: zId,
      vncSessionMaxMinutes: z.number().int().min(0).max(43200).nullable(), // null=继承用户/组，0=不限
    }), input)

    const ws = await db.browserWorkspace.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    // 组管理员范围校验
    if (ctx.role === "GROUP_ADMIN") {
      const { isGroupAdminOf } = await import("@/lib/permissions")
      if (!(await isGroupAdminOf(ctx.userId, ws.userId))) throw new Error("仅可管理本组成员的工作区")
    }

    const before = { vncSessionMaxMinutes: ws.vncSessionMaxMinutes }
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { vncSessionMaxMinutes: p.vncSessionMaxMinutes } })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKSPACE_VNC_LIMIT",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      before, after: { vncSessionMaxMinutes: p.vncSessionMaxMinutes }, severity: "WARN",
    })
    return { id: ws.id, vncSessionMaxMinutes: p.vncSessionMaxMinutes }
  })
}

// ============================================================
// r13c：企业级共享关系总列表管控（管理员侧）
// 精确到「共享给谁」的全生命周期管理：撤销单人 / 批量撤销 / 按工作区整批撤销 /
// 沙箱级禁共享否决开关（四级管控最高层）
// ============================================================

// ---- 撤销单个共享（精确移除某个被共享者的访问权） ----
export async function adminRevokeShareAction(input: unknown): Promise<ActionResult<{ shareId: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])
    const { shareId } = zodValidate(z.object({ shareId: zId }), input)

    const share = await db.workspaceShare.findUnique({ where: { id: shareId } })
    if (!share) throw new Error("共享记录不存在")
    if (share.revokedAt) throw new Error("该共享已被撤销，无需重复操作")
    const ws = await db.browserWorkspace.findUnique({ where: { id: share.workspaceId } })
    if (!ws) throw new Error("共享指向的工作区已不存在")

    // 组管理员范围校验（仅可撤销本组资源的共享）
    if (ctx.role === "GROUP_ADMIN") {
      const { isGroupAdminOf } = await import("@/lib/permissions")
      if (!(await isGroupAdminOf(ctx.userId, ws.userId)) && !(await isGroupAdminOf(ctx.userId, share.targetUserId))) {
        throw new Error("仅可管理本组成员相关的共享")
      }
    }

    const target = await db.user.findUnique({ where: { id: share.targetUserId }, select: { username: true } })
    await db.workspaceShare.update({ where: { id: shareId }, data: { revokedAt: new Date() } })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "ADMIN_SHARE_REVOKE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      before: { targetUser: target?.username || share.targetUserId, permission: share.permission, revoked: false },
      after: { targetUser: target?.username || share.targetUserId, permission: share.permission, revoked: true },
      severity: "WARN",
    })
    return { shareId }
  })
}

// ---- 批量撤销共享（勾选多条；返回成功/跳过计数） ----
export async function adminBatchRevokeSharesAction(input: unknown): Promise<ActionResult<{ revoked: number; skipped: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { shareIds } = zodValidate(z.object({ shareIds: z.array(zId).min(1).max(200) }), input)

    const shares = await db.workspaceShare.findMany({ where: { id: { in: shareIds } } })
    const todo = shares.filter((s) => !s.revokedAt)
    if (todo.length) {
      await db.workspaceShare.updateMany({ where: { id: { in: todo.map((s) => s.id) } }, data: { revokedAt: new Date() } })
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "ADMIN_SHARE_BATCH_REVOKE",
        resourceType: "WORKSPACE", resourceId: todo[0].workspaceId,
        after: { count: todo.length, shareIds: todo.map((s) => s.id) },
        severity: "WARN",
      })
    }
    return { revoked: todo.length, skipped: shares.length - todo.length }
  })
}

// ---- 按工作区整批撤销（一键断掉该工作区的全部共享；同时可选禁共享） ----
export async function adminRevokeAllWorkspaceSharesAction(input: unknown): Promise<ActionResult<{ revoked: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])
    const { workspaceId } = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.role === "GROUP_ADMIN") {
      const { isGroupAdminOf } = await import("@/lib/permissions")
      if (!(await isGroupAdminOf(ctx.userId, ws.userId))) throw new Error("仅可管理本组成员的工作区")
    }

    const r = await db.workspaceShare.updateMany({
      where: { workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "ADMIN_SHARE_REVOKE_ALL",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      after: { revoked: r.count }, severity: "WARN",
    })
    return { revoked: r.count }
  })
}

// ---- 沙箱级禁共享否决开关（四级管控最高优先级：开启后该工作区禁止任何新共享/链接） ----
export async function adminSetWorkspaceShareDisabledAction(input: unknown): Promise<ActionResult<{ id: string; shareDisabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])
    const { workspaceId, shareDisabled } = zodValidate(z.object({
      workspaceId: zId,
      shareDisabled: z.boolean(),
    }), input)

    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.role === "GROUP_ADMIN") {
      const { isGroupAdminOf } = await import("@/lib/permissions")
      if (!(await isGroupAdminOf(ctx.userId, ws.userId))) throw new Error("仅可管理本组成员的工作区")
    }

    await db.browserWorkspace.update({ where: { id: ws.id }, data: { shareDisabled } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKSPACE_SHARE_VETO",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      before: { shareDisabled: ws.shareDisabled }, after: { shareDisabled }, severity: "WARN",
    })
    return { id: ws.id, shareDisabled }
  })
}

// ============================================================
// r24-h：沙箱离线冻结封存（FROZEN）
// 语义（安全事件调查取证）：
//   · 进程立即停止（销毁底层会话 + 断开全部 VNC 连接）
//   · 冻结期间禁止 VNC 接入 / 浏览器启动 / CDP 控制 / 剪贴板中转（各入口 guard 拦截）
//   · Profile、CRX 策略、审计数据完整封存（不做任何清理）
//   · 可选自动解冻时间（expireAt）：到期由 frozen_expire_check 定时任务自动恢复为 STOPPED
//   · 管理员手动解冻随时可用
// ============================================================

const freezeSchema = z.object({
  id: zId,
  reason: z.string().min(4, "冻结原因至少 4 个字符").max(300),
  expireAt: z.string().datetime({ offset: true, message: "自动解冻时间必须为 ISO 时间" }).nullable().optional(), // null/缺省=无限期（仅手动解冻）
})

export async function freezeWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; status: string; frozenAt: string; expireAt: string | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(freezeSchema, input)
    const ws = await getWorkspace(p.id)

    if (ws.status === "FROZEN") throw new Error("工作区已处于冻结状态")
    if (ws.status === "DESTROYED") throw new Error("工作区已销毁，无法冻结")
    if (ws.status === "CREATING") throw new Error("工作区创建中，请稍后或先停止再冻结")

    const expire = p.expireAt ? new Date(p.expireAt) : null
    if (expire && expire.getTime() <= Date.now() + 60_000) {
      throw new Error("自动解冻时间必须晚于当前时间至少 1 分钟")
    }

    // 1. 进程立即停止：销毁底层会话 + 断开全部 VNC 客户端（尽力而为，失败不阻断冻结落库）
    const destroyed = await destroyUnderlying(ws).catch(() => [] as string[])
    if (ws.novncSessionId) await disconnectNovncClients(ws.id).catch(() => null)

    const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
    const updated = await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        status: "FROZEN",
        freezeReason: p.reason,
        expireAt: expire,
        // 会话/CDP 句柄清空（禁止接入与启动的关键字段位）；Profile/CRX 策略/审计全部保留
        browserSessionId: null,
        cdpUrl: null,
        novncSessionId: null,
        novncConnCount: 0,
        startedAt: null,
        runtimeAccumSec: { increment: runtimeDelta },
        lastActiveAt: new Date(),
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WORKSPACE_FREEZE",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { status: ws.status, mode: ws.mode },
      after: { status: "FROZEN", reason: p.reason, expireAt: expire?.toISOString() ?? null, destroyedSessions: destroyed },
    })
    await raiseAlert({
      title: "工作区被管理员离线冻结",
      level: "WARN",
      content: `工作区 ${ws.name}（${ws.uuid}）被管理员 ${ctx.username} 冻结封存：${p.reason}${expire ? `；将于 ${expire.toISOString()} 自动解冻` : "（无限期，需手动解冻）"}`,
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      ownerUserId: ws.userId,
      dedupeKey: `ws-freeze-${ws.id}`,
    })
    return { id: ws.id, status: updated.status, frozenAt: updated.updatedAt.toISOString(), expireAt: expire?.toISOString() ?? null }
  })
}

export async function unfreezeWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await getWorkspace(id)
    if (ws.status !== "FROZEN") throw new Error("工作区不在冻结状态")

    // 解冻后进入 STOPPED：所有者可随时重新启动（浏览器重新拉起）；封存数据原样保留
    const updated = await db.browserWorkspace.update({
      where: { id: ws.id },
      data: { status: "STOPPED", freezeReason: null, expireAt: null },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WORKSPACE_UNFREEZE",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      createdByUserId: ws.createdByUserId,
      severity: "INFO",
      before: { status: "FROZEN", freezeReason: ws.freezeReason, expireAt: ws.expireAt },
      after: { status: "STOPPED", manual: true },
    })
    return { id: ws.id, status: updated.status }
  })
}
