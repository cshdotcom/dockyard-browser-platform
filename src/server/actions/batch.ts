"use server"

// ============================================================
// 全站批量操作 Server Actions（r14：所有功能都支持批量 + 多选）
// 设计原则：
//   · 与单条操作完全一致的语义（软删进回收站 / 会话下线 / 审计留痕）
//   · 逐条独立 try/catch：单条失败不阻断整批（失败清单返回前端展示）
//   · 全部写 BATCH 级审计（含批次前后状态摘要）
//   · 批量上限 500 条/批（防止误操作与超大事务）
// ============================================================

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"
import { zodValidate, zId } from "@/lib/validators"
import { moveToRecycle } from "@/lib/recycle"
import { bizError, ErrorCode } from "@/lib/errors"
import { kickAllSessions, countRunningWorkspaces } from "./users-helpers"

const zIds = z.object({ ids: z.array(zId).min(1, "至少选择一条记录").max(500, "单批最多 500 条") })

// 内置任务（seed 幂等重建，删除无意义 → 只允许停用）
const BUILTIN_TASK_CODES = new Set([
  "session_idle_reclaim", "singbox_status_sync", "proxy_health_probe", "file_expire_clean",
  "db_backup", "log_archive", "alert_state_check", "zombie_reclaim", "quota_check",
  "token_expire", "recycle_purge", "dirty_data_clean", "host_probe", "config_drift",
  "self_check", "share_expire", "novnc_health", "policy_deployment_activation",
  "crx_install_poll", "crx_gray_rollout",
])

export interface BatchOutcome {
  affected: number
  failed: { id: string; reason: string }[]
}

async function kickSessionsForUser(userId: string): Promise<number> {
  return kickAllSessions(userId, "ADMIN_KICK")
}

// ============================================================
// 1. 用户批量删除（软删：deletedAt + 禁用 + 会话下线 + API 令牌软删）
// ============================================================
export async function batchDeleteUsersAction(input: unknown): Promise<ActionResult<BatchOutcome & { kicked: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)

    const targets = await db.user.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw bizError(ErrorCode.NOT_FOUND, "未找到有效用户")

    const now = new Date()
    const failed: { id: string; reason: string }[] = []
    let kicked = 0
    const deletedIds: string[] = []

    for (const u of targets) {
      try {
        if (u.id === ctx.userId) throw new Error("不能删除自己")
        const running = await countRunningWorkspaces(u.id)
        if (running > 0) throw new Error(`存在 ${running} 个运行中浏览器会话，请先销毁其工作区`)
        await db.user.update({ where: { id: u.id }, data: { deletedAt: now, enabled: false, frozen: true } })
        kicked += await kickSessionsForUser(u.id)
        await db.apiToken.updateMany({ where: { userId: u.id, deletedAt: null }, data: { deletedAt: now, enabled: false } })
        deletedIds.push(u.id)
      } catch (e) {
        failed.push({ id: u.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USER_BATCH_DELETE",
      resourceType: "USER",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), usernames: targets.map((t) => t.username) },
      after: { deletedIds, sessionsKicked: kicked, failed },
      extra: { batchSize: targets.length },
    })
    await trackBehavior(ctx.userId, "DELETE")
    return { affected: deletedIds.length, failed, kicked }
  })
}

// ============================================================
// 2. 用户组批量删除（软删进回收站 + 组成员脱离；有子组/成员阻止）
// ============================================================
export async function batchDeleteGroupsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)

    const targets = await db.group.findMany({ where: { id: { in: p.ids }, deletedAt: null } })
    if (targets.length === 0) throw bizError(ErrorCode.NOT_FOUND, "未找到有效用户组")

    const failed: { id: string; reason: string }[] = []
    const deletedIds: string[] = []

    for (const g of targets) {
      try {
        const childCount = await db.group.count({ where: { parentId: g.id, deletedAt: null } })
        if (childCount > 0) throw new Error(`存在 ${childCount} 个未删除的子组，请先处理子组`)
        const memberCount = await db.groupUser.count({ where: { groupId: g.id } })
        if (memberCount > 0) throw new Error(`组内仍有 ${memberCount} 名成员，请先迁移或移除成员`)
        await moveToRecycle({
          resourceType: "GROUP",
          resourceId: g.id,
          resourceName: g.name,
          deletedByUserId: ctx.userId,
          deletedByType: "ADMIN",
          reason: "管理员批量删除用户组",
          operatorName: ctx.username,
        })
        await db.group.update({ where: { id: g.id }, data: { deletedAt: new Date(), enabled: false } })
        deletedIds.push(g.id)
      } catch (e) {
        failed.push({ id: g.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "GROUP_BATCH_DELETE",
      resourceType: "GROUP",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), names: targets.map((t) => t.name) },
      after: { deletedIds, failed },
      extra: { batchSize: targets.length },
    })
    return { affected: deletedIds.length, failed }
  })
}

// ============================================================
// 3. 告警中心：批量标记已处理 / 批量删除
// ============================================================
export async function batchHandleAlertsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)

    const targets = await db.alert.findMany({ where: { id: { in: p.ids }, handleStatus: "PENDING" } })
    const now = new Date()
    const r = await db.alert.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { handleStatus: "HANDLED", handledByUserId: ctx.userId, handledAt: now },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_BATCH_HANDLE",
      resourceType: "ALERT",
      before: { ids: targets.map((t) => t.id), titles: targets.map((t) => t.title) },
      after: { handled: r.count, handledBy: ctx.username },
      extra: { batchSize: p.ids.length },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteAlertsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)

    const targets = await db.alert.findMany({ where: { id: { in: p.ids } } })
    // 告警为只插入流水，删除前保留快照审计（不进回收站：体量大且可再生）
    const r = await db.alert.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_BATCH_DELETE",
      resourceType: "ALERT",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), titles: targets.map((t) => t.title), levels: targets.map((t) => t.level) },
      after: { deleted: r.count },
      extra: { batchSize: p.ids.length },
    })
    return { affected: r.count, failed: [] }
  })
}

// ---- 告警规则 / Webhook 规则：批量启停 + 批量删除 ----
export async function batchToggleAlertRulesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds.extend({ enabled: z.boolean() }), input)
    const r = await db.alertRule.updateMany({ where: { id: { in: p.ids } }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_RULE_BATCH_TOGGLE",
      resourceType: "ALERT_RULE",
      before: { ids: p.ids },
      after: { enabled: p.enabled, affected: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteAlertRulesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const targets = await db.alertRule.findMany({ where: { id: { in: p.ids } } })
    const r = await db.alertRule.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_RULE_BATCH_DELETE",
      resourceType: "ALERT_RULE",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), names: targets.map((t) => t.name) },
      after: { deleted: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchToggleWebhookRulesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds.extend({ enabled: z.boolean() }), input)
    const r = await db.webhookRule.updateMany({ where: { id: { in: p.ids } }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WEBHOOK_RULE_BATCH_TOGGLE",
      resourceType: "WEBHOOK_RULE",
      before: { ids: p.ids },
      after: { enabled: p.enabled, affected: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteWebhookRulesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const targets = await db.webhookRule.findMany({ where: { id: { in: p.ids } } })
    const r = await db.webhookRule.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WEBHOOK_RULE_BATCH_DELETE",
      resourceType: "WEBHOOK_RULE",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), names: targets.map((t) => t.name) },
      after: { deleted: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

// ---- 站内通知（管理员批量维护）：批量已读 / 批量删除 ----
export async function batchReadNoticesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const r = await db.notice.updateMany({ where: { id: { in: p.ids }, readAt: null }, data: { readAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "NOTICE_BATCH_READ",
      resourceType: "NOTICE",
      after: { read: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteNoticesAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const r = await db.notice.deleteMany({ where: { id: { in: p.ids } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "NOTICE_BATCH_DELETE",
      resourceType: "NOTICE",
      severity: "WARN",
      after: { deleted: r.count, ids: p.ids },
    })
    return { affected: r.count, failed: [] }
  })
}

// ============================================================
// 4. 备份：批量删除（备份记录 + 文件元数据软删；文件保留待存储清理任务）
// ============================================================
export async function batchDeleteBackupsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)

    const targets = await db.backupRecord.findMany({ where: { id: { in: p.ids } } })
    const failed: { id: string; reason: string }[] = []
    const now = new Date()
    const deletedIds: string[] = []

    for (const b of targets) {
      try {
        if (b.status === "RESTORING") throw new Error("该备份正在恢复中，禁止删除")
        await db.backupRecord.delete({ where: { id: b.id } })
        await db.fileMeta.updateMany({ where: { id: b.fileMetaId }, data: { deletedAt: now } })
        deletedIds.push(b.id)
      } catch (e) {
        failed.push({ id: b.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BACKUP_BATCH_DELETE",
      resourceType: "BACKUP",
      severity: "WARN",
      before: { ids: targets.map((t) => t.id), fileMetaIds: targets.map((t) => t.fileMetaId) },
      after: { deletedIds, failed },
    })
    return { affected: deletedIds.length, failed }
  })
}

// ============================================================
// 5. 定时任务：批量启停 / 批量删除 + 任务日志批量清理
// ============================================================
export async function batchToggleTasksAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds.extend({ enabled: z.boolean() }), input)
    // ids 为任务 code（主键）
    const r = await db.scheduleTask.updateMany({ where: { code: { in: p.ids } }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_BATCH_TOGGLE",
      resourceType: "TASK",
      before: { codes: p.ids },
      after: { enabled: p.enabled, affected: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteTasksAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    // 内置任务（seed 每次启动幂等重建）不允许删除，只能停用
    const targets = await db.scheduleTask.findMany({ where: { code: { in: p.ids } } })
    const failed: { id: string; reason: string }[] = []
    const deletedIds: string[] = []
    for (const t of targets) {
      try {
        if (BUILTIN_TASK_CODES.has(t.code)) throw new Error("内置任务不允许删除（只能停用）")
        await db.scheduleTask.delete({ where: { code: t.code } })
        await db.scheduleTaskLog.deleteMany({ where: { taskCode: t.code } })
        deletedIds.push(t.code)
      } catch (e) {
        failed.push({ id: t.code, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_BATCH_DELETE",
      resourceType: "TASK",
      severity: "WARN",
      before: { codes: targets.map((t) => t.code), names: targets.map((t) => t.name) },
      after: { deletedIds, failed },
    })
    return { affected: deletedIds.length, failed }
  })
}

export async function batchDeleteTaskLogsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const r = await db.scheduleTaskLog.deleteMany({ where: { id: { in: p.ids } } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_LOG_BATCH_DELETE",
      resourceType: "TASK_LOG",
      after: { deleted: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

// ============================================================
// 6. 公告：批量启停 / 批量删除（复用单删语义：站内信同步清理 + 已读清理）
// ============================================================
export async function batchToggleAnnouncementsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds.extend({ enabled: z.boolean() }), input)
    const targets = await db.announcement.findMany({ where: { id: { in: p.ids } } })
    const r = await db.announcement.updateMany({ where: { id: { in: p.ids } }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_BATCH_TOGGLE",
      resourceType: "ANNOUNCEMENT",
      severity: p.enabled ? "INFO" : "WARN",
      before: { ids: targets.map((t) => t.id), enabled: targets.map((t) => t.enabled) },
      after: { enabled: p.enabled, affected: r.count },
      extra: { batchSize: p.ids.length },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteAnnouncementsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const targets = await db.announcement.findMany({ where: { id: { in: p.ids } } })
    const failed: { id: string; reason: string }[] = []
    const deletedIds: string[] = []

    for (const ann of targets) {
      try {
        // 站内信同步清理（仅未读的）+ 已读记录清理 + 物理删除（快照已在审计留痕）
        await db.notice.deleteMany({ where: { type: "ANNOUNCEMENT", link: `/announcements?focus=${ann.id}`, readAt: null } }).catch(() => {})
        await db.announcementRead.deleteMany({ where: { announcementId: ann.id } })
        await db.announcementDismiss.deleteMany({ where: { announcementId: ann.id } })
        await db.announcement.delete({ where: { id: ann.id } })
        deletedIds.push(ann.id)
      } catch (e) {
        failed.push({ id: ann.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ANNOUNCEMENT_BATCH_DELETE",
      resourceType: "ANNOUNCEMENT",
      severity: "WARN",
      before: {
        ids: targets.map((t) => t.id),
        titles: targets.map((t) => t.title),
        types: targets.map((t) => t.type),
        displayTypes: targets.map((t) => t.displayTypes),
        notifyInbox: targets.map((t) => t.notifyInbox),
        enabled: targets.map((t) => t.enabled),
      },
      after: { deletedIds, failed },
      extra: { batchSize: p.ids.length },
    })
    return { affected: deletedIds.length, failed }
  })
}

// ============================================================
// 7. CRX 插件库：批量启停 / 批量删除（软删进回收站）
// ============================================================
export async function batchToggleCrxPluginsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds.extend({ enabled: z.boolean() }), input)
    // ids 为 crxId（32 位扩展 ID）
    const r = await db.crxPlugin.updateMany({ where: { crxId: { in: p.ids }, deletedAt: null }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "CRX_PLUGIN_BATCH_TOGGLE",
      resourceType: "CRX_PLUGIN",
      before: { crxIds: p.ids },
      after: { enabled: p.enabled, affected: r.count },
    })
    return { affected: r.count, failed: [] }
  })
}

export async function batchDeleteCrxPluginsAction(input: unknown): Promise<ActionResult<BatchOutcome>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(zIds, input)
    const targets = await db.crxPlugin.findMany({ where: { crxId: { in: p.ids }, deletedAt: null } })
    const failed: { id: string; reason: string }[] = []
    const deletedIds: string[] = []
    const now = new Date()

    for (const c of targets) {
      try {
        await db.crxPlugin.update({ where: { crxId: c.crxId }, data: { deletedAt: now, enabled: false } })
        deletedIds.push(c.crxId)
      } catch (e) {
        failed.push({ id: c.crxId, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "CRX_PLUGIN_BATCH_DELETE",
      resourceType: "CRX_PLUGIN",
      severity: "WARN",
      before: { crxIds: targets.map((t) => t.crxId), names: targets.map((t) => t.name) },
      after: { deletedIds, failed },
    })
    return { affected: deletedIds.length, failed }
  })
}
