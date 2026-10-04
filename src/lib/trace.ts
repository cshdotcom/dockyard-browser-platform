import { headers } from "next/headers"
import { randomUUID } from "crypto"
import { extractClientIp } from "@/lib/client-ip"

// traceId 全链路：请求入口生成 → headers 传递 → 日志/审计全链路携带
export async function getTraceId(): Promise<string> {
  const h = await headers()
  return h.get("x-trace-id") || randomUUID()
}

export async function getRequestMeta(): Promise<{ ip: string; ua: string; traceId: string }> {
  const h = await headers()
  // r34：真实客户端 IP（CDN 边缘头 → XFF 多跳右→左公网判定 → 内网最左原客户端 → X-Real-IP）
  const ip = extractClientIp((name) => h.get(name))
  const ua = h.get("user-agent") || "unknown"
  const traceId = h.get("x-trace-id") || randomUUID()
  return { ip, ua, traceId }
}
