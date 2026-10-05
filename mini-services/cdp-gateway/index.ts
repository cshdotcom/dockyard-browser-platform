import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { WebSocketServer, type WebSocket, WebSocket as WsClient } from "ws"
import { createHmac, timingSafeEqual } from "crypto"
import { readFileSync } from "fs"
import { resolve } from "path"

// ---- .env 加载器（与主应用共享密钥）----
function loadDotEnv() {
  const candidates = [resolve(process.cwd(), ".env"), resolve(import.meta.dir, "../../.env")]
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8")
      for (const line of text.split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1")
      }
      return
    } catch { /* 下一个路径 */ }
  }
}
loadDotEnv()

// ============================================================
// Dockyard CDP 网关桥（mini-service）—— r36 安全加固版 + r37 持久票据
//   - 端口 3006（CDP_GATEWAY_PORT）：WebSocket 反向代理
//   - 路径 /t/<ticket>：HMAC 票据验签（单次防重放，短窗口）→ 拨号容器内 CDP → 双向转发
//   - 路径 /p/<tid>：r37 持久票据（公网连接地址）：实时回调主应用
//     POST /api/cdp/resolve 校验（吊销/过期/次数即时生效）→ 获 tgt+dur → 同一转发通道
//   - 用途：用户从外网（宿主机内网穿透域名 → 本端口）连接沙箱 CDP；
//     内网容器地址永不暴露给终端用户；容器内不装任何穿透组件（host 网络约束）
//   - /health：健康检查（daemon-services 守护探测）
//
// r36 公网暴露安全加固（防御公网扫描/爆破/浏览器跨站劫持）：
//   1. 票据 tgt 兼容 http(s):// 基址形态：拨号时先 GET /json/version 解析
//      webSocketDebuggerUrl 再连 ws（此前仅允许 ws:// → 嵌入式/容器形态的
//      cdpUrl 全部被拒 → 「invalid or expired ticket」根因修复）
//   2. IP 级验证失败限速与封禁：窗口内失败超阈值 → 临时封禁（防票据爆破/扫描）
//   3. Origin 校验：拒绝携带浏览器 Origin 的连接（CDP WS 无同源策略，
//      须防公网页面跨站劫持；Puppeteer/Playwright/node 客户端不发 Origin）
//   4. 绑定地址可配置（CDP_GATEWAY_BIND，默认 0.0.0.0）—— 仅内网穿透
//      场景需要 0.0.0.0，同机反代部署可改 127.0.0.1 缩小暴露面
//   5. 启动密钥强度检查：生产使用默认密钥 → 显式 CRITICAL 日志告警
// r37 持久票据语义（公网连接地址全生命周期）：
//   · 地址泄露 → 用户/管理员在面板「重新创建」→ 旧 tid 即时拒连（resolve 403）
//   · 有效期：永久（null）/ 自定义（expireAt）；次数上限 maxUses
//   · 沙箱重建/重启 → tgt 自动跟随最新 cdpUrl（不存在陈旧地址问题）
//   · fail-closed：主应用不可达 → 拒绝（fail-closed 安全语义）
// ============================================================

const PORT = Number(process.env.CDP_GATEWAY_PORT || 3006)
const BIND = process.env.CDP_GATEWAY_BIND || "0.0.0.0"
const SECRET = process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"
// r37：主应用基地址（持久票据实时校验通道；同机部署默认 127.0.0.1:PORT）
const MASTER_BASE = (process.env.CDP_GATEWAY_MASTER_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "")

// ---- 公网加固参数（环境变量可调）----
const FAIL_WINDOW_MS = Number(process.env.CDP_GATEWAY_FAIL_WINDOW_MS || 60_000) // 失败计数窗口
const FAIL_THRESHOLD = Number(process.env.CDP_GATEWAY_FAIL_THRESHOLD || 10) // 窗口内失败阈值
const BAN_MS = Number(process.env.CDP_GATEWAY_BAN_MS || 600_000) // 封禁时长（默认 10 分钟）

if (SECRET === "dockyard-dev-cdp-secret") {
  console.error(
    "[cdp-gateway] CRITICAL: 正在使用默认开发密钥（CDP_GATEWAY_SECRET 未设置）！\n" +
    "  公网部署必须设置强随机密钥（与主应用共享：主应用 CDP_GATEWAY_SECRET=同一值），\n" +
    "  否则票据可被伪造、任意沙箱 CDP 可被接管。生成：openssl rand -hex 32",
  )
}

// ---- 票据：b64url(payload).b64url(hmac) ----
interface TicketPayload {
  v: string // workspaceId
  u: string // userId
  tgt: string // CDP 目标：ws://ip:port/devtools/browser/<uuid> 或 http(s)://ip:port 基址
  exp: number // epoch sec（取票→建连窗口）
  dur: number // 连接最大存活秒（0=不限）
  n: string // nonce（单次）
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4 !== 0) s += "="
  return Buffer.from(s, "base64")
}
export function signTicket(p: TicketPayload): string {
  const payloadB = Buffer.from(JSON.stringify(p), "utf8")
  const payloadB64 = b64url(payloadB)
  const sig = b64url(createHmac("sha256", SECRET).update(payloadB64).digest())
  return payloadB64 + "." + sig
}
function verifyTicket(ticket: string): TicketPayload | null {
  const idx = ticket.lastIndexOf(".")
  if (idx <= 0 || idx > 2048) return null
  const payloadB64 = ticket.slice(0, idx)
  const sig = ticket.slice(idx + 1)
  if (payloadB64.length > 1536 || sig.length > 128) return null
  let expect: Buffer
  try {
    expect = createHmac("sha256", SECRET).update(payloadB64).digest()
  } catch { return null }
  const got = b64urlDecode(sig)
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
  let p: TicketPayload
  try {
    p = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as TicketPayload
  } catch { return null }
  if (typeof p.exp !== "number" || p.exp * 1000 < Date.now()) return null
  if (!p.v || !p.tgt || !/^(ws|http):\/\//.test(p.tgt)) return null
  if (!p.tgt.startsWith("ws://") && !p.tgt.startsWith("http://")) return null // 防协议注入（wss/https 回环目标不允许：内网拨号）
  if (usedNonces.has(p.n)) return null
  usedNonces.set(p.n, p.exp)
  return p
}
const usedNonces = new Map<string, number>()
setInterval(() => {
  const now = Date.now()
  for (const [k, exp] of usedNonces) if (exp * 1000 < now) usedNonces.delete(k)
}, 60_000).unref()

// ---- IP 级失败限速与封禁（防公网票据爆破/扫描）----
const failByIp = new Map<string, number[]>() // ip → 窗口内失败时间戳
const bannedIp = new Map<string, number>() // ip → 解封时间戳
setInterval(() => {
  const now = Date.now()
  for (const [ip, times] of failByIp) {
    while (times.length && now - times[0] > FAIL_WINDOW_MS) times.shift()
    if (times.length === 0) failByIp.delete(ip)
  }
  for (const [ip, until] of bannedIp) if (until < now) bannedIp.delete(ip)
}, 30_000).unref()

function clientIp(req: IncomingMessage): string {
  // 网关通常直连公网（无前置代理）→ socket 远端地址为准；
  // 有前置可信反代时反代注入 X-Real-IP
  const xr = req.headers["x-real-ip"]
  return (typeof xr === "string" && xr) || req.socket.remoteAddress || "unknown"
}
function recordFail(ip: string) {
  const arr = failByIp.get(ip) || []
  arr.push(Date.now())
  failByIp.set(ip, arr)
  if (arr.length >= FAIL_THRESHOLD) {
    bannedIp.set(ip, Date.now() + BAN_MS)
    console.warn(`[cdp-gateway] IP ${ip} 触发封禁：${FAIL_THRESHOLD} 次/窗口失败（封 ${Math.round(BAN_MS / 1000)}s）`)
  }
}
function isBanned(ip: string): boolean {
  const until = bannedIp.get(ip)
  if (until === undefined) return false
  if (until < Date.now()) { bannedIp.delete(ip); return false }
  return true
}

// ---- r37：持久票据（/p/<tid>）→ 主应用实时解析 ----
// 返回 { tgt, durSec }；任何失败均返回 null（fail-closed）。
// tid 白名单形态校验（hex 32-96）先行拒绝畸形值，不计失败次数以外的负担。
interface ResolvedPersistent {
  tgt: string
  durSec: number
  label: string
}
async function resolvePersistentToken(tid: string, ip: string): Promise<ResolvedPersistent | null> {
  if (!/^[a-f0-9]{32,96}$/i.test(tid)) return null
  try {
    const res = await fetch(`${MASTER_BASE}/api/cdp/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": SECRET },
      body: JSON.stringify({ tid, ip }),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null
      console.warn(`[cdp-gateway] 持久票据被拒 tid=${tid.slice(0, 8)}… reason=${j?.error || res.status}`)
      return null
    }
    const j = (await res.json()) as { ok?: boolean; tgt?: string; durSec?: number; label?: string }
    if (!j.ok || !j.tgt) return null
    return { tgt: j.tgt, durSec: Number(j.durSec) || 0, label: j.label || "" }
  } catch (e) {
    console.error(`[cdp-gateway] 主应用解析不可达（fail-closed 拒绝连接）: ${(e as Error).message}`)
    return null
  }
}

// ---- 活跃会话统计（/health 暴露） ----
const stats = { active: 0, total: 0, rejected: 0, banned: 0, originBlocked: 0, persistentTotal: 0, persistentRejected: 0, started: Date.now() }

// ---- r36：http 基址 → 浏览器级 ws 端点解析（Chromium 重启后 browser UUID 变化，
//      每次建连时实时解析，天然自愈；Host 头=目标地址满足 DevTools HTTP 校验）----
async function resolveWsTarget(tgt: string): Promise<string | null> {
  if (tgt.startsWith("ws://")) return tgt
  // http://host:port[/json] → GET /json/version → webSocketDebuggerUrl
  const base = tgt.replace(/\/json\/?$/, "").replace(/\/$/, "")
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const j = (await res.json().catch(() => null)) as { webSocketDebuggerUrl?: string } | null
    const wsUrl = j?.webSocketDebuggerUrl || ""
    if (!/^ws:\/\//.test(wsUrl)) return null
    // 目标 host 与 tgt 保持一致（DevTools 返回 127.0.0.1 形态时替换为实际地址，
    // 避免网关与浏览器不同网络命名空间时拨错）
    const tgtHost = base.replace(/^http:\/\//, "")
    return wsUrl.replace(/^ws:\/\/[^/]+\//, `ws://${tgtHost}/`)
  } catch {
    return null
  }
}

// ---- WS 服务器 ----
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, service: "cdp-gateway", ...stats, failWindowSec: Math.round(FAIL_WINDOW_MS / 1000), failThreshold: FAIL_THRESHOLD, banSec: Math.round(BAN_MS / 1000), bind: BIND, uptimeSec: Math.floor((Date.now() - stats.started) / 1000) }))
    return
  }
  // r39：受密钥保护的解封端点（生产等价 fail2ban unbanip —— 管理员远程解封误封 IP；
  //       QA 负向用例（伪造票据/过期/吊销等）后自解封，避免后续正向用例被防爆破误伤）
  if (req.method === "POST" && req.url === "/unban") {
    const auth = String(req.headers["x-gateway-secret"] || "")
    if (!SECRET || auth !== SECRET) {
      res.writeHead(403).end(JSON.stringify({ ok: false, error: "bad secret" }))
      return
    }
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let ip = ""
      try { ip = String((JSON.parse(body) || {}).ip || "") } catch { ip = "" }
      let unbanned = 0
      if (ip) {
        if (bannedIp.delete(ip)) unbanned++
        if (failByIp.delete(ip)) unbanned++
      } else {
        unbanned = bannedIp.size + failByIp.size
        bannedIp.clear()
        failByIp.clear()
      }
      console.log(`[cdp-gateway] 解封 ${ip || "全部 IP"}（清除 ${unbanned} 条记录）`)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, unbanned, ip: ip || "*" }))
    })
    return
  }
  res.writeHead(404).end("not found")
})

const wss = new WebSocketServer({ noServer: true })

wss.on("connection", (client: WebSocket, req: IncomingMessage, ticket: TicketPayload) => {
  stats.active++
  stats.total++
  const deadline = ticket.dur > 0 ? Date.now() + ticket.dur * 1000 : 0
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    stats.active = Math.max(0, stats.active - 1)
    try { client.close() } catch { /* noop */ }
    try { upstream?.close() } catch { /* noop */ }
  }

  // 拨号容器内 CDP（http 基址先解析 ws 端点；解析失败按上游错误收口）
  let upstream: WebSocket | null = null
  // 客户端消息监听【必须在拨号前注册】（r36-bugfix：http tgt 解析有网络延迟，
  // 此期间客户端早期消息若无处落地会被 ws 库直接丢弃 → CDP 客户端连接即发
  // 首条命令的时序下消息丢失；缓冲后于 upstream 握手完成时回放）
  const earlyBuffer: Array<{ data: Buffer; isBinary: boolean }> = []
  let upstreamReady = false
  client.on("message", (data: Buffer, isBinary: boolean) => {
    if (upstreamReady && upstream && upstream.readyState === 1) upstream.send(data, { binary: isBinary })
    else if (earlyBuffer.length < 64) earlyBuffer.push({ data, isBinary })
  })
  void resolveWsTarget(ticket.tgt).then((wsTarget) => {
    if (closed) return
    if (!wsTarget) {
      stats.rejected++
      try { client.close(1011, "cdp endpoint unreachable") } catch { /* noop */ }
      finish()
      return
    }
    let dialed: WebSocket
    try {
      dialed = new WsClient(wsTarget, { handshakeTimeout: 8000, perMessageDeflate: false })
    } catch {
      try { client.close(1011, "dial error") } catch { /* noop */ }
      finish()
      return
    }
    upstream = dialed

    upstream.on("open", () => {
      // 双向转发
      upstream!.on("message", (data: Buffer, isBinary: boolean) => {
        if (client.readyState === 1) client.send(data, { binary: isBinary })
      })
      // 回放早期缓冲消息
      upstreamReady = true
      for (const m of earlyBuffer) {
        if (upstream && upstream.readyState === 1) upstream.send(m.data, { binary: m.isBinary })
      }
      earlyBuffer.length = 0
      // 保活
      const ka = setInterval(() => {
        if (upstream && upstream.readyState === 1) upstream.ping()
        if (client.readyState === 1) client.ping()
      }, 25_000)
      upstream!.on("close", () => { clearInterval(ka); finish() })
      upstream!.on("error", () => { clearInterval(ka); finish() })
      client.on("close", () => { clearInterval(ka); finish() })
      client.on("error", () => { clearInterval(ka); finish() })
      if (deadline > 0) {
        const lim = setTimeout(() => {
          try { client.close(1008, "[cdp-gateway] 连接时长已达策略上限") } catch { /* noop */ }
          finish()
        }, Math.max(0, deadline - Date.now()))
        client.on("close", () => clearTimeout(lim))
      }
    })
    upstream.on("error", () => {
      try { client.close(1011, "upstream error") } catch { /* noop */ }
      finish()
    })
    upstream.on("close", () => finish())
  })
})

httpServer.on("upgrade", (req: IncomingMessage, socket: import("net").Socket, head: Buffer) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const mPersist = /^\/p\/([A-Za-z0-9_-]{24,96})$/.exec(url.pathname)
  const m = /^\/t\/([A-Za-z0-9_\-.]+)$/.exec(url.pathname)
  if (!m && !mPersist) { socket.destroy(); return }
  const ip = clientIp(req)

  // 加固 1：封禁检查（含重试提示）
  if (isBanned(ip)) {
    stats.banned++
    socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nRetry-After: ${Math.round(BAN_MS / 1000)}\r\n\r\n{"error":"banned: too many failed attempts"}`)
    socket.destroy()
    return
  }

  // 加固 2：Origin 校验（浏览器页面跨站 WS 劫持防护）
  // 正当客户端（Puppeteer/Playwright/node ws/自定义程序）不发送 Origin；
  // 浏览器网页内的 JS 会携带 Origin → 直接拒绝（票据不消费）
  const origin = req.headers.origin
  if (origin) {
    stats.originBlocked++
    console.warn(`[cdp-gateway] 拒绝携带 Origin 的连接（疑似浏览器跨站劫持尝试）ip=${ip} origin=${origin}`)
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n{\"error\":\"browser cross-site connections are not allowed\"}")
    socket.destroy()
    return
  }

  // r37：持久票据路径 /p/<tid> —— 主应用实时校验（吊销/过期/次数即时生效）
  if (mPersist) {
    const tid = mPersist[1]
    void resolvePersistentToken(tid, ip).then((resolved) => {
      if (!resolved) {
        stats.persistentRejected++
        stats.rejected++
        recordFail(ip)
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\":\"invalid, revoked or expired connection address (rotate it in panel)\"}")
        socket.destroy()
        return
      }
      stats.persistentTotal++
      // 校验通过 → 走统一转发通道（与 HMAC 短票据同构）
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, {
          v: `p:${tid}`, u: "persistent", tgt: resolved.tgt,
          exp: 0, dur: resolved.durSec, n: tid,
        })
      })
    })
    return
  }

  const payload = verifyTicket(m![1])
  if (!payload) {
    stats.rejected++
    recordFail(ip)
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\":\"invalid or expired ticket\"}")
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, payload)
  })
})

httpServer.listen(PORT, BIND, () => {
  console.log(`[cdp-gateway] listening on ${BIND}:${PORT} (ticket mode, HMAC verified; fail-ban ${FAIL_THRESHOLD}/${Math.round(FAIL_WINDOW_MS / 1000)}s → ${Math.round(BAN_MS / 1000)}s; origin-check on)`)
  console.log(`[cdp-gateway] persistent token mode /p/<tid> enabled (master=${MASTER_BASE}, realtime revoke via /api/cdp/resolve)`)
})

process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
process.on("SIGINT", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
