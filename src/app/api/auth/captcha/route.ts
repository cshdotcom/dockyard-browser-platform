import { NextRequest, NextResponse } from "next/server"
import { generateCaptcha } from "@/lib/captcha"
import { rateLimit } from "@/lib/rate-limit"

// 图形验证码下发：SVG 返回前端，答案仅存服务端内存
export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1"
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
