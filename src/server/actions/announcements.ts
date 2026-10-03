"use server"

// 公告管理 Server Actions：创建 / 编辑 / 启停 / 删除
// 说明：Announcement 模型无 deletedAt 字段（schema 不可改动），按规格"公告不进回收站"：
// 删除采用物理删除 + 全量快照审计（快照含全部字段，可追溯重建）。
// r15 升级：内容支持 Markdown/HTML 双格式（渲染侧 react-markdown + rehype-raw/sanitize）；
// 发布通道多选：展示方式（POPUP/MARQUEE/FORCE_VIEW 可组合）+ 站内信（Notice 通知铃）可叠加或单独发送。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"
import { announcementGroupIds, announcementUserIds } from "@/lib/announcement-targets"

const zAnnType = z.enum(["GLOBAL", "GROUP", "USER"])
const zDisplayType = z.enum(["POPUP", "MARQUEE", "FORCE_VIEW"])

// r30：范围多选 —— 用户组与用户均可多选（上限 100 防误选全库）
const announcementSchema = z.object({
  id: zId.optional(),
  title: z.string().min(1, "标题必填").max(100),
  content: z.string().min(1, "内容必填").max(5000),
  type: zAnnType,
  groupId: zId.optional().or(z.literal("").transform(() => undefined)), // 兼容旧单选调用
  userId: zId.optional().or(z.literal("").transform(() => undefined)), // 兼容旧单选调用
  groupIds: z.array(zId).max(100).optional(), // r30：目标用户组多选
  userIds: z.array(zId).max(100).optional(), // r30：目标用户多选（可与组混合）
  displayType: zDisplayType.optional(), // 兼容旧调用（单值）
  displayTypes: z.array(zDisplayType).max(3).optional(), // 多选展示方式（可与站内信叠加）
  notifyInbox: z.boolean().optional().default(false), // 站内信通道（可单独发送或与展示方式叠加）
  startAt: z.string().max(40).optional().or(z.literal("")), // 显示开始时间（datetime-local ISO；空=立即显示）
  endAt: z.string().max(40).optional().or(z.literal("")), // 结束时间（空=永久；过期后不再展示）
  persistAfterRead: z.boolean().optional().default(false), // 已读后仍持续显示（弹窗每次刷新仍弹，除非今日不再提醒）
  allowDismiss: z.boolean().optional().default(true), // 允许用户勾选「今日不再提醒」（管理员可控）
  enabled: z.boolean(),
})

// datetime-local 字符串 → Date（非法输入按 null 处理，不影响保存）
function parseDate(v: string | undefined | null): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// ---- 站内信正文摘要：MD/HTML → 纯文本（防语法泄漏到通知铃） ----
function contentSummary(content: string, maxLen = 160): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|#-]+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
}

// ---- 站内信投递（幂等：notifiedAt 置位后永不重发） ----
async function fanOutInboxNotices(
  ann: {
    id: string
    title: string
    content: string
    type: string
    groupId: string | null
    userId: string | null
    groupIdsJson: string | null
    userIdsJson: string | null
  },
): Promise<{ delivered: number; skipped: number }> {
  // r30 目标用户解析：GLOBAL 全体 / 组多选成员并集 + 用户多选并集（混合范围合并去重）
  let finalUserIds: string[] = []
  if (ann.type === "GLOBAL") {
    const users = await db.user.findMany({
      where: { deletedAt: null, enabled: true, frozen: false },
      select: { id: true },
    })
    finalUserIds = users.map((u) => u.id)
  } else {
    const targetGroupIds = announcementGroupIds(ann)
    const targetUserIds = announcementUserIds(ann)
    // GroupUser 无 user 关系定义（纯外键表）：先取全部组成员再过滤有效用户
    const memberSets = await Promise.all(
      targetGroupIds.map((gid) =>
        db.groupUser.findMany({ where: { groupId: gid }, select: { userId: true } }).then((ms) => ms.map((m) => m.userId)),
      ),
    )
    const memberIds = Array.from(new Set(memberSets.flat()))
    const [memberValid, directValid] = await Promise.all([
      memberIds.length
        ? db.user.findMany({ where: { id: { in: memberIds }, deletedAt: null, enabled: true, frozen: false }, select: { id: true } })
        : Promise.resolve([] as { id: string }[]),
      targetUserIds.length
        ? db.user.findMany({ where: { id: { in: targetUserIds }, deletedAt: null, enabled: true, frozen: false }, select: { id: true } })
        : Promise.resolve([] as { id: string }[]),
    ])
    finalUserIds = Array.from(new Set([...memberValid.map((v) => v.id), ...directValid.map((v) => v.id)]))
  }
  if (finalUserIds.length === 0) return { delivered: 0, skipped: 0 }
  if (finalUserIds.length > 5000) finalUserIds = finalUserIds.slice(0, 5000) // 防爆量

  const summary = contentSummary(ann.content)
  const now = new Date()
  // 幂等：同一公告对同一用户只投一次（link 携带公告 ID 查重）
  const link = `/announcements?focus=${ann.id}`
  const existing = await db.notice.findMany({
    where: { type: "ANNOUNCEMENT", link },
    select: { userId: true },
  })
  const sentSet = new Set(existing.map((n) => n.userId))
  const pending = finalUserIds.filter((id) => !sentSet.has(id))
  if (pending.length === 0) return { delivered: 0, skipped: finalUserIds.length }

  // 分批插入（SQLite 变量上限）
  const BATCH = 200
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH).map((uid) => ({
      userId: uid,
      title: `【公告】${ann.title}`,
      content: summary || "请查看公告详情",
      type: "ANNOUNCEMENT",
      link,
      // createdAt 默认 now；readAt 未读
    }))
    await db.notice.createMany({ data: batch })
  }
  await db.announcement.update({ where: { id: ann.id }, data: { notifiedAt: now } }).catch(() => {})
  return { delivered: pending.length, skipped: finalUserIds.length - pending.length }
}

export async function upsertAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string; inboxDelivered?: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(announcementSchema, input)

    // r30 范围多选校验：组与用户均可多选（旧单选字段 groupId/userId 兼容并入）
    const targetGroupIds = Array.from(new Set([...(p.groupIds || []), ...(p.groupId ? [p.groupId] : [])]))
    const targetUserIds = Array.from(new Set([...(p.userIds || []), ...(p.userId ? [p.userId] : [])]))
    if (p.type === "GLOBAL" && (targetGroupIds.length > 0 || targetUserIds.length > 0)) {
      throw bizError(ErrorCode.PARAM_ERROR, "全站公告不需要指定范围（请清空用户组/用户多选）")
    }
    if (p.type === "GROUP" && targetGroupIds.length === 0) {
      throw bizError(ErrorCode.PARAM_ERROR, "用户组范围公告必须至少选择一个目标用户组")
    }
    if (p.type === "USER" && targetUserIds.length === 0) {
      throw bizError(ErrorCode.PARAM_ERROR, "用户范围公告必须至少选择一位目标用户（可与用户组混合）")
    }
    if (targetGroupIds.length > 0) {
      const groups = await db.group.findMany({ where: { id: { in: targetGroupIds }, deletedAt: null }, select: { id: true } })
      if (groups.length !== targetGroupIds.length) {
        throw bizError(ErrorCode.NOT_FOUND, "存在无效/已删除的目标用户组，请重新选择")
      }
    }
    if (targetUserIds.length > 0) {
      const users = await db.user.findMany({ where: { id: { in: targetUserIds }, deletedAt: null }, select: { id: true } })
      if (users.length !== targetUserIds.length) {
        throw bizError(ErrorCode.NOT_FOUND, "存在无效/已删除的目标用户，请重新选择")
      }
    }

    // 发布通道合并：displayTypes（新多选）∪ displayType（旧单值兼容）
    const displayTypes = Array.from(new Set([...(p.displayTypes || []), ...(p.displayType && !(p.displayTypes || []).length ? [p.displayType] : [])]))
    if (displayTypes.length === 0 && !p.notifyInbox) {
      throw bizError(ErrorCode.PARAM_ERROR, "至少选择一种发布通道：展示方式（弹窗/跑马灯/强制阅读）或站内信")
    }

    // 时效校验：开始时间必须早于结束时间
    const s = parseDate(p.startAt)
    const e = parseDate(p.endAt)
    if (s && e && s.getTime() >= e.getTime()) {
      throw bizError(ErrorCode.PARAM_ERROR, "显示开始时间必须早于结束时间")
    }

    const data = {
      title: p.title,
      content: p.content,
      type: p.type,
      // 兼容字段 = 数组首项（旧单选客户端按单值展示/查询在单目标场景行为不变）
      groupId: p.type === "GROUP" || p.type === "USER" ? targetGroupIds[0] || null : null,
      userId: p.type === "USER" ? targetUserIds[0] || null : null,
      groupIdsJson: targetGroupIds.length > 0 ? JSON.stringify(targetGroupIds) : null,
      userIdsJson: targetUserIds.length > 0 ? JSON.stringify(targetUserIds) : null,
      displayType: displayTypes[0] || "POPUP", // 主展示方式（列表/旧客户端兼容）
      displayTypes: JSON.stringify(displayTypes),
      notifyInbox: !!p.notifyInbox,
      startAt: s,
      endAt: e,
      persistAfterRead: !!p.persistAfterRead,
      allowDismiss: p.allowDismiss === undefined ? true : !!p.allowDismiss,
      enabled: p.enabled,
    }

    if (p.id) {
      const before = await db.announcement.findUnique({ where: { id: p.id } })
      if (!before) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")
      const ann = await db.announcement.update({ where: { id: p.id }, data })
      // 站内信投递：编辑时开启通道且未投递过 → 补发（幂等：notifiedAt 已置位则跳过）
      let inboxDelivered: number | undefined
      if (ann.notifyInbox && ann.enabled && !ann.notifiedAt) {
        const r = await fanOutInboxNotices({ id: ann.id, title: ann.title, content: ann.content, type: ann.type, groupId: ann.groupId, userId: ann.userId, groupIdsJson: ann.groupIdsJson, userIdsJson: ann.userIdsJson })
        inboxDelivered = r.delivered
      }
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "ANNOUNCEMENT_UPDATE",
        resourceType: "ANNOUNCEMENT",
        resourceId: ann.id,
        resourceName: ann.title,
        before: { title: before.title, content: before.content, type: before.type, groupId: before.groupId, userId: before.userId, groupIdsJson: before.groupIdsJson, userIdsJson: before.userIdsJson, displayType: before.displayType, displayTypes: before.displayTypes, notifyInbox: before.notifyInbox, startAt: before.startAt, endAt: before.endAt, persistAfterRead: before.persistAfterRead, allowDismiss: before.allowDismiss, enabled: before.enabled },
        after: { title: p.title, content: p.content, type: p.type, groupId: data.groupId, userId: data.userId, groupIdsJson: data.groupIdsJson, userIdsJson: data.userIdsJson, targetGroups: targetGroupIds.length, targetUsers: targetUserIds.length, displayType: data.displayType, displayTypes: data.displayTypes, notifyInbox: data.notifyInbox, startAt: data.startAt, endAt: data.endAt, persistAfterRead: data.persistAfterRead, allowDismiss: data.allowDismiss, enabled: p.enabled },
      })
      return { id: ann.id, inboxDelivered }
    }

    const ann = await db.announcement.create({ data: { ...data, createdByUserId: ctx.userId } })
    // 创建即启用 + 站内信通道 → 立即投递（草稿不投递，启用切换时也不补发，保持语义简单）
    let inboxDelivered: number | undefined
    if (ann.notifyInbox && ann.enabled) {
      const r = await fanOutInboxNotices({ id: ann.id, title: ann.title, content: ann.content, type: ann.type, groupId: ann.groupId, userId: ann.userId, groupIdsJson: ann.groupIdsJson, userIdsJson: ann.userIdsJson })
      inboxDelivered = r.delivered
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_CREATE",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      after: { title: p.title, content: p.content, type: p.type, groupId: data.groupId, userId: data.userId, groupIdsJson: data.groupIdsJson, userIdsJson: data.userIdsJson, targetGroups: targetGroupIds.length, targetUsers: targetUserIds.length, displayType: data.displayType, displayTypes: data.displayTypes, notifyInbox: data.notifyInbox, startAt: data.startAt, endAt: data.endAt, persistAfterRead: data.persistAfterRead, allowDismiss: data.allowDismiss, enabled: p.enabled, inboxDelivered },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { id: ann.id, inboxDelivered }
  })
}

const toggleSchema = z.object({ id: zId, enabled: z.boolean() })

export async function toggleAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean; inboxDelivered?: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(toggleSchema, input)
    const ann = await db.announcement.findUnique({ where: { id: p.id } })
    if (!ann) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")
    if (ann.enabled === p.enabled) return { id: ann.id, enabled: ann.enabled }
    await db.announcement.update({ where: { id: ann.id }, data: { enabled: p.enabled } })
    // 草稿 → 启用 且带站内信通道且未投递过 → 补发（自然工作流：先存草稿审阅，再启用发布）
    let inboxDelivered: number | undefined
    if (p.enabled && ann.notifyInbox && !ann.notifiedAt) {
      const r = await fanOutInboxNotices({ id: ann.id, title: ann.title, content: ann.content, type: ann.type, groupId: ann.groupId, userId: ann.userId, groupIdsJson: ann.groupIdsJson, userIdsJson: ann.userIdsJson })
      inboxDelivered = r.delivered
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_TOGGLE",
      resourceType: "ANNOUNCEMENT",
      resourceId: ann.id,
      resourceName: ann.title,
      before: { enabled: ann.enabled },
      after: { enabled: p.enabled, inboxDelivered },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: ann.id, enabled: p.enabled, inboxDelivered }
  })
}

export async function deleteAnnouncementAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const ann = await db.announcement.findUnique({ where: { id: p.id } })
    if (!ann) throw bizError(ErrorCode.NOT_FOUND, "公告不存在")

    // 全量快照（审计留痕可追溯重建） + 清理已读记录 + 物理删除 + 站内信同步清理（仅未读的）
    const readCount = await db.announcementRead.count({ where: { announcementId: ann.id } })
    await db.notice.deleteMany({
      where: { type: "ANNOUNCEMENT", link: `/announcements?focus=${ann.id}`, readAt: null },
    }).catch(() => {})
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
        groupIdsJson: ann.groupIdsJson,
        userIdsJson: ann.userIdsJson,
        displayType: ann.displayType,
        displayTypes: ann.displayTypes,
        notifyInbox: ann.notifyInbox,
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
