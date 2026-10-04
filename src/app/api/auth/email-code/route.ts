import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sha256, randomDigits } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { sendMail, emailCodeTemplate } from "@/lib/email"
import { writeSecurityEvent } from "@/lib/audit"
import { z } from "zod"

// 邮箱验证码发送：登录 / 注册激活 / 找回密码 / 换绑邮箱（旧/新）
// 防轰炸：同邮箱发送间隔限制 + 每小时上限 + IP限流；一次性使用；过期作废

const schema = z.object({
  email: z.string().email().max(190),
  purpose: z.enum(["LOGIN", "REGISTER", "RESET_PASSWORD", "CHANGE_EMAIL_OLD", "CHANGE_EMAIL_NEW"]),
})

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  // r34: real client IP (CDN edge headers → XFF multi-hop right-to-left public determination → intranet leftmost original client → X-Real-IP)
  const { extractClientIp } = await import("@/lib/client-ip")
  const ip = extractClientIp((name) => req.headers.get(name))
  const respond = (body: Record<string, unknown>) => NextResponse.json({ ...body, traceId })

  try {
    if (!rateLimit(`mail:${ip}`, 10, 60_000).allowed) {
      return respond({ code: 42900, msg: "请求过于频繁，请稍后再试" })
    }
    const parsed = schema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) return respond({ code: 40001, msg: "参数错误" })
    const { email, purpose } = parsed.data
    const emailLower = email.toLowerCase()

    const allowEmailLogin = await getConfigBool("security.allowEmailCodeLogin", true)
    if (purpose === "LOGIN" && !allowEmailLogin) {
      return respond({ code: 40300, msg: "管理员已禁用邮箱验证码登录" })
    }
    if (purpose === "REGISTER") {
      const allowRegister = await getConfigBool("security.allowRegister", true)
      if (!allowRegister) return respond({ code: 40300, msg: "管理员已关闭注册" })
    }

    // ---- 发送频率限制 ----
    const intervalSec = await getConfigNumber("security.emailCodeSendIntervalSec", 60)
    const maxPerHour = await getConfigNumber("security.emailCodeMaxSendPerHour", 10)
    const recent = await db.emailVerificationCode.findFirst({
      where: { email: emailLower, purpose, sentAt: { gt: new Date(Date.now() - intervalSec * 1000) } },
    })
    if (recent) {
      const remain = Math.ceil((recent.sentAt.getTime() + intervalSec * 1000 - Date.now()) / 1000)
      return respond({ code: 42900, msg: `发送过于频繁，请${remain}秒后重试` })
    }
    const hourCount = await db.emailVerificationCode.count({
      where: { email: emailLower, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    })
    if (hourCount >= maxPerHour) {
      return respond({ code: 42900, msg: "该邮箱发送次数已达每小时上限" })
    }

    // 生成6位验证码：哈希存储 + 过期时间
    const code = randomDigits(6)
    const expireSec = await getConfigNumber("security.emailCodeExpireSec", 300)
    await db.emailVerificationCode.create({
      data: {
        email: emailLower,
        codeHash: sha256(code),
        purpose,
        expiresAt: new Date(Date.now() + expireSec * 1000),
      },
    })

    const result = await sendMail(emailLower, `【Dockyard】您的验证码：${code}`, emailCodeTemplate(code, purpose))
    await writeSecurityEvent({ eventType: "EMAIL_CODE_SENT", detail: `${purpose} 验证码已发送`, ip, userAgent: req.headers.get("user-agent") || "" })

    // 模拟模式：验证码打印到 stdout（docker logs / dev.log 直接可查，便于开发联调与无 SMTP 环境登录）
    if (result.simulated) {
      console.log(`[email-code][simulated] purpose=${purpose} email=${emailLower} code=${code} expires=${expireSec}s（SMTP 未配置，进入控制台模拟模式）`)
    }

    // 统一返回语，不暴露账号是否存在
    return respond({
      code: 0,
      msg: result.simulated ? "验证码已发送（当前为模拟邮件模式，请查看服务端日志）" : "验证码已发送，请查收邮件",
      data: { simulated: result.simulated, expiresIn: expireSec },
    })
  } catch (e) {
    console.error("[email-code]", e)
    return respond({ code: 50000, msg: "服务内部错误" })
  }
}
