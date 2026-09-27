"use server"

// 风控与画像：黑白名单规则 CRUD / 手动解封过期临时规则
// 封禁操作全审计；RiskListRule 无软删字段 → 物理删除 + 审计

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"

const ruleSchema = z.object({
  id: zId.optional(),
  type: z.enum(["IP_BLACK", "IP_WHITE", "UA_BLACK", "DEVICE_BLACK"]),
  value: z.string().min(1, "规则值不能为空").max(300),
  note: z.string().max(300).optional().nullable(),
  mode: z.enum(["TEMP", "PERMANENT"]),
  expiresAt: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "过期时间格式不合法")
    .optional()
    .nullable(),
})

export async function createRiskRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(ruleSchema, input)
    let expiresAt: Date | null = null
    if (p.mode === "TEMP") {
      if (!p.expiresAt) throw new Error("临时规则必须选择过期时间")
      expiresAt = new Date(p.expiresAt)
      if (expiresAt.getTime() <= Date.now()) throw new Error("过期时间必须晚于当前时间")
    }
    const dup = await db.riskListRule.findFirst({ where: { type: p.type, value: p.value } })
    if (dup) throw new Error("相同类型与值的规则已存在")
    const rule = await db.riskListRule.create({
      data: { type: p.type, value: p.value, note: p.note || null, mode: p.mode, expiresAt, createdByUserId: ctx.userId },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "RISK_RULE_CREATE",
      resourceType: "RISK_RULE",
      resourceId: rule.id,
      resourceName: `${rule.type}:${rule.value}`,
      createdByUserId: ctx.userId,
      severity: "WARN",
      after: { type: rule.type, value: rule.value, mode: rule.mode, expiresAt: rule.expiresAt, note: rule.note },
    })
    return { id: rule.id }
  })
}

export async function updateRiskRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(ruleSchema, input)
    if (!p.id) throw new Error("缺少规则ID")
    const existing = await db.riskListRule.findUnique({ where: { id: p.id } })
    if (!existing) throw new Error("规则不存在")
    let expiresAt: Date | null = null
    if (p.mode === "TEMP") {
      if (!p.expiresAt) throw new Error("临时规则必须选择过期时间")
      expiresAt = new Date(p.expiresAt)
    }
    const dup = await db.riskListRule.findFirst({ where: { type: p.type, value: p.value, id: { not: p.id } } })
    if (dup) throw new Error("相同类型与值的规则已存在")
    const rule = await db.riskListRule.update({
      where: { id: p.id },
      data: { type: p.type, value: p.value, note: p.note || null, mode: p.mode, expiresAt },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "RISK_RULE_UPDATE",
      resourceType: "RISK_RULE",
      resourceId: rule.id,
      resourceName: `${rule.type}:${rule.value}`,
      severity: "WARN",
      before: { type: existing.type, value: existing.value, mode: existing.mode, expiresAt: existing.expiresAt, note: existing.note },
      after: { type: rule.type, value: rule.value, mode: rule.mode, expiresAt: rule.expiresAt, note: rule.note },
    })
    return { id: rule.id }
  })
}

// 删除规则（物理删除 + 审计）
export async function deleteRiskRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.riskListRule.findUnique({ where: { id } })
    if (!existing) throw new Error("规则不存在")
    await db.riskListRule.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "RISK_RULE_DELETE",
      resourceType: "RISK_RULE",
      resourceId: id,
      resourceName: `${existing.type}:${existing.value}`,
      severity: "WARN",
      before: { type: existing.type, value: existing.value, mode: existing.mode, expiresAt: existing.expiresAt, note: existing.note },
      after: { deleted: true },
    })
    return { id }
  })
}

// 手动解封：临时且已过期的规则清理（物理删 + 审计）
export async function unbanRiskRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.riskListRule.findUnique({ where: { id } })
    if (!existing) throw new Error("规则不存在")
    if (existing.mode !== "TEMP" || !existing.expiresAt) throw new Error("仅临时规则支持解封")
    if (existing.expiresAt.getTime() > Date.now()) throw new Error("该规则尚未过期，请直接删除")
    await db.riskListRule.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "RISK_RULE_UNBAN",
      resourceType: "RISK_RULE",
      resourceId: id,
      resourceName: `${existing.type}:${existing.value}`,
      severity: "WARN",
      before: { type: existing.type, value: existing.value, mode: existing.mode, expiresAt: existing.expiresAt },
      after: { unbanned: true, cleaned: true },
    })
    return { id }
  })
}

// 一键清理全部已过期的临时规则
export async function purgeExpiredRiskRulesAction(): Promise<ActionResult<{ cleaned: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const expired = await db.riskListRule.findMany({ where: { mode: "TEMP", expiresAt: { lt: new Date() } } })
    for (const r of expired) {
      await db.riskListRule.delete({ where: { id: r.id } })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "RISK_RULE_UNBAN",
        resourceType: "RISK_RULE",
        resourceId: r.id,
        resourceName: `${r.type}:${r.value}`,
        severity: "WARN",
        before: { type: r.type, value: r.value, mode: r.mode, expiresAt: r.expiresAt },
        after: { unbanned: true, cleaned: true },
      })
    }
    await trackBehavior(ctx.userId, "BATCH")
    return { cleaned: expired.length }
  })
}
