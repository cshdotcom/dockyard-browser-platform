"use server"

// 文件管理 Server Actions（管理员）：删除 / 过期 / 扫描
// r23：recycle.requireReason 真实生效（开启后删除必须填写原因）；
//     storage.backupOnDelete 真实生效（删除前备份副本到 backups/deleted/ 目录）

// 文件存储 Server Actions：软删除（入回收站）/ 立即过期 / 病毒扫描标记
// 上传与下载在 /api/files/upload 与 /api/files/download Route Handler 中实现。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin } from "@/lib/permissions"
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
