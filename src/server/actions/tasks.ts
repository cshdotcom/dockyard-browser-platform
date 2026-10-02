"use server"

// 定时任务 Server Actions：启停 / 手动执行一次（走内部 cron HTTP 接口，防请求锁死）/ 编辑 cron 与超时
// 注意：定时任务控制属于运维控制面（维护模式下任务仍需可管理），故不做 requireWritableMode 拦截。

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zPrecision } from "@/lib/validators"
import { ENV } from "@/lib/env"
import { bizError, ErrorCode } from "@/lib/errors"

// ---- 1. 启用 / 禁用任务 ----

const toggleSchema = z.object({
  code: z.string().min(1).max(64),
  enabled: z.boolean(),
})

export async function toggleTaskAction(input: unknown): Promise<ActionResult<{ code: string; enabled: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(toggleSchema, input)

    const task = await db.scheduleTask.findUnique({ where: { code: p.code } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "任务不存在")
    if (task.enabled === p.enabled) return { code: task.code, enabled: task.enabled }

    await db.scheduleTask.update({ where: { code: task.code }, data: { enabled: p.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_TOGGLE",
      resourceType: "TASK",
      resourceId: task.code,
      resourceName: task.name,
      before: { enabled: task.enabled },
      after: { enabled: p.enabled },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { code: task.code, enabled: p.enabled }
  })
}

// ---- 2. 手动执行一次（内部转发到 cron HTTP 接口，绝不直接 import 执行函数） ----

const executeSchema = z.object({ code: z.string().min(1).max(64) })

export interface TaskExecuteResult {
  code: string
  cronCode: number
  cronMsg: string
  httpStatus: number
  ok: boolean
}

export async function executeTaskNowAction(input: unknown): Promise<ActionResult<TaskExecuteResult>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(executeSchema, input)

    const task = await db.scheduleTask.findUnique({ where: { code: p.code } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "任务不存在")

    // 服务端内部请求 cron 接口（独立 HTTP 请求，隔离执行上下文，防止直接调用执行函数导致请求锁死）
    let httpStatus = 0
    let cronCode = -1
    let cronMsg = ""
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 100_000) // 最长等待 100s，超过提示查看执行日志
      const res = await fetch(`http://localhost:${ENV.appPort}/api/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": ENV.cronSecret },
        body: JSON.stringify({ taskCode: p.code }),
        cache: "no-store",
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      httpStatus = res.status
      let json: { code?: number; msg?: string } | null = null
      try {
        json = (await res.json()) as { code?: number; msg?: string }
      } catch {
        json = null
      }
      cronCode = typeof json?.code === "number" ? json.code : res.status
      cronMsg = json?.msg || (res.ok ? "已触发执行" : `cron 接口返回 HTTP ${res.status}`)
    } catch (e) {
      cronMsg = e instanceof Error && e.name === "AbortError" ? "执行等待超时，请稍后在执行日志中查看结果" : `触发失败：${e instanceof Error ? e.message : String(e)}`
    }
    const ok = cronCode === 0

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_EXECUTE",
      resourceType: "TASK",
      resourceId: task.code,
      resourceName: task.name,
      after: { manual: true, httpStatus, cronCode, cronMsg: cronMsg.slice(0, 300) },
      severity: ok ? "INFO" : "WARN",
    })
    return { code: task.code, cronCode, cronMsg, httpStatus, ok }
  })
}

// ---- 3. 编辑 cron 表达式 / 超时时间 ----

const CRON_FIELD_RE = /^(\S+\s+){4}\S+$/ // 标准5字段（分 时 日 月 周）

const updateSchema = z.object({
  code: z.string().min(1).max(64),
  cronExpr: z.string().min(5, "cron 表达式至少5个字段").max(64).regex(CRON_FIELD_RE, "cron 表达式必须为5字段格式：分 时 日 月 周（空格分隔）"),
  timeoutSec: zPrecision("超时时间（秒）", 5, 86400),
})

export async function updateTaskAction(
  input: unknown
): Promise<ActionResult<{ code: string; cronExpr: string; timeoutSec: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(updateSchema, input)

    const task = await db.scheduleTask.findUnique({ where: { code: p.code } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "任务不存在")

    await db.scheduleTask.update({
      where: { code: task.code },
      data: { cronExpr: p.cronExpr, timeoutSec: Math.round(p.timeoutSec) },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_UPDATE",
      resourceType: "TASK",
      resourceId: task.code,
      resourceName: task.name,
      before: { cronExpr: task.cronExpr, timeoutSec: task.timeoutSec },
      after: { cronExpr: p.cronExpr, timeoutSec: Math.round(p.timeoutSec) },
      severity: "INFO",
    })
    return { code: task.code, cronExpr: p.cronExpr, timeoutSec: Math.round(p.timeoutSec) }
  })
}

// ============================================================
// r23：自定时任务（自定义任务）CRUD + 批量操作 + 日志清理
// ============================================================

import { TASKS, customExecMeta } from "@/server/tasks/engine"
import { validateCustomExecParams } from "@/server/tasks/custom-exec"
import { parseCron, nextCronRun, describeCron } from "@/lib/cron-next"

// ---- 4. 可用任务类型清单（自定义任务创建表单用；r24-a：参数化类型标记 paramKind）----
export async function listCustomTaskTypesAction(): Promise<ActionResult<{ items: { code: string; description: string; paramKind: "shell" | "chain" | "webhook" | null }[] }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const nameMap: Record<string, string> = {}
    const rows = await db.scheduleTask.findMany({ where: { isCustom: false }, select: { code: true, name: true } })
    for (const r of rows) nameMap[r.code] = r.name
    const items = Object.keys(TASKS).map((code) => {
      const meta = customExecMeta(code)
      return {
        code,
        description: meta ? `${meta.name} · ${meta.description}` : (nameMap[code] || code),
        paramKind: meta ? (meta.kind as "shell" | "chain" | "webhook") : null,
      }
    })
    return { items }
  })
}

// ---- 5. 创建自定义任务（r24-a：params 携带参数化执行体内容，存 paramsJson）----
const createCustomSchema = z.object({
  name: z.string().min(2, "任务名称至少2个字符").max(64),
  taskType: z.string().min(1).max(64),
  cronExpr: z.string().min(5).max(64),
  timeoutSec: zPrecision("超时时间（秒）", 5, 86400),
  description: z.string().max(300).optional(),
  enabled: z.boolean().optional().default(true),
  params: z.record(z.string(), z.unknown()).optional(), // r24-a：参数化执行体（shell/chain/webhook）执行内容
})

export async function createCustomTaskAction(input: unknown): Promise<ActionResult<{ code: string; name: string; cronExpr: string; nextRunAt: string | null; describe: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(createCustomSchema, input)

    if (!TASKS[p.taskType]) throw bizError(ErrorCode.PARAM_ERROR, `任务类型不存在：${p.taskType}`)
    const cron = parseCron(p.cronExpr)
    if (!cron.ok) throw bizError(ErrorCode.PARAM_ERROR, cron.error || "cron 表达式非法")
    const next = nextCronRun(p.cronExpr)
    if (!next) throw bizError(ErrorCode.PARAM_ERROR, "cron 表达式无法计算出下次运行时间（可能永不触发）")

    // r24-a：参数化执行体内容校验（shell 黑名单/chain 步骤/webhook SSRF 参数）
    let paramsJson: string | null = null
    if (p.params !== undefined) {
      const v = validateCustomExecParams(p.taskType, p.params, ENV.storageLocalPath)
      if (!v.ok) throw bizError(ErrorCode.PARAM_ERROR, `执行内容校验失败：${v.error}`)
      if (v.kind) paramsJson = JSON.stringify(p.params)
    }

    // 同名检查
    const dup = await db.scheduleTask.findFirst({ where: { name: p.name } })
    if (dup) throw bizError(ErrorCode.CONFLICT, `已存在同名任务「${p.name}」`)

    const code = `custom:${crypto.randomUUID().slice(0, 12)}`
    await db.scheduleTask.create({
      data: {
        code,
        name: p.name,
        cronExpr: p.cronExpr,
        enabled: p.enabled,
        timeoutSec: Math.round(p.timeoutSec),
        isCustom: true,
        taskType: p.taskType,
        paramsJson,
        description: p.description ?? null,
        createdByUserId: ctx.userId,
        nextRunAt: next,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_CUSTOM_CREATE",
      resourceType: "TASK",
      resourceId: code,
      resourceName: p.name,
      after: { taskType: p.taskType, cronExpr: p.cronExpr, timeoutSec: p.timeoutSec, enabled: p.enabled, description: p.description ?? null, paramsJson: paramsJson ? `${paramsJson.slice(0, 300)}${paramsJson.length > 300 ? "…" : ""}` : null },
      severity: "INFO",
    })
    return { code, name: p.name, cronExpr: p.cronExpr, nextRunAt: next.toISOString(), describe: describeCron(p.cronExpr) }
  })
}

// ---- 6. 编辑自定义任务（名称/类型/cron/超时/描述/启停/执行内容） ----
const updateCustomSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(2).max(64).optional(),
  taskType: z.string().min(1).max(64).optional(),
  cronExpr: z.string().min(5).max(64).optional(),
  timeoutSec: zPrecision("超时时间（秒）", 5, 86400).optional(),
  description: z.string().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(), // r24-a：更新参数化执行体内容（undefined=不改）
})

export async function updateCustomTaskAction(input: unknown): Promise<ActionResult<{ code: string; nextRunAt: string | null; describe: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(updateCustomSchema, input)

    const task = await db.scheduleTask.findUnique({ where: { code: p.code } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "任务不存在")
    if (!task.isCustom) throw bizError(ErrorCode.FORBIDDEN, "内置任务的配置只能修改 cron/超时/启停（不能改类型与名称）")

    const data: Record<string, unknown> = {}
    if (p.name) {
      const dup = await db.scheduleTask.findFirst({ where: { name: p.name, code: { not: task.code } } })
      if (dup) throw bizError(ErrorCode.CONFLICT, `已存在同名任务「${p.name}」`)
      data.name = p.name
    }
    if (p.taskType) {
      if (!TASKS[p.taskType]) throw bizError(ErrorCode.PARAM_ERROR, `任务类型不存在：${p.taskType}`)
      data.taskType = p.taskType
    }
    // r24-a：执行内容更新（类型切换或参数变更时校验）
    const effectiveType = (p.taskType || task.taskType || "") as string
    if (p.params !== undefined) {
      const v = validateCustomExecParams(effectiveType, p.params, ENV.storageLocalPath)
      if (!v.ok) throw bizError(ErrorCode.PARAM_ERROR, `执行内容校验失败：${v.error}`)
      data.paramsJson = v.kind ? JSON.stringify(p.params) : null
    } else if (p.taskType && p.taskType !== task.taskType) {
      // 切换到非参数化类型：清空旧参数
      data.paramsJson = null
    }
    if (p.cronExpr) {
      const cron = parseCron(p.cronExpr)
      if (!cron.ok) throw bizError(ErrorCode.PARAM_ERROR, cron.error || "cron 表达式非法")
      const next = nextCronRun(p.cronExpr)
      if (!next) throw bizError(ErrorCode.PARAM_ERROR, "cron 表达式无法计算出下次运行时间")
      data.cronExpr = p.cronExpr
      data.nextRunAt = next
    }
    if (p.timeoutSec !== undefined) data.timeoutSec = Math.round(p.timeoutSec)
    if (p.description !== undefined) data.description = p.description
    if (p.enabled !== undefined) data.enabled = p.enabled

    await db.scheduleTask.update({ where: { code: task.code }, data })
    const updated = await db.scheduleTask.findUnique({ where: { code: task.code } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_CUSTOM_UPDATE",
      resourceType: "TASK",
      resourceId: task.code,
      resourceName: updated?.name ?? task.name,
      before: { name: task.name, taskType: task.taskType, cronExpr: task.cronExpr, timeoutSec: task.timeoutSec, enabled: task.enabled },
      after: data,
      severity: "INFO",
    })
    return { code: task.code, nextRunAt: updated?.nextRunAt?.toISOString() ?? null, describe: describeCron(updated?.cronExpr || task.cronExpr) }
  })
}

// ---- 7. 删除自定义任务（含其历史日志；内置任务不可删） ----
export async function deleteCustomTaskAction(input: unknown): Promise<ActionResult<{ code: string; deletedLogs: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ code: z.string().min(1).max(64) }), input)
    const task = await db.scheduleTask.findUnique({ where: { code: p.code } })
    if (!task) throw bizError(ErrorCode.NOT_FOUND, "任务不存在")
    if (!task.isCustom) throw bizError(ErrorCode.FORBIDDEN, "内置任务不可删除（只能停用）")

    const logs = await db.scheduleTaskLog.deleteMany({ where: { taskCode: task.code } })
    await db.scheduleTask.delete({ where: { code: task.code } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_CUSTOM_DELETE",
      resourceType: "TASK",
      resourceId: task.code,
      resourceName: task.name,
      before: { name: task.name, taskType: task.taskType, cronExpr: task.cronExpr },
      after: { deletedLogs: logs.count },
      severity: "WARN",
    })
    return { code: task.code, deletedLogs: logs.count }
  })
}

// ---- 8. 批量启停 ----
export async function batchToggleTasksAction(input: unknown): Promise<ActionResult<{ enabled: number; disabled: number; skipped: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ codes: z.array(z.string().min(1).max(64)).min(1, "至少选择一个任务").max(100), enabled: z.boolean() }), input)
    let enabled = 0
    let disabled = 0
    let skipped = 0
    for (const code of p.codes) {
      const task = await db.scheduleTask.findUnique({ where: { code } })
      if (!task) { skipped++; continue }
      if (task.enabled === p.enabled) { skipped++; continue }
      await db.scheduleTask.update({ where: { code }, data: { enabled: p.enabled } })
      if (p.enabled) enabled++
      else disabled++
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_BATCH_TOGGLE",
      resourceType: "TASK",
      resourceId: p.codes.join(","),
      after: { enabled: p.enabled, count: p.codes.length, applied: enabled + disabled, skipped },
      severity: p.enabled ? "INFO" : "WARN",
    })
    return { enabled: p.enabled ? enabled + disabled : 0, disabled: p.enabled ? 0 : enabled + disabled, skipped }
  })
}

// ---- 9. 批量立即执行（逐个触发内部 cron 接口；汇总结果） ----
export async function batchExecuteTasksAction(input: unknown): Promise<ActionResult<{ results: { code: string; ok: boolean; message: string }[]; ok: number; fail: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ codes: z.array(z.string().min(1).max(64)).min(1, "至少选择一个任务").max(20, "单批最多20个") }), input)

    const results: { code: string; ok: boolean; message: string }[] = []
    for (const code of p.codes) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 100_000)
        const res = await fetch(`http://localhost:${ENV.appPort}/api/cron`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": ENV.cronSecret },
          body: JSON.stringify({ taskCode: code }),
          cache: "no-store",
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        const json = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
        const ok = json?.code === 0
        results.push({ code, ok, message: json?.msg || (res.ok ? "已触发" : `HTTP ${res.status}`) })
      } catch (e) {
        results.push({ code, ok: false, message: e instanceof Error ? e.message : String(e) })
      }
    }
    const ok = results.filter((r) => r.ok).length
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_BATCH_EXECUTE",
      resourceType: "TASK",
      resourceId: p.codes.join(","),
      after: { total: p.codes.length, ok, fail: results.length - ok, detail: results.map((r) => `${r.code}:${r.ok ? "OK" : r.message.slice(0, 60)}`).slice(0, 10) },
      severity: ok === results.length ? "INFO" : "WARN",
    })
    return { results, ok, fail: results.length - ok }
  })
}

// ---- 10. 执行日志清理（按任务/状态/天数） ----
export async function cleanupTaskLogsAction(input: unknown): Promise<ActionResult<{ deleted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        days: z.number().int().min(1, "至少保留1天").max(3650).optional().default(30),
        taskCode: z.string().max(64).optional(),
        status: z.enum(["ALL", "SUCCESS", "FAILED", "TIMEOUT"]).optional().default("ALL"),
      }),
      input
    )
    const cutoff = new Date(Date.now() - p.days * 86400_000)
    const where: Record<string, unknown> = { startAt: { lt: cutoff } }
    if (p.taskCode) where.taskCode = p.taskCode
    if (p.status !== "ALL") where.status = p.status
    const r = await db.scheduleTaskLog.deleteMany({ where })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TASK_LOG_CLEANUP",
      resourceType: "TASK",
      resourceId: p.taskCode || "all",
      after: { days: p.days, status: p.status, deleted: r.count },
      severity: "WARN",
    })
    return { deleted: r.count }
  })
}

// ---- 11. cron 表达式校验与预览（创建/编辑表单实时反馈） ----
export async function previewCronAction(input: unknown): Promise<ActionResult<{ ok: boolean; error: string | null; describe: string; nextRuns: string[] }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ cronExpr: z.string().min(1).max(64) }), input)
    const parsed = parseCron(p.cronExpr)
    if (!parsed.ok) return { ok: false, error: parsed.error ?? "表达式非法", describe: "", nextRuns: [] }
    const runs: string[] = []
    let from = new Date()
    for (let i = 0; i < 3; i++) {
      const next = nextCronRun(p.cronExpr, from)
      if (!next) break
      runs.push(next.toISOString())
      from = next
    }
    return { ok: true, error: null, describe: describeCron(p.cronExpr), nextRuns: runs }
  })
}
