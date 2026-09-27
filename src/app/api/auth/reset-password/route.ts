import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { hashPassword, sha256 } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"
import { validatePasswordPolicy, checkPasswordHistory } from "@/lib/validators"
import { writeSecurityEvent, writeAudit } from "@/lib/audit"
import { z } from "zod"

// 找回密码：全部依靠邮箱链路完成身份确认，绝不返回账号状态

const schema = z.object({
  email: z.string().email().max(190),
  code: z.string().length(6),
  newPassword: z.string().min(1).max(128),
})

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1"
  const respond = (body: Record<string, unknown>) => NextResponse.json({ ...body, traceId })

  try {
    if (!rateLimit(`resetpw:${ip}`, 5, 300_000).allowed) {
      return respond({ code: 42900, msg: "请求过于频繁" })
    }
    const parsed = schema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return respond({ code: 40001, msg: "参数错误" })
    const { email, code, newPassword } = parsed.data
    const emailLower = email.toLowerCase()

    const generic = { code: 40001, msg: "验证码错误或已失效" }

    const policy = await validatePasswordPolicy(newPassword)
    if (!policy.ok) return respond({ code: 40001, msg: policy.message })

    const codeRow = await db.emailVerificationCode.findFirst({
      where: { email: emailLower, purpose: "RESET_PASSWORD", consumedAt: null },
      orderBy: { createdAt: "desc" },
    })
    if (!codeRow || codeRow.expiresAt < new Date() || codeRow.attempts >= 5) return respond(generic)
    if (sha256(code) !== codeRow.codeHash) {
      await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { attempts: { increment: 1 } } })
      return respond(generic)
    }

    const user = await db.user.findFirst({ where: { email: emailLower, deletedAt: null } })
    if (!user) {
      // 账号不存在：同样作废验证码，返回相同文案，防枚举
      await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { consumedAt: new Date() } })
      return respond(generic)
    }

    const historyOk = await checkPasswordHistory(user.id, newPassword)
    if (!historyOk) return respond({ code: 40001, msg: "新密码不能与最近使用过的密码重复" })

    // 一次性作废
    await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { consumedAt: new Date() } })

    const passwordHash = await hashPassword(newPassword)
    await db.passwordHistory.create({ data: { userId: user.id, passwordHash: user.passwordHash || "" } })
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
    })

    // 重置密码 → 全部会话下线 + refreshToken 黑名单
    await db.loginSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "PASSWORD_RESET" },
    })
    await db.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })

    await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "PASSWORD_RESET", detail: "通过邮箱验证码重置密码", ip, userAgent: req.headers.get("user-agent") || "" })
    await writeAudit({
      operatorUserId: user.id,
      operatorName: user.username,
      operationType: "PASSWORD_RESET",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      severity: "WARN",
      extra: { via: "EMAIL_CODE", ip },
    })
    return respond({ code: 0, msg: "密码重置成功，请使用新密码登录" })
  } catch (e) {
    console.error("[reset-password]", e)
    return respond({ code: 50000, msg: "服务内部错误" })
  }
}
