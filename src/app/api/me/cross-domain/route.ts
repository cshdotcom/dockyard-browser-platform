import { NextRequest, NextResponse } from "next/server"
import { corsAllowedOrigins } from "@/lib/env"
import { getAuthContext } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// ============================================================
// 跨域名登录态与用户信息传递端点（22-d）
//
// 场景：平台与业务系统分属不同域名时，外部域名的页面/脚本经本端点识别
//   用户在 Dockyard 的登录态并获取基础用户信息（不含任何敏感字段）。
// 配套：CORS_ALLOWED_ORIGINS 白名单（src/proxy.ts 全局 CORS + 本端点自带头双保险）；
//   跨域携带 Cookie 需响应 Access-Control-Allow-Credentials: true + origin 回显。
//
// 用法（外部域名侧）：
//   const res = await fetch("https://dockyard.example.com/api/me/cross-domain", {
//     credentials: "include",  // 携带 Dockyard 会话 Cookie（需同父域或 SameSite 配置支持）
//   })
//   // 200 → { code: 0, data: { id, username, displayName, role } }
//   // 401 → 未登录 / 会话失效（同样带 CORS 头，外部页面可读）
//   // 403 → origin 不在 CORS_ALLOWED_ORIGINS 白名单
//
// OPTIONS → 204（预检；本端点自带处理，不依赖中间件）
// ============================================================

// 与 src/proxy.ts 全局 CORS 逻辑一致的响应头构造（双保险：不依赖 matcher 覆盖）
function corsHeadersFor(origin: string | null): Record<string, string> | null {
  if (!origin) return null
  if (corsAllowedOrigins.length === 0) return null // 未配置白名单：不跨域开放（同源调用不受影响）
  const wildcard = corsAllowedOrigins.includes("*")
  if (!wildcard && !corsAllowedOrigins.includes(origin)) return null // 白名单外：不加跨域头（由中间件/此处返回 403）
  const h: Record<string, string> = {
    "Access-Control-Allow-Origin": wildcard ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Trace-Id",
    "Access-Control-Expose-Headers": "X-Trace-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }
  if (!wildcard) h["Access-Control-Allow-Credentials"] = "true" // HttpOnly Cookie 跨域携带必需
  return h
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin")
  const h = corsHeadersFor(origin)
  if (origin && corsAllowedOrigins.length > 0 && !h) {
    return new NextResponse(null, { status: 403, headers: { "X-Trace-Id": crypto.randomUUID() } })
  }
  return new NextResponse(null, { status: 204, headers: { ...(h || {}), "X-Trace-Id": crypto.randomUUID() } })
}

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const origin = req.headers.get("origin")
    const cors = corsHeadersFor(origin)
    // 白名单显式配置且当前 origin 不在其中 → 403（与全局中间件策略一致）
    if (origin && corsAllowedOrigins.length > 0 && !cors) {
      const res = NextResponse.json({ code: 40300, msg: "跨域请求被拒绝" }, { status: 403 })
      res.headers.set("X-Trace-Id", crypto.randomUUID())
      return res
    }
    const ctx = await getAuthContext()
    const withCors = (body: unknown, status: number) => {
      const res = NextResponse.json(body, { status })
      if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
      res.headers.set("X-Trace-Id", crypto.randomUUID())
      res.headers.set("Cache-Control", "no-store") // 用户信息不做跨域缓存
      return res
    }
    if (!ctx) {
      // 未登录：同样带 CORS 头（外部页面据此区分「未登录」与「跨域被拒」）
      return withCors({ code: 40100, msg: "未登录或会话已失效" }, 401)
    }
    // 仅返回基础识别字段；passwordHash / 邮箱 / 配额 / 偏好等一律不外泄
    return withCors(
      {
        code: 0,
        msg: "ok",
        data: {
          id: ctx.userId,
          username: ctx.username,
          displayName: ctx.displayName ?? null,
          role: ctx.role,
        },
      },
      200,
    )
  })
}
