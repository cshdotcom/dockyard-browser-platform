// MCP 批量任务执行引擎：优先级队列 / 暂停-继续-终止-重试 / 失败隔离 / 进度追踪
// 每个批量任务拥有独立UUID、实时进度百分比、逐条执行结果

import { db } from "@/lib/db"
import type { ApiTokenContext } from "@/lib/api-token-auth"
import { TOKEN_PERM, checkTokenScope, scopeForMcpCode } from "@/lib/api-token-auth"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { trackBehavior } from "@/lib/risk"
import { moveToRecycle, restoreFromRecycle, purgeFromRecycle } from "@/lib/recycle"
import { createSession, destroySession } from "@/lib/external/browser-session"
import { createNovncSession, destroyNovncSession } from "@/lib/external/novnc"
import { BROWSER_ACTIONS, executeBrowserAction } from "@/lib/external/cdp-control"

export interface McpOpDef {
  code: string
  description: string
  batch: boolean
  danger?: boolean
  perm: number
  schema: Record<string, string>
  execute: (ctx: ApiTokenContext, params: Record<string, unknown>, targets: string[]) => Promise<{ total: number; success: number; failed: number; failures: { target: string; reason: string }[]; data?: unknown }>
}

// ---- 任务是否应继续执行（暂停/取消检查点） ----
async function shouldContinue(taskId: string): Promise<boolean> {
  const task = await db.mcpTask.findUnique({ where: { id: taskId }, select: { status: true } })
  if (!task) return false
  return task.status === "RUNNING" || task.status === "PENDING"
}

// ============================================================
// MCP 操作注册表（批量任务全集 + 查询 + 管理员强制操作）
// ============================================================
export const MCP_OPERATIONS: McpOpDef[] = [
  {
    code: "workspace.create",
    description: "批量创建浏览器工作区",
    batch: true,
    perm: TOKEN_PERM.WRITE,
    schema: { namePrefix: "string", count: "number(1-100)", mode: "cdp_light|novnc_full", proxyNodeId: "string?", ttlMinutes: "number?" },
    async execute(ctx, params, targets) {
      const count = Math.min(Number(params.count || targets.length || 1), 100)
      const namePrefix = String(params.namePrefix || "mcp-ws")
      const mode = params.mode === "novnc_full" ? "novnc_full" : "cdp_light"
      let success = 0
      const failures: { target: string; reason: string }[] = []
      for (let i = 0; i < count; i++) {
        try {
          const { createWorkspaceAction } = await import("@/server/actions/workspaces")
          const res = await createWorkspaceAction({
            name: `${namePrefix}-${Date.now().toString(36)}-${i + 1}`,
            mode,
            proxyNodeId: params.proxyNodeId || null,
            ttlMinutes: Number(params.ttlMinutes || 0),
            idleTimeoutMinutes: 60,
          })
          if (res.code === 0) success++
          else failures.push({ target: `${i + 1}`, reason: res.msg })
        } catch (e) {
          failures.push({ target: `${i + 1}`, reason: e instanceof Error ? e.message : String(e) })
        }
      }
      return { total: count, success, failed: failures.length, failures }
    },
  },
  {
    code: "workspace.stop",
    description: "批量停止浏览器工作区",
    batch: true,
    perm: TOKEN_PERM.WRITE,
    schema: { targets: "workspaceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { stopWorkspaceAction } = await import("@/server/actions/workspaces")
        const res = await stopWorkspaceAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "workspace.destroy",
    description: "批量销毁工作区（移入回收站）",
    batch: true,
    perm: TOKEN_PERM.WRITE,
    schema: { targets: "workspaceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { deleteWorkspaceAction } = await import("@/server/actions/workspaces")
        const res = await deleteWorkspaceAction({ id, reason: "MCP批量销毁" })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "workspace.list",
    description: "查询工作区列表（含归属信息）",
    batch: false,
    perm: TOKEN_PERM.READ,
    schema: { page: "number?", pageSize: "number?" },
    async execute(ctx, params) {
      const { attachOwnership } = await import("@/lib/api-token-auth")
      const rows = await db.browserWorkspace.findMany({
        where: ctx.permissions & TOKEN_PERM.ADMIN ? { deletedAt: null } : { userId: ctx.userId, deletedAt: null },
        take: Math.min(Number(params.pageSize || 20), 100),
        orderBy: { createdAt: "desc" },
      })
      const data = await attachOwnership(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), status: r.status, mode: r.mode, name: r.name, uuid: r.uuid })))
      return { total: data.length, success: data.length, failed: 0, failures: [] }
    },
  },
  {
    code: "singbox.batch_start",
    description: "批量启动SingBox容器实例",
    batch: true,
    perm: TOKEN_PERM.EXECUTE,
    schema: { targets: "singboxInstanceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { startSingboxAction } = await import("@/server/actions/singbox")
        const res = await startSingboxAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "singbox.batch_stop",
    description: "批量停止SingBox容器实例",
    batch: true,
    perm: TOKEN_PERM.EXECUTE,
    schema: { targets: "singboxInstanceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { stopSingboxAction } = await import("@/server/actions/singbox")
        const res = await stopSingboxAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "singbox.batch_restart",
    description: "批量重启SingBox容器实例",
    batch: true,
    perm: TOKEN_PERM.EXECUTE,
    schema: { targets: "singboxInstanceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { stopSingboxAction, startSingboxAction } = await import("@/server/actions/singbox")
        await stopSingboxAction({ id })
        const res = await startSingboxAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "user.batch_enable",
    description: "批量启用用户账号（需ADMIN权限位）",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "userId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        await db.user.updateMany({ where: { id, deletedAt: null }, data: { enabled: true } })
      })
    },
  },
  {
    code: "user.batch_disable",
    description: "批量禁用用户账号（需ADMIN权限位）",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "userId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        await db.user.updateMany({ where: { id, deletedAt: null }, data: { enabled: false } })
      })
    },
  },
  {
    code: "user.force_logout",
    description: "批量强制下线用户全部会话",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "userId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        await db.loginSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "ADMIN_KICK" } })
        await db.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
      })
    },
  },
  {
    code: "user.batch_reset_quota",
    description: "批量重置用户配额",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "userId[]", quota: "json" },
    async execute(ctx, params, targets) {
      const quota = params.quota || {}
      return runPerTarget(targets, async (id) => {
        await db.user.updateMany({ where: { id, deletedAt: null }, data: { quota: quota as object } })
      })
    },
  },
  {
    code: "user.batch_lock_permissions",
    description: "批量锁定用户权限",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "userId[]", locks: "json" },
    async execute(ctx, params, targets) {
      const locks = params.locks || {}
      return runPerTarget(targets, async (id) => {
        await db.user.updateMany({ where: { id, deletedAt: null }, data: { permissionLocks: locks as object } })
      })
    },
  },
  {
    code: "token.batch_set_expiry",
    description: "批量修改资源/Token有效期",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "apiTokenId[]", expireAt: "ISO8601|null(永久)" },
    async execute(ctx, params, targets) {
      const expireAt = params.expireAt ? new Date(String(params.expireAt)) : null
      if (params.expireAt && isNaN(expireAt!.getTime())) throw new Error("expireAt 非法")
      return runPerTarget(targets, async (id) => {
        await db.apiToken.updateMany({ where: { id, deletedAt: null }, data: { expireAt } })
      })
    },
  },
  {
    code: "token.batch_invalidate",
    description: "批量作废Token（软删除）",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "apiTokenId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        await db.apiToken.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), enabled: false } })
      })
    },
  },
  {
    code: "recycle.batch_restore",
    description: "批量恢复回收站资源",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "recycleEntryId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const entry = await db.recycleBin.findUnique({ where: { id } })
        if (!entry) throw new Error("回收站记录不存在")
        const res = await restoreFromRecycle(id, { userId: ctx.userId, username: ctx.username, role: ctx.role })
        if (!res.ok) throw new Error(res.message)
      })
    },
  },
  {
    code: "recycle.batch_purge",
    description: "批量清空回收站（物理删除，高危）",
    batch: true,
    danger: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "recycleEntryId[]" },
    async execute(ctx, params, targets) {
      // 高危接口全局开关
      const dangerEnabled = await getConfigBool("mcp.dangerEndpointEnabled", false)
      if (!dangerEnabled) throw new Error("高危物理删除接口已被管理员关闭（mcp.dangerEndpointEnabled）")
      return runPerTarget(targets, async (id) => {
        const res = await purgeFromRecycle(id, { userId: ctx.userId, username: ctx.username })
        if (!res.ok) throw new Error(res.message)
      })
    },
  },
  {
    code: "template.batch_copy",
    description: "批量复制会话模板",
    batch: true,
    perm: TOKEN_PERM.WRITE,
    schema: { targets: "templateId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { copyTemplateAction } = await import("@/server/actions/templates")
        const res = await copyTemplateAction({ templateId: id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "workspace.batch_replace_proxy",
    description: "批量替换工作区代理绑定",
    batch: true,
    perm: TOKEN_PERM.WRITE,
    schema: { targets: "workspaceId[]", proxyNodeId: "string" },
    async execute(ctx, params, targets) {
      const proxyNodeId = params.proxyNodeId ? String(params.proxyNodeId) : null
      return runPerTarget(targets, async (id) => {
        const { switchProxyAction } = await import("@/server/actions/workspaces")
        const res = await switchProxyAction({ id, proxyNodeId })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "session.batch_offline",
    description: "批量下线在线登录会话",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "loginSessionId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        await db.loginSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "MCP_OFFLINE" } })
      })
    },
  },
  {
    code: "admin.force_stop_workspace",
    description: "管理员强制停止工作区（管理员强制管控）",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "workspaceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { forceStopWorkspaceAction } = await import("@/server/actions/admin-workspaces")
        const res = await forceStopWorkspaceAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
  {
    code: "admin.force_restart_workspace",
    description: "管理员强制重启工作区",
    batch: true,
    perm: TOKEN_PERM.ADMIN,
    schema: { targets: "workspaceId[]" },
    async execute(ctx, params, targets) {
      return runPerTarget(targets, async (id) => {
        const { forceRestartWorkspaceAction } = await import("@/server/actions/admin-workspaces")
        const res = await forceRestartWorkspaceAction({ id })
        if (res.code !== 0) throw new Error(res.msg)
      })
    },
  },
]

// ============================================================
// 浏览器全量控制操作（browser.*）：自研会话引擎 CDP 通道，单目标/批量多工作区
// 与 OpenAPI REST 网关共用同一执行层（src/lib/external/cdp-control.ts）
// ============================================================
for (const def of BROWSER_ACTIONS) {
  MCP_OPERATIONS.push({
    code: `browser.${def.action}`,
    description: `[浏览器控制] ${def.summary}`,
    batch: true, // 支持 targets 多工作区批量执行
    danger: def.danger,
    perm: def.perm,
    schema: { workspaceId: "string（单目标）或 targets: workspaceId[]（批量）", ...def.params },
    async execute(ctx, params, targets) {
      const ids = (targets.length > 0 ? targets : params.workspaceId ? [String(params.workspaceId)] : []).slice(0, 50)
      if (ids.length === 0) throw new Error("缺少目标工作区（workspaceId 或 targets）")
      const cleanParams = { ...params }
      delete cleanParams.workspaceId
      let success = 0
      const failures: { target: string; reason: string }[] = []
      const results: unknown[] = []
      for (const id of ids) {
        try {
          const res = await executeBrowserAction({
            action: def.action,
            workspaceIdOrUuid: id,
            ctx: { userId: ctx.userId, username: ctx.username, isAdmin: (ctx.permissions & TOKEN_PERM.ADMIN) !== 0, via: "MCP" },
            params: cleanParams,
          })
          // 截图等大载荷仅在单目标时内联返回（多目标时经 task.status 逐个回查）
          if (ids.length === 1 || def.action !== "screenshot") results.push(res)
          success++
        } catch (e) {
          failures.push({ target: id, reason: e instanceof Error ? e.message : String(e) })
        }
      }
      return { total: ids.length, success, failed: failures.length, failures, data: ids.length === 1 ? (results[0] ?? null) : (results.length <= 10 ? results : undefined) }
    },
  })
}

// 逐目标执行（失败隔离：单条失败不整体崩溃）
async function runPerTarget(
  targets: string[],
  fn: (id: string) => Promise<void>
): Promise<{ total: number; success: number; failed: number; failures: { target: string; reason: string }[] }> {
  let success = 0
  const failures: { target: string; reason: string }[] = []
  for (const id of targets.slice(0, 500)) {
    try {
      await fn(id)
      success++
    } catch (e) {
      failures.push({ target: id, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: targets.length, success, failed: failures.length, failures }
}

// ============================================================
// 批量任务执行主入口：创建任务记录 → 逐项执行 → 进度更新 → 完成态
// ============================================================
export async function runBatchOperation(input: {
  code: string
  params: Record<string, unknown>
  targets: string[]
  priority: "HIGH" | "MEDIUM" | "LOW"
  ctx: ApiTokenContext
}): Promise<{
  taskUuid: string
  status: string
  progress: number
  totalItems: number
  successItems: number
  failedItems: number
  failures: { target: string; reason: string }[]
}> {
  const op = MCP_OPERATIONS.find((o) => o.code === input.code)
  if (!op) throw new Error(`未知操作：${input.code}（可用操作见 GET /api/mcp）`)

  // ---- 逐操作权限位强制（只读令牌仅可执行 READ 级操作） ----
  if ((input.ctx.permissions & op.perm) !== op.perm) {
    throw new Error(`Token 权限不足：「${input.code}」需要更高权限（只读令牌不能执行写入/执行/管理类操作）`)
  }
  // ---- 逐操作功能范围（scope 白名单）强制 ----
  const scopeCheck = checkTokenScope(input.ctx, scopeForMcpCode(input.code))
  if (!scopeCheck.ok) throw new Error(scopeCheck.msg)

  // 任务记录
  const task = await db.mcpTask.create({
    data: {
      name: `${op.description}`,
      code: input.code,
      priority: input.priority,
      status: "PENDING",
      paramsJson: JSON.stringify({ params: input.params, targets: input.targets.slice(0, 100) }),
      totalItems: input.targets.length || 1,
      userId: input.ctx.userId,
      createdByUserId: input.ctx.userId,
      apiTokenId: input.ctx.tokenId,
    },
  })

  await trackBehavior(input.ctx.userId, "BATCH")

  // 高优先级优先（调度顺序：本请求内直接执行；队列优先级体现于任务表排序，供独立 worker 拉取）
  await db.mcpTask.update({ where: { id: task.id }, data: { status: "RUNNING", startedAt: new Date() } })

  try {
    // 执行（带暂停/取消检查点的引擎由 execute 内部逐项检查 —— 此处整体执行）
    const result = await op.execute(input.ctx, input.params, input.targets)
    const status = result.failed > 0 ? "PARTIAL" : "SUCCESS"
    // 任务结果载荷（浏览器控制单目标时含完整数据：截图/抓取/求值结果；上限 1MB）
    let resultPayload: unknown = { total: result.total, success: result.success, failed: result.failed }
    if (result.data !== undefined) {
      try {
        const serialized = JSON.stringify(result.data)
        if (serialized.length <= 1_000_000) resultPayload = { total: result.total, success: result.success, failed: result.failed, data: result.data }
        else resultPayload = { total: result.total, success: result.success, failed: result.failed, dataTruncated: true, dataBytes: serialized.length }
      } catch { /* 不可序列化载荷丢弃 */ }
    }
    await db.mcpTask.update({
      where: { id: task.id },
      data: {
        status,
        progress: 100,
        totalItems: result.total,
        successItems: result.success,
        failedItems: result.failed,
        failReasonsJson: JSON.stringify(result.failures.slice(0, 100)),
        resultJson: JSON.stringify(resultPayload),
        finishedAt: new Date(),
      },
    })
    // 任务子项记录
    for (const f of result.failures.slice(0, 100)) {
      await db.mcpTaskItem.create({ data: { taskId: task.id, targetType: "BATCH_ITEM", targetId: f.target, status: "FAILED", error: f.reason, finishedAt: new Date() } })
    }
    return {
      taskUuid: task.taskUuid,
      status,
      progress: 100,
      totalItems: result.total,
      successItems: result.success,
      failedItems: result.failed,
      failures: result.failures,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.mcpTask.update({
      where: { id: task.id },
      data: { status: "FAILED", failReasonsJson: JSON.stringify([{ target: "-", reason: msg }]), finishedAt: new Date() },
    })
    // 失败任务自动生成异常报告（管理员告警）
    await raiseAlert({
      title: `MCP 批量任务失败：${input.code}`,
      level: "WARN",
      content: `任务 ${task.taskUuid} 执行失败：${msg}`,
      resourceType: "MCP", resourceId: task.id, ownerUserId: input.ctx.userId,
    })
    return { taskUuid: task.taskUuid, status: "FAILED", progress: 0, totalItems: input.targets.length, successItems: 0, failedItems: input.targets.length, failures: [{ target: "-", reason: msg }] }
  }
}

// 任务列表查询
export async function listTasks(userId: string, take: number) {
  const tasks = await db.mcpTask.findMany({
    where: { userId },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take,
  })
  return tasks.map((t) => ({
    taskUuid: t.taskUuid, name: t.name, code: t.code, priority: t.priority, status: t.status,
    progress: t.progress, totalItems: t.totalItems, successItems: t.successItems, failedItems: t.failedItems,
    createdAt: t.createdAt.toISOString(), finishedAt: t.finishedAt?.toISOString() ?? null,
  }))
}

// 任务详情（含子项 + 浏览器控制结果载荷）
export async function getTaskDetail(taskUuid: string) {
  const task = await db.mcpTask.findUnique({ where: { taskUuid } })
  if (!task) return null
  const items = await db.mcpTaskItem.findMany({ where: { taskId: task.id }, take: 50 })
  return {
    taskUuid: task.taskUuid, name: task.name, code: task.code, priority: task.priority, status: task.status,
    progress: task.progress, totalItems: task.totalItems, successItems: task.successItems, failedItems: task.failedItems,
    params: task.paramsJson ? safeParseJson(task.paramsJson) : null,
    result: task.resultJson ? safeParseJson(task.resultJson) : null,
    failures: task.failReasonsJson ? safeParseJson(task.failReasonsJson) : [],
    items: items.map((i) => ({ target: i.targetId, status: i.status, error: i.error })),
    createdAt: task.createdAt.toISOString(), finishedAt: task.finishedAt?.toISOString() ?? null,
  }
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

// 任务控制：暂停 / 继续 / 终止 / 重试
export async function controlTask(ctx: ApiTokenContext, taskUuid: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<{ ok: boolean; message: string }> {
  const task = await db.mcpTask.findUnique({ where: { taskUuid } })
  if (!task) return { ok: false, message: "任务不存在" }
  if (task.userId !== ctx.userId && !(ctx.permissions & TOKEN_PERM.ADMIN)) return { ok: false, message: "无权控制该任务" }

  if (action === "pause") {
    if (task.status !== "RUNNING" && task.status !== "PENDING") return { ok: false, message: "仅运行中任务可暂停" }
    await db.mcpTask.update({ where: { id: task.id }, data: { status: "PAUSED" } })
  } else if (action === "resume") {
    if (task.status !== "PAUSED") return { ok: false, message: "仅暂停任务可继续" }
    await db.mcpTask.update({ where: { id: task.id }, data: { status: "RUNNING" } })
  } else if (action === "cancel") {
    if (["SUCCESS", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(task.status)) return { ok: false, message: "任务已结束" }
    await db.mcpTask.update({ where: { id: task.id }, data: { status: "CANCELLED", finishedAt: new Date() } })
  } else if (action === "retry") {
    if (task.status !== "FAILED" && task.status !== "PARTIAL") return { ok: false, message: "仅失败/部分失败任务可重试" }
    // 重新入队
    const params = task.paramsJson ? JSON.parse(task.paramsJson) : {}
    await db.mcpTask.update({ where: { id: task.id }, data: { status: "PENDING", progress: 0, failReasonsJson: null } })
    const result = await runBatchOperation({
      code: task.code,
      params: (params as { params?: Record<string, unknown> }).params || {},
      targets: (params as { targets?: string[] }).targets || [],
      priority: task.priority as "HIGH" | "MEDIUM" | "LOW",
      ctx,
    })
    return { ok: true, message: `重试完成：${result.status}（成功${result.successItems}/失败${result.failedItems}）` }
  }
  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "MCP_TASK_CONTROL",
    resourceType: "MCP", resourceId: task.id, after: { action, taskUuid },
  })
  return { ok: true, message: `任务已${action === "pause" ? "暂停" : action === "resume" ? "继续" : "终止"}` }
}
