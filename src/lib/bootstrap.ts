// ============================================================
// 管理员账号引导（Bootstrap）+ Setup Token 机制
//
// 初始化通道（幂等、可后期经账号安全页修改）：
//   1. 配置文件/环境变量：ADMIN_USERNAME + ADMIN_EMAIL + ADMIN_PASSWORD
//      （start.sh 启动时 seed 自动创建；ADMIN_PASSWORD_FORCE=1 可强制同步密码）
//   2. 首次启动引导页 /setup：库中无管理员时开放注册，注册完成即关闭
//
// —— Setup Token 安全门（本轮新增）——
//   · 服务进程每次启动生成一次性 setup token（环境变量 SETUP_TOKEN 可固定）
//   · 只要管理员尚未配置完成，每次重启 token 都会变化（模块级单例 = 进程生命周期）
//   · token 完整值仅两处可见：服务启动日志 + 数据目录 setup-token.txt（仅运维可读）
//   · /setup 注册第一个管理员时必须输入本 token，否则拒绝（防引导页被恶意抢占）
//   · 校验失败同样计入限流并写安全事件
//   · 注册成功后 token 文件即被删除，通道永久关闭
//
// 安全：仅当库中不存在 ADMIN/SUPER_ADMIN 时开放注册；注册后写入审计与安全事件；
//       独立限流防爆破；用户名/邮箱与既有账号冲突时明确报错。
// ============================================================

import { db } from "./db"
import { writeAudit, writeSecurityEvent } from "./audit"
import { rateLimit } from "./rate-limit"
import { randomBytes, timingSafeEqual } from "crypto"
import { mkdir, writeFile, unlink } from "fs/promises"
import { join, dirname } from "path"

// ---------------- Setup Token（进程级单例） ----------------
// 规则：
//   · SETUP_TOKEN 环境变量存在 → 固定 token（配置文件形态）
//   · 否则每次进程启动随机生成（未完成初始化时重启即变化）
//   · 以模块级常量初始化：Next.js 服务进程加载本模块时生效，恰为“启动时刻”
const SETUP_TOKEN_FILE = () => join(process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage", "setup-token.txt")

function generateSetupToken(): string {
  const fixed = process.env.SETUP_TOKEN
  if (fixed && fixed.trim().length >= 8) return fixed.trim()
  return randomBytes(16).toString("hex") // 32 位十六进制
}

const startupSetupToken = generateSetupToken()

// token 落盘 + 控制台输出（fire-and-forget：进程启动即写入，供运维检索）
function persistSetupTokenFile() {
  const file = SETUP_TOKEN_FILE()
  void mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, startupSetupToken + "\n", { encoding: "utf-8", mode: 0o600 }))
    .then(() => {
      console.log(
        `[bootstrap] Setup Token 已生成（管理员未完成初始化前每次重启都会变化）\n` +
          `[bootstrap] → 完整密钥: ${startupSetupToken}\n` +
          `[bootstrap] → 文件位置: ${file}\n` +
          `[bootstrap] → 首次访问 /setup 注册管理员时必须输入本密钥`,
      )
    })
    .catch(() => {
      // 文件不可写（只读卷等）：控制台输出仍然有效
      console.log(
        `[bootstrap] Setup Token: ${startupSetupToken}（token 文件写入失败，请从启动日志获取）`,
      )
    })
}
persistSetupTokenFile()

// 校验 setup token（恒时比较，防时序侧信道）
export function verifySetupToken(input: string): boolean {
  const a = Buffer.from((input || "").trim(), "utf-8")
  const b = Buffer.from(startupSetupToken, "utf-8")
  return a.length === b.length && timingSafeEqual(a, b)
}

// token 提示（脱敏：前 4 位 + 后 4 位；供 /setup 页面帮助运维核对日志）
export function setupTokenHint(): string {
  const t = startupSetupToken
  if (t.length <= 8) return "********"
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

// 清理 token 文件（注册成功后调用）
async function cleanupSetupTokenFile() {
  try {
    await unlink(SETUP_TOKEN_FILE())
  } catch {
    /* 文件不存在或不可写：忽略 */
  }
}

// ---------------- 引导状态 ----------------
export interface BootstrapState {
  hasAdmin: boolean // 库中是否已有管理员
  userCount: number // 用户总数
  needsSetup: boolean // 是否开放 /setup 注册（无管理员且无任何用户）
  setupTokenRequired: boolean // 注册时是否要求输入 setup token（恒 true：通道开放即校验）
  setupTokenHint: string // 当前启动 token 的脱敏提示（核对日志用）
}

export async function getBootstrapState(): Promise<BootstrapState> {
  const [adminCount, userCount] = await Promise.all([
    db.user.count({ where: { role: { in: ["ADMIN", "SUPER_ADMIN"] }, deletedAt: null } }),
    db.user.count({ where: { deletedAt: null } }),
  ])
  const needsSetup = adminCount === 0 && userCount === 0
  return {
    hasAdmin: adminCount > 0,
    userCount,
    needsSetup,
    setupTokenRequired: needsSetup,
    setupTokenHint: needsSetup ? setupTokenHint() : "",
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface FirstAdminInput {
  username: string
  displayName?: string | null
  email?: string | null
  password: string
  setupToken?: string // 启动密钥（管理员未初始化前每次重启变化；注册必须输入）
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

  // ---- Setup Token 校验（首道安全门）----
  if (!input.setupToken || !verifySetupToken(input.setupToken)) {
    await writeSecurityEvent({
      username: input.username || "unknown",
      eventType: "BOOTSTRAP_SETUP_TOKEN_FAIL",
      success: false,
      detail: `初始化引导 setup token 校验失败（提示应为 ${setupTokenHint()}）`,
    })
    return {
      ok: false,
      message: "启动密钥（Setup Token）不正确：请从服务启动日志或数据目录 setup-token.txt 获取当前进程的密钥",
    }
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

  // 注册成功 → 清理 token 文件（通道永久关闭）
  await cleanupSetupTokenFile()

  await writeAudit({
    operatorUserId: user.id,
    operatorName: username,
    operationType: "BOOTSTRAP_FIRST_ADMIN",
    resourceType: "USER",
    resourceId: user.id,
    resourceName: username,
    after: { username, email, role: "SUPER_ADMIN", via: "首次启动引导页（setup token 校验通过）" },
    severity: "WARN",
  })
  await writeSecurityEvent({
    userId: user.id,
    username,
    eventType: "BOOTSTRAP_FIRST_ADMIN",
    success: true,
    detail: "首次启动引导：超级管理员账号已创建（setup token 校验通过），初始化通道关闭，token 文件已清理",
  })

  return { ok: true, message: "管理员账号创建成功，请登录", userId: user.id }
}
