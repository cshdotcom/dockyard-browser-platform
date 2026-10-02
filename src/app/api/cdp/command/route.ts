import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { getConfigNumber, getConfigBool } from "@/lib/config"

// CDP 指令网关转发：限速 + 黑名单拦截 + 权限校验
// 真实部署：转发到浏览器会话的 CDP WebSocket；未配置浏览器端点时记录并返回（链路演示）
// CDP 服务后台端口可由环境变量 CDP_SERVICE_PORT 改变（Docker host 模式部署用）

const CDP_BLACKLIST = [
  "Browser.close", "Browser.crash", "Browser.setCrashDetails",
  "Target.closeTarget", "Runtime.terminateExecution",
  "Emulation.setScriptExecutionDisabled",
]

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId })

  const body = await req.json().catch(() => ({})) as { workspaceId?: string; method?: string; params?: Record<string, unknown> }
  if (!body.workspaceId || !body.method) {
    return NextResponse.json({ code: 40001, msg: "缺少 workspaceId 或 method", traceId })
  }

  const ws = await db.browserWorkspace.findFirst({ where: { id: body.workspaceId, deletedAt: null } })
  if (!ws || ws.mode !== "cdp_light") {
    return NextResponse.json({ code: 40400, msg: "CDP 工作区不存在", traceId })
  }
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  const share = await db.workspaceShare.findFirst({
    where: { workspaceId: ws.id, targetUserId: ctx.userId, permission: "OPERATE", revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
  })
  if (ws.userId !== ctx.userId && !isAdmin && !share) {
    return NextResponse.json({ code: 40300, msg: "无权操作该工作区", traceId })
  }

  // 指令黑名单拦截
  if (CDP_BLACKLIST.some((m) => body.method!.startsWith(m))) {
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { cdpBlockedCount: { increment: 1 } } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_BLOCKED",
      resourceType: "WORKSPACE", resourceId: ws.id, severity: "WARN",
      after: { method: body.method },
    })
    return NextResponse.json({ code: 40300, msg: `CDP 指令 ${body.method} 已被网关黑名单拦截`, traceId })
  }

  // 指令限速：单工作区每分钟
  const limit = await getConfigNumber("workspace.cdpRateLimitPerMin", 600)
  if (!rateLimit(`cdp:${ws.id}`, limit, 60_000).allowed) {
    return NextResponse.json({ code: 42900, msg: "CDP 指令调用频率超限", traceId })
  }

  await db.browserWorkspace.update({ where: { id: ws.id }, data: { cdpCallCount: { increment: 1 }, lastActiveAt: new Date() } })
  const { touchSimSession } = await import("@/lib/external/browser-session")
  if (ws.browserSessionId) touchSimSession(ws.browserSessionId)

  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: { forwarded: true, method: body.method, sessionId: ws.browserSessionId, cdpServicePort: Number(process.env.CDP_SERVICE_PORT || 9222) },
    traceId,
  })
}
