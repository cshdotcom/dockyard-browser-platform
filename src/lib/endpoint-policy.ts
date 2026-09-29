// ============================================================
// 端点级精确限制策略（Endpoint Access Policy —— host:port 精确到端口）
// 作用域三层（与域名规则同模型）：GLOBAL 全局 + 用户所属组（含继承链）+ 用户级
// 语义：
//   · BLACK 规则 → Chromium URLBlocklist 精确拦截 host:port（内网放行后仍可封指定端点）
//   · WHITE 规则 → 黑名单语义下的例外放行（“!host:port” 例外语法）
//   · 与域名白名单严格模式共存：WHITE 端点进入 URLAllowlist 放行集
// 支持的模式形态（规范化输出为 Chromium URL 过滤模式）：
//   · IP 字面量          10.0.0.5 / 10.0.0.5:8080 / 127.0.0.1:*（任意端口）
//   · IP 通配            10.0.0.* / 192.168.1.*:443
//   · CIDR（/8 /16 /24 /32 → 通配展开）  10.0.0.0/24:443
//   · 域名（含通配）      *.corp.com / internal.corp:22
//   · IPv6 字面量        [::1] / [::1]:9222 / [fe80::]:5900
//   · 端口区间（≤16 展开） 10.0.0.5:8000-8003
//   · 任意主机指定端口    *:22（Chromium 端 host 通配）
// 执行层：L1 Chromium 托管策略（与网络/域名策略合并写入同一只读策略文件）
// 来源追踪：每条生效规则携带来源（GLOBAL/GROUP/USER + 规则ID）
// ============================================================

import { db } from "./db"
import { effectiveGroupIds } from "./domain-policy"

export interface ScopedEndpointRule {
  id: string
  pattern: string
  type: "BLACK" | "WHITE"
  priority: number
  source: "GLOBAL" | "GROUP" | "USER"
  sourceGroupId?: string | null
  sourceUserId?: string | null
}

export interface EndpointPolicy {
  rules: ScopedEndpointRule[] // 全部生效规则（含来源）
  blackPatterns: string[] // 去重后的拦截端点模式（host[:port]）
  whitePatterns: string[] // 去重后的放行例外端点模式
  resolvedAt: string
}

const EMPTY_POLICY = (resolvedAt: string): EndpointPolicy => ({
  rules: [],
  blackPatterns: [],
  whitePatterns: [],
  resolvedAt,
})

// ---- 模式规范化（Chromium URL 过滤语法：host[:port]，可选 scheme 前缀被剥离）----
export function normalizeEndpointPattern(input: string): string | null {
  let p = (input || "").trim().toLowerCase()
  if (!p || p.length > 253) return null
  // 去协议前缀（http:// https:// ws:// wss:// ftp://）——记录是否含 scheme（决定路径剥离语义）
  let hadScheme = false
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, () => {
    hadScheme = true
    return ""
  })
  // 去路径：仅对含 scheme 的 URL 形态剥离（host/path）；
  // 无 scheme 的斜杠属于 CIDR 记法（如 10.0.0.0/24），必须保留
  if (hadScheme) {
    const slash = p.indexOf("/")
    if (slash > 0) p = p.slice(0, slash)
  }

  // —— IPv6 形态：[xxxx::xxxx] 或 [xxxx::xxxx]:port ——
  if (p.startsWith("[")) {
    const close = p.indexOf("]")
    if (close < 0) return null
    const host = p.slice(0, close + 1) // 含方括号
    const rest = p.slice(close + 1)
    let port: string | null = null
    if (rest.startsWith(":")) {
      port = rest.slice(1)
      if (!/^(\d{1,5}|\*)$/.test(port)) return null
      if (port !== "*" && (Number(port) < 1 || Number(port) > 65535)) return null
    } else if (rest !== "") return null
    if (!/^\[[0-9a-f:]+\]$/.test(host)) return null
    if (countChar(host, ":") < 2) return null // 至少 ::1 形态
    return port === "*" ? host : port ? `${host}:${port}` : host
  }

  // —— 主机[:port] 拆分（host 为 IPv4 / 域名 / 通配 / CIDR）——
  const lastColon = p.lastIndexOf(":")
  let hostPart = p
  let portPart: string | null = null
  if (lastColon > 0) {
    const maybePort = p.slice(lastColon + 1)
    if (/^\d{1,5}$/.test(maybePort) || maybePort === "*" || /^\d{1,5}-\d{1,5}$/.test(maybePort)) {
      hostPart = p.slice(0, lastColon)
      portPart = maybePort
    }
  }

  // —— CIDR 展开（仅 IPv4 /8 /16 /24 /32 → 通配；其他前缀拒绝）——
  if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(hostPart)) {
    const [ip, bitsRaw] = hostPart.split("/")
    const bits = Number(bitsRaw)
    if (![8, 16, 24, 32].includes(bits)) return null
    const oct = ip.split(".").map(Number)
    if (oct.some((o) => o > 255)) return null
    const wildcardOctets = 4 - bits / 8
    let hostOut: string
    if (wildcardOctets === 0) hostOut = ip
    else if (wildcardOctets === 1) hostOut = `${oct[0]}.${oct[1]}.${oct[2]}.*`
    else if (wildcardOctets === 2) hostOut = `${oct[0]}.${oct[1]}.*`
    else hostOut = `${oct[0]}.*`
    return withPort(hostOut, portPart)
  }

  // —— 主机合法性：IPv4 字面量（纯数字/点 → 严格八位组校验）/ 域名（含通配）/ 单星 ——
  // 纯数字与点组成的主机只允许合法 IPv4 或 IPv4 通配形态（尾段 *），否则拒绝（不落入域名分支）
  if (/^[\d.]+$/.test(hostPart)) {
    const segs = hostPart.split(".")
    if (segs.some((s) => s === "")) return null
    const hasWildcard = segs[segs.length - 1] === "*"
    if (hasWildcard && (segs.length < 2 || segs.length > 4)) return null
    if (!hasWildcard && segs.length !== 4) return null
    for (const seg of segs) {
      if (seg === "*") continue
      if (!/^\d{1,3}$/.test(seg) || Number(seg) > 255) return null
    }
  }
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){0,3}(\.\*)?$/.test(hostPart) && hostPart.split(".").every((seg) => seg === "*" || Number(seg) <= 255)
  const isDomain = /^[a-z0-9.*-]+$/.test(hostPart) && !hostPart.includes("**") && !hostPart.includes(" ")
  if (hostPart !== "*" && !isIpv4 && !isDomain) return null

  return withPort(hostPart, portPart)
}

function withPort(host: string, portPart: string | null): string | null {
  if (portPart === null || portPart === "*") return host // 无端口/任意端口 = 全端口语义
  if (/^\d{1,5}$/.test(portPart)) {
    const n = Number(portPart)
    if (n < 1 || n > 65535) return null
    return `${host}:${n}`
  }
  // 区间：80-90（≤16 个端口展开为多条模式；跨度过大拒绝）
  const m = portPart.match(/^(\d{1,5})-(\d{1,5})$/)
  if (!m) return null
  const lo = Number(m[1])
  const hi = Number(m[2])
  if (lo < 1 || hi > 65535 || hi <= lo || hi - lo > 15) return null
  return `${host}:${lo}-${hi}` // 区间标记：由 expandEndpointPattern 展开
}

// 区间模式 → 逐端口多条模式（入策略文件时展开）
export function expandEndpointPattern(pattern: string): string[] {
  const m = pattern.match(/^(.+):(\d{1,5})-(\d{1,5})$/)
  if (!m) return [pattern]
  const host = m[1]
  const out: string[] = []
  for (let p = Number(m[2]); p <= Number(m[3]); p++) out.push(`${host}:${p}`)
  return out
}

// ---- 单用户解析（三层合并）----
export async function resolveEndpointPolicyForUser(userId: string): Promise<EndpointPolicy> {
  const resolvedAt = new Date().toISOString()
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })
  if (!user || user.deletedAt) return EMPTY_POLICY(resolvedAt)

  const groupIds = await effectiveGroupIds(userId)
  const rules = await db.networkEndpointRule.findMany({
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

  return buildEndpointPolicy(rules, resolvedAt)
}

// ---- 批量解析（列表页一次装配）----
export async function resolveEndpointPoliciesBatch(userIds: string[]): Promise<Map<string, EndpointPolicy>> {
  const out = new Map<string, EndpointPolicy>()
  if (userIds.length === 0) return out
  const resolvedAt = new Date().toISOString()
  const [users, memberships, groups, allRules] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, deletedAt: true } }),
    db.groupUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } }),
    db.group.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, parentId: true } }),
    db.networkEndpointRule.findMany({ where: { enabled: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }),
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
    const scoped = allRules.filter((r) => {
      const scope = (r as unknown as { scopeType?: string }).scopeType || "GLOBAL"
      const gid = (r as unknown as { groupId?: string | null }).groupId ?? null
      const ruid = (r as unknown as { userId?: string | null }).userId ?? null
      if (scope === "USER") return ruid === uid
      if (scope === "GROUP") return !!gid && gids.has(gid)
      return true
    })
    out.set(uid, buildEndpointPolicy(scoped, resolvedAt))
  }
  return out
}

type RuleRow = {
  id: string
  pattern: string
  type: string
  priority: number | null
  scopeType?: string
  groupId?: string | null
  userId?: string | null
}

function buildEndpointPolicy(rules: RuleRow[], resolvedAt: string): EndpointPolicy {
  const scoped: ScopedEndpointRule[] = rules.map((r) => {
    const scope = r.scopeType || "GLOBAL"
    return {
      id: r.id,
      pattern: r.pattern,
      type: r.type === "WHITE" ? "WHITE" : "BLACK",
      priority: r.priority ?? 0,
      source: scope === "USER" ? "USER" : scope === "GROUP" ? "GROUP" : "GLOBAL",
      sourceGroupId: r.groupId ?? null,
      sourceUserId: r.userId ?? null,
    }
  })
  const blackPatterns: string[] = []
  const whitePatterns: string[] = []
  for (const r of scoped) {
    // 解析期二次规范化（纵深防御：库中历史数据可能为原始未规范化形态，如 CIDR 记法）
    const normalized = normalizeEndpointPattern(r.pattern) ?? r.pattern
    if (r.type === "WHITE") whitePatterns.push(normalized)
    else blackPatterns.push(normalized)
  }
  return {
    rules: scoped,
    blackPatterns: [...new Set(blackPatterns.filter(Boolean))],
    whitePatterns: [...new Set(whitePatterns.filter(Boolean))],
    resolvedAt,
  }
}

// 人读摘要
export function describeEndpointPolicy(p: EndpointPolicy): string {
  if (p.rules.length === 0) return "无端点规则"
  const b = p.blackPatterns.length
  const w = p.whitePatterns.length
  return w > 0 ? `拦截 ${b} 项 · 例外放行 ${w} 项` : `拦截 ${b} 项`
}

function countChar(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}
