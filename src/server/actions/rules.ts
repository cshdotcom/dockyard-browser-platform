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
  // —— 作用域：全局/用户组/用户/单沙箱（四层定向限制） ——
  scopeType: z.enum(["GLOBAL", "GROUP", "USER", "SANDBOX"]).default("GLOBAL"),
  groupId: zId.nullish(),
  userId: zId.nullish(),
  workspaceId: zId.nullish(),
  priority: z.number().int().min(0).max(9999).default(0),
})

// 作用域参数清洗（GROUP 必须有效组 / USER 必须有效用户 / SANDBOX 必须有效沙箱；不一致时回退 GLOBAL）
async function sanitizeDomainScope(p: { scopeType: string; groupId?: string | null; userId?: string | null; workspaceId?: string | null }): Promise<{
  scopeType: string; groupId: string | null; userId: string | null; workspaceId: string | null
}> {
  if (p.scopeType === "GROUP") {
    if (!p.groupId) throw new Error("组级规则必须选择用户组")
    const g = await db.group.findFirst({ where: { id: p.groupId, deletedAt: null } })
    if (!g) throw new Error("用户组不存在")
    return { scopeType: "GROUP", groupId: p.groupId, userId: null, workspaceId: null }
  }
  if (p.scopeType === "USER") {
    if (!p.userId) throw new Error("用户级规则必须选择用户")
    const u = await db.user.findFirst({ where: { id: p.userId, deletedAt: null } })
    if (!u) throw new Error("用户不存在")
    return { scopeType: "USER", groupId: null, userId: p.userId, workspaceId: null }
  }
  if (p.scopeType === "SANDBOX") {
    if (!p.workspaceId) throw new Error("沙箱级规则必须选择目标沙箱")
    const w = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null } })
    if (!w) throw new Error("沙箱不存在或已删除")
    return { scopeType: "SANDBOX", groupId: null, userId: null, workspaceId: p.workspaceId }
  }
  return { scopeType: "GLOBAL", groupId: null, userId: null, workspaceId: null }
}

export async function saveDomainRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(domainSchema, input)
    const scope = await sanitizeDomainScope(p)
    const dup = await db.domainRule.findFirst({
      where: {
        pattern: p.pattern, type: p.type, scopeType: scope.scopeType, groupId: scope.groupId, userId: scope.userId, workspaceId: scope.workspaceId,
        ...(p.id ? { id: { not: p.id } } : {}),
      },
    })
    if (dup) throw new Error("相同域名模式（同作用域/同类型）已存在")
    const scopeData = { scopeType: scope.scopeType, groupId: scope.groupId, userId: scope.userId, workspaceId: scope.workspaceId, priority: p.priority ?? 0 }
    if (p.id) {
      const existing = await db.domainRule.findUnique({ where: { id: p.id } })
      if (!existing) throw new Error("域名规则不存在")
      const row = await db.domainRule.update({
        where: { id: p.id },
        data: { pattern: p.pattern, type: p.type, enabled: p.enabled, note: p.note || null, ...scopeData },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "DOMAIN_RULE_UPDATE",
        resourceType: "DOMAIN_RULE",
        resourceId: row.id,
        resourceName: row.pattern,
        before: { pattern: existing.pattern, type: existing.type, enabled: existing.enabled, note: existing.note, scopeType: existing.scopeType, groupId: existing.groupId, userId: existing.userId },
        after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note, ...scopeData },
      })
      return { id: row.id }
    }
    const row = await db.domainRule.create({
      data: { pattern: p.pattern, type: p.type, enabled: p.enabled, note: p.note || null, createdByUserId: ctx.userId, ...scopeData },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "DOMAIN_RULE_CREATE",
      resourceType: "DOMAIN_RULE",
      resourceId: row.id,
      resourceName: row.pattern,
      after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note, ...scopeData },
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

// ============================================================
// 端点级精确限制规则 NetworkEndpointRule（host:port 精确到端口）
// 与域名规则同一作用域模型（GLOBAL/GROUP/USER）；
// 执行层：Chromium 托管策略 URLBlocklist（与内网/域名策略合并注入）
// ============================================================

const endpointSchema = z.object({
  id: zId.optional(),
  pattern: z.string().min(1, "端点模式不能为空").max(253),
  type: z.enum(["BLACK", "WHITE"]),
  enabled: z.boolean(),
  note: z.string().max(300).optional().nullable(),
  scopeType: z.enum(["GLOBAL", "GROUP", "USER", "SANDBOX"]).default("GLOBAL"),
  groupId: zId.nullish(),
  userId: zId.nullish(),
  workspaceId: zId.nullish(),
  priority: z.number().int().min(0).max(9999).default(0),
})

export async function saveEndpointRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(endpointSchema, input)
    // 模式规范化（host:port / host:* / CIDR:port / [::1]:port / 端口区间）
    const { normalizeEndpointPattern } = await import("@/lib/endpoint-policy")
    const normalized = normalizeEndpointPattern(p.pattern)
    if (!normalized) {
      throw new Error("非法端点模式：支持 host:port / host:* / 10.0.0.0/24:443 / *.corp.com:22 / [::1]:9222 / host:80-90")
    }
    const scope = await sanitizeDomainScope(p)
    const dup = await db.networkEndpointRule.findFirst({
      where: {
        pattern: normalized, type: p.type, scopeType: scope.scopeType, groupId: scope.groupId, userId: scope.userId, workspaceId: scope.workspaceId,
        ...(p.id ? { id: { not: p.id } } : {}),
      },
    })
    if (dup) throw new Error("相同端点模式（同作用域/同类型）已存在")
    const scopeData = { scopeType: scope.scopeType, groupId: scope.groupId, userId: scope.userId, workspaceId: scope.workspaceId, priority: p.priority ?? 0 }
    if (p.id) {
      const existing = await db.networkEndpointRule.findUnique({ where: { id: p.id } })
      if (!existing) throw new Error("端点规则不存在")
      const row = await db.networkEndpointRule.update({
        where: { id: p.id },
        data: { pattern: normalized, type: p.type, enabled: p.enabled, note: p.note || null, ...scopeData },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "ENDPOINT_RULE_UPDATE",
        resourceType: "ENDPOINT_RULE",
        resourceId: row.id,
        resourceName: row.pattern,
        before: { pattern: existing.pattern, type: existing.type, enabled: existing.enabled, note: existing.note, scopeType: existing.scopeType },
        after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note, ...scopeData },
      })
      return { id: row.id }
    }
    const row = await db.networkEndpointRule.create({
      data: { pattern: normalized, type: p.type, enabled: p.enabled, note: p.note || null, createdByUserId: ctx.userId, ...scopeData },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ENDPOINT_RULE_CREATE",
      resourceType: "ENDPOINT_RULE",
      resourceId: row.id,
      resourceName: row.pattern,
      after: { pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note, ...scopeData },
    })
    return { id: row.id }
  })
}

export async function toggleEndpointRuleAction(input: unknown): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.networkEndpointRule.findUnique({ where: { id } })
    if (!existing) throw new Error("端点规则不存在")
    const row = await db.networkEndpointRule.update({ where: { id }, data: { enabled: !existing.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ENDPOINT_RULE_UPDATE",
      resourceType: "ENDPOINT_RULE",
      resourceId: id,
      resourceName: row.pattern,
      before: { enabled: existing.enabled },
      after: { enabled: row.enabled },
      extra: { change: row.enabled ? "启用" : "逻辑停用" },
    })
    return { id, enabled: row.enabled }
  })
}

export async function deleteEndpointRuleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.networkEndpointRule.findUnique({ where: { id } })
    if (!existing) throw new Error("端点规则不存在")
    await db.networkEndpointRule.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "ENDPOINT_RULE_DELETE",
      resourceType: "ENDPOINT_RULE",
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
// 文件访问限制策略（四层定向：GLOBAL / GROUP / USER / SANDBOX 单沙箱）
// 下载 / 上传 / file:// 三个维度独立布尔；执行层 Chromium 托管策略注入
// ============================================================

const filePolicySchema = z.object({
  scopeType: z.enum(["GLOBAL", "GROUP", "USER", "SANDBOX"]),
  scopeId: z.string().max(64).default(""), // GLOBAL 恒空串；GROUP/USER/SANDBOX 为对应 ID
  allowDownload: z.boolean().default(true),
  allowUpload: z.boolean().default(true),
  allowFileScheme: z.boolean().default(false),
  note: z.string().max(300).optional().nullable(),
})

async function validateFileScope(scopeType: string, scopeId: string): Promise<string> {
  if (scopeType === "GLOBAL") return "全局默认"
  if (!scopeId) throw new Error("该作用域必须指定目标 ID")
  if (scopeType === "GROUP") {
    const g = await db.group.findFirst({ where: { id: scopeId, deletedAt: null } })
    if (!g) throw new Error("用户组不存在")
    return `组：${g.name}`
  }
  if (scopeType === "USER") {
    const u = await db.user.findFirst({ where: { id: scopeId, deletedAt: null } })
    if (!u) throw new Error("用户不存在")
    return `用户：${u.username}`
  }
  if (scopeType === "SANDBOX") {
    const w = await db.browserWorkspace.findFirst({ where: { id: scopeId, deletedAt: null } })
    if (!w) throw new Error("沙箱不存在或已删除")
    return `沙箱：${w.name}`
  }
  throw new Error("非法作用域")
}

// 保存（upsert）文件限制策略条目
export async function saveFilePolicyAction(input: unknown): Promise<ActionResult<{ id: string; effective: { allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean; source: string } }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(filePolicySchema, input)
    const label = await validateFileScope(p.scopeType, p.scopeId)
    const row = await db.filePolicyConfig.upsert({
      where: { scopeType_scopeId: { scopeType: p.scopeType, scopeId: p.scopeId } },
      create: {
        scopeType: p.scopeType, scopeId: p.scopeId,
        allowDownload: p.allowDownload, allowUpload: p.allowUpload, allowFileScheme: p.allowFileScheme,
        note: p.note || null, createdByUserId: ctx.userId,
      },
      update: {
        allowDownload: p.allowDownload, allowUpload: p.allowUpload, allowFileScheme: p.allowFileScheme,
        note: p.note || null,
      },
    })
    // 即时回显生效链（作用域覆盖 > 继承）
    const { resolveFilePolicy } = await import("@/lib/file-policy")
    const userId = p.scopeType === "USER" ? p.scopeId
      : p.scopeType === "SANDBOX" ? (await db.browserWorkspace.findUnique({ where: { id: p.scopeId }, select: { userId: true } }))?.userId
      : undefined
    const effective = userId
      ? await resolveFilePolicy(userId, p.scopeType === "SANDBOX" ? p.scopeId : undefined)
      : null
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_POLICY_SAVE", resourceType: "FILE_POLICY", resourceId: row.id, resourceName: label,
      after: { scope: label, allowDownload: p.allowDownload, allowUpload: p.allowUpload, allowFileScheme: p.allowFileScheme },
      severity: "WARN",
    })
    return {
      id: row.id,
      effective: effective
        ? { allowDownload: effective.allowDownload, allowUpload: effective.allowUpload, allowFileScheme: effective.allowFileScheme, source: effective.source }
        : { allowDownload: p.allowDownload, allowUpload: p.allowUpload, allowFileScheme: p.allowFileScheme, source: p.scopeType },
    }
  })
}

// 删除文件策略条目（该作用域回退继承上层）
export async function deleteFilePolicyAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.filePolicyConfig.findUnique({ where: { id } })
    if (!existing) throw new Error("文件策略条目不存在")
    await db.filePolicyConfig.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_POLICY_DELETE", resourceType: "FILE_POLICY", resourceId: id, resourceName: `${existing.scopeType}:${existing.scopeId.slice(0, 12)}`,
      severity: "WARN", before: { allowDownload: existing.allowDownload, allowUpload: existing.allowUpload, allowFileScheme: existing.allowFileScheme },
      after: { deleted: true, fallback: "继承上层" },
    })
    return { id }
  })
}

// 文件策略条目列表（含目标标签）
export async function listFilePolicyAction(): Promise<ActionResult<Array<{ id: string; scopeType: string; scopeId: string; scopeLabel: string; allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean; note: string | null; updatedAt: Date }>>> {
  return actionHandler(async () => {
    await requireAdmin()
    const rows = await db.filePolicyConfig.findMany({ orderBy: [{ scopeType: "asc" }, { updatedAt: "desc" }] })
    const [groups, users, workspaces] = await Promise.all([
      db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
      db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true } }),
      db.browserWorkspace.findMany({ where: { deletedAt: null }, select: { id: true, name: true, userId: true } }),
    ])
    const gMap = new Map(groups.map((g) => [g.id, g.name]))
    const uMap = new Map(users.map((u) => [u.id, u.username]))
    const wMap = new Map(workspaces.map((w) => [w.id, w]))
    return rows.map((r) => ({
      id: r.id,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      scopeLabel:
        r.scopeType === "GLOBAL" ? "全局默认"
        : r.scopeType === "GROUP" ? `组：${gMap.get(r.scopeId) || "(已删除)"}`
        : r.scopeType === "USER" ? `用户：${uMap.get(r.scopeId) || "(已删除)"}`
        : `沙箱：${wMap.get(r.scopeId)?.name || "(已删除)"}`,
      allowDownload: r.allowDownload,
      allowUpload: r.allowUpload,
      allowFileScheme: r.allowFileScheme,
      note: r.note,
      updatedAt: r.updatedAt,
    }))
  })
}

// ============================================================
// 沙箱级策略覆盖与即时下发（单沙箱定向限制核心）
// 1) 网络开关覆盖（内网/安全位置，非 null 即最高优先）
// 2) 策略即时刷新：重解析四层 → 重写托管策略文件 → 容器内浏览器进程重启（USR1）
// ============================================================

const wsPolicyOverrideSchema = z.object({
  workspaceId: zId,
  allowInternalNetwork: z.boolean().nullable(), // null = 继承上层
  allowSecureLocationAccess: z.boolean().nullable(),
  restartNow: z.boolean().default(true), // 运行中沙箱立即重刷策略（浏览器进程 1 秒内重启生效）
})

export async function setWorkspacePolicyOverrideAction(input: unknown): Promise<ActionResult<{ applied: boolean; restarted: boolean; effective: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; source: string } }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(wsPolicyOverrideSchema, input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null } })
    if (!ws) throw new Error("沙箱不存在或已删除")
    if (ws.mode !== "novnc_full") throw new Error("仅 NoVNC 重度沙箱支持沙箱级覆盖")

    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        policyAllowInternalNetwork: p.allowInternalNetwork,
        policyAllowSecureLocationAccess: p.allowSecureLocationAccess,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WS_POLICY_OVERRIDE", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      before: { policyAllowInternalNetwork: ws.policyAllowInternalNetwork, policyAllowSecureLocationAccess: ws.policyAllowSecureLocationAccess },
      after: { policyAllowInternalNetwork: p.allowInternalNetwork, policyAllowSecureLocationAccess: p.allowSecureLocationAccess },
      severity: "WARN", ownerUserId: ws.userId,
    })

    // 即时生效：运行中容器重刷策略文件并重启浏览器进程
    let restarted = false
    if (p.restartNow && ws.status === "RUNNING" && ws.containerRef) {
      const { refreshWorkspacePolicyFile } = await import("@/lib/network-policy-apply")
      const applied = await refreshWorkspacePolicyFile(ws.id).catch(() => false)
      if (applied) {
        const { restartBrowserProcessInContainer } = await import("@/lib/external/docker")
        const r = await restartBrowserProcessInContainer(ws.containerRef).catch(() => ({ restarted: false, simulated: true }))
        restarted = !!r.restarted
      }
    }
    const { resolveNetworkPolicy } = await import("@/lib/network-policy")
    const effective = await resolveNetworkPolicy(ws.userId, ws.id)
    return {
      applied: true,
      restarted,
      effective: { allowInternalNetwork: effective.allowInternalNetwork, allowSecureLocationAccess: effective.allowSecureLocationAccess, source: effective.source },
    }
  })
}

// 沙箱策略即时刷新（四层重解析 → 策略文件重写 → 浏览器进程重启）
// 供域名/端点/文件策略变更后对运行中沙箱一键生效；也可被部署中心批量调用
export async function refreshWorkspacePolicyAction(input: unknown): Promise<ActionResult<{ refreshed: boolean; restarted: boolean; effective: Record<string, unknown> }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("沙箱不存在或已删除")
    if (ws.mode !== "novnc_full") throw new Error("仅 NoVNC 重度沙箱支持策略即时刷新")
    if (!ws.containerRef && !ws.novncSessionId) throw new Error("沙箱容器不存在（停止状态将在下次启动时自动应用最新策略）")

    const { refreshWorkspacePolicyFile } = await import("@/lib/network-policy-apply")
    const refreshed = await refreshWorkspacePolicyFile(ws.id)
    let restarted = false
    if (refreshed && ws.containerRef && ws.status === "RUNNING") {
      const { restartBrowserProcessInContainer } = await import("@/lib/external/docker")
      const r = await restartBrowserProcessInContainer(ws.containerRef).catch(() => ({ restarted: false, simulated: true }))
      restarted = !!r.restarted
    }
    const { resolveAccessPolicies } = await import("@/lib/domain-policy")
    const bundle = await resolveAccessPolicies(ws.userId, ws.id)
    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        networkPolicyJson: JSON.parse(JSON.stringify({
          ...bundle.network,
          domainMode: bundle.domain.mode, domainBlack: bundle.domain.blackPatterns, domainWhite: bundle.domain.whitePatterns,
          endpointBlack: bundle.endpoint.blackPatterns, endpointWhite: bundle.endpoint.whitePatterns,
          fileAllowDownload: bundle.file.allowDownload, fileAllowUpload: bundle.file.allowUpload, fileAllowFileScheme: bundle.file.allowFileScheme, fileSource: bundle.file.source,
        })) as import("@prisma/client").Prisma.InputJsonValue,
      },
    }).catch(() => {})
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WS_POLICY_REFRESH", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { refreshed, restarted, netSource: bundle.network.source, fileSource: bundle.file.source, domainRules: bundle.domain.rules.length, endpointRules: bundle.endpoint.rules.length },
      severity: "WARN", ownerUserId: ws.userId,
    })
    return {
      refreshed,
      restarted,
      effective: {
        network: { allowInternalNetwork: bundle.network.allowInternalNetwork, allowSecureLocationAccess: bundle.network.allowSecureLocationAccess, source: bundle.network.source },
        domain: { mode: bundle.domain.mode, black: bundle.domain.blackPatterns.length, white: bundle.domain.whitePatterns.length, rules: bundle.domain.rules.length },
        endpoint: { black: bundle.endpoint.blackPatterns.length, white: bundle.endpoint.whitePatterns.length },
        file: { allowDownload: bundle.file.allowDownload, allowUpload: bundle.file.allowUpload, allowFileScheme: bundle.file.allowFileScheme, source: bundle.file.source },
      },
    }
  })
}
