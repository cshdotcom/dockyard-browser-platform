import { NextRequest, NextResponse } from "next/server"
import { generateCaptcha } from "@/lib/captcha"
import { rateLimit } from "@/lib/rate-limit"

// 图形验证码下发：SVG 返回前端，答案仅存服务端内存
export async function GET(req: NextRequest) {
  // r34: real client IP (CDN edge headers → XFF multi-hop right-to-left public determination → intranet leftmost original client → X-Real-IP)
  const { extractClientIp } = await import("@/lib/client-ip")
  const ip = extractClientIp((name) => req.headers.get(name))
  if (!rateLimit(`captcha:${ip}`, 30, 60_000).allowed) {
    return NextResponse.json({ code: 42900, msg: "请求过于频繁" })
  }
  const cap = generateCaptcha()
  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: { captchaId: cap.id, svg: cap.svg, expiresAt: cap.expiresAt },
  })
}
