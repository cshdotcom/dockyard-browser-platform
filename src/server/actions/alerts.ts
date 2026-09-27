"use server"

// 告警中心 Server Actions：告警处理 / 告警规则 CRUD / Webhook 规则 CRUD（软删）
// 站内通知为只读视图，无写操作。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireWritableMode, requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"

// ---- 1. 标记告警已处理 ----

const handleSchema = z.object({ alertId: zId })

export async function handleAlertAction(
  input: unknown
): Promise<ActionResult<{ alertId: string; handleStatus: string; handledAt: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(handleSchema, input)

    const alert = await db.alert.findUnique({ where: { id: p.alertId } })
    if (!alert) throw bizError(ErrorCode.NOT_FOUND, "告警不存在")
    if (alert.handleStatus !== "PENDING") throw bizError(ErrorCode.CONFLICT, "该告警已处理或已自动恢复")

    const now = new Date()
    await db.alert.update({
      where: { id: alert.id },
      data: { handleStatus: "HANDLED", handledByUserId: ctx.userId, handledAt: now },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_HANDLE",
      resourceType: "ALERT",
      resourceId: alert.id,
      resourceName: alert.title,
      ownerUserId: alert.ownerUserId ?? undefined,
      before: { handleStatus: alert.handleStatus },
      after: { handleStatus: "HANDLED", handledBy: ctx.username, handledAt: now.toISOString() },
      severity: alert.level === "CRITICAL" ? "WARN" : "INFO",
    })
    return { alertId: alert.id, handleStatus: "HANDLED", handledAt: now.toISOString() }
  })
}

// ---- 2. 告警规则 CRUD ----

const zAlertLevel = z.enum(["INFO", "WARN", "CRITICAL"])

const alertRuleSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "规则名称必填").max(64),
  conditionsJson: z.string().min(2, "条件 JSON 必填").max(4000),
  level: zAlertLevel,
  silenceWindowMin: z.number().int().min(0).max(10080),
  webhookEnabled: z.boolean(),
  enabled: z.boolean(),
})

export async function upsertAlertRuleAction(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(alertRuleSchema, input)

    // 条件 JSON 必须可解析（结构为条件数组 / 含 logic 字段的对象）
    let parsed: unknown
    try {
      parsed = JSON.parse(p.conditionsJson)
    } catch {
      throw bizError(ErrorCode.PARAM_ERROR, "条件 JSON 格式非法，无法解析")
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw bizError(ErrorCode.PARAM_ERROR, "条件 JSON 必须为对象或数组")
    }

    if (p.id) {
      const before = await db.alertRule.findUnique({ where: { id: p.id } })
      if (!before) throw bizError(ErrorCode.NOT_FOUND, "告警规则不存在")
      const dup = await db.alertRule.findFirst({ where: { name: p.name, id: { not: p.id } } })
      if (dup) throw bizError(ErrorCode.CONFLICT, `规则名称 ${p.name} 已存在`)
      const rule = await db.alertRule.update({
        where: { id: p.id },
        data: {
          name: p.name,
          conditionsJson: p.conditionsJson,
          level: p.level,
          silenceWindowMin: p.silenceWindowMin,
          webhookEnabled: p.webhookEnabled,
          enabled: p.enabled,
        },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "ALERT_RULE_UPDATE",
        resourceType: "ALERT_RULE",
        resourceId: rule.id,
        resourceName: rule.name,
        before: { name: before.name, level: before.level, conditionsJson: before.conditionsJson, silenceWindowMin: before.silenceWindowMin, webhookEnabled: before.webhookEnabled, enabled: before.enabled },
        after: { name: p.name, level: p.level, conditionsJson: p.conditionsJson, silenceWindowMin: p.silenceWindowMin, webhookEnabled: p.webhookEnabled, enabled: p.enabled },
      })
      return { id: rule.id }
    }

    const dup = await db.alertRule.findFirst({ where: { name: p.name } })
    if (dup) throw bizError(ErrorCode.CONFLICT, `规则名称 ${p.name} 已存在`)
    const rule = await db.alertRule.create({
      data: {
        name: p.name,
        conditionsJson: p.conditionsJson,
        level: p.level,
        silenceWindowMin: p.silenceWindowMin,
        webhookEnabled: p.webhookEnabled,
        enabled: p.enabled,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_RULE_CREATE",
      resourceType: "ALERT_RULE",
      resourceId: rule.id,
      resourceName: rule.name,
      after: { name: p.name, level: p.level, conditionsJson: p.conditionsJson, silenceWindowMin: p.silenceWindowMin, webhookEnabled: p.webhookEnabled, enabled: p.enabled },
    })
    return { id: rule.id }
  })
}

const toggleRuleSchema = z.object({ id: zId, enabled: z.boolean() })

export async function toggleAlertRuleAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(toggleRuleSchema, input)
    const rule = await db.alertRule.findUnique({ where: { id: p.id } })
    if (!rule) throw bizError(ErrorCode.NOT_FOUND, "告警规则不存在")
    if (rule.enabled === p.enabled) return { id: rule.id, enabled: rule.enabled }
    await db.alertRule.update({ where: { id: rule.id }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_RULE_TOGGLE",
      resourceType: "ALERT_RULE",
      resourceId: rule.id,
      resourceName: rule.name,
      before: { enabled: rule.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: rule.id, enabled: p.enabled }
  })
}

export async function deleteAlertRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const rule = await db.alertRule.findUnique({ where: { id: p.id } })
    if (!rule) throw bizError(ErrorCode.NOT_FOUND, "告警规则不存在")
    await db.alertRule.delete({ where: { id: rule.id } }) // AlertRule 无软删字段：物理删除 + 全量快照审计
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ALERT_RULE_DELETE",
      resourceType: "ALERT_RULE",
      resourceId: rule.id,
      resourceName: rule.name,
      before: { name: rule.name, level: rule.level, conditionsJson: rule.conditionsJson, silenceWindowMin: rule.silenceWindowMin, webhookEnabled: rule.webhookEnabled, enabled: rule.enabled },
      after: { deleted: true },
      severity: "WARN",
    })
    return { id: rule.id }
  })
}

// ---- 3. Webhook 规则 CRUD ----

const WEBHOOK_EVENTS = ["SESSION", "PROXY", "SINGBOX", "TOKEN", "SYSTEM", "SECURITY"] as const

const webhookRuleSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "规则名称必填").max(64),
  url: z.string().url("URL 格式非法").max(500).refine((s) => s.startsWith("http://") || s.startsWith("https://"), "URL 必须以 http(s):// 开头"),
  secret: z.string().max(200).optional().or(z.literal("").transform(() => undefined)),
  events: z.array(z.enum(WEBHOOK_EVENTS)).max(6),
  groupId: zId.optional().or(z.literal("").transform(() => undefined)),
  enabled: z.boolean(),
})

export async function upsertWebhookRuleAction(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(webhookRuleSchema, input)

    if (p.groupId) {
      const group = await db.group.findFirst({ where: { id: p.groupId, deletedAt: null } })
      if (!group) throw bizError(ErrorCode.NOT_FOUND, "绑定的用户组不存在或已删除")
    }

    const data = {
      name: p.name,
      url: p.url,
      secret: p.secret ?? null,
      events: p.events,
      groupId: p.groupId ?? null,
      enabled: p.enabled,
    }

    if (p.id) {
      const before = await db.webhookRule.findUnique({ where: { id: p.id } })
      if (!before) throw bizError(ErrorCode.NOT_FOUND, "Webhook 规则不存在")
      const dup = await db.webhookRule.findFirst({ where: { name: p.name, id: { not: p.id }, deletedAt: null } })
      if (dup) throw bizError(ErrorCode.CONFLICT, `规则名称 ${p.name} 已存在`)
      const rule = await db.webhookRule.update({ where: { id: p.id }, data })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "WEBHOOK_UPDATE",
        resourceType: "WEBHOOK",
        resourceId: rule.id,
        resourceName: rule.name,
        before: { name: before.name, url: before.url, secret: before.secret, events: before.events, groupId: before.groupId, enabled: before.enabled },
        after: { name: p.name, url: p.url, secret: p.secret, events: p.events, groupId: p.groupId ?? null, enabled: p.enabled },
      })
      return { id: rule.id }
    }

    const dup = await db.webhookRule.findFirst({ where: { name: p.name, deletedAt: null } })
    if (dup) throw bizError(ErrorCode.CONFLICT, `规则名称 ${p.name} 已存在`)
    const rule = await db.webhookRule.create({ data: { ...data, createdByUserId: ctx.userId } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WEBHOOK_CREATE",
      resourceType: "WEBHOOK",
      resourceId: rule.id,
      resourceName: rule.name,
      after: { name: p.name, url: p.url, secret: p.secret, events: p.events, groupId: p.groupId ?? null, enabled: p.enabled },
    })
    return { id: rule.id }
  })
}

const toggleWebhookSchema = z.object({ id: zId, enabled: z.boolean() })

export async function toggleWebhookRuleAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(toggleWebhookSchema, input)
    const rule = await db.webhookRule.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!rule) throw bizError(ErrorCode.NOT_FOUND, "Webhook 规则不存在或已删除")
    if (rule.enabled === p.enabled) return { id: rule.id, enabled: rule.enabled }
    await db.webhookRule.update({ where: { id: rule.id }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WEBHOOK_TOGGLE",
      resourceType: "WEBHOOK",
      resourceId: rule.id,
      resourceName: rule.name,
      before: { enabled: rule.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { id: rule.id, enabled: p.enabled }
  })
}

export async function deleteWebhookRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const rule = await db.webhookRule.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!rule) throw bizError(ErrorCode.NOT_FOUND, "Webhook 规则不存在或已删除")
    await db.webhookRule.update({ where: { id: rule.id }, data: { deletedAt: new Date(), enabled: false } }) // 软删除
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "WEBHOOK_DELETE",
      resourceType: "WEBHOOK",
      resourceId: rule.id,
      resourceName: rule.name,
      before: { name: rule.name, url: rule.url, events: rule.events, enabled: rule.enabled },
      after: { deleted: true },
      severity: "WARN",
    })
    return { id: rule.id }
  })
}
