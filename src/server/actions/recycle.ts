"use server"

// 回收站管理（管理员）：恢复 / 物理清除 / 锁定解锁 / 延期 / 批量 / 一键清空全站
// 全部操作审计；物理删除不可恢复

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { restoreFromRecycle, purgeFromRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"

export interface BatchOutcome {
  successCount: number
  failCount: number
  failures: { id: string; reason: string }[]
}

// 锁定/解锁（锁定保护期间禁止自动过期删除/用户恢复/用户删除）
export async function toggleRecycleLockAction(input: unknown): Promise<ActionResult<{ id: string; locked: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const entry = await db.recycleBin.findUnique({ where: { id } })
    if (!entry) throw new Error("回收站记录不存在")
    const updated = await db.recycleBin.update({ where: { id }, data: { locked: !entry.locked } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: updated.locked ? "ADMIN_RECYCLE_LOCK" : "ADMIN_RECYCLE_UNLOCK",
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
      ownerUserId: entry.ownerUserId,
      createdByUserId: entry.createdByUserId,
      severity: "WARN",
      before: { locked: entry.locked },
      after: { locked: updated.locked },
    })
    return { id, locked: updated.locked }
  })
}

// 管理员恢复（restoreFromRecycle：原 UUID / 原配置 / 原创建时间完整还原）
export async function adminRestoreRecycleAction(input: unknown): Promise<ActionResult<{ id: string; message: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const entry = await db.recycleBin.findUnique({ where: { id } })
    if (!entry) throw new Error("回收站记录不存在")
    if (entry.restoredAt) throw new Error("该资源已恢复，请勿重复操作")
    const result = await restoreFromRecycle(id, { userId: ctx.userId, username: ctx.username, role: ctx.role })
    if (!result.ok) throw new Error(result.message)
    await trackBehavior(ctx.userId, "RESTORE")
    return { id, message: result.message }
  })
}

// 单条物理清除（purgeFromRecycle：真正的数据库硬删除）
export async function adminPurgeRecycleAction(input: unknown): Promise<ActionResult<{ id: string; message: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const entry = await db.recycleBin.findUnique({ where: { id } })
    if (!entry) throw new Error("回收站记录不存在")
    if (entry.locked) throw new Error("该条目已被锁定保护，请先解锁再清除")
    const result = await purgeFromRecycle(id, { userId: ctx.userId, username: ctx.username })
    if (!result.ok) throw new Error(result.message)
    await trackBehavior(ctx.userId, "DELETE")
    return { id, message: result.message }
  })
}

// 批量操作：RESTORE / PURGE / LOCK / UNLOCK / EXTEND（延期改 purgeAt）
const batchSchema = z.object({
  ids: z.array(zId).min(1, "请选择记录"),
  op: z.enum(["RESTORE", "PURGE", "LOCK", "UNLOCK", "EXTEND"]),
  purgeAt: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "时间格式不合法")
    .optional(),
})

export async function batchRecycleAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(batchSchema, input)
    if (p.op === "EXTEND" && !p.purgeAt) throw new Error("批量延期需要填写新的物理清除时间")

    const failures: { id: string; reason: string }[] = []
    let successCount = 0
    for (const id of p.ids) {
      try {
        if (p.op === "RESTORE") {
          const res = await adminRestoreRecycleAction({ id })
          if (res.code !== 0) throw new Error(res.msg)
        } else if (p.op === "PURGE") {
          const res = await adminPurgeRecycleAction({ id })
          if (res.code !== 0) throw new Error(res.msg)
        } else if (p.op === "LOCK" || p.op === "UNLOCK") {
          const entry = await db.recycleBin.findUnique({ where: { id } })
          if (!entry) throw new Error("记录不存在")
          const want = p.op === "LOCK"
          if (entry.locked !== want) {
            const res = await toggleRecycleLockAction({ id })
            if (res.code !== 0) throw new Error(res.msg)
          }
        } else {
          const entry = await db.recycleBin.findUnique({ where: { id } })
          if (!entry) throw new Error("记录不存在")
          await db.recycleBin.update({ where: { id }, data: { purgeAt: new Date(p.purgeAt as string) } })
          await writeAudit({
            operatorUserId: ctx.userId,
            operatorName: ctx.username,
            operationType: "ADMIN_RECYCLE_EXTEND",
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            resourceName: entry.resourceName,
            ownerUserId: entry.ownerUserId,
            createdByUserId: entry.createdByUserId,
            severity: "WARN",
            before: { purgeAt: entry.purgeAt },
            after: { purgeAt: new Date(p.purgeAt as string) },
          })
        }
        successCount++
      } catch (e) {
        failures.push({ id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await trackBehavior(ctx.userId, "BATCH")
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_RECYCLE_BATCH",
      resourceType: "RECYCLE_BIN",
      severity: p.op === "PURGE" ? "DANGER" : "WARN",
      extra: { op: p.op, ids: p.ids, successCount, failCount: failures.length, failures, purgeAt: p.purgeAt },
    })
    return { successCount, failCount: failures.length, failures }
  })
}

// 一键清空全站（强确认 requirePhrase="PURGE ALL" 在前端；此处仅处理未恢复且未锁定条目）
export async function purgeAllRecycleAction(): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const entries = await db.recycleBin.findMany({ where: { restoredAt: null, locked: false }, select: { id: true } })
    const failures: { id: string; reason: string }[] = []
    let successCount = 0
    for (const e of entries) {
      try {
        const res = await purgeFromRecycle(e.id, { userId: ctx.userId, username: ctx.username })
        if (!res.ok) throw new Error(res.message)
        successCount++
      } catch (err) {
        failures.push({ id: e.id, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    await trackBehavior(ctx.userId, "BATCH")
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ADMIN_RECYCLE_PURGE_ALL",
      resourceType: "RECYCLE_BIN",
      severity: "DANGER",
      extra: { total: entries.length, successCount, failCount: failures.length, failures },
    })
    return { successCount, failCount: failures.length, failures }
  })
}
