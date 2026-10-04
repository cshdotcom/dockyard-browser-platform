"use server"

// ============================================================
// r28a：用户云盘 /files 专属 Server Actions
//   · userDeleteFileAction —— 用户删除自己云盘文件（软删 + 回收站 owner=本人）
//   · saveFileTextAction   —— 纯文本在线编辑保存（写盘 + 审计 FILE_EDIT + size/checksum 更新）
//
// 安全基线（每个 Action 均强制）：
//   · requireAuth + requireWritableMode
//   · userId 归属校验（仅能操作 userId === ctx.userId 的文件 —— /files 是"我的云盘"视图）
//   · PROFILE / BACKUP 类文件禁止用户删除/编辑（浏览器 Profile 绝不暴露）
//   · storageKey 路径穿越防护（resolve 后必须落在 ENV.storageLocalPath 内）
//   · 审计 writeAudit（operationType 大写蛇形）
// ============================================================

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAuth } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { moveToRecycle } from "@/lib/recycle"
import { bizError, ErrorCode } from "@/lib/errors"
import { sha256 } from "@/lib/crypto"

const TEXT_EDIT_MAX_BYTES = 1024 * 1024 // 1MB

// ---- 1. 用户删除（批量；软删除 + 入回收站，回收站归属=用户自己） ----

const userDeleteSchema = z.object({
  fileIds: z.array(zId).min(1, "请选择要删除的文件").max(100, "单次最多删除 100 个文件"),
  reason: z.string().max(200).optional(),
})

// 删除前备份（storage.backupOnDelete 开启时复制到 storage/backups/deleted/；与管理端 deleteFileAction 同语义）
async function backupBeforeDelete(file: { fileName: string; storageKey: string }): Promise<string | null> {
  try {
    const { getConfigBool } = await import("@/lib/config")
    if (!(await getConfigBool("storage.backupOnDelete", false))) return null
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
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

export async function userDeleteFileAction(
  input: unknown
): Promise<ActionResult<{ deleted: number; failed: Array<{ id: string; fileName: string; msg: string }> }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(userDeleteSchema, input)

    // recycle.requireReason 开启时强制填写删除原因
    const { getConfigBool } = await import("@/lib/config")
    if (await getConfigBool("recycle.requireReason", false)) {
      if (!p.reason || p.reason.trim().length < 2) {
        throw bizError(ErrorCode.PARAM_ERROR, "管理员已开启「删除强制备注原因」：请填写至少2个字符的删除原因")
      }
    }

    const files = await db.fileMeta.findMany({ where: { id: { in: p.fileIds }, deletedAt: null } })
    const byId = new Map(files.map((f) => [f.id, f]))

    const deleted: string[] = []
    const failed: Array<{ id: string; fileName: string; msg: string }> = []

    for (const id of p.fileIds) {
      const file = byId.get(id)
      if (!file) {
        failed.push({ id, fileName: id, msg: "文件不存在或已删除" })
        continue
      }
      // 归属校验：/files 是"我的云盘"视图 —— 仅能删除自己的文件（管理员也不例外，管理端走 admin/files）
      if (file.userId !== ctx.userId) {
        failed.push({ id, fileName: file.fileName, msg: "只能删除自己云盘中的文件" })
        continue
      }
      // 安全要求：浏览器 Profile / 数据库备份绝不开放用户删除
      if (file.category === "PROFILE" || file.category === "BACKUP") {
        failed.push({ id, fileName: file.fileName, msg: "该类型文件不允许在个人云盘中删除" })
        continue
      }

      const backupPath = await backupBeforeDelete(file)
      await db.fileMeta.update({ where: { id: file.id }, data: { deletedAt: new Date() } })
      await moveToRecycle({
        resourceType: "FILE",
        resourceId: file.id,
        resourceName: file.fileName,
        ownerUserId: file.userId, // 回收站归属 = 用户自己（可在回收站内恢复）
        createdByUserId: file.createdByUserId,
        deletedByUserId: ctx.userId,
        deletedByType: "USER",
        reason: p.reason || "用户云盘删除",
        operatorName: ctx.username,
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "FILE_DELETE",
        resourceType: "FILE",
        resourceId: file.id,
        resourceName: file.fileName,
        ownerUserId: file.userId,
        before: { fileName: file.fileName, size: file.size, category: file.category, storageKey: file.storageKey },
        after: { deleted: true, deletedByType: "USER", reason: p.reason || "用户云盘删除", backupPath },
        severity: "WARN",
      })
      deleted.push(file.id)
    }

    if (deleted.length === 0) {
      throw bizError(ErrorCode.PARAM_ERROR, failed[0]?.msg || "没有可删除的文件")
    }
    return { deleted: deleted.length, failed }
  })
}

// ---- 2. 纯文本在线编辑保存 ----

const saveTextSchema = z.object({
  fileId: zId,
  content: z.string().max(TEXT_EDIT_MAX_BYTES, "内容超出 1MB 编辑上限"),
})

export async function saveFileTextAction(
  input: unknown
): Promise<ActionResult<{ fileId: string; size: number; checksum: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(saveTextSchema, input)

    const file = await db.fileMeta.findFirst({ where: { id: p.fileId, deletedAt: null } })
    if (!file) throw bizError(ErrorCode.NOT_FOUND, "文件不存在或已删除")
    if (file.userId !== ctx.userId) throw bizError(ErrorCode.FORBIDDEN, "只能编辑自己云盘中的文件")
    if (file.category === "PROFILE" || file.category === "BACKUP") {
      throw bizError(ErrorCode.FORBIDDEN, "该类型文件不允许在线编辑")
    }

    // 可编辑类型：纯文本族 + SVG（源码即文本）
    const { isTextEditable } = await import("@/lib/preview-kind")
    if (!isTextEditable(file.mime, file.fileName)) {
      throw bizError(ErrorCode.PARAM_ERROR, "仅纯文本类文件（txt/md/csv/json/代码/svg 等）支持在线编辑")
    }

    const bytes = Buffer.byteLength(p.content, "utf8")
    if (bytes > TEXT_EDIT_MAX_BYTES) throw bizError(ErrorCode.PARAM_ERROR, "内容超出 1MB 编辑上限")

    // 路径穿越防护：归一化后必须落在存储根内
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    const { ENV } = await import("@/lib/env")
    const root = path.resolve(ENV.storageLocalPath)
    const target = path.resolve(root, file.storageKey)
    if (!target.startsWith(root + path.sep)) {
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "FILE_EDIT",
        resourceType: "FILE",
        resourceId: file.id,
        resourceName: file.fileName,
        severity: "DANGER",
        after: { storageKey: file.storageKey, blocked: "path-traversal" },
      })
      throw bizError(ErrorCode.FORBIDDEN, "非法的文件路径")
    }

    await fs.writeFile(target, p.content, "utf8")

    const checksum = sha256(p.content)
    await db.fileMeta.update({ where: { id: file.id }, data: { size: bytes, checksum } })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_EDIT",
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      ownerUserId: file.userId,
      before: { size: file.size, checksum: file.checksum },
      after: { size: bytes, checksum, bytesDelta: bytes - file.size, lines: p.content.split("\n").length },
      severity: "INFO",
    })

    return { fileId: file.id, size: bytes, checksum }
  })
}
