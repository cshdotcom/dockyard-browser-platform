"use server"

// ============================================================
// r37：Playground（沙箱 CDP 控制台）
//
// 目标：给用户一个安全的「试验场」——对自己的沙箱执行 CDP 级操作并实时查看
// 结果，验证链路健康（连接/目标/页面/网络代理/打印），也可用于调试脚本片段。
//
// 动作白名单（页面级安全子集；自动化重操作仍走 MCP/OpenAPI 权限体系）：
//   status / debug_info / get_tabs / screenshot / evaluate / print_pdf / navigate
// 门禁：
//   · requireAuth + 资源归属（executeBrowserAction 内：所有者/OPERATE 共享/管理员）
//   · blockPlayground 权限锁 + feature.playground 全局开关
//   · 双模式开放（cdp_light + novnc_full；VNC 会话有真实 CDP 端点）
//   · 限流 60 次/分钟/用户
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAuth, isPermissionLocked } from "@/lib/permissions"
import { db } from "@/lib/db"
import { getConfigBool } from "@/lib/config"
import { executeBrowserAction } from "@/lib/external/cdp-control"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"

const PLAYGROUND_ACTIONS = ["status", "debug_info", "get_tabs", "screenshot", "evaluate", "print_pdf", "navigate"] as const
type PlaygroundAction = (typeof PLAYGROUND_ACTIONS)[number]

export async function playgroundRunAction(input: unknown): Promise<ActionResult<{
  action: string
  workspaceId: string
  workspaceName: string
  mode: string
  data: unknown
  durationMs: number
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({
      workspaceId: zId,
      action: z.enum(PLAYGROUND_ACTIONS),
      params: z.record(z.string(), z.unknown()).optional().default({}),
    }), input)

    if (!(await getConfigBool("feature.playground", true))) {
      throw Object.assign(new Error("管理员已停用 Playground（功能开关）"), { code: 403 })
    }
    if (await isPermissionLocked(ctx.userId, "blockPlayground")) {
      throw Object.assign(new Error("管理员已禁止你使用 Playground（权限锁）"), { code: 403 })
    }
    if (!rateLimit(`playground:${ctx.userId}`, 60, 60_000).allowed) {
      throw Object.assign(new Error("Playground 操作过于频繁（60次/分钟），请稍后再试"), { code: 429 })
    }

    // evaluate 表达式长度限制（复用底层动作 100KB 上限；此处更严格）
    if (p.action === "evaluate" && String((p.params as Record<string, unknown>).expression || "").length > 20_000) {
      throw Object.assign(new Error("表达式过长（Playground 上限 20KB）"), { code: 400 })
    }

    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const result = await executeBrowserAction({
      action: p.action,
      workspaceIdOrUuid: p.workspaceId,
      ctx: { userId: ctx.userId, username: ctx.username, isAdmin, via: "INTERNAL" },
      params: p.params,
      allowNovnc: true,
    })

    return {
      action: result.action,
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      mode: result.mode,
      data: result.data,
      durationMs: result.durationMs,
    }
  })
}

/** Playground 网关票据测试（复用 getCdpGatewayTicketAction 的语义，直接转发） */
export async function playgroundTicketTestAction(input: unknown): Promise<ActionResult<{ reachable: boolean; detail: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId } = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true, cdpUrl: true, status: true, mode: true } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    if (ws.status !== "RUNNING") throw Object.assign(new Error("沙箱未运行"), { code: 409 })

    // CDP 端点真实拨测（/json/version）
    const base = (ws.cdpUrl || "").replace(/\/json\/?$/, "")
    if (!base.startsWith("http")) {
      return { reachable: false, detail: `无 HTTP CDP 基址（cdpUrl=${(ws.cdpUrl || "null").slice(0, 60)}；嵌入式/池形态端点为内部通道）` }
    }
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })
      const j = (await res.json().catch(() => null)) as { Browser?: string; webSocketDebuggerUrl?: string } | null
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "PLAYGROUND_PROBE",
        resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        after: { reachable: res.ok, browser: j?.Browser },
      }).catch(() => null)
      if (res.ok && j?.Browser) {
        return { reachable: true, detail: `CDP 端点健康：${j.Browser}（ws 端点 ${j.webSocketDebuggerUrl ? "可用" : "缺失"}）` }
      }
      return { reachable: false, detail: `CDP 端点响应异常（HTTP ${res.status}）` }
    } catch (e) {
      return { reachable: false, detail: `CDP 端点不可达：${e instanceof Error ? e.message : "网络错误"}` }
    }
  })
}
