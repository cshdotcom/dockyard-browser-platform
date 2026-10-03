// ============================================================
// 网络访问策略（Network Access Policy）
// 管理员按【单沙箱 > 用户 / 用户组】控制浏览器会话是否允许：
//   1. allowInternalNetwork       —— 访问内网（RFC1918 私有网段 / 链路本地 / 云元数据 / mDNS）
//   2. allowSecureLocationAccess  —— 访问容器内所有安全位置
//      （本机 CDP:9222 / VNC:5900 端口、file:// 协议、chrome:// 管理页、
//        平台内部端点：Next 应用 / VNC 网关桥 / CDP 服务 / Docker API 代理）
//
// 解析优先级（四层，逐级回退，默认全部拒绝）：
//   SANDBOX（单沙箱级覆盖，BrowserWorkspace.policyAllowXxx 非 null 即生效，最高优先）
//     > USER（用户级覆盖，allowXxx != null）
//       > GROUP（所属组，沿 parentId 继承链向上取第一个显式组级值）
//         > GLOBAL_DEFAULT（system_config：security.defaultAllowInternalNetwork / security.defaultAllowSecureLocationAccess，默认 false）
//
// 执行层（纵深防御，双层真实拦截）：
//   L1 Chromium 托管策略（/etc/chromium/policies/managed/dockyard.json，只读 bind-mount，
//      只读根 FS 下用户无法篡改）：URLBlocklist 在 URL 分类阶段直接拦截导航/子资源/WebSocket，
//      与是否走代理无关；内网封禁时 WebRtcIPHandling 关闭非代理 UDP 防局域网泄漏（仅该场景，浏览器其余行为保持原汁原味）。
//   L2 Sing-Box 路由拦截（ip_cidr 真实 CIDR，action=block）：供内部 sing-box / 管理端编排注入。
//   L3 Docker 网络层：会话网络 ICC=false（容器互访封禁，跨用户浏览器网络不可达）。
// ============================================================

import { db } from "./db"
import { getConfigBool } from "./config"
import { ENV } from "./env"
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import type { DomainPolicy } from "./domain-policy"
import type { EndpointPolicy } from "./endpoint-policy"
import { expandEndpointPattern } from "./endpoint-policy"
import { filePolicyManagedPrefs, fileSchemeBlockPatterns, type FilePolicy } from "./file-policy"

// 安全关键键（网络/代理/CRX/WebRTC）：模板级 extraManagedPolicy 不得覆盖
//（目录层 validateExtraPolicies 已拒收；此处双保险跳过）
const SECURITY_OWNED_POLICY_KEYS = new Set([
  "URLBlocklist", "URLAllowlist", "ProxyMode", "ProxyServer", "ProxyBypassList",
  "ExtensionInstallForcelist", "ExtensionInstallBlocklist", "ExtensionSettings",
  "WebRtcIPHandling", "AllowWebRtcUdpPorts",
])

export interface NetworkPolicy {
  allowInternalNetwork: boolean
  allowSecureLocationAccess: boolean
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL_DEFAULT"
  sourceGroupId?: string | null
  sourceWorkspaceId?: string | null
  resolvedAt: string
}

// ---- 内网网段（IPv4 通配符模式，Chromium URLBlocklist 语法）----
// 含全部环回形态：localhost（任意端口）/ 127.0.0.0/8 全段（127.*）/ 0.0.0.0 / ::1 / [::]
const PRIVATE_HOST_PATTERNS: string[] = [
  "localhost",
  "*.localhost", // 某些实现将 *.localhost 视为环回
  "127.*", // 127.0.0.1 - 127.255.255.254 全段任意端口
  "0.0.0.0", // “未指定地址” —— 某些栈上会被解析为本机
  "10.*",
  "192.168.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
  "169.254.*", // 链路本地 + 云元数据 169.254.169.254
  "100.64.*", // CGNAT 起始段（收口常见内网穿透网段）
  "[::1]", // IPv6 环回
  "[::]", // IPv6 未指定地址
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
    Number(process.env.WS_EVENT_PORT || 3004), // 事件注入（仅回环监听）
  ]
  return ports.filter((p) => p > 0).map((p) => String(p))
}

// ---- 单容器全内置（r13）：跨沙箱安全基线（deny-wins，不可被任何作用域豁免）----
// 嵌入式沙箱与平台共享网络命名空间：即便管理员放行内网，也必须无条件封禁：
//   · 其他沙箱的 CDP/RFB 端口段（防跨沙箱浏览器接管 —— 单容器形态的 ICC 等价物）
//   · 平台自身端口（allowSecureLocationAccess=false 时；管理员显式授予后放行）
export const EMBEDDED_CDP_PORT_RANGE = { base: 29222, span: 60 } // 每沙箱 CDP 端口段（仅 127.0.0.1 绑定）
export const EMBEDDED_RFB_PORT_RANGE = { base: 25900, span: 60 } // 每沙箱 x11vnc 端口段（仅 127.0.0.1 绑定）

export function embeddedSandboxBaseline(includePlatform: boolean): string[] {
  const ports: number[] = []
  for (let i = 0; i < EMBEDDED_CDP_PORT_RANGE.span; i++) ports.push(EMBEDDED_CDP_PORT_RANGE.base + i)
  for (let i = 0; i < EMBEDDED_RFB_PORT_RANGE.span; i++) ports.push(EMBEDDED_RFB_PORT_RANGE.base + i)
  if (includePlatform) for (const p of platformSecureEndpoints()) ports.push(Number(p))
  // 三种环回形态全部覆盖（IPv4 / localhost / IPv6 字面量）
  const out: string[] = []
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const p of ports) out.push(`${h}:${p}`)
  }
  return out
}

// ---- 策略解析（四层回退：单沙箱 > 用户 > 组 > 全局默认，默认拒绝）----
export async function resolveNetworkPolicy(userId: string, workspaceId?: string | null): Promise<NetworkPolicy> {
  const resolvedAt = new Date().toISOString()

  // 0) 沙箱级覆盖（最高优先；归属强校验：仅作用于该沙箱所有者的解析链，防越权串扰）
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({
      where: { id: workspaceId },
      select: { userId: true, policyAllowInternalNetwork: true, policyAllowSecureLocationAccess: true, deletedAt: true },
    })
    if (ws && !ws.deletedAt && ws.userId === userId) {
      const a = ws.policyAllowInternalNetwork
      const b = ws.policyAllowSecureLocationAccess
      if (a !== null && a !== undefined && b !== null && b !== undefined) {
        return { allowInternalNetwork: a, allowSecureLocationAccess: b, source: "SANDBOX", sourceWorkspaceId: workspaceId, resolvedAt }
      }
    }
  }

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
  endpointPolicy?: EndpointPolicy | null // 端点级精确限制（host:port 作用域合并后）
  crxManagedPolicy?: Record<string, unknown> | null // CRX 扩展管控策略（五级合并后的 Managed Preferences）
  filePolicy?: import("./file-policy").FilePolicy | null // 文件访问限制策略（四层合并后；缺省按系统默认：下载/上传允许、file:// 禁）
  extraBaselineBlock?: string[] | null // 单容器内嵌基线（deny-wins：跨沙箱 CDP/RFB 段 + 平台回环端口；不可被任何作用域豁免）
  // r27：模板级 Chromium 企业策略目录注入（已过 validateExtraPolicies 校验）
  // 合并顺序：此处先注入 → 文件/CRX/代理/WebRTC 安全层后注入 → 安全层永不被模板覆盖
  extraManagedPolicy?: Record<string, unknown> | null
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
    // file:// 专属策略显式放行时，从安全位置粗粒度封禁集中剔除 file:// 条目
    // （allowFileScheme 默认 false=禁止；显式 true = 管理员明确意图，细粒度覆盖粗粒度）
    const fileAllowed = opts.filePolicy?.allowFileScheme === true
    const secureEndpoints = fileAllowed ? SECURE_LOCAL_ENDPOINTS.filter((e) => !e.startsWith("file://")) : SECURE_LOCAL_ENDPOINTS
    blocklist.push(...expandPatterns(secureEndpoints))
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

  // —— 端点级精确限制（host:port）——：内网放行后仍可封指定端点；
  //     与域名白名单严格模式叠加共存
  if (opts.endpointPolicy) {
    const ep = opts.endpointPolicy
    // 展开端口区间（如 10.0.0.5:8000-8003 → 4 条）后按方案冗余覆盖
    const epBlack = ep.blackPatterns.flatMap(expandEndpointPattern)
    const epWhite = ep.whitePatterns.flatMap(expandEndpointPattern)
    if (whitelistMode || (opts.domainPolicy && opts.domainPolicy.mode === "WHITELIST")) {
      // 白名单严格模式：端点 WHITE 加入放行集；BLACK 作为集内排除
      for (const w of epWhite) for (const s of SCHEMES) allowlist.push(s + w)
      for (const b of epBlack) for (const s of SCHEMES) allowlist.push("!" + s + b)
    } else {
      for (const b of epBlack) for (const s of SCHEMES) blocklist.push(s + b)
      for (const w of epWhite) for (const s of SCHEMES) blocklist.push("!" + s + w) // 黑名单内例外放行
    }
  }

  const managed: Record<string, unknown> = {
    URLBlocklist: blocklist,
    // 浏览器保持原汁原味：不注入任何 UDP/QUIC/WebRTC 全局限制（浏览器行为与原生一致）
    // 零 UDP 约束仅适用于平台后台链路（HTTP/WS/RFB/SMTP/Docker API 全 TCP）
  }
  // —— r27：模板级企业策略目录注入（安全层前 → 可被安全层覆写，不可反向覆盖）——
  if (opts.extraManagedPolicy) {
    for (const [k, v] of Object.entries(opts.extraManagedPolicy)) {
      if (SECURITY_OWNED_POLICY_KEYS.has(k)) continue // 双保险：目录层已校验拒收
      managed[k] = v
    }
  }
  // —— 文件访问限制策略（四层：单沙箱>用户>组>全局；缺省按系统默认）——
  const fp: FilePolicy = opts.filePolicy ?? {
    allowDownload: true,
    allowUpload: true,
    allowFileScheme: false,
    source: "DEFAULT",
    resolvedAt: "",
  }
  if (!fp.allowFileScheme) {
    blocklist.push(...fileSchemeBlockPatterns())
  }
  for (const [k, v] of Object.entries(filePolicyManagedPrefs(fp))) {
    managed[k] = v
  }
  if (whitelistMode) managed.URLAllowlist = allowlist
  // CRX 扩展管控策略合入（ExtensionInstallForcelist / Blocklist / ExtensionSettings）
  if (opts.crxManagedPolicy) {
    for (const [k, v] of Object.entries(opts.crxManagedPolicy)) managed[k] = v
  }
  // 安全位置封禁时：锁定代理设置（chrome://settings 已封禁，策略层再锁一道）
  if (!policy.allowSecureLocationAccess && opts.proxyUrl) {
    managed.ProxyMode = "fixed_servers"
    managed.ProxyServer = opts.proxyUrl
    managed.ProxyBypassList = "<-loopback>"
  }
  // 内网封禁时：WebRTC 仅走代理，防本机/局域网 IP 泄漏与 P2P 直连（仅此场景生效，浏览器其余行为保持原汁原味）
  if (!policy.allowInternalNetwork) {
    managed.WebRtcIPHandling = "disable_non_proxied_udp"
    managed.AllowWebRtcUdpPorts = [] as number[]
  }
  // —— 单容器内嵌基线（deny-wins，最后注入）：即便管理员放行内网，跨沙箱 CDP/RFB 段也绝不豁免 ——
  // 注：Chromium URLAllowlist 命中优先于 URLBlocklist（引擎语义）；此处仅防域名白名单模式叠加放行，
  // 管理员显式将环回端口段加入白名单属极端配置，由部署文档声明禁止
  if (opts.extraBaselineBlock && opts.extraBaselineBlock.length > 0) {
    blocklist.push(...expandPatterns(opts.extraBaselineBlock))
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
  const src =
    p.source === "SANDBOX" ? "沙箱级覆盖" : p.source === "USER" ? "用户级覆盖" : p.source === "GROUP" ? "组级继承" : "全局默认"
  const inner = p.allowInternalNetwork ? "允许内网" : "禁止内网"
  const secure = p.allowSecureLocationAccess ? "允许安全位置" : "禁止安全位置"
  return `${src} · ${inner} · ${secure}`
}

// ---- 批量解析（列表页一次装配，避免逐行 N+1；pairs 含 workspaceId 即按沙箱维度取最高优先覆盖）----
export async function resolveNetworkPoliciesBatch(
  pairs: Array<{ userId: string; workspaceId?: string | null }>,
): Promise<Map<string, NetworkPolicy>> {
  // key = workspaceId（有）或 userId（无）
  const out = new Map<string, NetworkPolicy>()
  if (pairs.length === 0) return out
  const resolvedAt = new Date().toISOString()
  const userIds = [...new Set(pairs.map((p) => p.userId))].filter(Boolean)
  const workspaceIds = [...new Set(pairs.map((p) => p.workspaceId).filter((x): x is string => !!x))]
  const [users, memberships, groups, defA, defB, workspaces] = await Promise.all([
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
    workspaceIds.length
      ? db.browserWorkspace.findMany({
          where: { id: { in: workspaceIds } },
          select: { id: true, userId: true, policyAllowInternalNetwork: true, policyAllowSecureLocationAccess: true, deletedAt: true },
        })
      : Promise.resolve(
          [] as Array<{ id: string; userId: string; policyAllowInternalNetwork: boolean | null; policyAllowSecureLocationAccess: boolean | null; deletedAt: Date | null }>,
        ),
  ])
  const userById = new Map(users.map((u) => [u.id, u]))
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const groupIdsByUser = new Map<string, string[]>()
  for (const m of memberships) {
    const arr = groupIdsByUser.get(m.userId) || []
    arr.push(m.groupId)
    groupIdsByUser.set(m.userId, arr)
  }

  const pick = (v: boolean | null | undefined): boolean | null =>
    v === null || v === undefined ? null : v

  for (const p of pairs) {
    const key = p.workspaceId || p.userId
    // 0) 沙箱级覆盖（归属校验）
    if (p.workspaceId) {
      const ws = wsById.get(p.workspaceId)
      if (ws && !ws.deletedAt && ws.userId === p.userId) {
        const a = pick(ws.policyAllowInternalNetwork)
        const b = pick(ws.policyAllowSecureLocationAccess)
        if (a !== null && b !== null) {
          out.set(key, { allowInternalNetwork: a, allowSecureLocationAccess: b, source: "SANDBOX", sourceWorkspaceId: p.workspaceId, resolvedAt })
          continue
        }
      }
    }
    const uid = p.userId
    const u = userById.get(uid)
    if (!u || u.deletedAt) continue
    const ua = pick(u.allowInternalNetwork)
    const ub = pick(u.allowSecureLocationAccess)

    // 用户级全显式 → 直接生效
    if (ua !== null && ub !== null) {
      out.set(key, { allowInternalNetwork: ua, allowSecureLocationAccess: ub, source: "USER", resolvedAt })
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
      out.set(key, {
        allowInternalNetwork: ua !== null ? ua : ga,
        allowSecureLocationAccess: ub !== null ? ub : gb,
        source: "GROUP",
        sourceGroupId,
        resolvedAt,
      })
      continue
    }

    // 全局默认（用户级半覆盖仍优先）
    out.set(key, {
      allowInternalNetwork: ua !== null ? ua : defA,
      allowSecureLocationAccess: ub !== null ? ub : defB,
      source: "GLOBAL_DEFAULT",
      resolvedAt,
    })
  }
  return out
}
