"use server"

// 浏览器配置快照（用户侧）：从运行中的 CDP 工作区导出 profile
// 创建（浏览器 Profile 打包导出 → fileMeta + BrowserProfileSnapshot）/ 删除 / 设置过期时间 / 重命名
// 权限锁：blockDeleteResource / blockModifyResourceExpiry

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth, requirePermission, requireWritableMode } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"
import { exportProfile } from "@/lib/external/browser-session"
import { bizError, ErrorCode } from "@/lib/errors"

// 归属校验：仅快照所有者可操作（共享快照只允许查看）
async function assertOwnSnapshot(userId: string, snapshotId: string) {
  const snap = await db.browserProfileSnapshot.findFirst({ where: { id: snapshotId, deletedAt: null } })
  if (!snap) throw bizError(ErrorCode.NOT_FOUND, "快照不存在或已删除")
  if (snap.userId !== userId) throw bizError(ErrorCode.FORBIDDEN, "只能操作自己的快照")
  return snap
}

export async function createSnapshotAction(input: unknown): Promise<ActionResult<{ id: string; storageKey: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(
      z.object({
        workspaceId: zId,
        name: z.string().min(1, "快照名称必填").max(100),
      }),
      input
    )

    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null } })
    if (!ws || ws.userId !== ctx.userId) throw bizError(ErrorCode.NOT_FOUND, "工作区不存在或无权访问")
    if (ws.mode !== "cdp_light") {
      throw bizError(ErrorCode.PARAM_ERROR, "仅 CDP 轻量模式工作区支持导出配置快照")
    }
    if (ws.status !== "RUNNING") {
      throw bizError(ErrorCode.RESOURCE_IN_USE, `工作区当前状态为 ${ws.status}，仅运行中可创建快照`)
    }
    if (!ws.browserSessionId) throw bizError(ErrorCode.RESOURCE_IN_USE, "工作区缺少 浏览器会话标识，无法导出")

    // 打包导出浏览器 Profile → archiveKey
    const exported = await exportProfile(ws.browserSessionId)
    if (!exported) throw bizError(ErrorCode.EXTERNAL_SERVICE, "浏览器 Profile 导出失败，请稍后重试")

    // 模拟导出时使用估算大小，真实导出按归档实际占用统计入口在文件模块
    const sizeBytes = exported.simulated ? 524288 : 0

    const file = await db.fileMeta.create({
      data: {
        fileName: `${p.name}.tar.gz`,
        storageKey: exported.archiveKey,
        size: sizeBytes,
        mime: "application/gzip",
        category: "SNAPSHOT",
        userId: ctx.userId,
        workspaceId: ws.id,
        createdByUserId: ctx.userId,
      },
    })

    const snap = await db.browserProfileSnapshot.create({
      data: {
        name: p.name,
        scope: "PRIVATE",
        userId: ctx.userId,
        groupId: null,
        workspaceId: ws.id,
        sizeBytes,
        storageKey: exported.archiveKey,
        createdByUserId: ctx.userId,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SNAPSHOT_CREATE",
      resourceType: "SNAPSHOT",
      resourceId: snap.id,
      resourceName: snap.name,
      ownerUserId: ctx.userId,
      after: {
        name: p.name,
        workspaceId: ws.id,
        workspaceName: ws.name,
        storageKey: exported.archiveKey,
        sizeBytes,
        fileMetaId: file.id,
        simulated: exported.simulated,
      },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { id: snap.id, storageKey: exported.archiveKey }
  })
}

export async function deleteSnapshotAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockDeleteResource", "删除资源已被权限锁禁止")
    const p = zodValidate(z.object({ id: zId, reason: z.string().max(200).optional() }), input)

    const snap = await assertOwnSnapshot(ctx.userId, p.id)

    await db.browserProfileSnapshot.update({ where: { id: snap.id }, data: { deletedAt: new Date() } })
    await moveToRecycle({
      resourceType: "SNAPSHOT",
      resourceId: snap.id,
      resourceName: snap.name,
      ownerUserId: snap.userId,
      createdByUserId: snap.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "USER",
      reason: p.reason || "用户删除快照",
      operatorName: ctx.username,
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SNAPSHOT_DELETE",
      resourceType: "SNAPSHOT",
      resourceId: snap.id,
      resourceName: snap.name,
      ownerUserId: snap.userId,
      before: { name: snap.name, scope: snap.scope, sizeBytes: snap.sizeBytes, expireAt: snap.expireAt?.toISOString() ?? null },
      after: { deleted: true, softDeleted: true },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { id: snap.id }
  })
}

export async function setSnapshotExpireAction(input: unknown): Promise<ActionResult<{ id: string; expireAt: string | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockModifyResourceExpiry", "修改资源有效期已被权限锁禁止")
    const p = zodValidate(
      z.object({
        id: zId,
        // null / "" = 清除过期时间（永不过期）；否则为 ISO 时间字符串
        expireAtIso: z.string().nullable().optional(),
      }),
      input
    )

    const snap = await assertOwnSnapshot(ctx.userId, p.id)

    let expireAt: Date | null = null
    if (p.expireAtIso) {
      expireAt = new Date(p.expireAtIso)
      if (Number.isNaN(expireAt.getTime())) throw bizError(ErrorCode.PARAM_ERROR, "过期时间格式非法")
      if (expireAt.getTime() <= Date.now()) throw bizError(ErrorCode.PARAM_ERROR, "过期时间必须晚于当前时间")
    }

    await db.browserProfileSnapshot.update({ where: { id: snap.id }, data: { expireAt } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SNAPSHOT_EXPIRE_UPDATE",
      resourceType: "SNAPSHOT",
      resourceId: snap.id,
      resourceName: snap.name,
      ownerUserId: snap.userId,
      before: { expireAt: snap.expireAt?.toISOString() ?? null },
      after: { expireAt: expireAt?.toISOString() ?? null },
    })
    return { id: snap.id, expireAt: expireAt?.toISOString() ?? null }
  })
}

export async function renameSnapshotAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(
      z.object({
        id: zId,
        name: z.string().min(1, "名称必填").max(100),
      }),
      input
    )

    const snap = await assertOwnSnapshot(ctx.userId, p.id)
    if (snap.name === p.name) return { id: snap.id }

    await db.browserProfileSnapshot.update({ where: { id: snap.id }, data: { name: p.name } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "SNAPSHOT_RENAME",
      resourceType: "SNAPSHOT",
      resourceId: snap.id,
      resourceName: p.name,
      ownerUserId: snap.userId,
      before: { name: snap.name },
      after: { name: p.name },
    })
    return { id: snap.id }
  })
}
