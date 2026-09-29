// ============================================================
// 域名黑白名单策略（Domain Access Policy）
// 作用域三层：GLOBAL 全局规则 + 用户所属组（含继承链）组级规则 + 用户级规则
// 语义：
//   · 黑名单模式（默认）：命中 BLACK 规则的域名被 Chromium URLBlocklist 拦截
//   · 白名单模式：任一作用域存在启用的 WHITE 规则 → 进入白名单严格模式
//     （URLBlocklist=["*"] 全量阻断 + URLAllowlist 白名单放行，最强管控）
// 执行层：
//   L1 Chromium 托管策略（与内网/安全位置封禁合并写入同一份只读 bind-mount 策略文件）
//   L2 MCP/OpenAPI browser.blockUrls 运行时拦截（CDP Network.setBlockedURLs）
// 来源追踪：每条生效规则携带来源（GLOBAL/GROUP/USER + 规则ID），管理端可视化
// ============================================================

import { db } from "./db"
import { resolveNetworkPolicy, type NetworkPolicy } from "./network-policy"
import { resolveEndpointPolicyForUser, type EndpointPolicy } from "./endpoint-policy"

export interface ScopedDomainRule {
  id: string
  pattern: string
  type: "BLACK" | "WHITE"
  priority: number
  source: "GLOBAL" | "GROUP" | "USER"
  sourceGroupId?: string | null
  sourceUserId?: string | null
}

export interface DomainPolicy {
  mode: "BLACKLIST" | "WHITELIST"
  rules: ScopedDomainRule[] // 全部生效规则（含来源）
  blackPatterns: string[] // 去重后的黑名单模式串
  whitePatterns: string[] // 去重后的白名单模式串
  resolvedAt: string
}

const EMPTY_POLICY = (resolvedAt: string): DomainPolicy => ({
  mode: "BLACKLIST",
  rules: [],
  blackPatterns: [],
  whitePatterns: [],
  resolvedAt,
})

// ---- 用户生效组ID集合（含 parentId 继承链，防环）----
export async function effectiveGroupIds(userId: string): Promise<string[]> {
  const memberships = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  const groups = await db.group.findMany({
    where: { deletedAt: null, enabled: true },
    select: { id: true, parentId: true },
  })
  const byId = new Map(groups.map((g) => [g.id, g]))
  const out = new Set<string>()
  for (const m of memberships) {
    let cursor: string | null = m.groupId
    const seen = new Set<string>()
    let depth = 0
    while (cursor && !seen.has(cursor) && depth < 8) {
      seen.add(cursor)
      out.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
      depth += 1
    }
  }
  return [...out]
}

// ---- 规则规范化：Chromium URL 过滤模式（域名通配）----
export function normalizeDomainPattern(input: string): string | null {
  let p = (input || "").trim().toLowerCase()
  if (!p || p.length > 253) return null
  // 去协议前缀
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  // 去路径（保留主机）
  const slash = p.indexOf("/")
  if (slash > 0) p = p.slice(0, slash)
  // 去端口
  p = p.replace(/:\d+$/, "")
  if (!/^[a-z0-9.*-]+$/.test(p)) return null // 仅允许合法主机字符与通配
  if (p === "*" || p.includes(" ") || p.includes("**")) return null
  return p
}

function dedupe(patterns: string[]): string[] {
  return [...new Set(patterns.filter(Boolean))]
}

// ---- 单用户解析（三层合并）----
export async function resolveDomainPolicyForUser(userId: string): Promise<DomainPolicy> {
  const resolvedAt = new Date().toISOString()
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
  if (!user || user.deletedAt) return EMPTY_POLICY(resolvedAt)

  const groupIds = await effectiveGroupIds(userId)
  const rules = await db.domainRule.findMany({
    where: {
      enabled: true,
      OR: [
        { scopeType: "GLOBAL" },
        { scopeType: "GROUP", groupId: { in: groupIds } },
        { scopeType: "USER", userId },
      ],
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  })

  const scoped: ScopedDomainRule[] = []
  for (const r of rules) {
    const scope = (r as unknown as { scopeType?: string }).scopeType || "GLOBAL"
    const gid = (r as unknown as { groupId?: string | null }).groupId ?? null
    const uid = (r as unknown as { userId?: string | null }).userId ?? null
    scoped.push({
      id: r.id,
      pattern: r.pattern,
      type: (r.type === "WHITE" ? "WHITE" : "BLACK"),
      priority: r.priority ?? 0,
      source: scope === "USER" ? "USER" : scope === "GROUP" ? "GROUP" : "GLOBAL",
      sourceGroupId: gid,
      sourceUserId: uid,
    })
  }

  const blackPatterns: string[] = []
  const whitePatterns: string[] = []
  for (const r of scoped) {
    if (r.type === "WHITE") whitePatterns.push(r.pattern)
    else blackPatterns.push(r.pattern)
  }

  return {
    mode: whitePatterns.length > 0 ? "WHITELIST" : "BLACKLIST",
    rules: scoped,
    blackPatterns: dedupe(blackPatterns),
    whitePatterns: dedupe(whitePatterns),
    resolvedAt,
  }
}

// ---- 批量解析（列表页一次装配）----
export async function resolveDomainPoliciesBatch(userIds: string[]): Promise<Map<string, DomainPolicy>> {
  const out = new Map<string, DomainPolicy>()
  if (userIds.length === 0) return out
  const resolvedAt = new Date().toISOString()

  const [users, memberships, groups, allRules] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, deletedAt: true } }),
    db.groupUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } }),
    db.group.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, parentId: true } }),
    db.domainRule.findMany({ where: { enabled: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }),
  ])

  const groupById = new Map(groups.map((g) => [g.id, g]))
  const groupsByUser = new Map<string, Set<string>>()
  for (const m of memberships) {
    const set = groupsByUser.get(m.userId) ?? new Set<string>()
    set.add(m.groupId)
    let cursor: string | null = groupById.get(m.groupId)?.parentId ?? null
    const seen = new Set<string>([m.groupId])
    let depth = 0
    while (cursor && !seen.has(cursor) && depth < 8) {
      seen.add(cursor)
      set.add(cursor)
      cursor = groupById.get(cursor)?.parentId ?? null
      depth += 1
    }
    groupsByUser.set(m.userId, set)
  }

  const deletedUsers = new Set(users.filter((u) => u.deletedAt).map((u) => u.id))
  for (const uid of userIds) {
    if (deletedUsers.has(uid)) {
      out.set(uid, EMPTY_POLICY(resolvedAt))
      continue
    }
    const gids = groupsByUser.get(uid) ?? new Set<string>()
    const scoped: ScopedDomainRule[] = []
    for (const r of allRules) {
      const scope = (r as unknown as { scopeType?: string }).scopeType || "GLOBAL"
      const gid = (r as unknown as { groupId?: string | null }).groupId ?? null
      const ruid = (r as unknown as { userId?: string | null }).userId ?? null
      if (scope === "USER" && ruid !== uid) continue
      if (scope === "GROUP" && (!gid || !gids.has(gid))) continue
      scoped.push({
        id: r.id,
        pattern: r.pattern,
        type: (r.type === "WHITE" ? "WHITE" : "BLACK"),
        priority: r.priority ?? 0,
        source: scope === "USER" ? "USER" : scope === "GROUP" ? "GROUP" : "GLOBAL",
        sourceGroupId: gid,
        sourceUserId: ruid,
      })
    }
    const blackPatterns: string[] = []
    const whitePatterns: string[] = []
    for (const r of scoped) {
      if (r.type === "WHITE") whitePatterns.push(r.pattern)
      else blackPatterns.push(r.pattern)
    }
    out.set(uid, {
      mode: whitePatterns.length > 0 ? "WHITELIST" : "BLACKLIST",
      rules: scoped,
      blackPatterns: dedupe(blackPatterns),
      whitePatterns: dedupe(whitePatterns),
      resolvedAt,
    })
  }
  return out
}

// 人读摘要
export function describeDomainPolicy(p: DomainPolicy): string {
  if (p.rules.length === 0) return "无域名规则"
  if (p.mode === "WHITELIST") return `白名单严格模式 · 放行 ${p.whitePatterns.length} 项`
  return `黑名单模式 · 拦截 ${p.blackPatterns.length} 项`
}

// ============================================================
// 组合解析：一次取齐 网络访问策略（内网/安全位置） + 域名黑白名单策略 + 端点级精确限制策略
// 供工作区创建/启动/切代理/看门狗自愈统一调用
// ============================================================
export interface AccessPolicyBundle {
  network: NetworkPolicy
  domain: DomainPolicy
  endpoint: EndpointPolicy
}

export async function resolveAccessPolicies(userId: string): Promise<AccessPolicyBundle> {
  const [network, domain, endpoint] = await Promise.all([
    resolveNetworkPolicy(userId),
    resolveDomainPolicyForUser(userId),
    resolveEndpointPolicyForUser(userId),
  ])
  return { network, domain, endpoint }
}
