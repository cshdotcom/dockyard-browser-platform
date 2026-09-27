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
