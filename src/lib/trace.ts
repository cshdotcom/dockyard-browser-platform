import { headers } from "next/headers"
import { randomUUID } from "crypto"

// traceId 全链路：请求入口生成 → headers 传递 → 日志/审计全链路携带
export async function getTraceId(): Promise<string> {
  const h = await headers()
  return h.get("x-trace-id") || randomUUID()
}

export async function getRequestMeta(): Promise<{ ip: string; ua: string; traceId: string }> {
  const h = await headers()
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "127.0.0.1"
  const ua = h.get("user-agent") || "unknown"
  const traceId = h.get("x-trace-id") || randomUUID()
  return { ip, ua, traceId }
}
