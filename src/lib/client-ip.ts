// ============================================================
// r34：真实客户端 IP 解析（内网/外网全形态）
//
// 用户报障：审计/安全事件里记录的 IP 不是真实访问 IP（内网访问被记成 127.0.0.1，
// 外网访问被记成网关 IP）。根因：各处只取 X-Forwarded-For 第一跳，且无内网/外网语义。
//
// 解析链（按可信度降序）：
//   1. CDN/边缘节点头：CF-Connecting-IP / True-Client-IP / Fly-Client-IP / Fastly-Client-IP
//      （由可信边缘覆写，无法被客户端伪造）
//   2. X-Forwarded-For（多跳链）：从右往左跳过可信内网代理段（回环/RFC1918/链路本地/ULA），
//      首个公网地址 = 真实外网客户端（同时天然免疫客户端伪造左侧条目）；
//      全段皆内网 = 纯内网访问 → 取最左侧（最原始的内网客户端 IP，回答"是内网哪个 IP"）
//   3. X-Real-IP（单可信代理直挂）
//   4. 兜底 127.0.0.1（直连本机）
// ============================================================

// 内网/回环/链路本地判断（IPv4 + IPv6 全形态）
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "")
  if (!v) return true
  // IPv6 文本形态
  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true
    if (v.startsWith("fe80")) return true // 链路本地
    if (v.startsWith("fc") || v.startsWith("fd")) return true // ULA fc00::/7
    return false // 其余（含内嵌 IPv4 映射）按公网处理（VPC 直连场景）
  }
  const parts = v.split(".")
  if (parts.length !== 4) return true
  const n = parts.map((p) => Number(p))
  if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return true
  if (n[0] === 10) return true // 10.0.0.0/8
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true // 172.16.0.0/12
  if (n[0] === 192 && n[1] === 168) return true // 192.168.0.0/16
  if (n[0] === 127) return true // 回环
  if (n[0] === 169 && n[1] === 254) return true // 链路本地
  if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true // CGNAT 100.64.0.0/10（运营商级内网）
  if (n[0] === 0) return true // 0.0.0.0/8
  return false
}

const CDN_EDGE_HEADERS = ["cf-connecting-ip", "true-client-ip", "fly-client-ip", "fastly-client-ip"]

function isValidIp(v: string): boolean {
  const t = v.trim().replace(/^\[|\]$/g, "")
  if (!t) return false
  if (t.includes(":")) return /^[0-9a-f:.]+$/.test(t)
  const parts = t.split(".")
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * 从请求头解析真实客户端 IP。
 * @param get Header 读取器（NextRequest.headers.get / next/headers().get 适配）
 * @param peerIp 可选：直连对端 IP（无代理头时的最终真相）
 */
export function extractClientIp(get: (name: string) => string | null, peerIp?: string): string {
  // 1. CDN 边缘头（可信覆写）
  for (const h of CDN_EDGE_HEADERS) {
    const v = get(h)
    if (v) {
      const first = v.split(",")[0]?.trim() || ""
      if (isValidIp(first)) return first
    }
  }
  // 2. X-Forwarded-For 多跳链：右→左跳过可信内网代理，首个公网 = 真实外网客户端
  const xff = get("x-forwarded-for")
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim().replace(/^\[|\]$/g, "")).filter((s) => s.length > 0)
    const validHops = hops.filter(isValidIp)
    if (validHops.length > 0) {
      for (let i = validHops.length - 1; i >= 0; i--) {
        if (!isPrivateIp(validHops[i])) return validHops[i]
      }
      // 全段内网 = 纯内网访问：最左侧 = 最原始的内网客户端
      return validHops[0]
    }
  }
  // 3. X-Real-IP（单可信代理）
  const xri = get("x-real-ip")
  if (xri && isValidIp(xri)) return xri.trim().replace(/^\[|\]$/g, "")
  // 4. 直连对端（或兜底）
  if (peerIp && isValidIp(peerIp)) return peerIp
  return "127.0.0.1"
}

/** 附加内/外网语义标签（审计展示用） */
export function ipScopeLabel(ip: string): string {
  return isPrivateIp(ip) ? "内网" : "外网"
}
