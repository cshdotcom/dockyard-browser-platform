"use server"

// MCP 任务管理视图（管理员）：取消 / 重试入队 / 详情（含子项）
// 注意：执行引擎由 /api/mcp 负责，此处仅做管理操作

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// 任务详情（参数 / 结果 / 失败原因 / 子项前50条）
export async function getMcpTaskDetailAction(input: unknown): Promise<ActionResult<{
  task: {
    id: string
    taskUuid: string
    name: string
    code: string
    priority: string
    status: string
    paramsJson: string | null
    resultJson: string | null
    progress: number
    totalItems: number
    successItems: number
    failedItems: number
    failReasons: string[]
    userId: string | null
    startedAt: string | null
    finishedAt: string | null
    createdAt: string
  }
  items: { id: string; targetType: string; targetId: string; status: string; error: string | null; finishedAt: string | null }[]
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const task = await db.mcpTask.findUnique({ where: { id } })
    if (!task) throw new Error("任务不存在")
    const items = await db.mcpTaskItem.findMany({
      where: { taskId: id },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { id: true, targetType: true, targetId: true, status: true, error: true, finishedAt: true },
    })
    let failReasons: string[] = []
    try {
      failReasons = task.failReasonsJson ? (JSON.parse(task.failReasonsJson) as string[]) : []
    } catch {
      failReasons = []
    }
    return {
      task: {
        id: task.id,
        taskUuid: task.taskUuid,
        name: task.name,
        code: task.code,
        priority: task.priority,
        status: task.status,
        paramsJson: task.paramsJson,
        resultJson: task.resultJson,
        progress: task.progress,
        totalItems: task.totalItems,
        successItems: task.successItems,
        failedItems: task.failedItems,
        failReasons,
        userId: task.userId,
        startedAt: task.startedAt ? task.startedAt.toISOString() : null,
        finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
        createdAt: task.createdAt.toISOString(),
      },
      items: items.map((i) => ({
        id: i.id,
        targetType: i.targetType,
        targetId: i.targetId,
        status: i.status,
        error: i.error,
        finishedAt: i.finishedAt ? i.finishedAt.toISOString() : null,
      })),
    }
  })
}

// 取消任务：PENDING / RUNNING → CANCELLED
export async function cancelMcpTaskAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const task = await db.mcpTask.findUnique({ where: { id } })
    if (!task) throw new Error("任务不存在")
    if (task.status !== "PENDING" && task.status !== "RUNNING") throw new Error(`仅待执行/执行中任务可取消（当前 ${task.status}）`)
    const updated = await db.mcpTask.update({
      where: { id },
      data: { status: "CANCELLED", finishedAt: new Date() },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "MCP_TASK_CANCEL",
      resourceType: "MCP_TASK",
      resourceId: id,
      resourceName: task.name,
      ownerUserId: task.userId,
      createdByUserId: task.createdByUserId,
      severity: "WARN",
      before: { status: task.status, progress: task.progress },
      after: { status: updated.status },
    })
    return { id, status: updated.status }
  })
}

// 重试失败任务：重新入队 → 置回 PENDING（执行由 /api/mcp 执行引擎领取）
export async function retryMcpTaskAction(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const task = await db.mcpTask.findUnique({ where: { id } })
    if (!task) throw new Error("任务不存在")
    if (!["FAILED", "PARTIAL", "CANCELLED", "ROLLED_BACK"].includes(task.status)) {
      throw new Error(`仅失败/部分成功/已取消/已回滚任务可重试（当前 ${task.status}）`)
    }
    const updated = await db.mcpTask.update({
      where: { id },
      data: { status: "PENDING", progress: 0, startedAt: null, finishedAt: null, resultJson: null, failReasonsJson: null },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "MCP_TASK_RETRY",
      resourceType: "MCP_TASK",
      resourceId: id,
      resourceName: task.name,
      ownerUserId: task.userId,
      createdByUserId: task.createdByUserId,
      severity: "WARN",
      before: { status: task.status, progress: task.progress, successItems: task.successItems, failedItems: task.failedItems },
      after: { status: updated.status, requeued: true },
    })
    return { id, status: updated.status }
  })
}
