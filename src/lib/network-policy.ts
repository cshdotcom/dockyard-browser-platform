// ============================================================
// 网络访问策略（Network Access Policy）
// 管理员按【用户 / 用户组】控制浏览器会话是否允许：
//   1. allowInternalNetwork       —— 访问内网（RFC1918 私有网段 / 链路本地 / 云元数据 / mDNS）
//   2. allowSecureLocationAccess  —— 访问容器内所有安全位置
//      （本机 CDP:9222 / VNC:5900 端口、file:// 协议、chrome:// 管理页、
//        平台内部端点：Next 应用 / VNC 网关桥 / CDP 服务 / Docker API 代理）
//
// 解析优先级（三层，逐级回退，默认全部拒绝）：
//   USER（用户级覆盖，allowXxx != null）
//     > GROUP（所属组，沿 parentId 继承链向上取第一个显式组级值）
//       > GLOBAL_DEFAULT（system_config：security.defaultAllowInternalNetwork / security.defaultAllowSecureLocationAccess，默认 false）
//
// 执行层（纵深防御，双层真实拦截）：
//   L1 Chromium 托管策略（/etc/chromium/policies/managed/dockyard.json，只读 bind-mount，
//      只读根 FS 下用户无法篡改）：URLBlocklist 在 URL 分类阶段直接拦截导航/子资源/WebSocket，
//      与是否走代理无关；WebRtcIPHandling 关闭非代理 UDP 防局域网泄漏。
//   L2 Sing-Box 路由拦截（ip_cidr 真实 CIDR，action=block）：供内部 sing-box / 管理端编排注入。
//   L3 Docker 网络层：会话网络 ICC=false（容器互访封禁，跨用户浏览器网络不可达）。
// ============================================================

import { db } from "./db"
import { getConfigBool } from "./config"
import { ENV } from "./env"
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import type { DomainPolicy } from "./domain-policy"

export interface NetworkPolicy {
  allowInternalNetwork: boolean
  allowSecureLocationAccess: boolean
  source: "USER" | "GROUP" | "GLOBAL_DEFAULT"
  sourceGroupId?: string | null
  resolvedAt: string
}

// ---- 内网网段（IPv4 通配符模式，Chromium URLBlocklist 语法）----
const PRIVATE_HOST_PATTERNS: string[] = [
  "localhost",
  "127.*",
  "0.0.0.0",
  "10.*",
  "192.168.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
  "169.254.*", // 链路本地 + 云元数据 169.254.169.254
  "100.64.*", // CGNAT 起始段（收口常见内网穿透网段）
  "[::1]",
  "[fe80:*]",
  "[fc*]",
  "[fd*]",
  "*.local", // mDNS
]

// ---- 容器内安全位置（本机服务端口 / 协议 / 管理页）----
const SECURE_LOCAL_ENDPOINTS: string[] = [
  "localhost:9222",
  "127.0.0.1:9222", // 容器内 CDP 服务（自控通道，严禁沙箱内网页触达）
  "localhost:5900",
  "127.0.0.1:5900", // 容器内 VNC(RFB)
  "file://*",
  "file:///*",
  "chrome://settings",
  "chrome://extensions",
  "chrome://flags",
  "chrome://net-internals",
  "chrome://version",
  "chrome://policy",
  "chrome://system",
  "devtools://*",
]

// 覆盖的 URL 方案（scheme-less 条目在部分 Chromium 版本仅匹配默认方案，逐方案冗余覆盖）
const SCHEMES = ["", "http://", "https://", "ws://", "wss://", "ftp://"]

function expandPatterns(patterns: string[]): string[] {
  const out: string[] = []
  for (const p of patterns) {
    // IPv6 字面量与特殊协议不拼方案前缀
    if (p.startsWith("[") || p.includes("://")) {
      out.push(p)
      continue
    }
    for (const s of SCHEMES) out.push(s + p)
  }
  return out
}

// 平台内部端点（宿主网关上的全部服务端口）
export function platformSecureEndpoints(): string[] {
  const ports = [
    ENV.appPort, // NextJS 统一网关（页面/API/Server Actions）
    ENV.vncBridgePort, // HelmPort VNC 网关桥
    ENV.cdpServicePort, // CDP 服务后台端口
    Number(process.env.WS_HUB_PORT || 3003), // 事件推送枢纽
  ]
  return ports.filter((p) => p > 0).map((p) => String(p))
}

// ---- 策略解析（三层回退，默认拒绝）----
export async function resolveNetworkPolicy(userId: string): Promise<NetworkPolicy> {
  const resolvedAt = new Date().toISOString()
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { allowInternalNetwork: true, allowSecureLocationAccess: true, deletedAt: true },
  })
  // 用户级显式覆盖（两字段独立判断：任一字段非 null 即取该字段值，未覆盖字段回退组级）
  if (user && !user.deletedAt) {
    const a = user.allowInternalNetwork
    const b = user.allowSecureLocationAccess
    if (a !== null && a !== undefined && b !== null && b !== undefined) {
      return { allowInternalNetwork: a, allowSecureLocationAccess: b, source: "USER", resolvedAt }
    }
  }

  // 组级（沿 parentId 继承链向上，取第一个显式设置的组）
  const groups = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  const seen = new Set<string>()
  for (const g of groups) {
    let cursor: string | null = g.groupId
    let depth = 0
    while (cursor && !seen.has(cursor) && depth < 8) {
      // 防环：已访问即停
      seen.add(cursor)
      const grp = await db.group.findUnique({
        where: { id: cursor },
        select: { allowInternalNetwork: true, allowSecureLocationAccess: true, parentId: true, deletedAt: true, enabled: true },
      })
      if (grp && !grp.deletedAt && grp.enabled) {
        const a = grp.allowInternalNetwork
        const b = grp.allowSecureLocationAccess
        if (a !== null && a !== undefined && b !== null && b !== undefined) {
          // 用户级半覆盖（仅一个字段非空）与组级合并：用户字段优先
          const ua = user?.allowInternalNetwork ?? null
          const ub = user?.allowSecureLocationAccess ?? null
          return {
            allowInternalNetwork: ua !== null && ua !== undefined ? ua : a,
            allowSecureLocationAccess: ub !== null && ub !== undefined ? ub : b,
            source: "GROUP",
            sourceGroupId: cursor,
            resolvedAt,
          }
        }
      }
      cursor = grp?.parentId ?? null
      depth += 1
    }
  }

  // 用户级半覆盖兜底（无组级值时，已覆盖字段生效，其余取全局默认）
  const defA = await getConfigBool("security.defaultAllowInternalNetwork", false)
  const defB = await getConfigBool("security.defaultAllowSecureLocationAccess", false)
  const ua = user?.allowInternalNetwork ?? null
  const ub = user?.allowSecureLocationAccess ?? null
  if ((ua !== null && ua !== undefined) || (ub !== null && ub !== undefined)) {
    return {
      allowInternalNetwork: ua !== null && ua !== undefined ? ua : defA,
      allowSecureLocationAccess: ub !== null && ub !== undefined ? ub : defB,
      source: "GLOBAL_DEFAULT",
      resolvedAt,
    }
  }
  return { allowInternalNetwork: defA, allowSecureLocationAccess: defB, source: "GLOBAL_DEFAULT", resolvedAt }
}

// ---- Chromium 托管策略生成（容器内真实拦截层 L1）----
export interface ChromiumPolicyOptions {
  policy: NetworkPolicy
  gatewayIp?: string | null // 会话网络网关（宿主服务入口）
  proxyUrl?: string | null // 锁定代理（ProxyMode=fixed_servers，用户不可改）
  domainPolicy?: DomainPolicy | null // 域名黑白名单（作用域合并后）
}

export function buildChromiumManagedPolicy(opts: ChromiumPolicyOptions): Record<string, unknown> {
  const { policy } = opts
  const blocklist: string[] = []
  const allowlist: string[] = []
  let whitelistMode = false

  if (!policy.allowInternalNetwork) {
    blocklist.push(...expandPatterns(PRIVATE_HOST_PATTERNS))
  }
  if (!policy.allowSecureLocationAccess) {
    blocklist.push(...expandPatterns(SECURE_LOCAL_ENDPOINTS))
    // 平台内部端点（网关 IP + 平台端口）——显式 host:port 精确封禁
    const gw = opts.gatewayIp
    if (gw) {
      for (const port of platformSecureEndpoints()) {
        blocklist.push(`${gw}:${port}`)
      }
    }
  }

  // —— 域名黑白名单（黑名单直接入 blocklist；白名单模式切换 allowlist 严格语义）——
  if (opts.domainPolicy && opts.domainPolicy.rules.length > 0) {
    const dp = opts.domainPolicy
    if (dp.mode === "WHITELIST") {
      whitelistMode = true
      for (const w of dp.whitePatterns) {
        for (const s of SCHEMES) allowlist.push(s + w)
      }
      // 命中黑名单的白名单模式：黑名单规则叠加在 allowlist 之上（同为放行集内排除）
      for (const b of dp.blackPatterns) {
        for (const s of SCHEMES) allowlist.push("!" + s + b) // ! 前缀 = 白名单内排除例外
      }
      blocklist.push("*") // 全量阻断，仅白名单放行（allowlist 优先于 blocklist 命中）
    } else {
      for (const b of dp.blackPatterns) {
        for (const s of SCHEMES) blocklist.push(s + b)
      }
      // 黑名单模式下白名单规则仍有价值：作为 blocklist 内的例外放行（半放行）
      for (const w of dp.whitePatterns) {
        for (const s of SCHEMES) blocklist.push("!" + s + w)
      }
    }
  }

  const managed: Record<string, unknown> = {
    URLBlocklist: blocklist,
    // 沙箱内禁选文件（配合 file:// 封禁）
    AllowFileSelectionDialogs: false,
  }
  if (whitelistMode) managed.URLAllowlist = allowlist
  // 内网封禁时：WebRTC 仅走代理 UDP，防本机/局域网 IP 泄漏与 P2P 直连
  if (!policy.allowInternalNetwork) {
    managed.WebRtcIPHandling = "disable_non_proxied_udp"
    managed.AllowWebRtcUdpPorts = [] as number[]
  }
  // 安全位置封禁时：锁定代理设置（chrome://settings 已封禁，策略层再锁一道）
  if (!policy.allowSecureLocationAccess && opts.proxyUrl) {
    managed.ProxyMode = "fixed_servers"
    managed.ProxyServer = opts.proxyUrl
    managed.ProxyBypassList = "<-loopback>"
  }
  return managed
}

// ---- Sing-Box 路由拦截规则（真实 CIDR，供编排注入；L2）----
export const NETWORK_POLICY_BLOCK_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16", // 含云元数据 169.254.169.254
  "100.64.0.0/10",
  "0.0.0.0/8",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
]

export function singboxPolicyRouteRules(policy: NetworkPolicy): Array<Record<string, unknown>> {
  if (policy.allowInternalNetwork) return []
  return [
    {
      // 最高优先（priority < 0，置于全部用户规则之前）：内网网段全部拒绝
      outbound: "block",
      ip_cidr: NETWORK_POLICY_BLOCK_CIDRS,
      _dockyardPolicy: "deny_internal_network",
    },
  ]
}

// ---- 策略文件落盘（bind-mount 只读注入容器 /etc/chromium/policies/managed/）----
export function networkPolicyDir(): string {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "netpolicy")
}

export async function writeNetworkPolicyFile(
  key: string,
  opts: ChromiumPolicyOptions,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(key)) return null // 杜绝路径穿越
  const managed = buildChromiumManagedPolicy(opts)
  const dir = networkPolicyDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${key}.json`)
  await writeFile(path, JSON.stringify(managed, null, 2), { encoding: "utf-8" })
  return path
}

// 读取会话网络网关 IP（Docker 网络检查；模拟环境返回 null）
export async function sessionNetworkGateway(): Promise<string | null> {
  try {
    const { ENV: env, externalAvailable } = await import("./env")
    if (!externalAvailable.docker) return null
    const res = await fetch(`${env.dockerApiUrl.replace(/\/$/, "")}/networks/dockyard-sessions`, {
      signal: AbortSignal.timeout(env.dockerApiTimeout),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { IPAM?: { Config?: Array<{ Gateway?: string }> } }
    return json.IPAM?.Config?.find((c) => c.Gateway)?.Gateway ?? null
  } catch {
    return null
  }
}

// 策略人读摘要（列表/详情展示）
export function describeNetworkPolicy(p: NetworkPolicy): string {
  const src = p.source === "USER" ? "用户级覆盖" : p.source === "GROUP" ? "组级继承" : "全局默认"
  const inner = p.allowInternalNetwork ? "允许内网" : "禁止内网"
  const secure = p.allowSecureLocationAccess ? "允许安全位置" : "禁止安全位置"
  return `${src} · ${inner} · ${secure}`
}

// ---- 批量解析（列表页一次装配，避免逐行 N+1）----
export async function resolveNetworkPoliciesBatch(
  userIds: string[],
): Promise<Map<string, NetworkPolicy>> {
  const out = new Map<string, NetworkPolicy>()
  if (userIds.length === 0) return out
  const resolvedAt = new Date().toISOString()
  const [users, memberships, groups, defA, defB] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, allowInternalNetwork: true, allowSecureLocationAccess: true, deletedAt: true },
    }),
    db.groupUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } }),
    db.group.findMany({
      where: { deletedAt: null },
      select: { id: true, parentId: true, enabled: true, allowInternalNetwork: true, allowSecureLocationAccess: true },
    }),
    getConfigBool("security.defaultAllowInternalNetwork", false),
    getConfigBool("security.defaultAllowSecureLocationAccess", false),
  ])
  const userById = new Map(users.map((u) => [u.id, u]))
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  const groupIdsByUser = new Map<string, string[]>()
  for (const m of memberships) {
    const arr = groupIdsByUser.get(m.userId) || []
    arr.push(m.groupId)
    groupIdsByUser.set(m.userId, arr)
  }

  const pick = (v: boolean | null | undefined): boolean | null =>
    v === null || v === undefined ? null : v

  for (const uid of userIds) {
    const u = userById.get(uid)
    if (!u || u.deletedAt) continue
    const ua = pick(u.allowInternalNetwork)
    const ub = pick(u.allowSecureLocationAccess)

    // 用户级全显式 → 直接生效
    if (ua !== null && ub !== null) {
      out.set(uid, { allowInternalNetwork: ua, allowSecureLocationAccess: ub, source: "USER", resolvedAt })
      continue
    }

    // 组级：成员组沿继承链向上找第一个显式组
    let ga: boolean | null = null
    let gb: boolean | null = null
    let sourceGroupId: string | null = null
    for (const gid of groupIdsByUser.get(uid) || []) {
      let cursor: string | null = gid
      const seen = new Set<string>()
      let depth = 0
      while (cursor && !seen.has(cursor) && depth < 8) {
        seen.add(cursor)
        const grp = groupsById.get(cursor)
        if (grp && grp.enabled) {
          const a = pick(grp.allowInternalNetwork)
          const b = pick(grp.allowSecureLocationAccess)
          if (a !== null && b !== null) {
            ga = a
            gb = b
            sourceGroupId = cursor
            break
          }
        }
        cursor = grp?.parentId ?? null
        depth += 1
      }
      if (ga !== null) break
    }

    if (ga !== null && gb !== null) {
      // 用户级半覆盖与组级合并
      out.set(uid, {
        allowInternalNetwork: ua !== null ? ua : ga,
        allowSecureLocationAccess: ub !== null ? ub : gb,
        source: "GROUP",
        sourceGroupId,
        resolvedAt,
      })
      continue
    }

    // 全局默认（用户级半覆盖仍优先）
    out.set(uid, {
      allowInternalNetwork: ua !== null ? ua : defA,
      allowSecureLocationAccess: ub !== null ? ub : defB,
      source: "GLOBAL_DEFAULT",
      resolvedAt,
    })
  }
  return out
}
