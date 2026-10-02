import { db } from "./db"
import { getConfigBool, getConfigNumber } from "./config"

// ============================================================
// r23：API-Key 精确管控策略链（四级：每Key覆盖 > 用户级 > 组级 > 全局默认）
// 字段：allowCreate / maxPerUser / allowPermanent / maxLifetimeDays / rateLimitPerMin / allowedScopes
// · 每Key rateLimitPerMin：ApiToken.rateLimitPerMin（null=继承）
// · 用户级 User.tokenPolicy（JSON，null 字段=继承）
// · 组级 Group.tokenPolicy（用户多组取"最严格"：数值取最小、布尔取禁止）
// · 全局 token.* 配置（默认值）
// · SUPER_ADMIN 豁免（不受限制，便于平台运维兜底）
// ============================================================

export interface TokenPolicy {
  /** 是否允许创建 API-Key */
  allowCreate: boolean
  /** 单用户最大 Key 数量 */
  maxPerUser: number
  /** 是否允许永久 Key */
  allowPermanent: boolean
  /** Key 最大有效时长（天，0=不限） */
  maxLifetimeDays: number
  /** 每分钟调用上限（0=用全局默认） */
  rateLimitPerMin: number
  /** 允许的功能范围（null=不限） */
  allowedScopes: string[] | null
  /** 各字段的来源标注（UI 回显"生效值+来源"用） */
  sources: Partial<Record<keyof Omit<TokenPolicy, "sources">, "key" | "user" | "group" | "global">>
}

const GLOBAL_DEFAULTS = () => ({
  allowCreate: true,
  maxPerUser: 10,
  allowPermanent: true,
  maxLifetimeDays: 365,
  rateLimitPerMin: 0,
  allowedScopes: null as string[] | null,
})

/** 读取 JSON 策略字段（null/undefined 字段=继承） */
function readPolicy(raw: unknown): Partial<TokenPolicy> {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as Record<string, unknown>
  const out: Partial<TokenPolicy> = {}
  if (typeof obj.allowCreate === "boolean") out.allowCreate = obj.allowCreate
  if (Number.isFinite(Number(obj.maxPerUser))) out.maxPerUser = Math.max(0, Math.floor(Number(obj.maxPerUser)))
  if (typeof obj.allowPermanent === "boolean") out.allowPermanent = obj.allowPermanent
  if (Number.isFinite(Number(obj.maxLifetimeDays))) out.maxLifetimeDays = Math.max(0, Math.floor(Number(obj.maxLifetimeDays)))
  if (Number.isFinite(Number(obj.rateLimitPerMin))) out.rateLimitPerMin = Math.max(0, Math.floor(Number(obj.rateLimitPerMin)))
  if (Array.isArray(obj.allowedScopes)) out.allowedScopes = obj.allowedScopes.map(String).filter(Boolean)
  if (obj.allowedScopes === null) out.allowedScopes = null
  return out
}

/** 解析某用户生效的 Token 策略（四级链 + 来源标注） */
export async function resolveTokenPolicy(userId: string): Promise<TokenPolicy> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, tokenPolicy: true } })
  const result: TokenPolicy = { ...GLOBAL_DEFAULTS(), sources: {} }
  if (!user || user.role === "SUPER_ADMIN") {
    if (user?.role === "SUPER_ADMIN") {
      result.allowCreate = true
      result.maxPerUser = 9999
      result.allowPermanent = true
      result.maxLifetimeDays = 0
      result.sources = { allowCreate: "global", maxPerUser: "global", allowPermanent: "global", maxLifetimeDays: "global" }
    }
    return result
  }

  // 全局默认值读取实际配置
  result.allowCreate = await getConfigBool("token.allowCreate", true)
  result.maxPerUser = await getConfigNumber("token.maxPerUser", 10)
  result.allowPermanent = await getConfigBool("token.allowPermanent", true)
  result.maxLifetimeDays = await getConfigNumber("token.maxLifetimeDays", 365)
  const globalRate = await getConfigNumber("mcp.perKeyPerMinute", 300)
  result.rateLimitPerMin = globalRate

  // 组级（多组取最严格：数值最小、布尔禁止优先、scope 取交集）
  const gids = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  const groups = gids.length > 0 ? await db.group.findMany({ where: { id: { in: gids.map((g) => g.groupId) }, deletedAt: null } }) : []
  let groupScoped = false
  for (const grp of groups) {
    const p = readPolicy(grp.tokenPolicy)
    if (p.allowCreate === false) { result.allowCreate = false; result.sources.allowCreate = "group" }
    if (p.maxPerUser !== undefined && p.maxPerUser < result.maxPerUser) { result.maxPerUser = p.maxPerUser; result.sources.maxPerUser = "group" }
    if (p.allowPermanent === false) { result.allowPermanent = false; result.sources.allowPermanent = "group" }
    if (p.maxLifetimeDays !== undefined && p.maxLifetimeDays > 0 && (result.maxLifetimeDays === 0 || p.maxLifetimeDays < result.maxLifetimeDays)) { result.maxLifetimeDays = p.maxLifetimeDays; result.sources.maxLifetimeDays = "group" }
    if (p.rateLimitPerMin !== undefined && p.rateLimitPerMin > 0 && (result.rateLimitPerMin === 0 || p.rateLimitPerMin < result.rateLimitPerMin)) { result.rateLimitPerMin = p.rateLimitPerMin; result.sources.rateLimitPerMin = "group" }
    if (p.allowedScopes !== undefined && p.allowedScopes !== null) {
      result.allowedScopes = groupScoped && result.allowedScopes ? result.allowedScopes.filter((s) => p.allowedScopes!.includes(s)) : p.allowedScopes
      groupScoped = true
      result.sources.allowedScopes = "group"
    }
  }

  // 用户级覆盖（逐字段：显式设置才覆盖）
  const up = readPolicy(user.tokenPolicy)
  if (up.allowCreate !== undefined) { result.allowCreate = up.allowCreate; result.sources.allowCreate = "user" }
  if (up.maxPerUser !== undefined) { result.maxPerUser = up.maxPerUser; result.sources.maxPerUser = "user" }
  if (up.allowPermanent !== undefined) { result.allowPermanent = up.allowPermanent; result.sources.allowPermanent = "user" }
  if (up.maxLifetimeDays !== undefined) { result.maxLifetimeDays = up.maxLifetimeDays; result.sources.maxLifetimeDays = "user" }
  if (up.rateLimitPerMin !== undefined) { result.rateLimitPerMin = up.rateLimitPerMin; result.sources.rateLimitPerMin = "user" }
  if (up.allowedScopes !== undefined) { result.allowedScopes = up.allowedScopes; result.sources.allowedScopes = "user" }

  return result
}

/** 每分钟调用上限四级解析（鉴权热路径用：每Key > 用户/组策略 > 全局） */
export async function resolveTokenRatePerMin(opts: { tokenId?: string; userId: string }): Promise<number> {
  // 每Key覆盖
  if (opts.tokenId) {
    const t = await db.apiToken.findUnique({ where: { id: opts.tokenId }, select: { rateLimitPerMin: true } }).catch(() => null)
    if (t?.rateLimitPerMin != null && t.rateLimitPerMin > 0) return t.rateLimitPerMin
  }
  const policy = await resolveTokenPolicy(opts.userId)
  // 0 = 用全局默认（mcp.perKeyPerMinute 在 resolveTokenPolicy 已作为 global 值读入）
  return policy.rateLimitPerMin > 0 ? policy.rateLimitPerMin : await getConfigNumber("mcp.perKeyPerMinute", 300)
}

/** 创建/管理 Key 时的策略校验（返回 null=通过；否则返回错误信息） */
export async function checkTokenPolicyForCreate(userId: string, opts: { expireDays: number | null; scopes?: string[] | null }): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (user?.role === "SUPER_ADMIN") return null
  const policy = await resolveTokenPolicy(userId)
  if (!policy.allowCreate) return "管理员已禁止你创建 API-Key（可在用户/组策略中调整）"
  if (opts.expireDays === null && !policy.allowPermanent) return "管理员已禁止创建永久 Key（请设置有效期）"
  if (opts.expireDays != null && policy.maxLifetimeDays > 0 && opts.expireDays > policy.maxLifetimeDays) {
    return `Key 有效期不能超过 ${policy.maxLifetimeDays} 天（当前策略上限）`
  }
  if (policy.allowedScopes && policy.allowedScopes.length > 0 && opts.scopes && opts.scopes.length > 0) {
    const illegal = opts.scopes.filter((s) => !policy.allowedScopes!.includes(s))
    if (illegal.length > 0) return `功能范围超出策略限制：${illegal.join("、")}（允许：${policy.allowedScopes.join("、")}）`
  }
  return null
}

/** 数量校验（创建前调用） */
export async function checkTokenQuota(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (user?.role === "SUPER_ADMIN") return null
  const policy = await resolveTokenPolicy(userId)
  const count = await db.apiToken.count({ where: { userId, deletedAt: null } })
  if (count >= policy.maxPerUser) return `已达 Key 数量上限（${policy.maxPerUser} 个，策略来源：${policy.sources.maxPerUser === "user" ? "用户级" : policy.sources.maxPerUser === "group" ? "组级" : "全局"}）`
  return null
}

/** 清洗策略 JSON（保存前：去掉全部 null 字段→存稀疏对象） */
export function sanitizeTokenPolicyInput(raw: unknown): Record<string, unknown> {
  const p = readPolicy(raw)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k === "sources") continue
    if (v !== undefined) out[k] = v
  }
  return out
}
