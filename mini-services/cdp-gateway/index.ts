import { createServer, type IncomingMessage } from "http"
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
// Dockyard CDP 网关桥（mini-service）
//   - 端口 3006（CDP_GATEWAY_PORT）：WebSocket 反向代理
//   - 路径 /t/<ticket>：HMAC 票据验签（单次防重放）→ 拨号容器内 CDP → 双向转发
//   - 用途：用户从外网（宿主机内网穿透域名 → 本端口）连接沙箱 CDP；
//     内网容器地址永不暴露给终端用户；容器内不装任何穿透组件（host 网络约束）
//   - /health：健康检查（daemon-services 守护探测）
// ============================================================

const PORT = Number(process.env.CDP_GATEWAY_PORT || 3006)
const SECRET = process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"

// ---- 票据：b64url(payload).b64url(hmac) ----
interface TicketPayload {
  v: string // workspaceId
  u: string // userId
  tgt: string // 容器内 CDP ws URL（ws://127.0.0.1:<port>/devtools/browser/<uuid>）
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
  if (idx <= 0) return null
  const payloadB64 = ticket.slice(0, idx)
  const sig = ticket.slice(idx + 1)
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
  if (!p.v || !p.tgt || !/^ws:\/\//.test(p.tgt)) return null
  if (usedNonces.has(p.n)) return null
  usedNonces.set(p.n, p.exp)
  return p
}
const usedNonces = new Map<string, number>()
setInterval(() => {
  const now = Date.now()
  for (const [k, exp] of usedNonces) if (exp * 1000 < now) usedNonces.delete(k)
}, 60_000).unref()

// ---- 活跃会话统计（/health 暴露） ----
const stats = { active: 0, total: 0, rejected: 0, started: Date.now() }

// ---- WS 服务器 ----
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, service: "cdp-gateway", ...stats, uptimeSec: Math.floor((Date.now() - stats.started) / 1000) }))
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
    try { upstream.close() } catch { /* noop */ }
  }

  // 拨号容器内 CDP
  let upstream: WebSocket
  try {
    upstream = new WsClient(ticket.tgt, {
      handshakeTimeout: 8000,
      perMessageDeflate: false,
    })
  } catch {
    client.close(1011, "dial error")
    stats.active--
    return
  }

  // 客户端消息缓冲（upstream 握手完成前的早期消息不丢失——CDP 客户端连接即发首条命令的常见时序）
  const earlyBuffer: Array<{ data: Buffer; isBinary: boolean }> = []
  let upstreamReady = false
  client.on("message", (data: Buffer, isBinary: boolean) => {
    if (upstreamReady && upstream.readyState === 1) upstream.send(data, { binary: isBinary })
    else if (earlyBuffer.length < 64) earlyBuffer.push({ data, isBinary })
  })

  upstream.on("open", () => {
    // 双向转发
    upstream.on("message", (data: Buffer, isBinary: boolean) => {
      if (client.readyState === 1) client.send(data, { binary: isBinary })
    })
    // 回放早期缓冲消息
    upstreamReady = true
    for (const m of earlyBuffer) {
      if (upstream.readyState === 1) upstream.send(m.data, { binary: m.isBinary })
    }
    earlyBuffer.length = 0
    // 保活
    const ka = setInterval(() => {
      if (upstream.readyState === 1) upstream.ping()
      if (client.readyState === 1) client.ping()
    }, 25_000)
    upstream.on("close", () => { clearInterval(ka); finish() })
    upstream.on("error", () => { clearInterval(ka); finish() })
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

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const m = /^\/t\/([A-Za-z0-9_\-.]+)$/.exec(url.pathname)
  if (!m) { socket.destroy(); return }
  const payload = verifyTicket(m[1])
  if (!payload) {
    stats.rejected++
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"error\":\"invalid or expired ticket\"}")
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, payload)
  })
})

httpServer.listen(PORT, () => {
  console.log(`[cdp-gateway] listening on :${PORT} (ticket mode, HMAC verified)`)
})

process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
process.on("SIGINT", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
