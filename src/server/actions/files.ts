"use server"

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

export async function deleteFileAction(input: unknown): Promise<ActionResult<{ fileId: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(deleteSchema, input)

    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在或已删除")

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
      after: { deleted: true, reason: p.reason || "管理员删除文件" },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { fileId: file.id }
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
