import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions, revokeLoginSession } from "@/lib/auth"
import { db } from "@/lib/db"
import { writeSecurityEvent, writeAudit } from "@/lib/audit"

// 登出：
//  - POST：前端主动登出（撤销会话 + 审计），随后由前端调用 next-auth signOut 清 cookie
//  - GET?redirect=/xxx&reason=stale-jwt：middleware/布局检测到失效会话 cookie 时引导至此，
//    服务端直接清除 dockyard-session cookie 并 302 到站内安全路径 —— 打断「登录成功又被弹回」的循环。
//    redirect 仅允许以单个 "/" 开头的站内相对路径，防开放重定向。

const COOKIE_NAMES = [
  "dockyard-session",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.csrf-token",
  "next-auth.callback-url",
  "__Host-next-auth.csrf-token",
  "__Host-next-auth.callback-url",
]

function safeRedirectPath(raw: string | null): string {
  const p = raw || "/login"
  // 仅站内路径：以 "/" 开头且不以 "//"（协议相对）或 "/\" 开头
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return "/login"
  return p
}

function clearSessionCookies(res: NextResponse) {
  for (const name of COOKIE_NAMES) {
    res.cookies.set({
      name,
      value: "",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
      expires: new Date(0),
    })
  }
  res.headers.set("Cache-Control", "no-store")
  return res
}

async function revokeCurrentSession(reason: string) {
  try {
    const session = await getServerSession(authOptions)
    const sid = (session?.user as Record<string, unknown> | undefined)?.loginSessionId as string | undefined
    if (sid) {
      await revokeLoginSession(sid, reason)
      const uid = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined
      const uname = session?.user?.name
      await writeSecurityEvent({ userId: uid, username: uname, eventType: "LOGOUT", detail: `会话清理（${reason}）`, ip: undefined })
      await writeAudit({ operatorUserId: uid, operatorName: uname, operationType: "LOGOUT", resourceType: "USER", resourceId: uid, resourceName: uname, extra: { reason } })
    }
  } catch {
    // DB 异常时仍继续清 cookie（保证浏览器侧终止）
  }
}

export async function POST() {
  const session = await getServerSession(authOptions)
  const sid = (session?.user as Record<string, unknown> | undefined)?.loginSessionId as string | undefined
  if (sid) {
    await revokeLoginSession(sid, "LOGOUT")
    const uid = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined
    const uname = session?.user?.name
    await writeSecurityEvent({ userId: uid, username: uname, eventType: "LOGOUT", detail: "用户主动登出" })
    await writeAudit({ operatorUserId: uid, operatorName: uname, operationType: "LOGOUT", resourceType: "USER", resourceId: uid, resourceName: uname })
  }
  return NextResponse.json({ code: 0, msg: "ok" })
}

export async function GET(req: NextRequest) {
  const reason = req.nextUrl.searchParams.get("reason") || "manual"
  const dest = safeRedirectPath(req.nextUrl.searchParams.get("redirect"))
  await revokeCurrentSession(reason)
  // 相对 Location（RFC 7231）：浏览器按当前访问域名解析 —— 经任何反代/网关都正确，
  // 绝不会把用户甩到内网地址（NextResponse.redirect 会用 req.url 拼绝对地址，代理场景出错）
  const res = new NextResponse(null, { status: 307, headers: { Location: dest } })
  return clearSessionCookies(res)
}
