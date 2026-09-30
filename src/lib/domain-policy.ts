// ============================================================
// 域名黑白名单策略（Domain Access Policy）
// 作用域四层：GLOBAL 全局规则 + 用户所属组（含继承链）组级规则 + 用户级规则 + 单沙箱规则
// 语义：
//   · 黑名单模式（默认）：命中 BLACK 规则的域名被 Chromium URLBlocklist 拦截
//   · 白名单模式：任一作用域存在启用的 WHITE 规则 → 进入白名单严格模式
//     （URLBlocklist=["*"] 全量阻断 + URLAllowlist 白名单放行，最强管控）
//   · deny-wins 冲突抑制（确保完全安全）：同一 pattern 同时出现在 BLACK 与 WHITE
//     （不论作用域层级）→ 封禁胜出，放行例外被抑制 —— 上层封禁不可被下层豁免
// 执行层：
//   L1 Chromium 托管策略（与内网/安全位置/文件封禁合并写入同一份只读 bind-mount 策略文件）
//   L2 MCP/OpenAPI browser.blockUrls 运行时拦截（CDP Network.setBlockedURLs）
// 来源追踪：每条生效规则携带来源（GLOBAL/GROUP/USER/SANDBOX + 规则ID），管理端可视化
// ============================================================

import { db } from "./db"
import { resolveNetworkPolicy, type NetworkPolicy } from "./network-policy"
import { resolveEndpointPolicyForUser, type EndpointPolicy } from "./endpoint-policy"
import { resolveFilePolicy, type FilePolicy } from "./file-policy"

export interface ScopedDomainRule {
  id: string
  pattern: string
  type: "BLACK" | "WHITE"
  priority: number
  source: "GLOBAL" | "GROUP" | "USER" | "SANDBOX"
  sourceGroupId?: string | null
  sourceUserId?: string | null
  sourceWorkspaceId?: string | null
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

// ---- deny-wins 冲突抑制：同一 pattern 同封同放 → 封禁胜出（上层封禁不可被下层豁免）----
function suppressConflicts(rules: Array<{ pattern: string; type: "BLACK" | "WHITE" }>): { black: string[]; white: string[] } {
  const blackSet = new Set<string>()
  const whiteSet = new Set<string>()
  for (const r of rules) {
    if (r.type === "BLACK") blackSet.add(r.pattern)
    else whiteSet.add(r.pattern)
  }
  // 冲突 pattern 从放行集移除（保留在封禁集）
  for (const b of blackSet) whiteSet.delete(b)
  return { black: [...blackSet], white: [...whiteSet] }
}

// ---- 单目标解析（四层合并；workspaceId 非空即含单沙箱规则层）----
export async function resolveDomainPolicyForUser(userId: string, workspaceId?: string | null): Promise<DomainPolicy> {
  const resolvedAt = new Date().toISOString()
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
  if (!user || user.deletedAt) return EMPTY_POLICY(resolvedAt)

  // 沙箱归属强校验：仅当沙箱属于该用户时才并入 SANDBOX 层规则（防越权串扰）
  let sandboxId: string | null = null
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({
      where: { id: workspaceId },
      select: { userId: true, deletedAt: true },
    })
    if (ws && !ws.deletedAt && ws.userId === userId) sandboxId = workspaceId
  }

  const groupIds = await effectiveGroupIds(userId)
  const rules = await db.domainRule.findMany({
    where: {
      enabled: true,
      OR: [
        { scopeType: "GLOBAL" },
        { scopeType: "GROUP", groupId: { in: groupIds } },
        { scopeType: "USER", userId },
        ...(sandboxId ? [{ scopeType: "SANDBOX", workspaceId: sandboxId }] : []),
      ],
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  })

  const scoped: ScopedDomainRule[] = []
  for (const r of rules) {
    const scope = (r as unknown as { scopeType?: string }).scopeType || "GLOBAL"
    const gid = (r as unknown as { groupId?: string | null }).groupId ?? null
    const uid = (r as unknown as { userId?: string | null }).userId ?? null
    const wid = (r as unknown as { workspaceId?: string | null }).workspaceId ?? null
    scoped.push({
      id: r.id,
      pattern: r.pattern,
      type: (r.type === "WHITE" ? "WHITE" : "BLACK"),
      priority: r.priority ?? 0,
      source: scope === "USER" ? "USER" : scope === "GROUP" ? "GROUP" : scope === "SANDBOX" ? "SANDBOX" : "GLOBAL",
      sourceGroupId: gid,
      sourceUserId: uid,
      sourceWorkspaceId: wid,
    })
  }

  const { black: blackPatterns, white: whitePatterns } = suppressConflicts(scoped)

  return {
    mode: whitePatterns.length > 0 ? "WHITELIST" : "BLACKLIST",
    rules: scoped,
    blackPatterns: dedupe(blackPatterns),
    whitePatterns: dedupe(whitePatterns),
    resolvedAt,
  }
}

// ---- 批量解析（列表页一次装配；pairs 含 workspaceId 即按沙箱维度并入 SANDBOX 规则）----
export async function resolveDomainPoliciesBatch(
  pairs: Array<{ userId: string; workspaceId?: string | null }>,
): Promise<Map<string, DomainPolicy>> {
  const out = new Map<string, DomainPolicy>()
  if (pairs.length === 0) return out
  const resolvedAt = new Date().toISOString()
  const userIds = [...new Set(pairs.map((p) => p.userId))].filter(Boolean)
  const workspaceIds = [...new Set(pairs.map((p) => p.workspaceId).filter((x): x is string => !!x))]

  const [users, memberships, groups, allRules, workspaces] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, deletedAt: true } }),
    db.groupUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } }),
    db.group.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, parentId: true } }),
    db.domainRule.findMany({ where: { enabled: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }),
    workspaceIds.length
      ? db.browserWorkspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, userId: true } })
      : Promise.resolve([] as Array<{ id: string; userId: string }>),
  ])
  const wsById = new Map(workspaces.map((w) => [w.id, w]))

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
  for (const p of pairs) {
    const key = p.workspaceId || p.userId
    const uid = p.userId
    if (deletedUsers.has(uid)) {
      out.set(key, EMPTY_POLICY(resolvedAt))
      continue
    }
    // 沙箱归属校验：仅当沙箱属于该用户时并入 SANDBOX 规则
    const sandboxOk = p.workspaceId ? (() => { const w = wsById.get(p.workspaceId!); return !!w && w.userId === uid })() : false
    const gids = groupsByUser.get(uid) ?? new Set<string>()
    const scoped: ScopedDomainRule[] = []
    for (const r of allRules) {
      const scope = (r as unknown as { scopeType?: string }).scopeType || "GLOBAL"
      const gid = (r as unknown as { groupId?: string | null }).groupId ?? null
      const ruid = (r as unknown as { userId?: string | null }).userId ?? null
      const rwid = (r as unknown as { workspaceId?: string | null }).workspaceId ?? null
      if (scope === "USER" && ruid !== uid) continue
      if (scope === "GROUP" && (!gid || !gids.has(gid))) continue
      if (scope === "SANDBOX" && (!sandboxOk || rwid !== p.workspaceId)) continue
      scoped.push({
        id: r.id,
        pattern: r.pattern,
        type: (r.type === "WHITE" ? "WHITE" : "BLACK"),
        priority: r.priority ?? 0,
        source: scope === "USER" ? "USER" : scope === "GROUP" ? "GROUP" : scope === "SANDBOX" ? "SANDBOX" : "GLOBAL",
        sourceGroupId: gid,
        sourceUserId: ruid,
        sourceWorkspaceId: rwid,
      })
    }
    const { black: blackPatterns, white: whitePatterns } = suppressConflicts(scoped)
    out.set(key, {
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
// 组合解析：一次取齐 网络访问策略（内网/安全位置） + 域名黑白名单策略 + 端点级精确限制策略 + 文件限制策略
// 供工作区创建/启动/切代理/看门狗自愈统一调用；workspaceId 非空即全部按四层（含单沙箱级）解析
// ============================================================
export interface AccessPolicyBundle {
  network: NetworkPolicy
  domain: DomainPolicy
  endpoint: EndpointPolicy
  file: FilePolicy
}

export async function resolveAccessPolicies(userId: string, workspaceId?: string | null): Promise<AccessPolicyBundle> {
  const [network, domain, endpoint, file] = await Promise.all([
    resolveNetworkPolicy(userId, workspaceId),
    resolveDomainPolicyForUser(userId, workspaceId),
    resolveEndpointPolicyForUser(userId, workspaceId),
    resolveFilePolicy(userId, workspaceId),
  ])
  return { network, domain, endpoint, file }
}
