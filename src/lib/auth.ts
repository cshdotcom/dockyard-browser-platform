import type { NextAuthOptions } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import { db } from "./db"
import { sha256, verifyPassword, deviceFingerprint, decrypt } from "./crypto"
import { verifyTotp, getTotpSecret, consumeBackupCode } from "./totp"
import { writeSecurityEvent, writeAudit } from "./audit"
import { trackLoginFailure, clearLoginFailure } from "./rate-limit"
import { getConfigBool, getConfigNumber } from "./config"
import { sendMail, remoteLoginAlertTemplate } from "./email"

// NextAuth 配置：JWT(HttpOnly Cookie) + Credentials策略 + 2FA ticket 机制
// 登录流程：pre-login 校验凭证 → 签发短期 ticket → signIn(ticket) 建立正式会话

export interface TicketClaims {
  sub: string // userId
  typ: "LOGIN" | "2FA" | "FORCE_SETUP"
  remember: boolean
  jti: string
  exp: number
}

// 简易 JWT 签发/校验（ticket 用，HMAC-SHA256）
import crypto from "crypto"
function b64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url")
}
function sign(payload: object): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac("sha256", process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dockyard-dev-secret-change-me").update(`${header}.${body}`).digest("base64url")
  return `${header}.${body}.${sig}`
}
function verify(ticket: string): TicketClaims | null {
  try {
    const [h, b, s] = ticket.split(".")
    const expected = crypto.createHmac("sha256", process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dockyard-dev-secret-change-me").update(`${h}.${b}`).digest("base64url")
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null
    const claims = JSON.parse(Buffer.from(b, "base64url").toString()) as TicketClaims
    if (claims.exp < Date.now() / 1000) return null
    return claims
  } catch {
    return null
  }
}

export function issueLoginTicket(userId: string, typ: TicketClaims["typ"], remember: boolean): { ticket: string; jti: string } {
  const jti = crypto.randomUUID()
  const exp = Math.floor(Date.now() / 1000) + 300 // ticket 5分钟有效
  return { ticket: sign({ sub: userId, typ, remember, jti, exp }), jti }
}

export function verifyLoginTicket(ticket: string): TicketClaims | null {
  return verify(ticket)
}

// 检查是否命中强制2FA策略（全局或用户组）
export async function force2faRequired(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user || user.twoFactorEnabled) return false
  if (user.role === "SUPER_ADMIN" || user.role === "ADMIN") {
    // 管理员也遵守全局强制策略
  }
  const globalForce = await getConfigBool("security.globalForce2fa", false)
  if (globalForce) return true
  const inherit = await getConfigBool("security.groupInheritForce2fa", true)
  if (!inherit) return false
  const gids = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  for (const g of gids) {
    const grp = await db.group.findUnique({ where: { id: g.groupId } })
    if (grp?.force2fa) return true
  }
  return false
}

// 创建登录会话（LoginSession + RefreshToken）
export async function createLoginSession(
  userId: string,
  opts: { ip: string; ua: string; remember: boolean; trusted: boolean; deviceId: string; loginSessionHash?: string }
) {
  const rememberDays = await getConfigNumber("session.rememberDays", 30)
  const shortHours = await getConfigNumber("session.shortLivedHours", 12)
  const maxLifetimeHours = await getConfigNumber("session.maxLifetimeHours", 168)
  const idleMin = await getConfigNumber("session.idleTimeoutMin", 30)
  const jti = crypto.randomUUID()
  const sessionHash = opts.loginSessionHash || sha256(jti)

  const expiresHours = opts.remember ? Math.min(rememberDays * 24, maxLifetimeHours) : Math.min(shortHours, maxLifetimeHours)
  const expiresAt = new Date(Date.now() + expiresHours * 3600_000)

  const refreshRaw = crypto.randomBytes(48).toString("hex")
  const rt = await db.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(refreshRaw),
      expiresAt: new Date(Date.now() + Math.max(expiresHours, 72) * 3600_000), // refreshToken 至少72h
      clientIp: opts.ip,
      userAgent: opts.ua,
    },
  })

  const session = await db.loginSession.create({
    data: {
      userId,
      refreshTokenId: rt.id,
      sessionHash,
      ip: opts.ip,
      userAgent: opts.ua,
      deviceId: opts.deviceId,
      trusted: opts.trusted,
      rememberMe: opts.remember,
      deviceLabel: opts.ua.slice(0, 120),
      expiresAt,
      idleTimeoutSec: idleMin * 60,
      lastActiveAt: new Date(),
    },
  })

  // 异地登录检测：历史IP比对
  try {
    const history = await db.securityEvent.findMany({
      where: { userId, eventType: "LOGIN_SUCCESS", ip: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { ip: true },
    })
    const knownIps = new Set(history.map((h) => h.ip))
    const remoteAlert = await getConfigBool("security.remoteLoginAlert", true)
    if (remoteAlert && !knownIps.has(opts.ip) && knownIps.size > 0) {
      const user = await db.user.findUnique({ where: { id: userId } })
      if (user?.email) {
        void sendMail(
          user.email,
          "【Dockyard】异地登录风险提醒",
          remoteLoginAlertTemplate(opts.ip, opts.ua, new Date().toLocaleString("zh-CN"))
        ).catch(() => {})
      }
      await writeSecurityEvent({
        userId,
        eventType: "REMOTE_LOGIN_ALERT",
        detail: `新IP登录：${opts.ip}`,
        ip: opts.ip,
        userAgent: opts.ua,
      })
    }
  } catch (e) {
    console.error("[login] remote detection failed", e)
  }

  return { session, refreshTokenRaw: refreshRaw, sessionHash }
}

// 撤销登录会话
export async function revokeLoginSession(sessionId: string, reason: string) {
  const session = await db.loginSession.findUnique({ where: { id: sessionId } })
  if (!session) return
  await db.loginSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  if (session.refreshTokenId) {
    await db.refreshToken.updateMany({ where: { id: session.refreshTokenId }, data: { revokedAt: new Date() } })
  }
}

// ============================================================
// 会话 Cookie Secure 属性决策
// 历史缺陷：secure 挂在 NODE_ENV=production 上 → Docker 生产镜像下恒为 true，
// 而平台常通过 http://IP:81（Caddy 明文网关）访问 —— 浏览器会直接丢弃带 Secure
// 属性的 Cookie（仅 HTTPS / localhost 可信来源可存），于是 signIn 返回成功、
// 前端提示「登录成功」，但 Cookie 从未落盘 → 跳转 /dashboard 被守卫弹回 /login，
// 表现为「一直没登进去」。
// 修正为环境驱动自动检测：COOKIE_SECURE=1/true 强制开、0/false 强制关；
// 未配置时仅当公开访问地址（AUTH_PUBLIC_URL/AUTH_URL/NEXTAUTH_URL）为 https 才启用。
// ============================================================
const AUTH_PUBLIC_URL = process.env.AUTH_PUBLIC_URL || process.env.AUTH_URL || process.env.NEXTAUTH_URL || ""
export const sessionCookieSecure: boolean =
  process.env.COOKIE_SECURE === "1" || process.env.COOKIE_SECURE === "true"
    ? true
    : process.env.COOKIE_SECURE === "0" || process.env.COOKIE_SECURE === "false"
      ? false
      : AUTH_PUBLIC_URL.startsWith("https://")

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 3600, // 载体有效期；实际会话时长由 LoginSession.expiresAt 强制约束
  },
  cookies: {
    sessionToken: {
      name: `dockyard-session`,
      options: {
        httpOnly: true, // XSS 防护：禁止JS读取
        sameSite: "lax",
        secure: sessionCookieSecure,
        path: "/",
      },
    },
  },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    CredentialsProvider({
      name: "Dockyard",
      credentials: {
        ticket: { label: "ticket", type: "text" },
        totp: { label: "totp", type: "text" },
        trustDevice: { label: "trustDevice", type: "text" },
      },
      async authorize(credentials, req) {
        const ticket = credentials?.ticket
        if (!ticket) return null
        const claims = verifyLoginTicket(ticket)
        if (!claims) return null

        const user = await db.user.findUnique({ where: { id: claims.sub } })
        if (!user || user.deletedAt) return null
        if (!user.enabled || user.frozen) return null
        if (user.lockedUntil && user.lockedUntil > new Date()) return null

        const reqAny = req as unknown as { headers?: Record<string, string | undefined> }
        const ip =
          reqAny?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
          reqAny?.headers?.["x-real-ip"] ||
          "127.0.0.1"
        const ua = reqAny?.headers?.["user-agent"] || "unknown"
        const deviceId = deviceFingerprint(ua, ip)

        // ---- 2FA 校验 ----
        if (claims.typ === "2FA") {
          // 受信任设备跳过
          const trustedRow = await db.trustedDevice.findFirst({
            where: { userId: user.id, deviceId, revokedAt: null, expiresAt: { gt: new Date() } },
          })
          if (trustedRow) {
            await db.trustedDevice.update({ where: { id: trustedRow.id }, data: { lastUsedAt: new Date() } })
          } else {
            const code = (credentials?.totp || "").trim()
            if (!code) {
              await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_2FA", success: false, detail: "缺少2FA验证码", ip, userAgent: ua })
              return null
            }
            const secret = await getTotpSecret(user.id)
            let ok = false
            if (secret) ok = verifyTotp(code, secret)
            if (!ok && !/^\d{6}$/.test(code)) {
              ok = await consumeBackupCode(user.id, code)
            }
            if (!ok) {
              await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_2FA", success: false, detail: "2FA验证码错误", ip, userAgent: ua })
              clearLoginFailure(user.username)
              trackLoginFailure(user.username + ":2fa")
              return null
            }
            await writeSecurityEvent({ userId: user.id, username: user.username, eventType: "LOGIN_2FA", success: true, ip, userAgent: ua })
          }
        }

        // 建立登录会话
        const trustDevice = credentials?.trustDevice === "true"
        let trusted = false
        if (trustDevice && claims.typ === "2FA") {
          // 勾选信任此设备：写入受信任设备记录
          const days = await getConfigNumber("security.trustedDeviceDays", 30)
          await db.trustedDevice.upsert({
            where: { userId_deviceId: { userId: user.id, deviceId } },
            update: { expiresAt: new Date(Date.now() + days * 86400_000), revokedAt: null, lastUsedAt: new Date(), ip, ua },
            create: { userId: user.id, deviceId, label: ua.slice(0, 80), ua, ip, expiresAt: new Date(Date.now() + days * 86400_000), lastUsedAt: new Date() },
          })
          trusted = true
        }

        const jti = crypto.randomUUID()
        const sessionHash = sha256(jti)
        const { session } = await createLoginSession(user.id, { ip, ua, remember: claims.remember, trusted, deviceId, loginSessionHash: sessionHash })

        clearLoginFailure(user.username)

        await db.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            lastLoginIp: ip,
            failedLoginCount: 0,
            loginSessionCount: { increment: 1 },
            force2faSetup: claims.typ === "FORCE_SETUP",
          },
        })

        await writeSecurityEvent({
          userId: user.id,
          username: user.username,
          eventType: "LOGIN_SUCCESS",
          detail: claims.typ === "2FA" ? "双因素验证登录" : claims.typ === "FORCE_SETUP" ? "强制2FA设置会话" : "密码登录",
          ip,
          userAgent: ua,
        })
        await writeAudit({
          operatorUserId: user.id,
          operatorName: user.username,
          operationType: "LOGIN",
          resourceType: "USER",
          resourceId: user.id,
          resourceName: user.username,
          extra: { sessionId: session.id, ip, remember: claims.remember, trusted },
        })

        return {
          id: user.id,
          name: user.username,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          loginSessionId: session.id,
          sessionHash,
          jti,
          force2faSetup: claims.typ === "FORCE_SETUP",
        } as unknown as {
          id: string
          name: string
          email: string | null
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as unknown as {
          id: string
          role: string
          loginSessionId: string
          sessionHash: string
          jti: string
          force2faSetup: boolean
          displayName?: string | null
        }
        token.uid = u.id
        token.role = u.role
        token.sid = u.loginSessionId
        token.sHash = u.sessionHash
        token.jti = u.jti
        token.force2faSetup = u.force2faSetup
        token.displayName = u.displayName
      }
      return token
    },
    async session({ session, token }) {
      // 每次会话读取：校验 LoginSession 有效性（撤销/过期/闲置）—— 会话管理强约束点
      const sid = token.sid as string | undefined
      let valid = false
      let needs2faSetup = (token.force2faSetup as boolean) || false
      if (sid) {
        try {
          const ls = await db.loginSession.findUnique({ where: { id: sid } })
          if (ls && !ls.revokedAt && ls.expiresAt > new Date()) {
            const idleLimitMs = (ls.idleTimeoutSec || 1800) * 1000
            if (Date.now() - ls.lastActiveAt.getTime() < idleLimitMs) {
              valid = true
              // 闲置心跳节流更新：超过60秒才写库
              if (Date.now() - ls.lastActiveAt.getTime() > 60_000) {
                await db.loginSession.update({ where: { id: sid }, data: { lastActiveAt: new Date() } }).catch(() => {})
              }
            } else {
              await revokeLoginSession(sid, "IDLE_TIMEOUT")
            }
          }
        } catch {
          // DB异常时保守放行（避免全站不可用），写操作层还有二次校验
          valid = true
        }
      }
      const uid = token.uid as string | undefined
      let role = (token.role as string) || "USER"
      let displayName = token.displayName as string | undefined
      if (uid && valid) {
        // 实时角色（管理员调整权限立即生效）
        const u = await db.user.findUnique({ where: { id: uid }, select: { role: true, displayName: true, frozen: true, enabled: true } })
        if (u) {
          role = u.role
          displayName = u.displayName ?? displayName
          if (!u.enabled || u.frozen) valid = false
        }
      }
      ;(session.user as Record<string, unknown>).id = uid
      ;(session.user as Record<string, unknown>).role = role
      ;(session.user as Record<string, unknown>).displayName = displayName
      ;(session.user as Record<string, unknown>).loginSessionId = sid
      ;(session.user as Record<string, unknown>).sessionValid = valid
      ;(session.user as Record<string, unknown>).needs2faSetup = needs2faSetup && valid
      return session
    },
  },
}
