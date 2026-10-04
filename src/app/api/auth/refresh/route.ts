import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sha256, randomDigits } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"

// RefreshToken 刷新接口：校验数据库记录存在、未过期、未加黑名单 → 轮换新token
// 修改密码/登出操作会将该用户全部 refreshToken 置黑名单

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  // r34: real client IP (CDN edge headers → XFF multi-hop right-to-left public determination → intranet leftmost original client → X-Real-IP)
  const { extractClientIp } = await import("@/lib/client-ip")
  const ip = extractClientIp((name) => req.headers.get(name))
  const respond = (body: Record<string, unknown>) => NextResponse.json({ ...body, traceId })

  if (!rateLimit(`refresh:${ip}`, 30, 60_000).allowed) {
    return respond({ code: 42900, msg: "请求过于频繁" })
  }

  const token = req.headers.get("x-refresh-token") || ""
  if (!token) return respond({ code: 40100, msg: "缺少刷新令牌" })

  const row = await db.refreshToken.findUnique({ where: { tokenHash: sha256(token) } })
  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    return respond({ code: 40100, msg: "刷新令牌无效或已撤销" })
  }

  // 轮换：旧token立即作废，签发新token
  const newRaw = "rt_" + randomDigits(48)
  await db.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
  await db.refreshToken.create({
    data: {
      userId: row.userId,
      tokenHash: sha256(newRaw),
      expiresAt: new Date(Date.now() + 7 * 86400_000),
      clientIp: ip,
      userAgent: req.headers.get("user-agent") || "",
    },
  })
  return respond({ code: 0, msg: "刷新成功", data: { refreshToken: newRaw, expiresIn: 7 * 86400 } })
}
