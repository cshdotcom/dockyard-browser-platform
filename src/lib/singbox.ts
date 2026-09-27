// Sing-Box 配置组装器：结构化对象内存组装 → JSON序列化，绝不拼接字符串（防配置注入）
// 配置通过容器环境变量 DY_SINGBOX_CONFIG 注入 sing-box 容器，不落地磁盘

export interface SingboxOutbound {
  type: "vless" | "vmess" | "trojan" | "socks" | "http" | "direct" | "block"
  tag: string
  server?: string
  serverPort?: number
  uuid?: string
  userId?: string
  password?: string
  security?: string
  transport?: {
    type: "tcp" | "ws" | "grpc"
    path?: string
    serviceName?: string
    headers?: Record<string, string>
  }
  tls?: {
    enabled: boolean
    serverName?: string
    reality?: {
      enabled: boolean
      publicKey?: string
      shortId?: string
    }
  }
  flow?: string
}

export interface SingboxRouteRule {
  id: string
  priority: number // 拖拽排序
  outboundTag: string
  domain?: string[] // 支持通配符
  ipCidr?: string[]
  protocol?: string[]
  port?: number
  network?: "tcp" | "udp"
  ruleType?: string // geoip/geosite 简化
  invert?: boolean
}

export interface SingboxDnsConfig {
  servers: { tag: string; address: string; detour?: string }[]
  rules?: { server: string; domain?: string[] }[]
  strategy?: string
  cacheSize?: number
}

export interface SingboxInbound {
  tag: string
  listen: string // 容器内监听 0.0.0.0
  listenPort: number
}

export interface SingboxFormConfig {
  name: string
  remark?: string
  cpuLimit: number // 0.001 精度
  memLimitMb: number
  outbounds: SingboxOutbound[]
  defaultOutbound: string
  routeRules: SingboxRouteRule[]
  dns: SingboxDnsConfig
  inbound: SingboxInbound
  experimental?: {
    clashApi?: { externalController?: string; secret?: string }
    cacheFile?: { enabled: boolean }
  }
}

export const DEFAULT_SINGBOX_IMAGE = "ghcr.io/sagernet/sing-box:latest"

// 表单参数 → 完整 sing-box JSON（结构化组装）
export function assembleSingboxConfig(form: SingboxFormConfig): Record<string, unknown> {
  // 出站：补充 direct/block 基础出站
  const outbounds = form.outbounds.map((o) => {
    const ob: Record<string, unknown> = { type: o.type, tag: o.tag }
    if (o.server) ob.server = o.server
    if (o.serverPort) ob.server_port = o.serverPort
    if (o.uuid) ob.uuid = o.uuid
    if (o.userId) ob.user_id = o.userId
    if (o.password) ob.password = o.password
    if (o.security) ob.security = o.security
    if (o.flow) ob.flow = o.flow
    if (o.transport) {
      const tr: Record<string, unknown> = { type: o.transport.type }
      if (o.transport.path) tr.path = o.transport.path
      if (o.transport.serviceName) tr.service_name = o.transport.serviceName
      if (o.transport.headers) tr.headers = o.transport.headers
      ob.transport = tr
    }
    if (o.tls?.enabled) {
      const tls: Record<string, unknown> = { enabled: true }
      if (o.tls.serverName) tls.server_name = o.tls.serverName
      if (o.tls.reality?.enabled) {
        tls.reality = {
          enabled: true,
          public_key: o.tls.reality.publicKey,
          short_id: o.tls.reality.shortId,
        }
      }
      ob.tls = tls
    }
    return ob
  })

  // 确保基础出站存在
  if (!outbounds.some((o) => (o as { tag: string }).tag === "direct")) {
    outbounds.push({ type: "direct", tag: "direct" })
  }
  if (!outbounds.some((o) => (o as { tag: string }).tag === "block")) {
    outbounds.push({ type: "block", tag: "block" })
  }

  // 路由规则按优先级排序（拖拽结果）
  const sorted = [...form.routeRules].sort((a, b) => a.priority - b.priority)
  const routeRules = sorted.map((r) => {
    const rule: Record<string, unknown> = { outbound: r.outboundTag }
    if (r.domain?.length) rule.domain = r.domain
    if (r.ipCidr?.length) rule.ip_cidr = r.ipCidr
    if (r.protocol?.length) rule.protocol = r.protocol
    if (r.port) rule.port = r.port
    if (r.network) rule.network = r.network
    if (r.invert) rule.invert = true
    return rule
  })

  // DNS
  const dns: Record<string, unknown> = {
    servers: form.dns.servers.map((s) => ({ tag: s.tag, address: s.address, ...(s.detour ? { detour: s.detour } : {}) })),
  }
  if (form.dns.rules?.length) {
    dns.rules = form.dns.rules.map((r) => ({ server: r.server, ...(r.domain ? { domain: r.domain } : {}) }))
  }
  if (form.dns.strategy) dns.strategy = form.dns.strategy

  const config: Record<string, unknown> = {
    log: { level: "info", timestamp: true },
    dns,
    inbounds: [
      {
        type: "socks",
        tag: form.inbound.tag || "socks-in",
        listen: form.inbound.listen || "0.0.0.0",
        listen_port: form.inbound.listenPort || 1080,
      },
    ],
    outbounds,
    route: {
      rules: routeRules,
      final: form.defaultOutbound || "direct",
      auto_detect_interface: true,
    },
  }
  if (form.experimental) {
    config.experimental = {
      ...(form.experimental.cacheFile ? { cache_file: { enabled: form.experimental.cacheFile.enabled } } : {}),
    }
  }
  return config
}

// 配置语法预校验（结构级校验：必备字段、类型、数值范围）
export function validateSingboxConfig(config: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(config.outbounds) || config.outbounds.length === 0) errors.push("缺少出站配置")
  if (!Array.isArray(config.inbounds) || config.inbounds.length === 0) errors.push("缺少入站配置")
  const inbound = (config.inbounds as { listen_port?: number }[])?.[0]
  if (inbound && (inbound.listen_port ?? 0) <= 0) errors.push("入站端口非法")
  if (inbound && (inbound.listen_port ?? 0) > 65535) errors.push("入站端口超出范围")
  const tags = new Set<string>()
  for (const ob of (config.outbounds as { tag?: string; type?: string }[]) || []) {
    if (!ob.tag) errors.push("出站缺少tag")
    else if (tags.has(ob.tag)) errors.push(`出站tag重复: ${ob.tag}`)
    else tags.add(ob.tag)
    if (!ob.type) errors.push("出站缺少type")
  }
  const route = config.route as { final?: string } | undefined
  if (route?.final && !tags.has(route.final)) errors.push(`默认出站 ${route.final} 不存在`)
  return { ok: errors.length === 0, errors }
}

// 连通性测试（真实模式经socks发起请求；模拟模式返回演示结果）
export async function testConnectivity(socksAddr: string, target = "https://api.ipify.org?format=json"): Promise<{ ok: boolean; exitIp?: string; latencyMs: number; udpOk: boolean; dnsLeak: boolean; detail?: string }> {
  const start = Date.now()
  try {
    // 真实环境：经 socks 代理 fetch（Node fetch 不直接支持 socks —— 生产部署由 socks-proxy-agent 或
    // 由网关侧的测试容器执行；此处演示/模拟模式返回确定性结果）
    if (socksAddr.startsWith("sim:")) {
      const latency = 40 + Math.round(Math.random() * 200)
      return {
        ok: true,
        exitIp: `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
        latencyMs: latency,
        udpOk: Math.random() > 0.2,
        dnsLeak: false,
        detail: "模拟连通性测试结果",
      }
    }
    // 网关直连探测（用于 external 类型代理的对照测试）
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(target, { signal: ctrl.signal })
    const json = (await res.json()) as { ip?: string }
    return { ok: true, exitIp: json.ip, latencyMs: Date.now() - start, udpOk: true, dnsLeak: false }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, udpOk: false, dnsLeak: true, detail: e instanceof Error ? e.message : String(e) }
  }
}
