"use server"

// 公告管理 Server Actions：创建 / 编辑 / 启停 / 删除
// 说明：Announcement 模型无 deletedAt 字段（schema 不可改动），按规格"公告不进回收站"：
// 删除采用物理删除 + 全量快照审计（快照含全部字段，可追溯重建）。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"

const zAnnType = z.enum(["GLOBAL", "GROUP", "USER"])
const zDisplayType = z.enum(["POPUP", "MARQUEE", "FORCE_VIEW"])

const announcementSchema = z.object({
  id: zId.optional(),
  title: z.string().min(1, "标题必填").max(100),
  content: z.string().min(1, "内容必填").max(5000),
  type: zAnnType,
  groupId: zId.optional().or(z.literal("").transform(() => undefined)),
  userId: zId.optional().or(z.literal("").transform(() => undefined)),
  displayType: zDisplayType,
  enabled: z.boolean(),
})

export async function upsertAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(announcementSchema, input)

    // 范围校验：GROUP 必须选择组；USER 必须指定用户；GLOBAL 清空范围
    if (p.type === "GROUP") {
      if (!p.groupId) throw bizError(ErrorCode.PARAM_ERROR, "组范围公告必须选择目标用户组")
      const group = await db.group.findFirst({ where: { id: p.groupId, deletedAt: null } })
      if (!group) throw bizError(ErrorCode.NOT_FOUND, "目标用户组不存在或已删除")
    }
    if (p.type === "USER") {
      if (!p.userId) throw bizError(ErrorCode.PARAM_ERROR, "用户范围公告必须选择目标用户")
      const user = await db.user.findFirst({ where: { id: p.userId, deletedAt: null } })
      if (!user) throw bizError(ErrorCode.NOT_FOUND, "目标用户不存在或已删除")
    }
    if (p.type === "GLOBAL" && (p.groupId || p.userId)) {
      throw bizError(ErrorCode.PARAM_ERROR, "全站公告不需要指定范围")
    }

    const data = {
      title: p.title,
      content: p.content,
      type: p.type,
      groupId: p.type === "GROUP" ? p.groupId! : null,
      userId: p.type === "USER" ? p.userId! : null,
      displayType: p.displayType,
      enabled: p.enabled,
    }

    if (p.id) {
      const before = await db.announcement.findUnique({ where: { id: p.id } })
      if (!before) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")
      const ann = await db.announcement.update({ where: { id: p.id }, data })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "ANNOUNCEMENT_UPDATE",
        resourceType: "ANNOUNCEMENT",
        resourceId: ann.id,
        resourceName: ann.title,
        before: { title: before.title, content: before.content, type: before.type, groupId: before.groupId, userId: before.userId, displayType: before.displayType, enabled: before.enabled },
        after: { title: p.title, content: p.content, type: p.type, groupId: data.groupId, userId: data.userId, displayType: p.displayType, enabled: p.enabled },
      })
      return { id: ann.id }
    }

    const ann = await db.announcement.create({ data: { ...data, createdByUserId: ctx.userId } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_CREATE",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      after: { title: p.title, content: p.content, type: p.type, groupId: data.groupId, userId: data.userId, displayType: p.displayType, enabled: p.enabled },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { id: ann.id }
  })
}

const toggleSchema = z.object({ id: zId, enabled: z.boolean() })

export async function toggleAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(toggleSchema, input)
    const ann = await db.announcement.findUnique({ where: { id: p.id } })
    if (!ann) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")
    if (ann.enabled === p.enabled) return { id: ann.id, enabled: ann.enabled }
    await db.announcement.update({ where: { id: ann.id }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_TOGGLE",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      before: { enabled: ann.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: ann.id, enabled: p.enabled }
  })
}

export async function deleteAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const ann = await db.announcement.findUnique({ where: { id: p.id } })
    if (!ann) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")

    // 全量快照（审计留痕可追溯重建） + 清理已读记录 + 物理删除
    const readCount = await db.announcementRead.count({ where: { announcementId: ann.id } })
    await db.announcementRead.deleteMany({ where: { announcementId: ann.id } })
    await db.announcement.delete({ where: { id: ann.id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_DELETE",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      before: {
        title: ann.title,
        content: ann.content,
        type: ann.type,
        groupId: ann.groupId,
        userId: ann.userId,
        displayType: ann.displayType,
        enabled: ann.enabled,
        createdByUserId: ann.createdByUserId,
        readCount,
      },
      after: { deleted: true, physical: true },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { id: ann.id }
  })
}
