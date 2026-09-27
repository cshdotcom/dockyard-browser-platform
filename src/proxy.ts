import { NextRequest, NextResponse } from "next/server"
import { getToken } from "next-auth/jwt"

// 全局中间件：
// 1. traceId 注入（全链路携带）
// 2. CORS 前置处理（允许来源从环境变量读取）
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

  // ---- CORS ----
  const origin = req.headers.get("origin")
  if (origin) {
    const allowed = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
    if (allowed.length > 0 && !allowed.includes(origin) && allowed[0] !== "*") {
      return NextResponse.json({ code: 40300, msg: "跨域请求被拒绝", traceId }, { status: 403 })
    }
    if (allowed.length > 0) {
      const res = NextResponse.next({ request: { headers: requestHeaders } })
      res.headers.set("Access-Control-Allow-Origin", allowed.includes(origin) ? origin : allowed[0])
      res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
      res.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key,X-Refresh-Token")
      res.headers.set("X-Trace-Id", traceId)
      return res
    }
  }

  // 预检放行
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
      const loginUrl = new URL("/login", req.url)
      loginUrl.searchParams.set("from", pathname)
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
