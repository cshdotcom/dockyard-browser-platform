import { NextResponse } from "next/server"
import { BizError, ErrorCode } from "./errors"
import { getTraceId } from "./trace"

// 统一API返回结构：{ code, msg, data, traceId } —— 全链路携带 traceId
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
