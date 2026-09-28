"use server"

import { z } from "zod"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { actionHandler, type ActionResult } from "@/lib/api"
import { verifyPassword, hashPassword, sha256 } from "@/lib/crypto"
import { generateTotpSecret, saveTotpSecret, getTotpSecret, deleteTotpSecret, verifyTotp, regenerateBackupCodes, consumeBackupCode, totpOtpauthUrl, countUnusedBackupCodes } from "@/lib/totp"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"
import { validatePasswordPolicy, checkPasswordHistory, zodValidate } from "@/lib/validators"
import { getConfigBool, getConfig } from "@/lib/config"
import { sendMail, emailCodeTemplate } from "@/lib/email"
import { rateLimit } from "@/lib/rate-limit"
import { randomDigits } from "@/lib/crypto"
import QRCode from "qrcode"
import { revokeLoginSession } from "@/lib/auth"
import { trackBehavior } from "@/lib/risk"
import { headers } from "next/headers"

// ============================================================
// 账号安全 Server Actions：2FA全流程 / 修改密码 / 换绑邮箱
// ============================================================

async function clientIp() {
  const h = await headers()
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1"
}

// ---- 2FA 开启：生成密钥 + 二维码（未确认状态） ----
export async function start2faSetupAction(): Promise<ActionResult<{ secret: string; qrDataUrl: string; otpauthUrl: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    if (await getTotpSecret(ctx.userId)) {
      // 已有密钥但未确认 → 重新生成；已确认则走关闭流程
      const existing = await db.totpSecret.findUnique({ where: { userId: ctx.userId } })
      if (existing?.confirmed) {
        return { already: true } as unknown as { secret: string; qrDataUrl: string; otpauthUrl: string }
      }
    }
    const secret = generateTotpSecret()
    await saveTotpSecret(ctx.userId, secret, false)
    const otpauth = totpOtpauthUrl(secret, ctx.email || ctx.username)
    const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 220, margin: 1 })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TWOFA_SETUP_START",
      resourceType: "USER",
      resourceId: ctx.userId,
    })
    return { secret, qrDataUrl, otpauthUrl: otpauth }
  })
}

// ---- 2FA 确认：校验动态码 → 正式开启 + 展示一次性备份码 ----
export async function confirm2faSetupAction(input: unknown): Promise<ActionResult<{ backupCodes: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { code } = zodValidate(z.object({ code: z.string().length(6) }), input)
    const secret = await getTotpSecret(ctx.userId)
    if (!secret) throw new Error("请先生成2FA密钥")
    if (!verifyTotp(code, secret)) {
      await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "LOGIN_2FA", success: false, detail: "2FA确认验证码错误" })
      throw new Error("动态验证码错误，请核对App显示的6位数字")
    }
    await saveTotpSecret(ctx.userId, secret, true)
    await db.user.update({ where: { id: ctx.userId }, data: { twoFactorEnabled: true, force2faSetup: false } })
    const backupCodes = await regenerateBackupCodes(ctx.userId)
    await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "TWOFA_ENABLED", detail: "用户开启双因素认证" })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TWOFA_ENABLE",
      resourceType: "USER",
      resourceId: ctx.userId,
      severity: "WARN",
      after: { twoFactorEnabled: true, backupCodeCount: backupCodes.length },
    })
    return { backupCodes }
  })
}

// ---- 2FA 关闭：必须验证当前动态码或有效备份码 ----
export async function disable2faAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { code } = zodValidate(z.object({ code: z.string().min(4).max(16) }), input)
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user?.twoFactorEnabled) throw new Error("当前未开启双因素认证")

    const secret = await getTotpSecret(ctx.userId)
    let ok = false
    let usedBackup = false
    if (secret && verifyTotp(code, secret)) ok = true
    if (!ok) {
      ok = await consumeBackupCode(ctx.userId, code)
      usedBackup = ok
    }
    if (!ok) {
      await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "TWOFA_DISABLE_FAILED", success: false, detail: "关闭2FA验证失败" })
      throw new Error("验证失败：动态码或备份码错误")
    }

    await deleteTotpSecret(ctx.userId)
    await db.twoFactorBackupCode.deleteMany({ where: { userId: ctx.userId } })
    await db.user.update({ where: { id: ctx.userId }, data: { twoFactorEnabled: false } })
    // 关闭2FA后：撤销全部受信任设备
    await db.trustedDevice.updateMany({ where: { userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } })

    await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "TWOFA_DISABLED", detail: usedBackup ? "使用备份码关闭" : "使用动态码关闭" })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TWOFA_DISABLE",
      resourceType: "USER",
      resourceId: ctx.userId,
      severity: "WARN",
      before: { twoFactorEnabled: true },
      after: { twoFactorEnabled: false },
    })
    return null
  })
}

// ---- 重新生成备份码（需2FA验证） ----
export async function regenerateBackupCodesAction(input: unknown): Promise<ActionResult<{ backupCodes: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { code } = zodValidate(z.object({ code: z.string().min(4).max(16) }), input)
    const secret = await getTotpSecret(ctx.userId)
    if (!(secret && verifyTotp(code, secret)) && !(await consumeBackupCode(ctx.userId, code))) {
      throw new Error("动态码或备份码错误")
    }
    const backupCodes = await regenerateBackupCodes(ctx.userId)
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TWOFA_BACKUP_REGEN",
      resourceType: "USER",
      resourceId: ctx.userId,
    })
    return { backupCodes }
  })
}

// ---- 修改密码：旧密码校验 + 2FA状态额外TOTP + 历史密码 + 踢除其它会话 ----
export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { oldPassword, newPassword, confirmPassword, totpCode } = zodValidate(
      z.object({
        oldPassword: z.string().min(1).max(128),
        newPassword: z.string().min(1).max(128),
        confirmPassword: z.string().min(1).max(128),
        totpCode: z.string().optional().default(""),
      }),
      input
    )
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user?.passwordHash) throw new Error("当前账号未设置密码")

    if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致")
    if (!(await verifyPassword(oldPassword, user.passwordHash))) {
      await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "PASSWORD_CHANGE", success: false, detail: "旧密码错误" })
      throw new Error("旧密码错误")
    }

    // 开启2FA时额外TOTP校验
    const requireTotp = await getConfigBool("security.changePasswordRequireTotp", true)
    if (user.twoFactorEnabled && requireTotp) {
      if (!totpCode) throw new Error("开启双因素认证后修改密码需要输入TOTP动态码")
      const secret = await getTotpSecret(ctx.userId)
      if (!(secret && verifyTotp(totpCode, secret)) && !(await consumeBackupCode(ctx.userId, totpCode))) {
        throw new Error("TOTP动态码错误")
      }
    }

    const policy = await validatePasswordPolicy(newPassword)
    if (!policy.ok) throw new Error(policy.message)
    if (!(await checkPasswordHistory(ctx.userId, newPassword))) throw new Error("新密码不能与最近使用过的密码重复")

    // 历史记录 + 更新
    await db.passwordHistory.create({ data: { userId: ctx.userId, passwordHash: user.passwordHash } })
    await db.user.update({ where: { id: ctx.userId }, data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false } })

    // 修改密码成功 → 自动踢除该用户除当前以外全部登录会话
    const currentSessionId = ctx.loginSessionId
    const others = await db.loginSession.findMany({
      where: { userId: ctx.userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
      select: { id: true, refreshTokenId: true },
    })
    for (const s of others) {
      await revokeLoginSession(s.id, "PASSWORD_CHANGE")
    }
    // 全部 RefreshToken 黑名单（含当前，密码已改旧token作废）
    await db.refreshToken.updateMany({ where: { userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } })

    await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "PASSWORD_CHANGE", success: true, detail: `修改密码并踢除${others.length}个其它会话` })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PASSWORD_CHANGE",
      resourceType: "USER",
      resourceId: ctx.userId,
      severity: "WARN",
      extra: { kickedSessions: others.length, ip: await clientIp() },
    })

    // 安全变更联动作废API-Token（可配置）
    if (await getConfigBool("security.autoInvalidateTokensOnSecurityChange", false)) {
      await db.apiToken.updateMany({ where: { userId: ctx.userId, deletedAt: null }, data: { deletedAt: new Date() } })
    }
    return { kickedSessions: others.length }
  })
}

// ---- 修改登录用户名（需当前密码验证；审计 + 安全事件 + 会话保持）----
export async function changeUsernameAction(input: unknown): Promise<ActionResult<{ username: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { newUsername, currentPassword } = zodValidate(
      z.object({
        newUsername: z.string().min(3, "用户名至少 3 位").max(32, "用户名至多 32 位"),
        currentPassword: z.string().min(1).max(128),
      }),
      input
    )
    if (!rateLimit(`changeUsername:${ctx.userId}`, 5, 10 * 60_000).allowed) throw new Error("修改用户名过于频繁，请 10 分钟后再试")

    if (!/^[a-zA-Z0-9_.-]+$/.test(newUsername)) throw new Error("用户名仅允许字母/数字/下划线/点/横线")
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user?.passwordHash) throw new Error("当前账号未设置密码")
    if (newUsername === user.username) throw new Error("新用户名与当前相同")
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "USERNAME_CHANGE", success: false, detail: "密码验证失败" })
      throw new Error("当前密码错误")
    }
    const dup = await db.user.findFirst({ where: { username: newUsername }, select: { id: true } })
    if (dup) throw new Error("该用户名已被占用")

    await db.user.update({ where: { id: ctx.userId }, data: { username: newUsername } })
    await writeSecurityEvent({ userId: ctx.userId, username: newUsername, eventType: "USERNAME_CHANGE", success: true, detail: `登录用户名已由 ${ctx.username} 修改为 ${newUsername}` })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "USERNAME_CHANGE",
      resourceType: "USER",
      resourceId: ctx.userId,
      before: { username: user.username },
      after: { username: newUsername },
      severity: "WARN",
    })
    return { username: newUsername }
  })
}

// ---- 换绑邮箱：旧邮箱+新邮箱双重验证码 ----
export async function sendEmailChangeCodeAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { which, newEmail } = zodValidate(
      z.object({ which: z.enum(["old", "new"]), newEmail: z.string().email().max(190).optional() }),
      input
    )
    const ip = await clientIp()
    if (!rateLimit(`mailchg:${ctx.userId}`, 5, 300_000).allowed) throw new Error("操作过于频繁")

    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw new Error("用户不存在")

    if (which === "new") {
      if (!newEmail) throw new Error("请输入新邮箱地址")
      const emailLower = newEmail.toLowerCase()
      const exists = await db.user.findFirst({ where: { email: emailLower, deletedAt: null, id: { not: ctx.userId } } })
      if (exists) throw new Error("该邮箱已被其他账号使用")
      const code = randomDigits(6)
      await db.emailVerificationCode.create({
        data: { email: emailLower, codeHash: sha256(code), purpose: "CHANGE_EMAIL_NEW", userId: ctx.userId, expiresAt: new Date(Date.now() + 300_000) },
      })
      await sendMail(emailLower, `【Dockyard】换绑邮箱确认码：${code}`, emailCodeTemplate(code, "CHANGE_EMAIL_NEW"))
      return { sent: true, to: emailLower }
    } else {
      if (!user.email) throw new Error("当前账号未绑定邮箱，请联系管理员")
      const code = randomDigits(6)
      await db.emailVerificationCode.create({
        data: { email: user.email.toLowerCase(), codeHash: sha256(code), purpose: "CHANGE_EMAIL_OLD", userId: ctx.userId, expiresAt: new Date(Date.now() + 300_000) },
      })
      await sendMail(user.email, `【Dockyard】换绑邮箱确认码：${code}`, emailCodeTemplate(code, "CHANGE_EMAIL_OLD"))
      return { sent: true, to: user.email }
    }
  })
}

export async function changeEmailAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { oldCode, newCode, newEmail, password } = zodValidate(
      z.object({
        oldCode: z.string().length(6),
        newCode: z.string().length(6),
        newEmail: z.string().email().max(190),
        password: z.string().min(1).max(128),
      }),
      input
    )
    const user = await db.user.findUnique({ where: { id: ctx.userId } })
    if (!user) throw new Error("用户不存在")
    if (!user.email) throw new Error("当前账号未绑定邮箱")
    if (!(await verifyPassword(password, user.passwordHash))) {
      await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "EMAIL_CHANGE", success: false, detail: "密码校验失败" })
      throw new Error("密码错误")
    }

    const emailLower = newEmail.toLowerCase()
    const oldEmailLower = user.email.toLowerCase()

    const verifyCode = async (email: string, purpose: string, code: string) => {
      const row = await db.emailVerificationCode.findFirst({
        where: { email, purpose, consumedAt: null, userId: ctx.userId },
        orderBy: { createdAt: "desc" },
      })
      if (!row || row.expiresAt < new Date() || row.attempts >= 5) throw new Error("验证码错误或已过期")
      if (sha256(code) !== row.codeHash) {
        await db.emailVerificationCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
        throw new Error("验证码错误")
      }
      await db.emailVerificationCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
    }
    await verifyCode(oldEmailLower, "CHANGE_EMAIL_OLD", oldCode)
    await verifyCode(emailLower, "CHANGE_EMAIL_NEW", newCode)

    const exists = await db.user.findFirst({ where: { email: emailLower, deletedAt: null, id: { not: ctx.userId } } })
    if (exists) throw new Error("该邮箱已被其他账号使用")

    await db.user.update({ where: { id: ctx.userId }, data: { email: emailLower } })
    await writeSecurityEvent({ userId: ctx.userId, username: ctx.username, eventType: "EMAIL_CHANGE", success: true, detail: `邮箱变更 ${oldEmailLower} → ${emailLower}` })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EMAIL_CHANGE",
      resourceType: "USER",
      resourceId: ctx.userId,
      severity: "WARN",
      before: { email: oldEmailLower },
      after: { email: emailLower },
    })
    return null
  })
}

// ---- 安全日志数据（供页面 RSC 直接用 db，此处提供分页 action 给客户端刷新） ----
export async function getBackupCodeCountAction(): Promise<ActionResult<{ count: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    return { count: await countUnusedBackupCodes(ctx.userId) }
  })
}
