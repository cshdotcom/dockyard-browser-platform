// ============================================================
// 管理员账号引导（Bootstrap）
// 两种注册路径（均幂等、可后期经账号安全页修改）：
//   1. 配置文件/环境变量：ADMIN_USERNAME + ADMIN_EMAIL + ADMIN_PASSWORD
//      （start.sh 启动时 seed 自动创建；ADMIN_PASSWORD_FORCE=1 可强制同步密码）
//   2. 首次启动引导页 /setup：库中无管理员时开放注册，注册完成即关闭
// 安全：仅当库中不存在 ADMIN/SUPER_ADMIN 时开放注册；注册后写入审计与安全事件；
//       独立限流防爆破；用户名/邮箱与既有账号冲突时明确报错。
// ============================================================

import { db } from "./db"
import { writeAudit, writeSecurityEvent } from "./audit"
import { rateLimit } from "./rate-limit"

export interface BootstrapState {
  hasAdmin: boolean // 库中是否已有管理员
  userCount: number // 用户总数
  needsSetup: boolean // 是否开放 /setup 注册（无管理员且无任何用户）
}

export async function getBootstrapState(): Promise<BootstrapState> {
  const [adminCount, userCount] = await Promise.all([
    db.user.count({ where: { role: { in: ["ADMIN", "SUPER_ADMIN"] }, deletedAt: null } }),
    db.user.count({ where: { deletedAt: null } }),
  ])
  return {
    hasAdmin: adminCount > 0,
    userCount,
    needsSetup: adminCount === 0 && userCount === 0,
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface FirstAdminInput {
  username: string
  displayName?: string | null
  email?: string | null
  password: string
}

// 密码强度（与主注册流程一致的基线要求）
export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return "密码长度至少 10 位"
  if (pw.length > 128) return "密码长度至多 128 位"
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) return "密码需同时包含大写与小写字母"
  if (!/[0-9]/.test(pw)) return "密码需包含数字"
  return null
}

export async function registerFirstAdmin(input: FirstAdminInput): Promise<{ ok: boolean; message: string; userId?: string }> {
  // 限流（引导页本身无会话，按 IP 无法在此获取 —— 以全局桶限速）
  if (!rateLimit("bootstrapFirstAdmin", 20, 10 * 60_000).allowed) {
    return { ok: false, message: "注册尝试过于频繁，请 10 分钟后再试" }
  }

  // 二次校验：库中已有管理员则彻底关闭（防竞态双注册）
  const state = await getBootstrapState()
  if (state.hasAdmin) {
    return { ok: false, message: "管理员账号已存在（初始化通道已关闭），请直接登录或使用环境变量引导" }
  }

  const username = (input.username || "").trim()
  const email = (input.email || "").trim() || null
  const displayName = (input.displayName || "").trim() || null

  if (!USERNAME_RE.test(username)) {
    return { ok: false, message: "用户名须为 3-32 位字母/数字/下划线/点/横线" }
  }
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, message: "邮箱格式不正确" }
  }
  const pwErr = validatePasswordStrength(input.password)
  if (pwErr) return { ok: false, message: pwErr }

  // 冲突检查（含软删除账号，防用户名复用混淆）
  const conflicts = await db.user.findMany({
    where: { OR: [{ username }, ...(email ? [{ email }] : [])] },
    select: { username: true, email: true, deletedAt: true },
    take: 5,
  })
  if (conflicts.some((c) => c.username === username)) {
    return { ok: false, message: "用户名已被占用" }
  }
  if (email && conflicts.some((c) => c.email === email)) {
    return { ok: false, message: "邮箱已被占用" }
  }

  const bcrypt = (await import("bcryptjs")).default
  const { db: prisma } = await import("./db")
  const user = await prisma.user.create({
    data: {
      username,
      email,
      displayName: displayName || "超级管理员",
      passwordHash: await bcrypt.hash(input.password, 12),
      role: "SUPER_ADMIN",
      enabled: true,
      emailVerified: true,
    },
  })

  await writeAudit({
    operatorUserId: user.id,
    operatorName: username,
    operationType: "BOOTSTRAP_FIRST_ADMIN",
    resourceType: "USER",
    resourceId: user.id,
    resourceName: username,
    after: { username, email, role: "SUPER_ADMIN", via: "首次启动引导页" },
    severity: "WARN",
  })
  await writeSecurityEvent({
    userId: user.id,
    username,
    eventType: "BOOTSTRAP_FIRST_ADMIN",
    success: true,
    detail: "首次启动引导：超级管理员账号已创建，初始化通道关闭",
  })

  return { ok: true, message: "管理员账号创建成功，请登录", userId: user.id }
}
