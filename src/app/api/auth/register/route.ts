import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { hashPassword, sha256 } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"
import { getConfigBool } from "@/lib/config"
import { writeSecurityEvent, writeAudit } from "@/lib/audit"
import { validatePasswordPolicy, zUsername } from "@/lib/validators"
import { z } from "zod"

// 用户注册：总开关 + 邮箱激活流程（激活前 emailVerified=false，登录被拦截）

const schema = z.object({
  username: zUsername,
  email: z.string().email().max(190),
  password: z.string().min(1).max(128),
  emailCode: z.string().length(6).optional(), // 需要激活时提交验证码
})

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  // r34: real client IP (CDN edge headers → XFF multi-hop right-to-left public determination → intranet leftmost original client → X-Real-IP)
  const { extractClientIp } = await import("@/lib/client-ip")
  const ip = extractClientIp((name) => req.headers.get(name))
  const respond = (body: Record<string, unknown>) => NextResponse.json({ ...body, traceId })

  try {
    if (!rateLimit(`register:${ip}`, 5, 600_000).allowed) {
      return respond({ code: 42900, msg: "注册请求过于频繁" })
    }
    const allowRegister = await getConfigBool("security.allowRegister", true)
    if (!allowRegister) return respond({ code: 40300, msg: "管理员已关闭注册" })

    const parsed = schema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return respond({ code: 40001, msg: parsed.error.issues[0]?.message || "参数错误" })
    }
    const { username, email, password, emailCode } = parsed.data

    const policy = await validatePasswordPolicy(password)
    if (!policy.ok) return respond({ code: 40001, msg: policy.message })

    const emailLower = email.toLowerCase()
    const existUsername = await db.user.findFirst({ where: { username, deletedAt: null } })
    if (existUsername) return respond({ code: 40900, msg: "用户名已存在" })
    const existEmail = await db.user.findFirst({ where: { email: emailLower, deletedAt: null } })
    if (existEmail) return respond({ code: 40900, msg: "邮箱已被使用" })

    const requireActivation = await getConfigBool("security.requireEmailActivation", false)
    let emailVerified = false
    if (requireActivation) {
      if (!emailCode) return respond({ code: 40001, msg: "请输入邮箱激活验证码", data: { needCode: true } })
      const codeRow = await db.emailVerificationCode.findFirst({
        where: { email: emailLower, purpose: "REGISTER", consumedAt: null },
        orderBy: { createdAt: "desc" },
      })
      if (!codeRow || codeRow.expiresAt < new Date() || sha256(emailCode) !== codeRow.codeHash) {
        return respond({ code: 40001, msg: "激活验证码错误或已过期" })
      }
      await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { consumedAt: new Date() } })
      emailVerified = true
    }

    const passwordHash = await hashPassword(password)
    const user = await db.user.create({
      data: {
        username,
        email: emailLower,
        passwordHash,
        displayName: username,
        emailVerified,
        role: "USER",
      },
    })

    await writeAudit({
      operatorUserId: user.id,
      operatorName: username,
      operationType: "USER_REGISTER",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: username,
      extra: { email: emailLower, activated: emailVerified, ip },
    })
    await writeSecurityEvent({ userId: user.id, username, eventType: "REGISTER", detail: emailVerified ? "注册并激活" : "注册成功（待激活）", ip, userAgent: req.headers.get("user-agent") || "" })

    return respond({
      code: 0,
      msg: requireActivation && !emailVerified ? "注册成功，请先通过邮箱激活后再登录" : "注册成功，现在可以登录",
    })
  } catch (e) {
    console.error("[register]", e)
    return respond({ code: 50000, msg: "服务内部错误" })
  }
}
