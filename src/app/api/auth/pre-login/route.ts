import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { verifyPassword, sha256, randomDigits } from "@/lib/crypto"
import { issueLoginTicket, force2faRequired } from "@/lib/auth"
import { writeSecurityEvent } from "@/lib/audit"
import { trackLoginFailure, clearLoginFailure, getLoginFailure, rateLimit } from "@/lib/rate-limit"
import { checkIpBlack, checkUaRisk } from "@/lib/risk"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { sendMail, emailCodeTemplate } from "@/lib/email"
import { verifyCaptcha } from "@/lib/captcha"
import { BizError } from "@/lib/errors"
import { z } from "zod"

// 登录前置校验（不建会话）：密码 / 邮箱验证码 两种途径
// 关键安全设计：不返回“账号是否存在”，防账号枚举；全链路限流防爆破

const schema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("password"),
    username: z.string().min(1).max(190),
    password: z.string().min(1).max(128),
    remember: z.boolean().optional().default(false),
    captchaId: z.string().optional(),
    captchaCode: z.string().optional(),
  }),
  z.object({
    mode: z.literal("email"),
    email: z.string().email().max(190),
    code: z.string().length(6),
    remember: z.boolean().optional().default(false),
  }),
])

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "127.0.0.1"
  const ua = req.headers.get("user-agent") || "unknown"

  const respond = (body: Record<string, unknown>) => Response.json({ ...body, traceId })

  try {
    // ---- 风控前置：IP黑白名单 / UA黑名单 ----
    const ipRisk = await checkIpBlack(ip)
    if (ipRisk.blocked) {
      await writeSecurityEvent({ eventType: "LOGIN_BLOCKED", success: false, detail: ipRisk.reason, ip, userAgent: ua })
      return respond({ code: 46001, msg: "访问被风控策略拒绝" })
    }
    if (await checkUaRisk(ua)) {
      return respond({ code: 46001, msg: "访问被风控策略拒绝" })
    }

    // ---- 登录接口统一限流（不论账密对错）----
    const rl = rateLimit(`login:${ip}`, 20, 60_000)
    if (!rl.allowed) {
      return respond({ code: 42900, msg: "请求过于频繁，请稍后再试" })
    }

    const body = await req.json().catch(() => ({}))
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return respond({ code: 40001, msg: "参数错误" })
    }
    const input = parsed.data

    // ================= 邮箱验证码登录 =================
    if (input.mode === "email") {
      const allowEmailLogin = await getConfigBool("security.allowEmailCodeLogin", true)
      if (!allowEmailLogin) return respond({ code: 40300, msg: "管理员已禁用邮箱验证码登录" })

      const codeRow = await db.emailVerificationCode.findFirst({
        where: { email: input.email.toLowerCase(), purpose: "LOGIN", consumedAt: null },
        orderBy: { createdAt: "desc" },
      })
      const genericFail = { code: 41002, msg: "邮箱或验证码错误" }
      if (!codeRow || codeRow.expiresAt < new Date()) {
        await writeSecurityEvent({ username: input.email, eventType: "LOGIN_FAILED", success: false, detail: "邮箱验证码登录失败", ip, userAgent: ua })
        return respond(genericFail)
      }
      if (codeRow.attempts >= 5) {
        return respond({ code: 41002, msg: "验证码错误次数过多，已失效" })
      }
      if (sha256(input.code) !== codeRow.codeHash) {
        await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { attempts: { increment: 1 } } })
        await writeSecurityEvent({ username: input.email, eventType: "LOGIN_FAILED", success: false, detail: "邮箱验证码错误", ip, userAgent: ua })
        return respond(genericFail)
      }
      const user = await db.user.findFirst({
        where: { email: input.email.toLowerCase(), deletedAt: null },
      })
      if (!user) {
        // 不暴露账号存在性：返回通用错误（验证码消耗掉）
        await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { consumedAt: new Date() } })
        return respond(genericFail)
      }
      if (!user.enabled || user.frozen) return respond({ code: 41002, msg: "账号状态异常，无法登录" })
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return respond({ code: 41001, msg: "账号已临时锁定，请稍后再试" })
      }
      if (!user.emailVerified) return respond({ code: 41003, msg: "邮箱未激活" })

      // 一次性使用：立即作废
      await db.emailVerificationCode.update({ where: { id: codeRow.id }, data: { consumedAt: new Date() } })

      // 2FA 判定
      if (user.twoFactorEnabled) {
        const { ticket } = issueLoginTicket(user.id, "2FA", input.remember)
        await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_EMAIL_CODE", success: true, detail: "邮箱验证码通过，等待2FA", ip, userAgent: ua })
        return respond({ code: 0, msg: "ok", data: { twoFactorRequired: true, ticket } })
      }
      if (await force2faRequired(user.id)) {
        const { ticket } = issueLoginTicket(user.id, "FORCE_SETUP", input.remember)
        return respond({ code: 0, msg: "ok", data: { forceSetup: true, ticket } })
      }
      const { ticket } = issueLoginTicket(user.id, "LOGIN", input.remember)
      return respond({ code: 0, msg: "ok", data: { ok: true, ticket } })
    }

    // ================= 密码登录 =================
    const usernameKey = input.username.trim().toLowerCase()
    const user = await db.user.findFirst({
      where: {
        OR: [{ username: input.username.trim() }, { email: input.username.trim().toLowerCase() }],
        deletedAt: null,
      },
    })

    const generic = { code: 41002, msg: "账号或密码错误" }

    // 账号锁定检查
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await writeSecurityEvent({ userId: user?.id, username: input.username, eventType: "LOGIN_FAILED", success: false, detail: "账号锁定期间登录", ip, userAgent: ua })
      const remainMin = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
      return respond({ code: 41001, msg: `账号已临时锁定，请${remainMin}分钟后重试` })
    }

    // 需要验证码（失败次数达到阈值）
    const failNeeded = await getConfigNumber("security.captchaAfterFailures", 3)
    const fails = getLoginFailure(usernameKey)
    if (fails >= failNeeded) {
      if (!input.captchaId || !input.captchaCode) {
        return respond({ code: 41006, msg: "请完成图形验证码", data: { captchaRequired: true } })
      }
      if (!verifyCaptcha(input.captchaId, input.captchaCode)) {
        return respond({ code: 41006, msg: "图形验证码错误", data: { captchaRequired: true } })
      }
    }

    if (!user || !user.passwordHash) {
      trackLoginFailure(usernameKey)
      await writeSecurityEvent({ username: input.username, eventType: "LOGIN_FAILED", success: false, detail: "账号不存在或无密码", ip, userAgent: ua })
      return respond(generic)
    }
    if (!user.enabled || user.frozen) {
      await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_FAILED", success: false, detail: "账号禁用/冻结", ip, userAgent: ua })
      return respond({ code: 41002, msg: "账号状态异常，无法登录" })
    }
    if (!user.emailVerified && (await getConfigBool("security.requireEmailActivation", false))) {
      return respond({ code: 41003, msg: "邮箱未激活，请先查收激活邮件" })
    }

    const passOk = await verifyPassword(input.password, user.passwordHash)
    if (!passOk) {
      const count = trackLoginFailure(usernameKey)
      const threshold = await getConfigNumber("security.maxLoginFailures", 5)
      const lockoutMin = await getConfigNumber("security.lockoutMinutes", 15)
      if (count >= threshold) {
        await db.user.update({
          where: { id: user.id },
          data: { lockedUntil: new Date(Date.now() + lockoutMin * 60_000), failedLoginCount: count },
        })
        await writeSecurityEvent({
          userId: user.id,
          username: user.username,
          eventType: "ACCOUNT_LOCKED",
          success: false,
          detail: `连续失败${count}次，锁定${lockoutMin}分钟`,
          ip,
          userAgent: ua,
        })
        await writeAuditLock(user, ip, ua, count, lockoutMin)
        clearLoginFailure(usernameKey)
        return respond({ code: 41001, msg: `连续密码错误达到阈值，账号锁定${lockoutMin}分钟` })
      }
      await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_FAILED", success: false, detail: `密码错误(${count}/${threshold})`, ip, userAgent: ua })
      return respond(generic)
    }

    // ---- 密码正确 ----
    if (user.mustChangePassword) {
      const { ticket } = issueLoginTicket(user.id, "LOGIN", input.remember)
      return respond({ code: 0, msg: "ok", data: { ok: true, ticket, mustChangePassword: true } })
    }

    if (user.twoFactorEnabled) {
      const { ticket } = issueLoginTicket(user.id, "2FA", input.remember)
      await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_PASSWORD", success: true, detail: "密码通过，等待2FA", ip, userAgent: ua })
      return respond({ code: 0, msg: "ok", data: { twoFactorRequired: true, ticket } })
    }
    if (await force2faRequired(user.id)) {
      const { ticket } = issueLoginTicket(user.id, "FORCE_SETUP", input.remember)
      await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_PASSWORD", success: true, detail: "密码通过，强制设置2FA", ip, userAgent: ua })
      return respond({ code: 0, msg: "ok", data: { forceSetup: true, ticket } })
    }

    const { ticket } = issueLoginTicket(user.id, "LOGIN", input.remember)
    await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_PASSWORD", success: true, detail: "密码通过", ip, userAgent: ua })
    return respond({ code: 0, msg: "ok", data: { ok: true, ticket } })
  } catch (e) {
    console.error("[pre-login]", e)
    return respond({ code: 50000, msg: "服务内部错误" })
  }
}

async function writeAuditLock(user: { id: string; username: string }, ip: string, ua: string, count: number, lockoutMin: number) {
  try {
    const { writeAudit } = await import("@/lib/audit")
    await writeAudit({
      operatorUserId: user.id,
      operatorName: user.username,
      operationType: "ACCOUNT_LOCKED",
      resourceType: "USER",
      resourceId: user.id,
      resourceName: user.username,
      severity: "WARN",
      extra: { failures: count, lockoutMinutes: lockoutMin, ip, ua: ua.slice(0, 120) },
    })
  } catch { /* ignore */ }
}
