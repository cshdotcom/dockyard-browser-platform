import { db } from "./db"
import { sha256, decrypt, encrypt } from "./crypto"
import { getConfigNumber, getConfigBool } from "./config"
import { writeAudit } from "./audit"

// 回收站系统：全部删除禁止物理直删，先入回收站封存
// 支持锁定保护/恢复时效/到期物理清除/三种删除来源/恢复原UUID原配置

export interface RecyclableResource {
  resourceType: string // WORKSPACE | VNC_SESSION(并入WORKSPACE) | SINGBOX | API_TOKEN | TEMPLATE | FILE | SNAPSHOT | SCRIPT | PROXY_NODE ...
  resourceId: string
  resourceName?: string
  ownerUserId?: string | null
  createdByUserId?: string | null
}

// 软删除入回收站（保留 originalSnapshot 用于100%无损恢复）
export async function moveToRecycle(params: RecyclableResource & {
  deletedByUserId?: string | null
  deletedByType?: "USER" | "ADMIN" | "SYSTEM"
  reason?: string
  operatorName?: string
}) {
  // 抓取原始记录快照
  const tableMap: Record<string, string> = {
    WORKSPACE: "browserWorkspace",
    SINGBOX: "singboxInstance",
    API_TOKEN: "apiToken",
    TEMPLATE: "browserTemplate",
    SNAPSHOT: "browserProfileSnapshot",
    SCRIPT: "browserScriptTemplate",
    FILE: "fileMeta",
    PROXY_NODE: "proxyNode",
    BROWSER_NODE: "browserNode",
    HOST_NODE: "hostNode",
    GROUP: "group",
  }
  const modelName = tableMap[params.resourceType]
  let snapshot: Record<string, unknown> = {}
  if (modelName) {
    try {
      snapshot = await (db as unknown as Record<string, { findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown>> }>)[modelName].findUnique({
        where: { id: params.resourceId },
      })
    } catch {
      snapshot = {}
    }
  }

  const retentionMinutes = await getConfigNumber("recycle.retentionMinutes", 10080)
  const recoverWindowHours = await getConfigNumber("recycle.recoverWindowHours", 0)

  const entry = await db.recycleBin.create({
    data: {
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      resourceName: params.resourceName || (snapshot as { name?: string })?.name || null,
      ownerUserId: params.ownerUserId ?? ((snapshot as { userId?: string })?.userId ?? null),
      createdByUserId: params.createdByUserId ?? ((snapshot as { createdByUserId?: string })?.createdByUserId ?? null),
      deletedByUserId: params.deletedByUserId ?? null,
      deletedByType: params.deletedByType || "USER",
      reason: params.reason || null,
      originalSnapshot: JSON.stringify(snapshot || {}),
      purgeAt: new Date(Date.now() + retentionMinutes * 60_000),
      recoverDeadline: recoverWindowHours > 0 ? new Date(Date.now() + recoverWindowHours * 3600_000) : null,
    },
  })

  await writeAudit({
    operatorUserId: params.deletedByUserId || undefined,
    operatorName: params.operatorName,
    operationType: params.deletedByType === "ADMIN" ? "ADMIN_RECYCLE_MOVE" : "RECYCLE_MOVE",
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    resourceName: entry.resourceName ?? undefined,
    ownerUserId: params.ownerUserId ?? undefined,
    severity: params.deletedByType === "ADMIN" ? "WARN" : "INFO",
    after: { recycleId: entry.id, reason: params.reason, deletedByType: params.deletedByType },
  })

  return entry
}

// 用户恢复权限校验（全局开关 + 用户权限锁）
export async function canUserRestore(userId: string, entry: { ownerUserId: string | null }): Promise<boolean> {
  const globalEnabled = await getConfigBool("recycle.userRestoreEnabled", true)
  if (!globalEnabled) return false
  if (entry.ownerUserId !== userId) return false
  const { isPermissionLocked } = await import("./permissions")
  return !(await isPermissionLocked(userId, "blockRestoreRecycle"))
}

// 恢复：恢复原UUID/原配置/原创建时间（快照直接回写）
export async function restoreFromRecycle(recycleId: string, operator: { userId: string; username: string; role: string }): Promise<{ ok: boolean; message: string }> {
  const entry = await db.recycleBin.findUnique({ where: { id: recycleId } })
  if (!entry) return { ok: false, message: "回收站记录不存在" }
  if (entry.restoredAt) return { ok: false, message: "该资源已恢复" }
  if (entry.locked && operator.role !== "SUPER_ADMIN" && operator.role !== "ADMIN") {
    return { ok: false, message: "该资源已被管理员锁定保护，无法恢复" }
  }
  if (entry.recoverDeadline && entry.recoverDeadline < new Date()) {
    return { ok: false, message: "已超过恢复时效限制，无法恢复" }
  }

  const snapshot = JSON.parse(entry.originalSnapshot || "{}") as Record<string, unknown>
  const tableMap: Record<string, string> = {
    WORKSPACE: "browserWorkspace",
    SINGBOX: "singboxInstance",
    API_TOKEN: "apiToken",
    TEMPLATE: "browserTemplate",
    SNAPSHOT: "browserProfileSnapshot",
    SCRIPT: "browserScriptTemplate",
    FILE: "fileMeta",
    PROXY_NODE: "proxyNode",
    BROWSER_NODE: "browserNode",
    HOST_NODE: "hostNode",
    GROUP: "group",
    RECORDING: "vncRecording",
  }
  const modelName = tableMap[entry.resourceType]
  if (!modelName) return { ok: false, message: "未知资源类型" }

  const restoreData: Record<string, unknown> = { ...snapshot }
  delete restoreData.deletedAt // 清除软删除标记
  // 解密加密字段再重新加密（保持密文可用性）—— 快照里存的是密文，直接回写即可
  try {
    const model = (db as unknown as Record<string, { findUnique: (a: { where: { id: string } }) => Promise<Record<string, unknown> | null>; update: (a: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>; create: (a: { data: Record<string, unknown> }) => Promise<unknown> }>)[modelName]
    const existing = await model.findUnique({ where: { id: entry.resourceId } })
    if (existing) {
      // 记录仍存在（软删除状态）→ 更新恢复（r27 RECORDING：同时清物理清除计划）
      await model.update({ where: { id: entry.resourceId }, data: entry.resourceType === "RECORDING" ? { deletedAt: null, purgeAt: null, restoredAt: new Date() } : { deletedAt: null } })
    } else {
      // 记录已被物理清理 → 用快照原UUID重建
      await model.create({ data: restoreData })
    }
  } catch (e) {
    return { ok: false, message: `恢复失败：${e instanceof Error ? e.message : String(e)}` }
  }

  await db.recycleBin.update({ where: { id: recycleId }, data: { restoredAt: new Date() } })
  await writeAudit({
    operatorUserId: operator.userId,
    operatorName: operator.username,
    operationType: "RECYCLE_RESTORE",
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    resourceName: entry.resourceName ?? undefined,
    ownerUserId: entry.ownerUserId ?? undefined,
    after: { restored: true, originalIdPreserved: true },
  })
  return { ok: true, message: "恢复成功：原UUID/原配置/原创建时间已完整还原" }
}

// 物理清除（回收站到期/管理员清空）—— 真正的数据库硬删除
export async function purgeFromRecycle(recycleId: string, operator: { userId: string; username: string }): Promise<{ ok: boolean; message: string }> {
  const entry = await db.recycleBin.findUnique({ where: { id: recycleId } })
  if (!entry) return { ok: false, message: "记录不存在" }
  if (entry.locked) return { ok: false, message: "该资源已被锁定保护，禁止删除" }
  if (entry.restoredAt) {
    await db.recycleBin.delete({ where: { id: recycleId } })
    return { ok: true, message: "已恢复资源仅清理回收记录" }
  }

  const tableMap: Record<string, string> = {
    WORKSPACE: "browserWorkspace",
    SINGBOX: "singboxInstance",
    API_TOKEN: "apiToken",
    TEMPLATE: "browserTemplate",
    SNAPSHOT: "browserProfileSnapshot",
    SCRIPT: "browserScriptTemplate",
    FILE: "fileMeta",
    PROXY_NODE: "proxyNode",
    BROWSER_NODE: "browserNode",
    HOST_NODE: "hostNode",
    GROUP: "group",
    RECORDING: "vncRecording",
  }
  // r27：录像类型 → 文件 + 行 + 目录三级联清除（审计/回收记录随行清理）
  if (entry.resourceType === "RECORDING") {
    try {
      const { purgeRecordingRow } = await import("./recording")
      await purgeRecordingRow(entry.resourceId, { operatorUserId: operator.userId, operatorName: operator.username, fromRecycle: true })
    } catch { /* 行已不存在 → 仅清回收记录 */ }
  }
  const modelName = tableMap[entry.resourceType]
  if (modelName) {
    try {
      await (db as unknown as Record<string, { delete: (a: { where: { id: string } }) => Promise<unknown>; deleteMany: (a: { where: { id: string } }) => Promise<unknown> }>)[modelName].deleteMany({
        where: { id: entry.resourceId },
      })

    // r26：工作区物理清理级联业务行（审计永久保留，业务态随行清理）
    if (entry.resourceType === "WORKSPACE") {
      try {
        await db.crxInstallStatus.deleteMany({ where: { workspaceId: entry.resourceId } })
        await db.crxPolicyEntry.deleteMany({ where: { scopeType: "SANDBOX", scopeId: entry.resourceId } })
        await db.crxBlocklistEntry.deleteMany({ where: { scopeType: "SANDBOX", scopeId: entry.resourceId } })
        await db.workspaceShare.deleteMany({ where: { workspaceId: entry.resourceId } })
        await db.workspaceShareLink.deleteMany({ where: { workspaceId: entry.resourceId } })
        await db.harRecord.deleteMany({ where: { workspaceId: entry.resourceId } })
      } catch { /* 非关键：个别模型不存在时跳过 */ }
    }    } catch { /* 已不存在 */ }
  }
  await db.recycleBin.delete({ where: { id: recycleId } })
  await writeAudit({
    operatorUserId: operator.userId,
    operatorName: operator.username,
    operationType: "RECYCLE_PURGE",
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    severity: "WARN",
    after: { purged: true },
  })
  return { ok: true, message: "已彻底物理删除" }
}
