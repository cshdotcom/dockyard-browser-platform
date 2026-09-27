"use server"

// 规则管理：UA池 / 域名规则 / 请求篡改规则（管理员）
// UaRecord / DomainRule 无 deletedAt → 停用=enabled=false；物理删除需审计
// BrowserModifyRule 有 deletedAt → 软删除 + 审计（不进回收站）

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// ============================================================
// UA 池 UaRecord
// ============================================================

const uaSchema = z.object({
  id: zId.optional(),
  ua: z.string().min(10, "UA 字符串过短").max(500),
  label: z.string().max(64).optional().nullable(),
  category: z.enum(["DESKTOP", "MOBILE"]),
  enabled: z.boolean(),
})

export async function saveUaAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(uaSchema, input)
    const dup = await db.uaRecord.findFirst({ where: { ua: p.ua, ...(p.id ? { id: { not: p.id } } : {}) } })
    if (dup) throw new Error("相同 UA 已存在")
    if (p.id) {
      const existing = await db.uaRecord.findUnique({ where: { id: p.id } })
      if (!existing) throw new Error("UA 记录不存在")
      const row = await db.uaRecord.update({
        where: { id: p.id },
        data: { ua: p.ua, label: p.label || null, category: p.category, enabled: p.enabled },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "UA_RECORD_UPDATE",
        resourceType: "UA_RECORD",
        resourceId: row.id,
        resourceName: row.label || row.ua.slice(0, 40),
        before: { ua: existing.ua, label: existing.label, category: existing.category, enabled: existing.enabled },
        after: { ua: row.ua, label: row.label, category: row.category, enabled: row.enabled },
      })
      return { id: row.id }
    }
    const row = await db.uaRecord.create({
      data: { ua: p.ua, label: p.label || null, category: p.category, enabled: p.enabled },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "UA_RECORD_CREATE",
      resourceType: "UA_RECORD",
      resourceId: row.id,
      resourceName: row.label || row.ua.slice(0, 40),
      after: { ua: row.ua, label: row.label, category: row.category, enabled: row.enabled },
    })
    return { id: row.id }
  })
}

export async function toggleUaAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.uaRecord.findUnique({ where: { id } })
    if (!existing) throw new Error("UA 记录不存在")
    const row = await db.uaRecord.update({ where: { id }, data: { enabled: !existing.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "UA_RECORD_UPDATE",
      resourceType: "UA_RECORD",
      resourceId: id,
      resourceName: row.label || row.ua.slice(0, 40),
      before: { enabled: existing.enabled },
      after: { enabled: row.enabled },
      extra: { change: row.enabled ? "启用" : "逻辑停用" },
    })
    return { id, enabled: row.enabled }
  })
}

export async function deleteUaAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.uaRecord.findUnique({ where: { id } })
    if (!existing) throw new Error("UA 记录不存在")
    await db.uaRecord.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "UA_RECORD_DELETE",
      resourceType: "UA_RECORD",
      resourceId: id,
      resourceName: existing.label || existing.ua.slice(0, 40),
      severity: "WARN",
      before: { ua: existing.ua, label: existing.label, category: existing.category, usageCount: existing.usageCount },
      after: { deleted: true, physical: true },
    })
    return { id }
  })
}

// 导出 JSON（返回数据由前端组装下载）
export async function exportUaAction(): Promise<ActionResult<{ items: { ua: string; label: string | null; category: string; enabled: boolean }[]; exportedAt: string }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const rows = await db.uaRecord.findMany({ orderBy: { createdAt: "asc" } })
    return {
      items: rows.map((r) => ({ ua: r.ua, label: r.label, category: r.category, enabled: r.enabled })),
      exportedAt: new Date().toISOString(),
    }
  })
}

// 导入 JSON（逐条校验，重复跳过）
export async function importUaAction(input: unknown): Promise<ActionResult<{ imported: number; skipped: number; errors: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { text } = zodValidate(z.object({ text: z.string().min(1, "请输入 JSON 内容") }), input)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error("JSON 解析失败，请检查格式")
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown }).items
    if (!Array.isArray(arr) || arr.length === 0) throw new Error("JSON 需为数组或 { items: [] } 结构")
    if (arr.length > 200) throw new Error("单次导入上限 200 条")

    const errors: string[] = []
    let imported = 0
    let skipped = 0
    const itemSchema = z.object({
      ua: z.string().min(10).max(500),
      label: z.string().max(64).optional().nullable(),
      category: z.enum(["DESKTOP", "MOBILE"]).optional(),
      enabled: z.boolean().optional(),
    })
    for (let i = 0; i < arr.length; i++) {
      try {
        const item = zodValidate(itemSchema, arr[i])
        const dup = await db.uaRecord.findFirst({ where: { ua: item.ua } })
        if (dup) {
          skipped++
          continue
        }
        await db.uaRecord.create({
          data: { ua: item.ua, label: item.label || null, category: item.category || "DESKTOP", enabled: item.enabled ?? true },
        })
        imported++
      } catch (e) {
        errors.push(`第 ${i + 1} 条：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "UA_RECORD_IMPORT",
      resourceType: "UA_RECORD",
      after: { imported, skipped, errors: errors.length, total: arr.length },
    })
    return { imported, skipped, errors }
  })
}

// ============================================================
// 域名规则 DomainRule
// ============================================================

const domainSchema = z.object({
  id: zId.optional(),
  pattern: z.string().min(1, "域名模式不能为空").max(300),
  type: z.enum(["BLACK", "WHITE"]),
  enabled: z.boolean(),
  note: z.string().max(300).optional().nullable(),
})

export async function saveDomainRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(domainSchema, input)
    const dup = await db.domainRule.findFirst({ where: { pattern: p.pattern, ...(p.id ? { id: { not: p.id } } : {}) } })
    if (dup) throw new Error("相同域名模式已存在")
    if (p.id) {
      const existing = await db.domainRule.findUnique({ where: { id: p.id } })
      if (!existing) throw new Error("域名规则不存在")
      const row = await db.domainRule.update({
        where: { id: p.id },
        data: { pattern: p.pattern, type: p.type, enabled: p.enabled, note: p.note || null },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "DOMAIN_RULE_UPDATE",
        resourceType: "DOMAIN_RULE",
        resourceId: row.id,
        resourceName: row.pattern,
        before: { pattern: existing.pattern, type: existing.type, enabled: existing.enabled, note: existing.note },
        after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note },
      })
      return { id: row.id }
    }
    const row = await db.domainRule.create({
      data: { pattern: p.pattern, type: p.type, enabled: p.enabled, note: p.note || null, createdByUserId: ctx.userId },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "DOMAIN_RULE_CREATE",
      resourceType: "DOMAIN_RULE",
      resourceId: row.id,
      resourceName: row.pattern,
      after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note },
    })
    return { id: row.id }
  })
}

export async function toggleDomainRuleAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.domainRule.findUnique({ where: { id } })
    if (!existing) throw new Error("域名规则不存在")
    const row = await db.domainRule.update({ where: { id }, data: { enabled: !existing.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "DOMAIN_RULE_UPDATE",
      resourceType: "DOMAIN_RULE",
      resourceId: id,
      resourceName: row.pattern,
      before: { enabled: existing.enabled },
      after: { enabled: row.enabled },
      extra: { change: row.enabled ? "启用" : "逻辑停用" },
    })
    return { id, enabled: row.enabled }
  })
}

export async function deleteDomainRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.domainRule.findUnique({ where: { id } })
    if (!existing) throw new Error("域名规则不存在")
    await db.domainRule.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "DOMAIN_RULE_DELETE",
      resourceType: "DOMAIN_RULE",
      resourceId: id,
      resourceName: existing.pattern,
      severity: "WARN",
      before: { pattern: existing.pattern, type: existing.type, enabled: existing.enabled, note: existing.note },
      after: { deleted: true, physical: true },
    })
    return { id }
  })
}

// ============================================================
// 请求篡改规则 BrowserModifyRule（软删除，不进回收站）
// ============================================================

const modifySchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "名称不能为空").max(64),
  type: z.enum(["REQ_HEADER", "RESP_HEADER", "REDIRECT"]),
  matchPattern: z.string().min(1, "匹配模式不能为空").max(300),
  headerKey: z.string().max(190).optional().nullable(),
  headerValue: z.string().max(500).optional().nullable(),
  redirectUrl: z.string().max(500).optional().nullable(),
  enabled: z.boolean(),
  templateBinding: z.string().max(64).optional().nullable(),
})

function validateModifyFields(p: z.infer<typeof modifySchema>) {
  if (p.type === "REDIRECT") {
    if (!p.redirectUrl) throw new Error("重定向类型必须填写重定向 URL")
  } else {
    if (!p.headerKey) throw new Error("请求/响应头类型必须填写头名称")
    if (p.headerValue === null || p.headerValue === undefined) throw new Error("请求/响应头类型必须填写头值")
  }
}

export async function saveModifyRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(modifySchema, input)
    validateModifyFields(p)
    if (p.id) {
      const existing = await db.browserModifyRule.findUnique({ where: { id: p.id } })
      if (!existing || existing.deletedAt) throw new Error("篡改规则不存在")
      const row = await db.browserModifyRule.update({
        where: { id: p.id },
        data: {
          name: p.name,
          type: p.type,
          matchPattern: p.matchPattern,
          headerKey: p.type === "REDIRECT" ? null : p.headerKey,
          headerValue: p.type === "REDIRECT" ? null : p.headerValue,
          redirectUrl: p.type === "REDIRECT" ? p.redirectUrl : null,
          enabled: p.enabled,
          templateBinding: p.templateBinding || null,
        },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "MODIFY_RULE_UPDATE",
        resourceType: "MODIFY_RULE",
        resourceId: row.id,
        resourceName: row.name,
        before: { name: existing.name, type: existing.type, matchPattern: existing.matchPattern, enabled: existing.enabled },
        after: { name: row.name, type: row.type, matchPattern: row.matchPattern, headerKey: row.headerKey, redirectUrl: row.redirectUrl, enabled: row.enabled, templateBinding: row.templateBinding },
      })
      return { id: row.id }
    }
    const row = await db.browserModifyRule.create({
      data: {
        name: p.name,
        type: p.type,
        matchPattern: p.matchPattern,
        headerKey: p.type === "REDIRECT" ? null : p.headerKey,
        headerValue: p.type === "REDIRECT" ? null : p.headerValue,
        redirectUrl: p.type === "REDIRECT" ? p.redirectUrl : null,
        enabled: p.enabled,
        templateBinding: p.templateBinding || null,
        createdByUserId: ctx.userId,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "MODIFY_RULE_CREATE",
      resourceType: "MODIFY_RULE",
      resourceId: row.id,
      resourceName: row.name,
      after: { name: row.name, type: row.type, matchPattern: row.matchPattern, enabled: row.enabled },
    })
    return { id: row.id }
  })
}

export async function toggleModifyRuleAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.browserModifyRule.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("篡改规则不存在")
    const row = await db.browserModifyRule.update({ where: { id }, data: { enabled: !existing.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "MODIFY_RULE_UPDATE",
      resourceType: "MODIFY_RULE",
      resourceId: id,
      resourceName: row.name,
      before: { enabled: existing.enabled },
      after: { enabled: row.enabled },
    })
    return { id, enabled: row.enabled }
  })
}

// 软删除 + 审计（不进回收站）
export async function deleteModifyRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.browserModifyRule.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("篡改规则不存在")
    await db.browserModifyRule.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "MODIFY_RULE_DELETE",
      resourceType: "MODIFY_RULE",
      resourceId: id,
      resourceName: existing.name,
      severity: "WARN",
      before: { name: existing.name, type: existing.type, matchPattern: existing.matchPattern, enabled: existing.enabled },
      after: { deleted: true, soft: true, toRecycle: false },
    })
    return { id }
  })
}

// 模板下拉数据（绑定模板用）
export async function listTemplateOptionsAction(): Promise<ActionResult<{ id: string; name: string; scope: string }[]>> {
  return actionHandler(async () => {
    await requireAdmin()
    const rows = await db.browserTemplate.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, scope: true },
      orderBy: { name: "asc" },
      take: 200,
    })
    return rows
  })
}
