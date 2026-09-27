"use server"

// 工作区管控（管理员强制操作核心页）：停止/重启/回收/物理删除/断开VNC/改TTL/资源转移 + 全量批量
// 全部真实调用 Steel/NoVNC 外部适配器；审计记录 ownerUserId + createdByUserId

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId, zPrecision, zUsername } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, type AuthContext } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { moveToRecycle } from "@/lib/recycle"
import { encrypt } from "@/lib/crypto"
import { trackBehavior } from "@/lib/risk"
import { createSession, destroySession } from "@/lib/external/steel"
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
  steelNodeId: string | null
  templateId: string | null
  profileSnapshotId: string | null
  steelSessionId: string | null
  novncSessionId: string | null
  ttlMinutes: number
  idleTimeoutMinutes: number
  novncConnCount: number
  expireAt: Date | null
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
  if (ws.mode === "cdp_light" && ws.steelSessionId) {
    await destroySession(ws.steelSessionId)
    destroyed.push(`steel:${ws.steelSessionId}`)
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
    const updated = await db.browserWorkspace.update({
      where: { id },
      data: { status: "STOPPED", freezeReason: null, steelSessionId: null, cdpUrl: null, novncSessionId: null, novncConnCount: 0 },
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
      data: { status: "RUNNING", steelSessionId: session.sessionId, cdpUrl: session.cdpUrl, freezeReason: null, crashCategory: null },
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
      before: { status: ws.status, steelSessionId: ws.steelSessionId },
      after: { status: "RUNNING", steelSessionId: session.sessionId, cdpUrl: session.cdpUrl, proxyUrl: proxyUrl || null, profileSnapshotId: ws.profileSnapshotId, templateId: ws.templateId, simulated: session.simulated },
    })
  } else {
    const session = await createNovncSession({ proxyUrl, ttlMinutes: ttl })
    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        status: "RUNNING",
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
    await db.browserWorkspace.update({ where: { id }, data: { deletedAt: new Date(), status: "STOPPED", steelSessionId: null, cdpUrl: null, novncSessionId: null } })
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
    // 前置检查：同步销毁关联 VNC / Steel 会话（尽力而为，失败不阻断库内清理）
    const destroyed: string[] = []
    if (ws.steelSessionId) {
      try {
        await destroySession(ws.steelSessionId)
        destroyed.push(`steel:${ws.steelSessionId}`)
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
