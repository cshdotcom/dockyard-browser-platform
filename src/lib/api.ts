import { NextResponse } from "next/server"
import { BizError, ErrorCode } from "./errors"
import { getTraceId } from "./trace"

// 统一API返回结构：{ code, msg, data, traceId } —— 全链路携带 traceId

// r23：匿名请求限流（rate.anonymousQps 真实生效）
// 判定：无会话 Cookie 且无 API-Key 头 → 匿名；按 IP 限流（内存桶）
// 已登录用户走 getAuthContext 内的 rate.userQps；API-Key 通道有自己的 QPS 体系
async function anonymousRateGuard(): Promise<void> {
  try {
    const { headers } = await import("next/headers")
    const h = await headers()
    const hasSession = !!h.get("cookie")?.includes("dockyard-session")
    const hasApiKey = !!(h.get("x-api-key") || h.get("authorization"))
    if (hasSession || hasApiKey) return
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown"
    if (ip === "unknown" || ip === "127.0.0.1") return
    const { getConfigNumber } = await import("./config")
    const { rateLimit } = await import("./rate-limit")
    const qps = await getConfigNumber("rate.anonymousQps", 5)
    if (!rateLimit(`anon-api:${ip}`, qps, 1000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "请求过于频繁（匿名限流），请稍后再试")
    }
  } catch (e) {
    if (e instanceof BizError) throw e
    // 限流层自身异常 → 放行（不因限流基础设施影响主链路）
  }
}
export function apiOk<T>(data?: T, msg = "ok") {
  return Response.json({ code: ErrorCode.OK, msg, data: data ?? null, traceId: crypto.randomUUID() })
}

export function apiFail(code: number, msg: string, traceId?: string) {
  return Response.json({ code, msg, data: null, traceId: traceId || crypto.randomUUID() }, { status: 200 })
}

// Route Handler 统一异常捕获层
export async function apiHandler(fn: () => Promise<Response>): Promise<Response> {
  const traceId = await getTraceId().catch(() => crypto.randomUUID())
  try {
    await anonymousRateGuard()
    return await fn()
  } catch (e) {
    if (e instanceof BizError) {
      return Response.json({ code: e.code, msg: e.message, data: null, traceId })
    }
    const msg = e instanceof Error ? e.message : "内部错误"
    console.error(`[api] ${traceId} error:`, e)
    // 不暴露内部错误细节给前端
    return Response.json(
      { code: ErrorCode.INTERNAL, msg: process.env.NODE_ENV === "production" ? "服务内部错误" : msg, data: null, traceId },
      { status: 500 }
    )
  }
}

// Server Action 统一返回结构
export type ActionResult<T = unknown> = { code: number; msg: string; data?: T; traceId?: string }

export async function actionHandler<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  const traceId = await getTraceId().catch(() => crypto.randomUUID())
  try {
    const data = await fn()
    return { code: ErrorCode.OK, msg: "操作成功", data, traceId }
  } catch (e) {
    if (e instanceof BizError) {
      return { code: e.code, msg: e.message, traceId }
    }
    const msg = e instanceof Error ? e.message : "内部错误"
    console.error(`[action] ${traceId} error:`, e)
    return { code: ErrorCode.INTERNAL, msg, traceId }
  }
}
