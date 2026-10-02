import { createServer } from "http"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Server } from "socket.io"

// ---- .env 加载器：与主应用共享密钥（boot 脚本重置 .env 后两侧仍能对齐） ----
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
    } catch { /* 尝试下一个路径 */ }
  }
}
loadDotEnv()

// ============================================================
// Dockyard WebSocket 枢纽（mini-service）
//   - 端口 3003：socket.io（path=/，供浏览器客户端经 Caddy 网关接入）
//   - 端口 3004：内部事件注入 HTTP（POST /emit，x-hub-secret 鉴权）
// 职责：事件推送 ONLY —— 实例实时日志 / 会话状态变更 / 告警站内消息 / 管理员强制操作通知
// 约束：禁止执行业务写入操作（写入统一走 Server Action / Route Handler）
// 房间模型：user:<id> / group:<id> / role:admin / res:<type>:<id> / all
// 心跳保活 + 僵死连接超时回收 + 断线自动重连（客户端）
// ============================================================

const httpServer = createServer()
const io = new Server({
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 15000,
})
io.attach(httpServer)

interface HubEvent {
  event: string
  room?: string
  payload: unknown
}

io.on("connection", (socket) => {
  socket.on("register", (data: { userId: string; username?: string; groupIds?: string[]; role?: string }) => {
    if (!data?.userId) return
    socket.data.userId = data.userId
    socket.data.username = data.username
    socket.data.role = data.role
    socket.join(`user:${data.userId}`)
    for (const gid of data.groupIds || []) socket.join(`group:${gid}`)
    if (data.role === "SUPER_ADMIN" || data.role === "ADMIN") socket.join("role:admin")
    socket.emit("registered", { ok: true, rooms: Array.from(socket.rooms) })
    console.log(`[ws-hub] registered user=${data.userId} role=${data.role}`)
  })

  socket.on("subscribe", (data: { resourceType?: string; resourceId?: string }) => {
    if (data?.resourceType && data?.resourceId) {
      const room = `res:${data.resourceType}:${data.resourceId}`
      socket.join(room)
      socket.emit("subscribed", { resourceType: data.resourceType, resourceId: data.resourceId })
    }
  })
  socket.on("unsubscribe", (data: { resourceType?: string; resourceId?: string }) => {
    if (data?.resourceType && data?.resourceId) socket.leave(`res:${data.resourceType}:${data.resourceId}`)
  })

  socket.on("heartbeat", () => {
    socket.emit("heartbeat-ack", { t: Date.now() })
  })

  socket.on("disconnect", (reason) => {
    console.log(`[ws-hub] disconnect user=${socket.data.userId ?? "?"} reason=${reason}`)
  })
})

// ---- 内部事件注入服务（端口 3004，仅内网/本机访问） ----
// 回退值与主应用 ENV.cronSecret 保持同一字面量，缺失时两侧天然一致
const HUB_SECRET = process.env.CRON_SECRET || "dockyard-cron-secret"
const emitServer = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/emit")) {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 40400, msg: "not found" }))
    return
  }
  const auth = req.headers["x-hub-secret"]
  if (auth !== HUB_SECRET) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 40300, msg: "hub secret mismatch" }))
    return
  }
  let body = ""
  req.on("data", (chunk) => { body += chunk })
  req.on("end", () => {
    try {
      const evt = JSON.parse(body) as HubEvent
      if (evt.room === "all" || !evt.room) io.emit(evt.event, evt.payload)
      else io.to(evt.room).emit(evt.event, evt.payload)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 0, msg: "ok", room: evt.room || "all", event: evt.event }))
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ code: 40001, msg: String(e) }))
    }
  })
})

const WS_PORT = Number(process.env.PORT || process.env.WS_HUB_PORT || 3003)
const EMIT_PORT = Number(process.env.EMIT_PORT || 3004)
// 默认回环绑定：对外统一经网关（XTransformPort）透传；Docker host 网络模式下不额外暴露端口
const WS_BIND = process.env.BIND_ADDR || "127.0.0.1"

// ---- r13c: 端口占用重试退避（EADDRINUSE 不再一崩即溃）----
// 守护轮次切换瞬间可能出现短暂端口残留：最多 30 次退避重绑，非占用类错误立即失败
listenWithRetry(httpServer, WS_PORT, WS_BIND, "WebSocket 枢纽（socket.io path=/）")
listenWithRetry(emitServer, EMIT_PORT, "127.0.0.1", "事件注入端口（POST /emit + x-hub-secret）")

function listenWithRetry(srv: import("http").Server, port: number, host: string, label: string) {
  let attempt = 0
  const tryListen = () => {
    attempt += 1
    srv.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && attempt < 30) {
        console.error(`[ws-hub] ${label} 端口 ${host}:${port} 被占用（第 ${attempt} 次，1.5 秒后重试）`)
        setTimeout(tryListen, 1500)
      } else {
        console.error(`[ws-hub] ${label} 监听失败 ${host}:${port}：${e.message}（进程退出交由守护重启）`)
        process.exit(1)
      }
    })
    srv.listen(port, host, () => {
      console.log(`[ws-hub] ${label} ${host}:${port} 已启动`)
    })
  }
  tryListen()
}

process.on("SIGTERM", () => { httpServer.close(); emitServer.close(); process.exit(0) })
process.on("SIGINT", () => { httpServer.close(); emitServer.close(); process.exit(0) })
