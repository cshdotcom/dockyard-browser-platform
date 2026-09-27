"use server"

// 会话模板（用户侧）：创建 / 编辑 / 复制(deep copy) / 导入JSON / 删除(软删+回收站)
// 权限锁：blockImportTemplate(导入) / blockCopyOthersTemplate(复制他人) / blockDeleteResource(删除)
// 范围：PRIVATE(仅自己) / GROUP(我的组) / GLOBAL(仅 SUPER_ADMIN/ADMIN 可创建)

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth, requirePermission, requireWritableMode, userGroupIds, requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"
import { bizError, ErrorCode } from "@/lib/errors"

const templateConfigSchema = z.object({
  ua: z.string().max(512).optional().default(""),
  timezone: z.string().max(64).optional().default(""),
  locale: z.string().max(32).optional().default(""),
  variables: z.record(z.string(), z.string()).optional().nullable(),
})

const templateInputSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "模板名称必填").max(100),
  description: z.string().max(500).optional().default(""),
  scope: z.enum(["PRIVATE", "GROUP", "GLOBAL"]),
  groupId: zId.optional().nullable(),
  tags: z.array(z.string().max(32)).max(10).default([]),
  config: templateConfigSchema,
})

interface TemplateConfig {
  ua?: string
  timezone?: string
  locale?: string
  variables?: Record<string, string> | null
}

function buildConfigJson(config: TemplateConfig): string {
  return JSON.stringify({
    ua: config.ua || "",
    timezone: config.timezone || "",
    locale: config.locale || "",
    variables: config.variables || {},
  })
}

// 可见性判定：GLOBAL 直通 / GROUP 需在我组 / 其它需属于我
async function assertTemplateVisible(userId: string, templateId: string) {
  const t = await db.browserTemplate.findFirst({ where: { id: templateId, deletedAt: null } })
  if (!t) throw bizError(ErrorCode.NOT_FOUND, "模板不存在或已删除")
  if (t.scope !== "GLOBAL") {
    if (t.userId !== userId) {
      if (t.scope !== "GROUP" || !t.groupId) throw bizError(ErrorCode.FORBIDDEN, "无权访问该模板")
      const gids = await userGroupIds(userId)
      if (!gids.includes(t.groupId)) throw bizError(ErrorCode.FORBIDDEN, "无权访问该模板")
    }
  }
  return t
}

export async function upsertTemplateAction(input: unknown): Promise<ActionResult<{ id: string; version: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(templateInputSchema, input)

    if (p.scope === "GLOBAL") {
      // 全局模板仅管理员可创建/维护
      await requireAdmin()
    }
    if (p.scope === "GROUP") {
      const gids = await userGroupIds(ctx.userId)
      if (!p.groupId || !gids.includes(p.groupId)) {
        throw bizError(ErrorCode.PARAM_ERROR, "组共享模板必须选择你所在的用户组")
      }
    }

    const data = {
      name: p.name,
      description: p.description || "",
      scope: p.scope,
      groupId: p.scope === "GROUP" ? p.groupId! : null,
      userId: p.scope === "GLOBAL" ? null : ctx.userId,
      tags: p.tags.length ? (p.tags as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      configJson: buildConfigJson(p.config),
    }

    if (p.id) {
      const before = await db.browserTemplate.findFirst({ where: { id: p.id, deletedAt: null } })
      if (!before) throw bizError(ErrorCode.NOT_FOUND, "模板不存在或已删除")
      // 普通用户仅可编辑自己名下模板；管理员可编辑全局模板
      const isOwner = before.userId === ctx.userId
      const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
      if (!isOwner && !(isAdmin && before.scope === "GLOBAL")) {
        throw bizError(ErrorCode.FORBIDDEN, "只能编辑自己创建的模板")
      }

      const updated = await db.browserTemplate.update({
        where: { id: p.id },
        data: { ...data, version: before.version + 1 },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "TEMPLATE_UPDATE",
        resourceType: "TEMPLATE",
        resourceId: updated.id,
        resourceName: updated.name,
        ownerUserId: before.userId ?? ctx.userId,
        before: { name: before.name, scope: before.scope, version: before.version, configJson: before.configJson },
        after: { name: p.name, scope: p.scope, version: updated.version, configJson: data.configJson },
      })
      return { id: updated.id, version: updated.version }
    }

    const created = await db.browserTemplate.create({
      data: { ...data, createdByUserId: ctx.userId },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TEMPLATE_CREATE",
      resourceType: "TEMPLATE",
      resourceId: created.id,
      resourceName: created.name,
      ownerUserId: ctx.userId,
      after: { name: p.name, scope: p.scope, groupId: data.groupId, configJson: data.configJson },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { id: created.id, version: created.version }
  })
}

export async function copyTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ id: zId }), input)

    const src = await assertTemplateVisible(ctx.userId, p.id)
    if (src.userId !== ctx.userId) {
      await requirePermission(ctx.userId, "blockCopyOthersTemplate", "复制他人模板已被权限锁禁止")
    }

    const copy = await db.browserTemplate.create({
      data: {
        name: `${src.name}（副本）`,
        description: src.description,
        scope: "PRIVATE",
        userId: ctx.userId,
        parentId: src.id, // 继承来源
        configJson: src.configJson, // deep copy（配置为 JSON 字符串，直接克隆）
        version: 1,
        tags: src.tags ? (src.tags as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        createdByUserId: ctx.userId,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TEMPLATE_COPY",
      resourceType: "TEMPLATE",
      resourceId: copy.id,
      resourceName: copy.name,
      ownerUserId: ctx.userId,
      after: { sourceId: src.id, sourceName: src.name, scope: "PRIVATE", configJson: copy.configJson },
    })
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { id: copy.id }
  })
}

export async function deleteTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockDeleteResource", "删除资源已被权限锁禁止")
    const p = zodValidate(z.object({ id: zId, reason: z.string().max(200).optional() }), input)

    const t = await db.browserTemplate.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!t) throw bizError(ErrorCode.NOT_FOUND, "模板不存在或已删除")
    const isOwner = t.userId === ctx.userId
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    if (!isOwner && !(isAdmin && t.scope === "GLOBAL")) {
      throw bizError(ErrorCode.FORBIDDEN, "只能删除自己创建的模板")
    }

    await db.browserTemplate.update({ where: { id: t.id }, data: { deletedAt: new Date() } })
    await moveToRecycle({
      resourceType: "TEMPLATE",
      resourceId: t.id,
      resourceName: t.name,
      ownerUserId: t.userId,
      createdByUserId: t.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: isAdmin && !isOwner ? "ADMIN" : "USER",
      reason: p.reason || "用户删除模板",
      operatorName: ctx.username,
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TEMPLATE_DELETE",
      resourceType: "TEMPLATE",
      resourceId: t.id,
      resourceName: t.name,
      ownerUserId: t.userId,
      before: { name: t.name, scope: t.scope, version: t.version, configJson: t.configJson },
      after: { deleted: true, softDeleted: true },
      severity: "WARN",
    })
    await trackBehavior(ctx.userId, "DELETE").catch(() => {})
    return { id: t.id }
  })
}

// 导入 JSON：支持单对象或数组；scope 一律 PRIVATE 归当前用户
const importItemSchema = z.object({
  name: z.string().min(1, "模板名称必填").max(100),
  description: z.string().max(500).optional().default(""),
  tags: z.array(z.string().max(32)).max(10).optional().default([]),
  config: templateConfigSchema.optional(),
  configJson: z.string().max(10000).optional(),
})

export async function importTemplatesAction(input: unknown): Promise<ActionResult<{ created: number; skipped: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockImportTemplate", "导入模板已被权限锁禁止")

    const p = zodValidate(z.object({ payload: z.string().min(2, "导入内容为空").max(200000) }), input)
    let parsed: unknown
    try {
      parsed = JSON.parse(p.payload)
    } catch {
      throw bizError(ErrorCode.PARAM_ERROR, "JSON 解析失败，请检查导入内容格式")
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    if (arr.length === 0) throw bizError(ErrorCode.PARAM_ERROR, "导入内容为空数组")
    if (arr.length > 20) throw bizError(ErrorCode.PARAM_ERROR, "单次最多导入 20 条模板")

    let created = 0
    const skipped: string[] = []
    for (const raw of arr) {
      const item = importItemSchema.safeParse(raw)
      if (!item.success) {
        skipped.push(item.error.issues[0]?.message || "格式非法")
        continue
      }
      let configJson: string
      if (item.data.config) {
        configJson = buildConfigJson(item.data.config)
      } else if (item.data.configJson) {
        try {
          const cfg = JSON.parse(item.data.configJson)
          configJson = JSON.stringify({
            ua: String(cfg.ua || ""),
            timezone: String(cfg.timezone || ""),
            locale: String(cfg.locale || ""),
            variables: cfg.variables && typeof cfg.variables === "object" ? cfg.variables : {},
          })
        } catch {
          skipped.push(`${item.data.name}: configJson 解析失败`)
          continue
        }
      } else {
        configJson = buildConfigJson({})
      }
      const t = await db.browserTemplate.create({
        data: {
          name: item.data.name,
          description: item.data.description,
          scope: "PRIVATE",
          userId: ctx.userId,
          configJson,
          version: 1,
          tags: item.data.tags.length ? (item.data.tags as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          createdByUserId: ctx.userId,
        },
      })
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "TEMPLATE_IMPORT",
        resourceType: "TEMPLATE",
        resourceId: t.id,
        resourceName: t.name,
        ownerUserId: ctx.userId,
        after: { name: t.name, scope: "PRIVATE", configJson },
      })
      created++
    }
    await trackBehavior(ctx.userId, "CREATE").catch(() => {})
    return { created, skipped: skipped.length }
  })
}
