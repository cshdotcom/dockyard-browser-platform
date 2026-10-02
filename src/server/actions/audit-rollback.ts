"use server"

// ============================================================
// 审计日志回滚（管理员）：把某次操作的 before 快照写回资源 —— "撤销这次变更"
//   · 映射表驱动：operationType → { model, idField, fields }，before JSON 中
//     存在且字段白名单允许的键全部恢复（含批量 toggle 的 ids/enabled 数组）
//   · 安全边界：仅恢复非唯一性字段（username/name 等唯一键永不回滚，避免冲突）；
//     角色字段仅 SUPER_ADMIN 可回滚（防管理员借回滚提权/降权越权）
//   · 审计闭环：回滚本身写 AUDIT_ROLLBACK（before=回滚前现值 / after=恢复值 /
//     resourceId=被回滚的原审计 ID），可再次回滚"回滚"（往返可逆）
// ============================================================

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAdmin, requireWritableMode } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"

type ModelKey = "announcement" | "scheduleTask" | "apiToken" | "alertRule" | "webhookRule" | "crxPlugin" | "user" | "group"

interface RollbackRule {
  model: ModelKey
  idField: "id" | "code" | "crxId"
  fields: string[]
  label: string
  batch?: boolean
}

// 字段白名单：布尔态 / 配额 / 策略开关（可安全恢复；唯一键与身份凭证类字段永不回滚）
const USER_FIELDS = ["enabled", "frozen", "force2faSetup", "mustChangePassword", "allowInternalNetwork", "allowSecureLocationAccess", "vncSessionMaxMinutes", "quota", "permissionLocks", "role"]
const GROUP_FIELDS = ["enabled", "force2fa", "allowInternalNetwork", "allowSecureLocationAccess", "vncSessionMaxMinutes", "quota", "policy", "inheritParentQuota", "webhookUrl"]

const RULES: Record<string, RollbackRule> = {
  ANNOUNCEMENT_TOGGLE: { model: "announcement", idField: "id", fields: ["enabled"], label: "公告启停状态" },
  ANNOUNCEMENT_BATCH_TOGGLE: { model: "announcement", idField: "id", fields: ["enabled"], label: "公告批量启停", batch: true },
  TASK_TOGGLE: { model: "scheduleTask", idField: "code", fields: ["enabled"], label: "任务启停状态" },
  TASK_BATCH_TOGGLE: { model: "scheduleTask", idField: "code", fields: ["enabled"], label: "任务批量启停", batch: true },
  TOKEN_TOGGLE: { model: "apiToken", idField: "id", fields: ["enabled"], label: "API 令牌启停状态" },
  TOKEN_ADMIN_TOGGLE: { model: "apiToken", idField: "id", fields: ["enabled"], label: "API 令牌启停状态（管理员代管）" },
  ALERT_RULE_TOGGLE: { model: "alertRule", idField: "id", fields: ["enabled"], label: "告警规则启停状态" },
  ALERT_RULE_BATCH_TOGGLE: { model: "alertRule", idField: "id", fields: ["enabled"], label: "告警规则批量启停", batch: true },
  WEBHOOK_TOGGLE: { model: "webhookRule", idField: "id", fields: ["enabled"], label: "Webhook 启停状态" },
  WEBHOOK_RULE_BATCH_TOGGLE: { model: "webhookRule", idField: "id", fields: ["enabled"], label: "Webhook 批量启停", batch: true },
  CRX_PLUGIN_TOGGLE: { model: "crxPlugin", idField: "crxId", fields: ["enabled"], label: "插件启停状态" },
  CRX_PLUGIN_BATCH_TOGGLE: { model: "crxPlugin", idField: "crxId", fields: ["enabled"], label: "插件批量启停", batch: true },
  USER_FORCE_2FA: { model: "user", idField: "id", fields: ["force2faSetup"], label: "用户强制 2FA" },
  USER_UPDATE: { model: "user", idField: "id", fields: USER_FIELDS, label: "用户核心字段" },
  USER_BATCH_STATUS: { model: "user", idField: "id", fields: ["enabled", "frozen"], label: "用户批量状态", batch: true },
  GROUP_UPDATE: { model: "group", idField: "id", fields: GROUP_FIELDS, label: "用户组核心字段" },
}

// 前端查询：某 operationType 是否可回滚（支持类型清单）
export async function canRollbackOperationTypeAction(input: unknown): Promise<ActionResult<{ supported: string[] }>> {
  return actionHandler(async () => {
    await requireAdmin()
    return { supported: Object.keys(RULES) }
  })
}

export async function rollbackAuditAction(input: unknown): Promise<ActionResult<{ restored: Record<string, unknown>[]; skipped: string[] }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ auditId: zId }), input)

    const log = await db.auditLog.findUnique({ where: { id: p.auditId } })
    if (!log) throw bizError(ErrorCode.NOT_FOUND, "审计记录不存在")

    const rule = RULES[log.operationType]
    if (!rule) {
      throw bizError(ErrorCode.PARAM_ERROR, `操作类型 ${log.operationType} 不支持一键回滚（支持启停/策略/配额类变更；删除类请使用回收站恢复）`)
    }

    // 管理员不可借回滚恢复 role 字段（仅超管可）
    const isSuper = ctx.role === "SUPER_ADMIN"
    const fieldFilter = (fields: string[]) => fields.filter((f) => (f === "role" ? isSuper : true))

    let before: Record<string, unknown> = {}
    try {
      before = log.beforeJson ? (JSON.parse(log.beforeJson) as Record<string, unknown>) : {}
    } catch {
      throw bizError(ErrorCode.PARAM_ERROR, "before 快照解析失败（数据损坏）")
    }

    const model = db[rule.model] as unknown as {
      findUnique: (args: { where: Record<string, string> }) => Promise<Record<string, unknown> | null>
      update: (args: { where: Record<string, string>; data: Record<string, unknown> }) => Promise<Record<string, unknown>>
    }
    const restored: Record<string, unknown>[] = []
    const skipped: string[] = []

    const applyOne = async (targetId: string, patch: Record<string, unknown>) => {
      const allowed = fieldFilter(rule.fields)
      const data: Record<string, unknown> = {}
      for (const k of allowed) {
        if (k in patch && patch[k] !== undefined && patch[k] !== null) data[k] = patch[k]
      }
      if (Object.keys(data).length === 0) {
        skipped.push(`${targetId}：before 快照无可恢复字段`)
        return
      }
      const current = await model.findUnique({ where: { [rule.idField]: targetId } })
      if (!current) {
        skipped.push(`${targetId}：资源已不存在（可能已被删除）`)
        return
      }
      // Prisma Json 字段直接传 JS 对象（客户端自动序列化）
      await model.update({ where: { [rule.idField]: targetId }, data })
      restored.push({ targetId, fields: data, previous: Object.fromEntries(Object.keys(data).map((k) => [k, (current as Record<string, unknown>)[k]])) })
    }

    if (rule.batch) {
      // 批量类：before = { ids: [...], enabled: [...] / <field>: [...] } 或 before = { ids: [...], <单字段名>: 值 }（统一值）
      const ids = Array.isArray(before.ids) ? (before.ids as string[]) : log.resourceId && log.resourceId !== "batch-all" ? [log.resourceId] : []
      if (ids.length === 0) throw bizError(ErrorCode.PARAM_ERROR, "批量审计缺少目标 ID 清单，无法回滚")
      for (let i = 0; i < ids.length; i++) {
        const patch: Record<string, unknown> = {}
        for (const f of rule.fields) {
          if (Array.isArray(before[f])) {
            const arr = before[f] as unknown[]
            patch[f] = arr[i]
          } else if (before[f] !== undefined) {
            patch[f] = before[f]
          }
        }
        await applyOne(ids[i], patch)
      }
    } else {
      if (!log.resourceId) throw bizError(ErrorCode.PARAM_ERROR, "审计记录缺少资源 ID，无法回滚")
      await applyOne(log.resourceId, before)
    }

    if (restored.length === 0) {
      throw bizError(ErrorCode.PARAM_ERROR, `回滚未生效：${skipped[0] || "当前状态已与快照一致"}`)
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "AUDIT_ROLLBACK",
      resourceType: "AUDIT_LOG",
      resourceId: log.id,
      resourceName: `${log.operationType} · ${log.resourceName || log.resourceId || ""}`,
      before: { sourceOperation: log.operationType, sourceAuditId: log.id, sourceBefore: before },
      after: { restored, skipped },
      severity: "WARN",
    })

    return { restored, skipped }
  })
}
