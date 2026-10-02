import { getServerSession } from "next-auth"
import { authOptions } from "./auth"
import { db } from "./db"
import { BizError, bizError, ErrorCode } from "./errors"
import { getConfig, getConfigBool, getConfigNumber } from "./config"

// 统一权限校验：RSC / Server Action / Route Handler 三层均可调用
// 角色模型：SUPER_ADMIN > ADMIN > GROUP_ADMIN > USER
// 资源细粒度：VIEW / EDIT / DELETE / EXECUTE / SHARE / EXPORT

export type Role = "SUPER_ADMIN" | "ADMIN" | "GROUP_ADMIN" | "USER"
export type ResourceAction = "VIEW" | "EDIT" | "DELETE" | "EXECUTE" | "SHARE" | "EXPORT" | "CREATE"

export interface AuthContext {
  userId: string
  username: string
  displayName?: string | null
  email?: string | null
  role: Role
  loginSessionId?: string
}

export async function getAuthContext(): Promise<AuthContext | null> {
  // 1. Web 会话（NextAuth JWT + LoginSession 校验）
  const session = await getServerSession(authOptions)
  if (session?.user?.id) {
    // LoginSession 已撤销/过期/闲置 → 视为未登录
    if ((session.user as Record<string, unknown>).sessionValid === false) return null
    // r23：登录用户全局限流（rate.userQps 真实生效；内存桶，按 userId 计数）
    // 放在会话确认后：匿名请求走 apiHandler 的 anonymousQps；API-Key 走自身 QPS 体系
    try {
      const userQps = await getConfigNumber("rate.userQps", 30)
      if (userQps > 0) {
        const { rateLimit } = await import("./rate-limit")
        if (!rateLimit(`uqps:${session.user.id}`, userQps, 1000).allowed) {
          throw bizError(ErrorCode.RATE_LIMITED, "请求过于频繁（用户级限流），请稍后再试")
        }
      }
    } catch (e) {
      if (e instanceof BizError) throw e
      // 限流基础设施异常 → 放行
    }
    return {
      userId: session.user.id as string,
      username: (session.user.name as string) || "",
      displayName: (session.user as Record<string, unknown>).displayName as string | null ?? null,
      email: session.user.email || null,
      role: ((session.user as Record<string, unknown>).role as Role) || "USER",
      loginSessionId: (session.user as Record<string, unknown>).loginSessionId as string | undefined,
    }
  }
  // 2. API-Token 降级认证（MCP/OpenAPI 统一网关调用 Server Action 场景）
  try {
    const { headers } = await import("next/headers")
    const h = await headers()
    const apiKey = h.get("x-api-key") || h.get("authorization")?.replace(/^Bearer\s+/i, "") || ""
    if (apiKey) {
      const { db } = await import("./db")
      const { sha256 } = await import("./crypto")
      const token = await db.apiToken.findFirst({ where: { tokenHash: sha256(apiKey), deletedAt: null, enabled: true } })
      if (!token) return null
      if (token.expireAt && token.expireAt < new Date()) return null
      const user = await db.user.findUnique({ where: { id: token.userId } })
      if (!user || user.deletedAt || !user.enabled || user.frozen) return null
      return {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role as Role,
      }
    }
  } catch {
    // 非 request 上下文（定时任务）→ 无认证
  }
  return null
}

// 2FA 强制策略未完成 → 会话标记
export async function needs2faSetup(): Promise<boolean> {
  const session = await getServerSession(authOptions)
  return (session?.user as Record<string, unknown> | undefined)?.needs2faSetup === true
}

// ============================================================
// r23：强制 2FA 后端门控（真拦截，不仅前端提示）
// · requireWritableMode / requireAdmin / requireRole 均先行拦截：
//   未开通 2FA 且命中强制策略（用户级/组级/全局）时，除账号安全通道外全部拒绝
// · 管理员可配置 security.force2faAdminExempt 豁免 ADMIN/SUPER_ADMIN（保证后台可正常管理策略）
// · API-Key（MCP/OpenAPI）通道不受影响：机器调用无会话概念，用户要求 API/MCP 完整可用
// ============================================================
export async function enforce2faCompliance(): Promise<void> {
  const pending = await needs2faSetup()
  if (!pending) return
  // 管理员豁免开关（默认关闭：管理员同样被强制）
  const exempt = await getConfigBool("security.force2faAdminExempt", false)
  if (exempt) {
    const session = await getServerSession(authOptions)
    const role = (session?.user as Record<string, unknown> | undefined)?.role as string | undefined
    if (role === "SUPER_ADMIN" || role === "ADMIN") return
  }
  throw bizError(
    ErrorCode.FORBIDDEN,
    "管理员已强制要求开启双因素认证（2FA）：请先前往「账号安全」完成绑定后再使用平台功能（API-Key 机器调用不受影响）"
  )
}

// 必须登录，否则抛出
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext()
  if (!ctx) throw bizError(ErrorCode.UNAUTHORIZED, "未登录或会话已失效")
  return ctx
}

export async function requireRole(roles: Role[]): Promise<AuthContext> {
  const ctx = await requireAuth()
  if (!roles.includes(ctx.role)) throw bizError(ErrorCode.FORBIDDEN, "无权限执行该操作")
  return ctx
}

export async function requireAdmin(): Promise<AuthContext> {
  const ctx = await requireRole(["SUPER_ADMIN", "ADMIN"])
  await enforce2faCompliance() // r23：管理员读/写通道同样被 2FA 门控拦截
  return ctx
}

export async function requireSuperAdmin(): Promise<AuthContext> {
  const ctx = await requireRole(["SUPER_ADMIN"])
  await enforce2faCompliance()
  return ctx
}

// ---- 用户归属组 ----
export async function userGroupIds(userId: string): Promise<string[]> {
  const rows = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  return rows.map((r) => r.groupId)
}

export async function adminGroupIds(userId: string): Promise<string[]> {
  const rows = await db.groupAdmin.findMany({ where: { userId }, select: { groupId: true } })
  return rows.map((r) => r.groupId)
}

// 组管理员：只能操作绑定组内资源
export async function isGroupAdminOf(userId: string, targetUserId: string): Promise<boolean> {
  const adminGroups = await adminGroupIds(userId)
  if (adminGroups.length === 0) return false
  const targetGroups = await userGroupIds(targetUserId)
  return targetGroups.some((gid) => adminGroups.includes(gid))
}

// ---- 权限锁体系（16+ 细粒度开关，三层覆盖：GLOBAL > GROUP > USER 逐级生效，锁死优先） ----
export const PERMISSION_LOCK_KEYS = [
  "blockCreateWorkspace", "blockModifyWorkspace", "blockModifyResourceExpiry", "blockCreateApiToken",
  "blockEditTokenExpiry", "blockDeleteResource", "blockRestoreRecycle", "blockBatchOps",
  "blockExportData", "blockImportTemplate", "blockModifyProxyNetwork", "blockSwitchVncMode",
  "blockModifyOwnQuota", "blockViewOthersResourceList", "blockViewUsageStats", "blockEditProfile",
  "blockUploadScript", "blockCustomVncResolution", "blockCustomNetworkThrottle", "blockRefreshToken",
  "blockRefreshVncKey", "blockExportLogs", "blockShareWorkspace", "blockCopyOthersTemplate",
  "blockViewPublicIp", "blockSwitchProxyNode", "blockViewContainerDetail", "blockRestartInstance",
  "blockCleanOwnRecycle",
] as const
export type PermissionLockKey = (typeof PERMISSION_LOCK_KEYS)[number]

export async function isPermissionLocked(userId: string, lockKey: PermissionLockKey): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) return true
  if (user.role === "SUPER_ADMIN") return false // 超管不受权限锁约束

  // 用户级锁
  const userLocks = (user.permissionLocks as Record<string, boolean>) || {}
  if (userLocks[lockKey] === true) return true

  // 组级锁（用户归属任意组启用即锁）
  const gids = await userGroupIds(userId)
  for (const gid of gids) {
    const group = await db.group.findUnique({ where: { id: gid } })
    if (!group) continue
    const policy = (group.policy as Record<string, unknown>) || {}
    const locks = (policy.permissionLocks as Record<string, boolean>) || {}
    if (locks[lockKey] === true) return true
  }

  // 全局锁（system_config permissionLocks.global）
  const globalLocks = await getConfig<Record<string, boolean>>("permission.globalLocks", {})
  if (globalLocks[lockKey] === true) {
    // 管理员角色可豁免部分全局锁
    if (user.role === "ADMIN" && !lockKey.startsWith("blockView")) return false
    return true
  }
  return false
}

export async function requirePermission(userId: string, lockKey: PermissionLockKey, message?: string) {
  if (await isPermissionLocked(userId, lockKey)) {
    throw bizError(ErrorCode.PERMISSION_LOCKED, message || "该操作已被管理员权限锁禁止")
  }
}

// ---- 维护模式 / 只读模式 ----
export async function requireWritableMode() {
  await enforce2faCompliance() // r23：强制2FA未完成时禁止一切写操作（后端真拦截；仅账号安全链路不调用本函数）
  const readonly = await getConfigBool("readonly.enabled", false)
  if (readonly) throw bizError(ErrorCode.MAINTENANCE, "系统处于只读模式，禁止写入操作")
  const maintenance = await getConfigBool("maintenance.enabled", false)
  if (maintenance) {
    // 维护模式：查询允许，创建类资源被拦截
    throw bizError(ErrorCode.MAINTENANCE, await getConfig<string>("maintenance.message", "系统维护中"))
  }
}

// ---- 资源归属校验（多租户隔离核心） ----
interface OwnableResource {
  userId?: string | null
  groupId?: string | null
}

// 校验当前用户对资源的操作权限；管理员直通，组管理员管本组，普通用户仅自己
export async function requireResourceAccess(
  ctx: AuthContext,
  resource: OwnableResource | null,
  action: ResourceAction,
  resourceLabel = "资源"
): Promise<void> {
  if (!resource) throw bizError(ErrorCode.NOT_FOUND, `${resourceLabel}不存在或已删除`)
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return
  if (ctx.userId === resource.userId) return
  if (ctx.role === "GROUP_ADMIN") {
    const adminGroups = await adminGroupIds(ctx.userId)
    if (resource.groupId && adminGroups.includes(resource.groupId)) return
    if (resource.userId && (await isGroupAdminOf(ctx.userId, resource.userId))) return
  }
  // 查看动作允许被共享资源
  if (action === "VIEW") return // 共享校验由调用方单独做（workspaceShare）
  throw bizError(ErrorCode.FORBIDDEN, `无权操作该${resourceLabel}`)
}

// 配额校验：全局 / 组 / 个人 三级 + 预留水位保护
export interface QuotaSnapshot {
  globalUsed: number
  globalMax: number
  globalReserved: number
  groupUsed?: number
  groupMax?: number
  groupReserved?: number
  userUsed: number
  userMax?: number
}

export async function checkSessionQuota(
  userId: string,
  kind: "sessions" | "novncSessions"
): Promise<{ ok: boolean; reason?: string; snapshot: QuotaSnapshot }> {
  const mode = kind === "sessions" ? "cdp_light" : "novnc_full"
  const active = { status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null, mode }

  const globalUsed = await db.browserWorkspace.count({ where: active })
  const globalMax = await getConfig<number>(kind === "sessions" ? "workspace.maxConcurrentSessions" : "workspace.maxConcurrentNovnc", 50)
  const globalReserved = await getConfig<number>(kind === "sessions" ? "workspace.reservedSessions" : "workspace.reservedNovnc", 3)

  const userUsed = await db.browserWorkspace.count({ where: { ...active, userId } })
  const userQuota = await db.user.findUnique({ where: { id: userId }, select: { quota: true, role: true } })
  const userMax = (userQuota?.quota as Record<string, number> | null)?.[kind]

  const gids = await userGroupIds(userId)
  let groupUsed = 0
  let groupMax: number | undefined
  let groupReserved = 0
  for (const gid of gids) {
    const grp = await db.group.findUnique({ where: { id: gid } })
    if (!grp || grp.enabled === false) continue
    groupUsed += await db.browserWorkspace.count({ where: { ...active, groupId: gid } })
    const gq = (grp.quota as Record<string, number> | null)?.[kind]
    if (gq !== undefined && gq !== null) groupMax = (groupMax ?? 0) + gq
    const gr = ((grp.reservedQuota as Record<string, number> | null) || {})[kind]
    if (gr) groupReserved += gr
  }

  const snapshot: QuotaSnapshot = { globalUsed, globalMax, globalReserved, groupUsed, groupMax, groupReserved, userUsed, userMax }
  const isSuper = userQuota?.role === "SUPER_ADMIN"
  if (isSuper) return { ok: true, snapshot }

  // 预留水位：普通用户不能挤占预留资源
  if (globalUsed >= globalMax - globalReserved) {
    return { ok: false, reason: "全局并发已达上限（系统资源预留水位保护）", snapshot }
  }
  if (globalUsed >= globalMax) return { ok: false, reason: "全局并发会话已达上限", snapshot }
  if (userMax !== undefined && userMax !== null && userUsed >= userMax) {
    return { ok: false, reason: "个人并发会话配额已满", snapshot }
  }
  if (groupMax !== undefined && groupUsed >= groupMax - groupReserved) {
    return { ok: false, reason: "用户组配额已达上限（组预留水位保护）", snapshot }
  }
  return { ok: true, snapshot }
}
