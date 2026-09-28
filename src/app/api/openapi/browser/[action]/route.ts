import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { authenticateApiToken, TOKEN_PERM } from "@/lib/api-token-auth"
import { executeBrowserAction, listBrowserActions, BROWSER_ACTIONS } from "@/lib/external/cdp-control"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { getConfigBool } from "@/lib/config"

// ============================================================
// OpenAPI 浏览器控制 REST 网关
//   POST /api/openapi/browser/<action>   body: { workspaceId, params: {...} }
//   GET  /api/openapi/browser            动作目录
// 与 MCP browser.* 共用同一执行层（归属强制/限流/审计/双形态执行）
// ============================================================

export async function GET() {
  // 动作目录（公开：仅描述，不含敏感信息）
  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: {
      protocol: "OpenAPI 3.0 compatible",
      endpoint: "/api/openapi/browser/<action>",
      method: "POST",
      auth: { type: "ApiKeyAuth", header: "x-api-key" },
      note: "body 携带 workspaceId 与动作参数；完整 schema 见 /api/openapi/doc",
      actions: listBrowserActions(),
    },
    traceId: crypto.randomUUID(),
  })
}

const bodySchema = z.object({
  workspaceId: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional().default({}),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const traceId = crypto.randomUUID()
  const { action } = await params

  const def = BROWSER_ACTIONS.find((a) => a.action === action)
  if (!def) {
    return NextResponse.json(
      { code: 40401, msg: `未知浏览器控制动作：${action}（目录见 GET /api/openapi/browser）`, data: null, traceId },
      { status: 404 },
    )
  }

  const auth = await authenticateApiToken(req, def.perm)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const ctx = auth.ctx!

  // 网关全局开关
  const mcpEnabled = await getConfigBool("mcp.enabled", true)
  if (!mcpEnabled) return NextResponse.json({ code: 40300, msg: "MCP/OpenAPI 网关已被管理员关闭", data: null, traceId }, { status: 403 })

  // 限流（独立通道 120 次/分钟）
  if (rateLimit(`openapiBrowser:${ctx.userId}`, 120, 60_000).allowed === false) {
    return NextResponse.json({ code: 42901, msg: "浏览器控制调用过于频繁，请稍后再试", data: null, traceId }, { status: 429 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ code: 40001, msg: parsed.error.issues[0]?.message || "参数错误", data: null, traceId })
  }

  try {
    const result = await executeBrowserAction({
      action,
      workspaceIdOrUuid: parsed.data.workspaceId,
      ctx: { userId: ctx.userId, username: ctx.username, isAdmin: (ctx.permissions & TOKEN_PERM.ADMIN) !== 0, via: "OPENAPI" },
      params: parsed.data.params,
    })
    return NextResponse.json({ code: 0, msg: "ok", data: result, traceId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : "浏览器控制执行失败"
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BROWSER_CONTROL_FAIL",
      resourceType: "WORKSPACE",
      resourceId: parsed.data.workspaceId,
      after: { action, via: "OPENAPI", error: msg.slice(0, 200) },
      severity: "WARN",
    })
    return NextResponse.json({ code: 40001, msg, data: null, traceId })
  }
}
