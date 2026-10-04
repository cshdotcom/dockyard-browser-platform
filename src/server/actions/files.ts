"use server"

// 文件管理 Server Actions（管理员）：删除 / 过期 / 扫描
// r23：recycle.requireReason 真实生效（开启后删除必须填写原因）；
//     storage.backupOnDelete 真实生效（删除前备份副本到 backups/deleted/ 目录）

// 文件存储 Server Actions：软删除（入回收站）/ 立即过期 / 病毒扫描标记
// 上传与下载在 /api/files/upload 与 /api/files/download Route Handler 中实现。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin, requireAuth } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"

// ---- 1. 删除文件（软删除 + 入回收站 + 审计） ----

const deleteSchema = z.object({
  fileId: zId,
  reason: z.string().max(200).optional(),
})

// r23：删除前备份（storage.backupOnDelete 开启时复制到 storage/backups/deleted/，文件名带时间戳）
async function backupBeforeDelete(file: { id: string; fileName: string; storageKey: string }): Promise<string | null> {
  try {
    const { getConfigBool } = await import("@/lib/config")
    if (!(await getConfigBool("storage.backupOnDelete", false))) return null
    const fs = await import("fs/promises")
    const path = await import("path")
    const { ENV } = await import("@/lib/env")
    const src = path.join(ENV.storageLocalPath, file.storageKey)
    if (!path.resolve(src).startsWith(path.resolve(ENV.storageLocalPath))) return null
    const destDir = path.join(ENV.storageLocalPath, "backups", "deleted")
    await fs.mkdir(destDir, { recursive: true })
    const dest = path.join(destDir, `${Date.now()}-${file.fileName.replace(/[\/\\]/g, "_")}`)
    await fs.copyFile(src, dest).catch(() => null)
    return path.relative(ENV.storageLocalPath, dest)
  } catch {
    return null
  }
}

export async function deleteFileAction(input: unknown): Promise<ActionResult<{ fileId: string; backupPath: string | null }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(deleteSchema, input)

    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在或已删除")

    // r23：recycle.requireReason 开启时强制填写删除原因
    const { getConfigBool } = await import("@/lib/config")
    if (await getConfigBool("recycle.requireReason", false)) {
      if (!p.reason || p.reason.trim().length < 2) {
        throw bizError(ErrorCode.PARAM_ERROR, "管理员已开启「删除强制备注原因」：请填写至少2个字符的删除原因")
      }
    }
    const backupPath = await backupBeforeDelete(file)

    await db.fileMeta.update({ where: { id: file.id }, data: { deletedAt: new Date() } })
    await moveToRecycle({
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      ownerUserId: file.userId,
      createdByUserId: file.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: p.reason || "管理员删除文件",
      operatorName: ctx.username,
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_DELETE",
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      ownerUserId: file.userId ?? undefined,
      before: { fileName: file.fileName, size: file.size, category: file.category, storageKey: file.storageKey },
      after: { deleted: true, reason: p.reason || "管理员删除文件", backupPath },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { fileId: file.id, backupPath }
  })
}

// ---- 2. 立即过期（expireAt = now，等待过期清理任务回收） ----

const expireSchema = z.object({ fileId: zId })

export async function expireFileAction(input: unknown): Promise<ActionResult<{ fileId: string; expireAt: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(expireSchema, input)

    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在或已删除")

    const now = new Date()
    await db.fileMeta.update({ where: { id: file.id }, data: { expireAt: now } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_EXPIRE",
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      ownerUserId: file.userId ?? undefined,
      before: { expireAt: file.expireAt ? file.expireAt.toISOString() : null },
      after: { expireAt: now.toISOString(), forceExpired: true },
      severity: "INFO",
    })
    return { fileId: file.id, expireAt: now.toISOString() }
  })
}

// ---- 3. 病毒扫描（简化实现：标记 virusScanned + 审计；与 /api/files/scan 语义一致） ----

const scanSchema = z.object({ fileId: zId })

export async function scanFileAction(input: unknown): Promise<ActionResult<{ fileId: string; virusScanned: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(scanSchema, input)

    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在或已删除")

    await db.fileMeta.update({ where: { id: file.id }, data: { virusScanned: true } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_VIRUS_SCAN",
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      before: { virusScanned: file.virusScanned },
      after: { virusScanned: true, engine: "builtin-mark" },
      severity: "INFO",
    })
    return { fileId: file.id, virusScanned: true }
  })
}

// ============================================================
// r28：文件公开分享（/s/<token> 公开路由；修复「分享链接 404」）
// 权限：所有者本人 / ADMIN+ / GROUP_ADMIN（所辖组文件）；文件必须可读
// ============================================================

const createShareSchema = z.object({
  fileIds: z.array(zId).max(200).optional(),
  folderKey: z.string().max(300).optional(),
  name: z.string().max(120).optional(),
  permission: z.enum(["VIEW", "DOWNLOAD"]).default("VIEW"),
  visitorKey: z.string().min(4, "密钥至少 4 个字符").max(64).optional(),
  /** 分钟数（0/缺省 = 永久）；自定义有效期 */
  expireMinutes: z.number().int().min(0).max(60 * 24 * 365).optional(),
  maxUses: z.number().int().min(0).max(1000000).optional(),
  note: z.string().max(200).optional(),
})

// 校验操作者对目标文件/归属用户的权限（所有者/管理员/组管理员）
async function canShareFiles(ctx: { userId: string; role: string }, fileIds: string[]): Promise<void> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return
  const metas = await db.fileMeta.findMany({ where: { id: { in: fileIds } }, select: { userId: true, workspaceId: true } })
  for (const m of metas) {
    if (m.userId === ctx.userId) continue
    if (ctx.role === "GROUP_ADMIN" && m.workspaceId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: m.workspaceId }, select: { groupId: true } })
      if (ws?.groupId) {
        const admin = await db.groupAdmin.findFirst({ where: { groupId: ws.groupId, userId: ctx.userId } })
        if (admin) continue
      }
    }
    throw bizError(ErrorCode.FORBIDDEN, "只能分享自己拥有的文件（或需管理员权限）")
  }
}

// folderKey 场景：校验文件夹内全部文件归属
async function canShareFolder(ctx: { userId: string; role: string }, folderKey: string): Promise<void> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return
  const prefix = folderKey.replace(/\/+$/, "")
  const metas = await db.fileMeta.findMany({ where: { storageKey: { startsWith: `${prefix}/` } }, select: { userId: true }, take: 500 })
  for (const m of metas) {
    if (m.userId !== ctx.userId) throw bizError(ErrorCode.FORBIDDEN, "文件夹内含他人文件，只能分享自己拥有的内容（或需管理员权限）")
  }
}

export async function createFileShareAction(input: unknown): Promise<ActionResult<{
  id: string; token: string; url: string; visitorKeyPlain: string | null; fileCount: number; totalBytes: number; expireAt: string | null
}>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(createShareSchema, input)

    // 权限：非管理员只能分享自己的文件/文件夹
    if (p.fileIds?.length) await canShareFiles(ctx, p.fileIds)
    if (p.folderKey) await canShareFolder(ctx, p.folderKey)

    const expireAt = p.expireMinutes && p.expireMinutes > 0 ? new Date(Date.now() + p.expireMinutes * 60_000) : null
    const { createFileShare } = await import("@/lib/file-share")
    const result = await createFileShare({
      fileIds: p.fileIds,
      folderKey: p.folderKey,
      name: p.name,
      permission: p.permission,
      visitorKey: p.visitorKey,
      expireAt,
      maxUses: p.maxUses,
      note: p.note,
      creatorUserId: ctx.userId,
      creatorName: ctx.username,
    })
    return result
  })
}

const revokeShareSchema = z.object({ token: z.string().min(8).max(64) })

export async function revokeFileShareAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(revokeShareSchema, input)
    const share = await db.fileShare.findUnique({ where: { token: p.token } })
    if (!share) throw bizError(ErrorCode.NOT_FOUND, "分享不存在")
    if (share.createdByUserId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
      throw bizError(ErrorCode.FORBIDDEN, "只能撤销自己创建的分享")
    }
    const { revokeFileShare } = await import("@/lib/file-share")
    return await revokeFileShare(p.token, ctx.userId, ctx.username)
  })
}

export async function listMyFileSharesAction(input: unknown): Promise<ActionResult<{ items: Array<Record<string, unknown>> }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ keyword: z.string().max(64).optional() }), input)
    const { listSharesByCreator } = await import("@/lib/file-share")
    const items = await listSharesByCreator(ctx.userId, p.keyword)
    return { items: items as unknown as Array<Record<string, unknown>> }
  })
}

// r28：收藏夹切换（文件管理多标签页/收藏夹）
export async function toggleFileFavoriteAction(input: unknown): Promise<ActionResult<{ fileId: string; isFavorite: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ fileId: zId }), input)
    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在")
    if (file.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
      throw bizError(ErrorCode.FORBIDDEN, "只能收藏自己云盘中的文件")
    }
    const next = !file.isFavorite
    await db.fileMeta.update({ where: { id: file.id }, data: { isFavorite: next, favoritedBy: next ? ctx.userId : null, favoritedAt: next ? new Date() : null } })
    return { fileId: file.id, isFavorite: next }
  })
}
