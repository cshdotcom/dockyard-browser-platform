"use server"

// ============================================================
// CRX 扩展管控 Server Actions（RBAC：插件库=普通管理员可操作；彻底删除/灰度回滚=仅超管）
// 全部操作写全局不可篡改审计日志；冲突校验（强制安装 × 黑名单）；数量上限校验
// ============================================================

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireRole } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"
import {
  isValidCrxId, isValidUpdateUrl, isValidVersion, detectHighRisk,
  checkForceBlocklistConflict, checkSandboxForcelistLimit, MAX_FORCED_EXTENSIONS_PER_SANDBOX,
} from "@/lib/crx-policy"
import { raiseAlert } from "@/lib/alerts"

// ---- 1. 插件库：新增 / 编辑 ----
const pluginSchema = z.object({
  id: z.string().optional(), // 编辑时携带
  crxId: z.string().length(32),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(""),
  zhNote: z.string().max(300).optional().default(""),
  tags: z.string().max(200).optional().default(""), // 逗号分隔
  permissions: z.string().max(2000).optional().default(""), // 逗号分隔（manifest 权限清单）
  updateUrl: z.string().min(1).max(300),
  backupUpdateUrl: z.string().max(300).optional().default(""),
  lockedVersion: z.string().max(40).optional().default(""),
  allowIncognito: z.boolean().optional().default(false),
  allowUserDisable: z.boolean().optional().default(true),
  docUrl: z.string().max(300).optional().default(""),
})

function parseTags(s: string): string[] {
  return s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
}

export async function saveCrxPluginAction(input: unknown): Promise<ActionResult<{ crxId: string; highRisk: boolean; highRiskReason: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(pluginSchema, input)
    if (!isValidCrxId(p.crxId)) throw bizError(ErrorCode.PARAM_ERROR, "CRX-ID 格式非法（应为 32 位 a-p 扩展 ID）")
    if (!isValidUpdateUrl(p.updateUrl)) throw bizError(ErrorCode.PARAM_ERROR, "主 update_url 格式非法（须 http(s):// 开头）")
    if (p.backupUpdateUrl && !isValidUpdateUrl(p.backupUpdateUrl)) throw bizError(ErrorCode.PARAM_ERROR, "备用 update_url 格式非法")
    if (p.lockedVersion && !isValidVersion(p.lockedVersion)) throw bizError(ErrorCode.PARAM_ERROR, "锁定版本号格式非法（如 1.2.3.4）")

    const permissions = parseTags(p.permissions)
    const hr = detectHighRisk(permissions)
    const tags = parseTags(p.tags)

    const before = p.id ? await db.crxPlugin.findUnique({ where: { id: p.id } }) : null
    if (p.id && !before) throw bizError(ErrorCode.NOT_FOUND, "插件不存在")

    const data = {
      crxId: p.crxId, name: p.name, description: p.description || null, zhNote: p.zhNote || null,
      tags, permissions,
      updateUrl: p.updateUrl, backupUpdateUrl: p.backupUpdateUrl || null,
      lockedVersion: p.lockedVersion || null,
      allowIncognito: p.allowIncognito, allowUserDisable: p.allowUserDisable,
      highRisk: hr.highRisk, highRiskReason: hr.reasons,
      docUrl: p.docUrl || null,
      updatedByUserId: ctx.userId, updatedByName: ctx.username,
    }

    const plugin = p.id
      ? await db.crxPlugin.update({ where: { id: p.id }, data })
      : await db.crxPlugin.create({ data: { ...data, createdByUserId: ctx.userId, createdByName: ctx.username } })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: p.id ? "CRX_PLUGIN_UPDATE" : "CRX_PLUGIN_CREATE",
      resourceType: "CRX_PLUGIN", resourceId: plugin.crxId, resourceName: plugin.name,
      before: p.id ? { name: before?.name, updateUrl: before?.updateUrl, lockedVersion: before?.lockedVersion, enabled: before?.enabled } : undefined,
      after: { name: plugin.name, updateUrl: plugin.updateUrl, backupUpdateUrl: plugin.backupUpdateUrl, lockedVersion: plugin.lockedVersion, allowIncognito: plugin.allowIncognito, allowUserDisable: plugin.allowUserDisable, highRisk: hr.highRisk },
      severity: "INFO",
    })
    // manifest 权限变更检测（高危权限新增 → 告警）
    if (before) {
      const beforePerms = Array.isArray(before.permissions) ? (before.permissions as string[]) : []
      const added = permissions.filter((x) => !beforePerms.includes(x))
      const addedHighRisk = detectHighRisk(added)
      if (addedHighRisk.highRisk) {
        await raiseAlert({
          title: `CRX 插件权限变更（新增高危权限）：${plugin.name}`,
          level: "WARNING",
          content: `插件 ${plugin.name}（${plugin.crxId}）权限清单新增：${added.join(", ")}，其中高危权限 ${addedHighRisk.reasons.join(", ")}`,
          resourceType: "CRX_PLUGIN", resourceId: plugin.crxId,
          dedupeKey: `crx-permchg-${plugin.crxId}`,
          webhookPayload: { event: "crx.permission_changed", crxId: plugin.crxId, name: plugin.name, addedPermissions: added, highRisk: addedHighRisk.reasons },
        })
      }
    }
    return { crxId: plugin.crxId, highRisk: hr.highRisk, highRiskReason: hr.reasons }
  })
}

// ---- 2. 插件库：启用 / 禁用 ----
export async function toggleCrxPluginAction(input: unknown): Promise<ActionResult<{ enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { crxId, enabled } = zodValidate(z.object({ crxId: z.string().length(32), enabled: z.boolean() }), input)
    const plugin = await db.crxPlugin.findUnique({ where: { crxId } })
    if (!plugin || plugin.deletedAt) throw bizError(ErrorCode.NOT_FOUND, "插件不存在")
    await db.crxPlugin.update({ where: { crxId }, data: { enabled, updatedByUserId: ctx.userId, updatedByName: ctx.username } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: enabled ? "CRX_PLUGIN_ENABLE" : "CRX_PLUGIN_DISABLE",
      resourceType: "CRX_PLUGIN", resourceId: crxId, resourceName: plugin.name,
      after: { enabled }, severity: "WARN",
    })
    if (!enabled) {
      // 禁用后仍有沙箱引用 → 即时告警（轮询任务也会持续提醒）
      const refs = await db.crxPolicyEntry.count({ where: { crxId, deletedAt: null } })
      if (refs > 0) {
        await raiseAlert({
          title: `CRX 插件库禁用但仍被引用：${plugin.name}`,
          level: "WARNING",
          content: `插件 ${plugin.name}（${crxId}）已禁用，但仍有 ${refs} 条策略引用（沙箱/组/用户/全局），相关沙箱将停止安装该插件`,
          resourceType: "CRX_PLUGIN", resourceId: crxId,
          dedupeKey: `crx-disabled-ref-${crxId}`,
          webhookPayload: { event: "crx.library_disabled_referenced", crxId, references: refs },
        })
      }
    }
    return { enabled }
  })
}

// ---- 3. 插件库回收站：软删 / 恢复 / 彻底删除（超管 + 引用校验） ----
export async function recycleCrxPluginAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { crxId } = zodValidate(z.object({ crxId: z.string().length(32) }), input)
    const refs = await db.crxPolicyEntry.count({ where: { crxId, deletedAt: null } })
    if (refs > 0) throw bizError(ErrorCode.CONFLICT, `该插件仍被 ${refs} 条策略引用（沙箱/组/用户/全局），请先移除引用再删除`)
    const plugin = await db.crxPlugin.update({ where: { crxId }, data: { deletedAt: new Date(), deletedByUserId: ctx.userId, deletedByName: ctx.username } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_PLUGIN_RECYCLE",
      resourceType: "CRX_PLUGIN", resourceId: crxId, resourceName: plugin.name, severity: "WARN",
      after: { movedTo: "插件库回收站" },
    })
    return { ok: true }
  })
}

export async function restoreCrxPluginAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { crxId } = zodValidate(z.object({ crxId: z.string().length(32) }), input)
    const plugin = await db.crxPlugin.update({ where: { crxId }, data: { deletedAt: null, deletedByUserId: null, deletedByName: null, updatedByUserId: ctx.userId, updatedByName: ctx.username } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_PLUGIN_RESTORE",
      resourceType: "CRX_PLUGIN", resourceId: crxId, resourceName: plugin.name, after: { restored: true },
    })
    return { ok: true }
  })
}

export async function destroyCrxPluginAction(input: unknown): Promise<ActionResult<{ confirmName: string }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN"]) // 彻底删除仅超管
    const { crxId, confirmName } = zodValidate(z.object({ crxId: z.string().length(32), confirmName: z.string().min(1) }), input)
    const plugin = await db.crxPlugin.findUnique({ where: { crxId } })
    if (!plugin) throw bizError(ErrorCode.NOT_FOUND, "插件不存在")
    if (confirmName !== plugin.name) throw bizError(ErrorCode.PARAM_ERROR, "二次确认失败：名称不匹配")
    // 引用校验：存在任何策略引用 → 拒绝彻底删除
    const refs = await db.crxPolicyEntry.count({ where: { crxId, deletedAt: null } })
    const grayRefs = await db.crxGrayTask.count({ where: { status: { in: ["PENDING", "ROLLING"] } } })
    if (refs > 0) throw bizError(ErrorCode.CONFLICT, `彻底删除被拒绝：仍有 ${refs} 条策略引用该插件`)
    await db.crxInstallStatus.deleteMany({ where: { crxId } })
    await db.crxPlugin.delete({ where: { crxId } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_PLUGIN_DESTROY",
      resourceType: "CRX_PLUGIN", resourceId: crxId, resourceName: plugin.name, severity: "CRITICAL",
      after: { destroyed: true, grayRunningTasks: grayRefs, operatorConfirm: confirmName },
    })
    return { confirmName }
  })
}

// ---- 4. 批量 CSV 导入（crxId,updateUrl[,backupUpdateUrl,name]） ----
export async function importCrxCsvAction(input: unknown): Promise<ActionResult<{ imported: number; skipped: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { csv } = zodValidate(z.object({ csv: z.string().min(1).max(100_000) }), input)
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^crxid/i.test(l))
    const imported: number[] = []
    const skipped: string[] = []
    for (const line of lines) {
      const [crxId, updateUrl, backupUpdateUrl, name] = line.split(",").map((x) => (x || "").trim())
      if (!isValidCrxId(crxId || "")) { skipped.push(`${line.slice(0, 40)}（ID 格式非法）`); continue }
      if (!isValidUpdateUrl(updateUrl || "")) { skipped.push(`${crxId.slice(0, 8)}…（update_url 非法）`); continue }
      const exists = await db.crxPlugin.findUnique({ where: { crxId } })
      if (exists) { skipped.push(`${crxId.slice(0, 8)}…（已存在）`); continue }
      await db.crxPlugin.create({
        data: {
          crxId, name: name || `扩展 ${crxId.slice(0, 8)}…`,
          updateUrl, backupUpdateUrl: backupUpdateUrl || null,
          permissions: [], tags: [],
          createdByName: ctx.username, updatedByName: ctx.username,
        },
      })
      imported.push(1)
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_PLUGIN_CSV_IMPORT",
      resourceType: "CRX_PLUGIN", resourceId: "csv-batch",
      after: { lines: lines.length, imported: imported.length, skipped: skipped.length }, severity: "INFO",
    })
    return { imported: imported.length, skipped }
  })
}

// ---- 5. 策略条目（五级配置写入：强制安装列表项） ----
const entrySchema = z.object({
  scopeType: z.enum(["GLOBAL", "GROUP", "USER", "SANDBOX"]),
  scopeId: z.string().default(""), // GLOBAL 恒空串
  crxId: z.string().length(32),
  updateUrl: z.string().max(300).optional().default(""),
  backupUpdateUrl: z.string().max(300).optional().default(""),
  lockedVersion: z.string().max(40).optional().default(""),
  allowIncognito: z.boolean().optional().nullable(),
  allowUserDisable: z.boolean().optional().nullable(),
  note: z.string().max(200).optional().default(""),
})

export async function saveCrxPolicyEntryAction(input: unknown): Promise<ActionResult<{ entryId: string }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(entrySchema, input)
    const plugin = await db.crxPlugin.findUnique({ where: { crxId: p.crxId } })
    if (!plugin || plugin.deletedAt) throw bizError(ErrorCode.NOT_FOUND, "插件必须先录入插件库（不能随意填写 ID）")
    if (p.updateUrl && !isValidUpdateUrl(p.updateUrl)) throw bizError(ErrorCode.PARAM_ERROR, "覆盖主源 update_url 格式非法")
    if (p.lockedVersion && !isValidVersion(p.lockedVersion)) throw bizError(ErrorCode.PARAM_ERROR, "锁定版本号格式非法")
    // 冲突校验：同一 CRX 同时在 forcelist 与 blocklist → 拦截
    const conflict = await checkForceBlocklistConflict({ scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId })
    if (!conflict.ok) throw bizError(ErrorCode.PARAM_ERROR, conflict.message || "配置冲突")
    // 沙箱数量上限
    if (p.scopeType === "SANDBOX") {
      if (!p.scopeId) throw bizError(ErrorCode.PARAM_ERROR, "沙箱级作用域必须指定 scopeId")
      const limit = await checkSandboxForcelistLimit(p.scopeId, 1)
      if (!limit.ok) throw bizError(ErrorCode.CONFLICT, limit.message)
    }
    const entry = await db.crxPolicyEntry.upsert({
      where: { scopeType_scopeId_crxId: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId } },
      create: {
        scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId,
        updateUrl: p.updateUrl || null, backupUpdateUrl: p.backupUpdateUrl || null, lockedVersion: p.lockedVersion || null,
        allowIncognito: p.allowIncognito ?? null, allowUserDisable: p.allowUserDisable ?? null,
        note: p.note || null, createdByUserId: ctx.userId, createdByName: ctx.username,
      },
      update: {
        updateUrl: p.updateUrl || null, backupUpdateUrl: p.backupUpdateUrl || null, lockedVersion: p.lockedVersion || null,
        allowIncognito: p.allowIncognito ?? null, allowUserDisable: p.allowUserDisable ?? null,
        note: p.note || null, deletedAt: null,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_POLICY_ENTRY_SAVE",
      resourceType: "CRX_POLICY", resourceId: `${p.scopeType}:${p.scopeId}:${p.crxId}`, resourceName: plugin.name,
      after: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId, updateUrl: p.updateUrl, backupUpdateUrl: p.backupUpdateUrl, lockedVersion: p.lockedVersion, allowIncognito: p.allowIncognito, allowUserDisable: p.allowUserDisable },
      severity: "WARN",
    })
    return { entryId: entry.id }
  })
}

export async function removeCrxPolicyEntryAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const entry = await db.crxPolicyEntry.findUnique({ where: { id } })
    if (!entry) throw bizError(ErrorCode.NOT_FOUND, "策略条目不存在")
    await db.crxPolicyEntry.update({ where: { id }, data: { deletedAt: new Date() } })
    // 沙箱安装状态 → 等待轮询软清理
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_POLICY_ENTRY_REMOVE",
      resourceType: "CRX_POLICY", resourceId: `${entry.scopeType}:${entry.scopeId}:${entry.crxId}`,
      before: { updateUrl: entry.updateUrl, lockedVersion: entry.lockedVersion }, severity: "WARN",
    })
    return { ok: true }
  })
}

// ---- 6. 黑名单 ----
export async function saveCrxBlocklistAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(z.object({
      scopeType: z.enum(["GLOBAL", "GROUP", "USER", "SANDBOX"]),
      scopeId: z.string().default(""),
      crxId: z.string().length(32),
      note: z.string().max(200).optional().default(""),
    }), input)
    if (!isValidCrxId(p.crxId)) throw bizError(ErrorCode.PARAM_ERROR, "CRX-ID 格式非法")
    const conflict = await db.crxPolicyEntry.findFirst({ where: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId, deletedAt: null } })
    if (conflict) throw bizError(ErrorCode.CONFLICT, `CRX ${p.crxId} 已在本作用域强制安装列表中，禁止同时加入黑名单`)
    await db.crxBlocklistEntry.upsert({
      where: { scopeType_scopeId_crxId: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId } },
      create: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId, note: p.note || null, createdByUserId: ctx.userId, createdByName: ctx.username },
      update: { note: p.note || null },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_BLOCKLIST_SAVE",
      resourceType: "CRX_BLOCKLIST", resourceId: `${p.scopeType}:${p.crxId}`,
      after: { scopeType: p.scopeType, scopeId: p.scopeId, crxId: p.crxId }, severity: "WARN",
    })
    return { ok: true }
  })
}

export async function removeCrxBlocklistAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const entry = await db.crxBlocklistEntry.findUnique({ where: { id } })
    if (!entry) throw bizError(ErrorCode.NOT_FOUND, "黑名单条目不存在")
    await db.crxBlocklistEntry.delete({ where: { id } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_BLOCKLIST_REMOVE",
      resourceType: "CRX_BLOCKLIST", resourceId: `${entry.scopeType}:${entry.crxId}`,
      before: { crxId: entry.crxId, note: entry.note }, severity: "WARN",
    })
    return { ok: true }
  })
}

// ---- 7. 手动重试安装（失败插件） ----
export async function retryCrxInstallAction(input: unknown): Promise<ActionResult<{ reset: number }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(z.object({
      workspaceId: z.string().optional(),
      crxId: z.string().optional(),
      all: z.boolean().optional().default(false), // 批量重试全部失败插件
    }), input)
    const where = p.all
      ? { state: { in: ["PRIMARY_FAILED", "BACKUP_RETRY", "ALL_FAILED", "VERSION_MISMATCH"] } }
      : { AND: [{ state: { in: ["PRIMARY_FAILED", "BACKUP_RETRY", "ALL_FAILED", "VERSION_MISMATCH"] } }, ...(p.workspaceId ? [{ workspaceId: p.workspaceId }] : []), ...(p.crxId ? [{ crxId: p.crxId }] : [])] }
    const r = await db.crxInstallStatus.updateMany({ where, data: { state: "PENDING", attempts: 0, lastErrorCode: null } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_INSTALL_RETRY",
      resourceType: "CRX_INSTALL", resourceId: p.all ? "batch-all" : `${p.workspaceId || "*"}:${p.crxId || "*"}`,
      after: { reset: r.count, scope: p.all ? "全部失败插件" : "单个插件" }, severity: "WARN",
    })
    // 高危插件运行检测事件补充（WebHook：权限变更/重试操作事件）
    return { reset: r.count }
  })
}

// ---- 8. 灰度任务 ----
export async function createCrxGrayTaskAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(z.object({
      name: z.string().min(1).max(100),
      crxIds: z.array(z.string().length(32)).min(1, "至少选择一个插件"),
      workspaceIds: z.array(z.string()).min(1, "至少选择一个沙箱"),
      batchSize: z.number().int().min(1).max(20).optional().default(3),
      updateUrl: z.string().max(300).optional().default(""),
      lockedVersion: z.string().max(40).optional().default(""),
    }), input)
    // 校验插件全部在库
    for (const crxId of p.crxIds) {
      const lib = await db.crxPlugin.findUnique({ where: { crxId } })
      if (!lib || lib.deletedAt) throw bizError(ErrorCode.NOT_FOUND, `插件 ${crxId} 不在插件库中`)
    }
    if (p.updateUrl && !isValidUpdateUrl(p.updateUrl)) throw bizError(ErrorCode.PARAM_ERROR, "update_url 格式非法")
    if (p.lockedVersion && !isValidVersion(p.lockedVersion)) throw bizError(ErrorCode.PARAM_ERROR, "版本号格式非法")
    const task = await db.crxGrayTask.create({
      data: {
        name: p.name,
        entriesJson: JSON.stringify(p.crxIds.map((crxId) => ({ crxId, updateUrl: p.updateUrl || undefined, lockedVersion: p.lockedVersion || undefined }))),
        targetIds: p.workspaceIds,
        batchSize: p.batchSize,
        total: p.workspaceIds.length,
        createdByUserId: ctx.userId, createdByName: ctx.username,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_GRAY_CREATE",
      resourceType: "CRX_GRAY_TASK", resourceId: task.id, resourceName: p.name,
      after: { plugins: p.crxIds, targets: p.workspaceIds.length, batchSize: p.batchSize }, severity: "WARN",
    })
    return { id: task.id }
  })
}

// 灰度回滚（仅超管）
export async function rollbackCrxGrayTaskAction(input: unknown): Promise<ActionResult<{ removed: number }>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN"])
    const { id, reason } = zodValidate(z.object({ id: z.string(), reason: z.string().max(300).optional().default("") }), input)
    const task = await db.crxGrayTask.findUnique({ where: { id } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "灰度任务不存在")
    if (["ROLLED_BACK", "SUCCESS"].includes(task.status)) throw bizError(ErrorCode.CONFLICT, `任务已 ${task.status}，无法回滚`)
    const entries = JSON.parse(task.entriesJson) as Array<{ crxId: string }>
    const targets = (Array.isArray(task.targetIds) ? task.targetIds : []) as string[]
    let removed = 0
    for (const workspaceId of targets) {
      for (const e of entries) {
        const r = await db.crxPolicyEntry.updateMany({
          where: { scopeType: "SANDBOX", scopeId: workspaceId, crxId: e.crxId, note: `灰度任务 ${task.name}` },
          data: { deletedAt: new Date() },
        })
        removed += r.count
      }
    }
    await db.crxGrayTask.update({ where: { id }, data: { status: "ROLLED_BACK", rollbackReason: reason, finishedAt: new Date() } })
    await db.crxInstallStatus.updateMany({
      where: { workspaceId: { in: targets }, crxId: { in: entries.map((e) => e.crxId) } },
      data: { state: "REMOVED" },
    }).catch(() => { /* 非关键 */ })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_GRAY_ROLLBACK",
      resourceType: "CRX_GRAY_TASK", resourceId: id, resourceName: task.name, severity: "CRITICAL",
      after: { removed, reason, targets: targets.length },
    })
    await raiseAlert({
      title: `CRX 灰度任务已回滚：${task.name}`,
      level: "WARNING",
      content: `超管 ${ctx.username} 回滚灰度任务 ${task.name}：移除 ${removed} 条沙箱插件策略${reason ? `（原因：${reason}）` : ""}`,
      resourceType: "CRX_GRAY_TASK", resourceId: id,
      webhookPayload: { event: "crx.gray_rolled_back", taskId: id, taskName: task.name, removed, reason },
    })
    return { removed }
  })
}

// ---- 9. 沙箱 CRX 设置（继承开关 / 黑名单豁免） ----
export async function setSandboxCrxSettingsAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(z.object({
      workspaceId: z.string(),
      crxInheritEnabled: z.boolean().optional(),
      crxBlocklistExempt: z.boolean().optional(),
    }), input)
    if (p.crxBlocklistExempt === true) {
      // 黑名单豁免仅超管可开（敏感操作）
      await requireRole(["SUPER_ADMIN"])
    }
    const ws = await db.browserWorkspace.findUnique({ where: { id: p.workspaceId }, select: { id: true, name: true, crxInheritEnabled: true, crxBlocklistExempt: true } })
    if (!ws) throw bizError(ErrorCode.NOT_FOUND, "沙箱不存在")
    await db.browserWorkspace.update({
      where: { id: p.workspaceId },
      data: {
        ...(p.crxInheritEnabled !== undefined ? { crxInheritEnabled: p.crxInheritEnabled } : {}),
        ...(p.crxBlocklistExempt !== undefined ? { crxBlocklistExempt: p.crxBlocklistExempt } : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_SANDBOX_SETTINGS",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      before: { crxInheritEnabled: ws.crxInheritEnabled, crxBlocklistExempt: ws.crxBlocklistExempt },
      after: { crxInheritEnabled: p.crxInheritEnabled ?? ws.crxInheritEnabled, crxBlocklistExempt: p.crxBlocklistExempt ?? ws.crxBlocklistExempt },
      severity: "WARN",
    })
    return { ok: true }
  })
}

// ============================================================
// r13c：批量策略下发（三级：用户组/用户/单沙箱 × 多选插件）
// 一次操作把 N 个插件下发到 M 个目标作用域（N×M 条策略条目），
// 逐对校验（库存在性/黑名单冲突/沙箱数量上限），逐对 upsert（幂等，已有则覆盖更新），
// 失败对跳过并汇总返回 —— 企业批量运维入口（对应 13 项清单「插件策略下发」）
// ============================================================
export async function batchDeployCrxPolicyAction(input: unknown): Promise<ActionResult<{
  deployed: number
  skipped: number
  conflicts: string[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
    const p = zodValidate(z.object({
      crxIds: z.array(z.string().length(32)).min(1, "至少选择一个插件").max(50),
      scopeType: z.enum(["GROUP", "USER", "SANDBOX"]),
      scopeIds: z.array(z.string().min(1)).min(1, "至少选择一个目标").max(100),
      updateUrl: z.string().max(300).optional().default(""),
      backupUpdateUrl: z.string().max(300).optional().default(""),
      lockedVersion: z.string().max(40).optional().default(""),
      note: z.string().max(200).optional().default(""),
    }), input)

    if (p.updateUrl && !isValidUpdateUrl(p.updateUrl)) throw bizError(ErrorCode.PARAM_ERROR, "覆盖主源 update_url 格式非法")
    if (p.lockedVersion && !isValidVersion(p.lockedVersion)) throw bizError(ErrorCode.PARAM_ERROR, "锁定版本号格式非法")

    // 目标作用域存在性校验
    if (p.scopeType === "GROUP") {
      const groups = await db.group.findMany({ where: { id: { in: p.scopeIds }, deletedAt: null }, select: { id: true, name: true } })
      if (groups.length !== p.scopeIds.length) throw bizError(ErrorCode.NOT_FOUND, "部分用户组不存在或已删除")
    } else if (p.scopeType === "USER") {
      const users = await db.user.findMany({ where: { id: { in: p.scopeIds }, deletedAt: null }, select: { id: true, username: true } })
      if (users.length !== p.scopeIds.length) throw bizError(ErrorCode.NOT_FOUND, "部分用户不存在或已删除")
    } else {
      const wss = await db.browserWorkspace.findMany({ where: { id: { in: p.scopeIds }, deletedAt: null }, select: { id: true } })
      if (wss.length !== p.scopeIds.length) throw bizError(ErrorCode.NOT_FOUND, "部分沙箱不存在或已删除")
    }

    // 插件库存在性（批量预取）
    const plugins = await db.crxPlugin.findMany({ where: { crxId: { in: p.crxIds }, deletedAt: null }, select: { crxId: true, name: true } })
    const pluginMap = new Map(plugins.map((x) => [x.crxId, x.name]))
    for (const crxId of p.crxIds) {
      if (!pluginMap.has(crxId)) throw bizError(ErrorCode.NOT_FOUND, `插件 ${crxId} 不在插件库中（必须先入库）`)
    }

    let deployed = 0
    let skipped = 0
    const conflicts: string[] = []

    for (const crxId of p.crxIds) {
      for (const scopeId of p.scopeIds) {
        // 逐对冲突校验（forcelist × blocklist 交集）
        const conflict = await checkForceBlocklistConflict({ scopeType: p.scopeType, scopeId, crxId })
        if (!conflict.ok) {
          skipped += 1
          conflicts.push(`${pluginMap.get(crxId) || crxId} → ${scopeId.slice(0, 8)}：${conflict.message || "黑名单冲突"}`)
          continue
        }
        // 沙箱级数量上限
        if (p.scopeType === "SANDBOX") {
          const existing = await db.crxPolicyEntry.count({ where: { scopeType: "SANDBOX", scopeId, deletedAt: null } })
          const already = await db.crxPolicyEntry.findFirst({ where: { scopeType: "SANDBOX", scopeId, crxId, deletedAt: null }, select: { id: true } })
          if (!already && existing >= MAX_FORCED_EXTENSIONS_PER_SANDBOX) {
            skipped += 1
            conflicts.push(`${pluginMap.get(crxId) || crxId} → 沙箱 ${scopeId.slice(0, 8)}：超出单沙箱上限 ${MAX_FORCED_EXTENSIONS_PER_SANDBOX}`)
            continue
          }
        }
        await db.crxPolicyEntry.upsert({
          where: { scopeType_scopeId_crxId: { scopeType: p.scopeType, scopeId, crxId } },
          create: {
            scopeType: p.scopeType, scopeId, crxId,
            updateUrl: p.updateUrl || null, backupUpdateUrl: p.backupUpdateUrl || null, lockedVersion: p.lockedVersion || null,
            note: p.note || `批量下发（${pluginMap.get(crxId)}）`,
            createdByUserId: ctx.userId, createdByName: ctx.username,
          },
          update: {
            updateUrl: p.updateUrl || null, backupUpdateUrl: p.backupUpdateUrl || null, lockedVersion: p.lockedVersion || null,
            note: p.note || null, deletedAt: null,
          },
        })
        deployed += 1
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CRX_POLICY_BATCH_DEPLOY",
      resourceType: "CRX_POLICY", resourceId: `batch:${p.scopeType}`,
      after: { scopeType: p.scopeType, targets: p.scopeIds.length, plugins: p.crxIds.length, deployed, skipped, conflicts: conflicts.slice(0, 10) },
      severity: "WARN",
    })
    return { deployed, skipped, conflicts }
  })
}
