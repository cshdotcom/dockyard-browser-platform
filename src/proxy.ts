import { NextRequest, NextResponse } from "next/server"
import { getToken } from "next-auth/jwt"

// 全局中间件：
// 1. traceId 注入（全链路携带）
// 2. CORS 前置处理 + OPTIONS 预检终结（白名单 CORS_ALLOWED_ORIGINS，兼容 CORS_ORIGINS；回显+凭证）
// 3. 登录守卫（JWT校验）+ 角色路由保护（/admin/** 需要管理员）
// 4. 请求体大小保护提示、限流第一层（IP维度）
// 深度校验（会话撤销/闲置/禁用/维护模式）在 RSC layout + Server Action + Route Handler 三层完成

const PROTECTED_PREFIXES = ["/dashboard", "/workspaces", "/account", "/admin", "/mcp"]
const ADMIN_PREFIX = "/admin"

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ---- traceId 生成与注入 ----
  const traceId = crypto.randomUUID()
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-trace-id", traceId)

  // ---- CORS（[22-d] 跨域名登录态/用户信息传递）----
  // 白名单：CORS_ALLOWED_ORIGINS（新名称，兼容旧名 CORS_ORIGINS），逗号分隔；"*" 全放行（无凭证模式）
  // · 白名单内 origin → 回显该 origin + Allow-Credentials（跨域携带 HttpOnly 会话 Cookie 的必要条件）
  // · OPTIONS 预检在中间件层直接 204 终结（带完整跨域头），不穿透到路由处理器
  // · 白名单外 origin → 403（保持历史行为）
  const origin = req.headers.get("origin")
  const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (origin && corsAllowed.length > 0) {
    const wildcard = corsAllowed.includes("*")
    if (!wildcard && !corsAllowed.includes(origin)) {
      return NextResponse.json({ code: 40300, msg: "跨域请求被拒绝", traceId }, { status: 403 })
    }
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": wildcard ? "*" : origin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api-Key,X-Refresh-Token,X-Trace-Id",
      "Access-Control-Expose-Headers": "X-Trace-Id",
      "Access-Control-Max-Age": "86400",
    }
    if (!wildcard) {
      // 回显模式：浏览器跨域请求携带 Cookie（credentials: 'include'）必需；"*" 与凭证互斥（CORS 规范）
      corsHeaders["Access-Control-Allow-Credentials"] = "true"
      corsHeaders["Vary"] = "Origin"
    }
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: { ...corsHeaders, "X-Trace-Id": traceId } })
    }
    const res = NextResponse.next({ request: { headers: requestHeaders } })
    for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v)
    res.headers.set("X-Trace-Id", traceId)
    return res
  }

  // 同源 / 未配置白名单的预检：原样放行（无跨域头）
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: { "X-Trace-Id": traceId } })
  }

  // ---- 登录守卫 ----
  const needsAuth = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))
  if (needsAuth) {
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dockyard-dev-secret-change-me",
      cookieName: "dockyard-session",
    })
    if (!token?.uid) {
      // 若浏览器带着一枚解不开的旧会话 cookie（密钥轮换/环境重置后），
      // 直接踢回 /login 会形成「登录成功 → 又被弹回」的循环（重定向你太多次）。
      // 先经 /api/auth/logout 清除失效 cookie，再回到登录页 —— 单向、必然终止。
      if (req.cookies.has("dockyard-session")) {
        // r22b：from 携带完整原路径+查询串（如 /workspaces/shared?token=xxx），登录后可回到原链接
        const res = NextResponse.redirect(
          new URL(`/api/auth/logout?redirect=${encodeURIComponent(`/login?from=${encodeURIComponent(pathname + req.nextUrl.search)}`)}&reason=stale-jwt`, req.url),
        )
        res.headers.set("X-Trace-Id", traceId)
        res.headers.set("Cache-Control", "no-store")
        return res
      }
      const loginUrl = new URL("/login", req.url)
      // r22b：from 携带完整原路径+查询串（如 /workspaces/shared?token=xxx），登录后自动回来绑定
      loginUrl.searchParams.set("from", pathname + req.nextUrl.search)
      const res = NextResponse.redirect(loginUrl)
      res.headers.set("X-Trace-Id", traceId)
      return res
    }
    // 管理员路由角色守卫（JWT内的实时角色在 RSC 层二次校验）
    if (pathname.startsWith(ADMIN_PREFIX)) {
      const role = token.role as string | undefined
      if (role !== "SUPER_ADMIN" && role !== "ADMIN" && role !== "GROUP_ADMIN") {
        const res = NextResponse.redirect(new URL("/dashboard?error=forbidden", req.url))
        res.headers.set("X-Trace-Id", traceId)
        return res
      }
    }
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set("X-Trace-Id", traceId)
  return res
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
}
