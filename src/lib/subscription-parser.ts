// ============================================================
// r35 订阅链接一键导入解析器（用户点名功能）
// 用户诉求："一键导入订阅链接（完全模拟真实客户端解析）"
//
// 兼容主流客户端（Clash/v2rayN/sing-box 客户端）订阅格式：
//   1. Base64 整体编码的 URI 列表（v2rayN 经典格式）
//   2. 明文 URI 列表（每行一个）
//   3. Clash YAML（proxies: 节段 → 基础字段提取，深度转换出站）
// 协议：vmess://(base64 JSON) vless:// ss:// trojan:// socks:// http://
// 产物：SingboxOutbound[]（直接进入 singbox.ts 组装器）
// SSR vmess obfs 等冷门扩展字段安全忽略（解析失败单行跳过不阻断）。
// ============================================================
import type { SingboxOutbound } from "./singbox"

export interface ParsedNode {
  outbound: SingboxOutbound
  raw: string
  name: string
}

export interface SubscriptionParseResult {
  nodes: ParsedNode[]
  format: "base64-uri-list" | "uri-list" | "clash-yaml" | "unknown"
  total: number
  failed: number
}

/** 安全 base64 解码（补齐 padding，URL-safe 变体兼容） */
function safeB64Decode(s: string): string {
  try {
    const norm = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "")
    const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4))
    return Buffer.from(norm + pad, "base64").toString("utf8")
  } catch { return "" }
}

function looksLikeBase64(s: string): boolean {
  const t = s.replace(/\s/g, "")
  if (!t || t.includes("://") && t.indexOf("://") < 32) return false
  return /^[A-Za-z0-9+/\-_=]+$/.test(t.slice(0, 128))
}

function uniqTag(base: string, used: Set<string>): string {
  let tag = base.replace(/[^\w\u4e00-\u9fa5.-]/g, "_").slice(0, 60) || "node"
  let i = 2
  while (used.has(tag)) {
    tag = `${base.slice(0, 56)}-${i++}`
  }
  used.add(tag)
  return tag
}

/** vmess://BASE64(JSON) —— v2rayN 经典格式 */
function parseVmess(uri: string, used: Set<string>): ParsedNode | null {
  const body = uri.slice("vmess://".length)
  const json = safeB64Decode(body)
  if (!json.startsWith("{")) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(json) } catch { return null }
  const add = String(o.add || o.address || "")
  const port = Number(o.port)
  if (!add || !Number.isFinite(port) || port <= 0 || port > 65535) return null
  const net = String(o.net || "tcp")
  const tag = uniqTag(String(o.ps || o.remarks || `vmess-${add}`), used)
  const outbound: SingboxOutbound = {
    type: "vmess",
    tag,
    server: add,
    serverPort: port,
    userId: String(o.id || ""),
    security: String(o.scy || o.security || "auto"),
    ...(net === "ws" || net === "grpc" || net === "tcp" ? {
      transport: {
        type: net as "ws" | "grpc" | "tcp",
        ...(String(o.path || "") ? { path: String(o.path) } : {}),
        ...(String(o.host || "") ? { headers: { Host: String(o.host) } } : {}),
        ...(net === "grpc" && String(o.path || "") ? { serviceName: String(o.path) } : {}),
      },
    } : {}),
    ...(String(o.tls || "") === "tls" ? {
      tls: { enabled: true, ...(String(o.sni || o.host || "") ? { serverName: String(o.sni || o.host) } : {}) },
    } : {}),
  }
  return { outbound, raw: uri, name: tag }
}

/** vless://uuid@host:port?params#name */
function parseVless(uri: string, used: Set<string>): ParsedNode | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== "vless:") return null
    const host = u.hostname
    const port = Number(u.port)
    if (!host || !Number.isFinite(port) || port <= 0) return null
    const q = u.searchParams
    const net = q.get("type") || "tcp"
    const security = q.get("security") || ""
    const name = decodeURIComponent(u.hash.slice(1)) || `vless-${host}`
    const tag = uniqTag(name, used)
    const outbound: SingboxOutbound = {
      type: "vless",
      tag,
      server: host,
      serverPort: port,
      uuid: u.username,
      ...(q.get("flow") ? { flow: q.get("flow") || undefined } : {}),
      ...(net === "ws" || net === "grpc" || net === "tcp" ? {
        transport: {
          type: net as "ws" | "grpc" | "tcp",
          ...(q.get("path") ? { path: decodeURIComponent(q.get("path") || "") } : {}),
          ...(q.get("host") ? { headers: { Host: q.get("host") || "" } } : {}),
          ...(net === "grpc" && q.get("serviceName") ? { serviceName: q.get("serviceName") || "" } : {}),
        },
      } : {}),
      ...(security === "tls" ? {
        tls: { enabled: true, ...(q.get("sni") ? { serverName: q.get("sni") || "" } : {}) },
      } : security === "reality" ? {
        tls: {
          enabled: true,
          ...(q.get("sni") ? { serverName: q.get("sni") || "" } : {}),
          reality: {
            enabled: true,
            publicKey: q.get("pbk") || "",
            shortId: q.get("sid") || "",
          },
        },
      } : {}),
    }
    return { outbound, raw: uri, name: tag }
  } catch { return null }
}

/** ss://base64(method:pass)@host:port#name 或 ss://method:pass@host:port */
function parseShadowsocks(uri: string, used: Set<string>): ParsedNode | null {
  try {
    let rest = uri.slice("ss://".length)
    let name = ""
    const h = rest.indexOf("#")
    if (h >= 0) { name = decodeURIComponent(rest.slice(h + 1)); rest = rest.slice(0, h) }
    let method = "", password = "", hostport = ""
    const at = rest.lastIndexOf("@")
    if (at >= 0) {
      const cred = rest.slice(0, at)
      hostport = rest.slice(at + 1)
      if (cred.includes(":")) {
        ;[method, password] = cred.split(":")
      } else {
        const dec = safeB64Decode(cred)
        if (dec.includes(":")) { ;[method, password] = dec.split(":") } else return null
      }
    } else {
      // 整体 base64：method:pass@host:port
      const dec = safeB64Decode(rest)
      const at2 = dec.lastIndexOf("@")
      if (at2 < 0) return null
      const cred = dec.slice(0, at2)
      hostport = dec.slice(at2 + 1)
      if (!cred.includes(":")) return null
      ;[method, password] = cred.split(":")
    }
    const c = hostport.lastIndexOf(":")
    if (c < 0) return null
    const host = hostport.slice(0, c).replace(/^\[|\]$/g, "")
    const port = Number(hostport.slice(c + 1))
    if (!host || !Number.isFinite(port) || port <= 0) return null
    const tag = uniqTag(name || `ss-${host}`, used)
    return { outbound: { type: "shadowsocks", tag, server: host, serverPort: port, method: method || "aes-256-gcm", password: password || "" }, raw: uri, name: tag }
  } catch { return null }
}

/** trojan://password@host:port?params#name */
function parseTrojan(uri: string, used: Set<string>): ParsedNode | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== "trojan:") return null
    const host = u.hostname
    const port = Number(u.port)
    if (!host || !Number.isFinite(port) || port <= 0) return null
    const q = u.searchParams
    const name = decodeURIComponent(u.hash.slice(1)) || `trojan-${host}`
    const tag = uniqTag(name, used)
    return {
      outbound: {
        type: "trojan",
        tag,
        server: host,
        serverPort: port,
        password: decodeURIComponent(u.username) + (u.password ? `:${u.password}` : ""),
        ...(q.get("sni") ? { tls: { enabled: true, serverName: q.get("sni") || "" } } : { tls: { enabled: true } }),
      },
      raw: uri,
      name: tag,
    }
  } catch { return null }
}

/** socks:// / http:// 代理 URI */
function parsePlainProxy(uri: string, used: Set<string>, type: "socks" | "http"): ParsedNode | null {
  try {
    const u = new URL(uri)
    const host = u.hostname
    const port = Number(u.port)
    if (!host || !Number.isFinite(port) || port <= 0) return null
    const name = decodeURIComponent(u.hash.slice(1)) || `${type}-${host}`
    const tag = uniqTag(name, used)
    return {
      outbound: {
        type,
        tag,
        server: host,
        serverPort: port,
        ...(u.username ? { password: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}` } : {}),
      } as SingboxOutbound,
      raw: uri,
      name: tag,
    }
  } catch { return null }
}

/** 单行 URI → 节点 */
export function parseShareUri(uri: string, used: Set<string>): ParsedNode | null {
  const t = uri.trim()
  if (!t) return null
  if (t.startsWith("vmess://")) return parseVmess(t, used)
  if (t.startsWith("vless://")) return parseVless(t, used)
  if (t.startsWith("ss://")) return parseShadowsocks(t, used)
  if (t.startsWith("trojan://")) return parseTrojan(t, used)
  if (t.startsWith("socks://") || t.startsWith("socks5://")) return parsePlainProxy(t.replace("socks5://", "socks://"), used, "socks")
  if (t.startsWith("http://") || t.startsWith("https://")) return parsePlainProxy(t, used, "http")
  return null
}

/** Clash YAML proxies 节段 → 节点（基础字段提取；无 yaml 依赖用行扫描） */
function parseClashYaml(text: string, used: Set<string>): ParsedNode[] {
  const nodes: ParsedNode[] = []
  const lines = text.split("\n")
  let inProxies = false
  let cur: Record<string, string> | null = null
  const flush = () => {
    if (!cur || !cur.name || !cur.server || !cur.port) { cur = null; return }
    const port = Number(cur.port)
    if (!Number.isFinite(port) || port <= 0) { cur = null; return }
    const tag = uniqTag(cur.name, used)
    const type = (cur.type || "").toLowerCase()
    if (type === "vmess") {
      nodes.push({ outbound: { type: "vmess", tag, server: cur.server, serverPort: port, userId: cur.uuid || "", security: cur.cipher || "auto", ...(cur.network === "ws" ? { transport: { type: "ws", ...(cur.wsPath ? { path: cur.wsPath } : {}) } } : {}), ...(String(cur.tls) === "true" ? { tls: { enabled: true } } : {}) } as SingboxOutbound, raw: `${cur.name}`, name: tag })
    } else if (type === "vless") {
      nodes.push({ outbound: { type: "vless", tag, server: cur.server, serverPort: port, uuid: cur.uuid || "", ...(cur.flow ? { flow: cur.flow } : {}), ...(cur.network === "ws" ? { transport: { type: "ws", ...(cur["ws-opts.path"] ? { path: cur["ws-opts.path"] } : {}) } } : {}), ...(cur.tls ? { tls: { enabled: true } } : {}) } as SingboxOutbound, raw: `${cur.name}`, name: tag })
    } else if (type === "trojan") {
      nodes.push({ outbound: { type: "trojan", tag, server: cur.server, serverPort: port, password: cur.password || "", tls: { enabled: true } }, raw: `${cur.name}`, name: tag })
    } else if (type === "ss") {
      nodes.push({ outbound: { type: "shadowsocks", tag, server: cur.server, serverPort: port, method: cur.cipher || "aes-256-gcm", password: cur.password || "" }, raw: `${cur.name}`, name: tag })
    } else if (type === "socks5") {
      nodes.push({ outbound: { type: "socks", tag, server: cur.server, serverPort: port }, raw: `${cur.name}`, name: tag })
    }
    cur = null
  }
  for (const line of lines) {
    if (/^proxies\s*:/.test(line)) { inProxies = true; continue }
    if (inProxies && /^\S/.test(line)) { flush(); inProxies = false; continue }
    if (!inProxies) continue
    const item = /^-\s*\{(.*)\}$/.exec(line.trim())
    if (item) {
      flush()
      cur = {}
      for (const kv of item[1].split(",")) {
        const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(kv)
        if (m) cur[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
      }
      flush()
      continue
    }
    if (/^-\s*\S/.test(line.trim())) { flush(); cur = {}; continue }
    if (cur) {
      const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(line)
      if (m) cur[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
    }
  }
  flush()
  return nodes
}

/** 订阅正文解析（自动识别格式） */
export function parseSubscriptionContent(text: string): SubscriptionParseResult {
  const trimmed = (text || "").trim()
  if (!trimmed) return { nodes: [], format: "unknown", total: 0, failed: 0 }
  const used = new Set<string>()

  // ① Base64 整体编码（v2rayN 订阅最常见）
  if (looksLikeBase64(trimmed)) {
    const decoded = safeB64Decode(trimmed)
    if (decoded && /^(vmess|vless|ss|trojan|socks|https?):\/\//m.test(decoded)) {
      const lines = decoded.split(/\r?\n/).filter(Boolean)
      const nodes = lines.map((l) => parseShareUri(l, used)).filter((x): x is ParsedNode => !!x)
      return { nodes, format: "base64-uri-list", total: lines.length, failed: lines.length - nodes.length }
    }
  }
  // ② Clash YAML
  if (/proxies\s*:/.test(trimmed) && /type\s*:/.test(trimmed)) {
    const nodes = parseClashYaml(trimmed, used)
    if (nodes.length > 0) return { nodes, format: "clash-yaml", total: nodes.length, failed: 0 }
  }
  // ③ 明文 URI 列表
  if (/^(vmess|vless|ss|trojan|socks|https?):\/\//m.test(trimmed)) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"))
    const nodes = lines.map((l) => parseShareUri(l, used)).filter((x): x is ParsedNode => !!x)
    return { nodes, format: "uri-list", total: lines.length, failed: lines.length - nodes.length }
  }
  return { nodes: [], format: "unknown", total: 0, failed: 0 }
}

/** 订阅 URL 安全校验（SSRF 防护：拒绝内网/回环/链路本地/元数据端点） */
export function assertPublicSubscriptionUrl(raw: string): URL {
  const u = new URL(raw)
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http/https 订阅链接")
  const host = u.hostname.toLowerCase()
  const priv =
    host === "localhost" || host === "0.0.0.0" || host === "169.254.169.254" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") ||
    host.endsWith(".internal") || host.endsWith(".local")
  if (priv) throw new Error("订阅地址不允许指向内网/回环地址（SSRF 防护）")
  return u
}
