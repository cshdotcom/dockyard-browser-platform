import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { rateLimit } from "@/lib/rate-limit"
import { verifyPassword } from "@/lib/crypto"
import { extractClientIp } from "@/lib/client-ip"

// ============================================================
// r37：访客密码校验（独立端点 —— 与 VNC/CDP 票据解耦）
//   · 仅校验链接密码（不签发任何票据；票据仍按需走 vnc-ticket/cdp-ticket）
//   · CDP 轻量模式沙箱的访客也可通过密码门（原实现复用 vnc-ticket → CDP 模式恒 403 密码门永远过不去）
//   · IP 限速 8/min + 恒定失败语义（401 不区分无密码/错密码细节）
// ============================================================

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const ip = extractClientIp((n) => req.headers.get(n), req.headers.get("x-real-ip") || undefined)
  if (!rateLimit(`guestVerify:${ip}`, 8, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "尝试过于频繁，请稍后再试" }, { status: 429 })
  }
  let body: { token?: string; password?: string }
  try {
    body = (await req.json()) as { token?: string; password?: string }
  } catch {
    return NextResponse.json({ code: 40000, msg: "bad json" }, { status: 400 })
  }
  const token = (body.token || "").trim()
  if (!/^[a-f0-9]{16,128}$/i.test(token)) {
    return NextResponse.json({ code: 40000, msg: "链接无效" }, { status: 400 })
  }
  const link = await db.workspaceShareLink.findUnique({ where: { token } })
  if (!link || link.revokedAt) {
    return NextResponse.json({ code: 40300, msg: "分享链接不可用" }, { status: 403 })
  }
  if (link.expireAt && link.expireAt.getTime() < Date.now()) {
    return NextResponse.json({ code: 40300, msg: "该分享链接已过期" }, { status: 403 })
  }
  if (!link.passwordHash) {
    // 无密码链接：直接通过（幂等）
    return NextResponse.json({ code: 0, msg: "ok", data: { verified: true } })
  }
  const pw = (body.password || "").trim()
  if (!pw) return NextResponse.json({ code: 40100, msg: "该链接设置了访问密码" }, { status: 401 })
  const ok = await verifyPassword(pw, link.passwordHash).catch(() => false)
  if (!ok) return NextResponse.json({ code: 40101, msg: "访问密码不正确" }, { status: 401 })
  return NextResponse.json({ code: 0, msg: "ok", data: { verified: true } })
}
