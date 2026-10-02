// ============================================================
// Dockyard 统一入口网关（单容器"仅 2 端口"核心组件）
// ------------------------------------------------------------
// 对外唯一 UI 端口（GATEWAY_PORT，默认 3000）承接全部流量：
//   1) Next.js 平台（APP_INTERNAL_PORT，默认 127.0.0.1:13000）
//   2) VNC 网关桥（127.0.0.1:3005）：路径 /vnc-ws/* 或 ?XTransformPort=3005
//   3) WS 枢纽（127.0.0.1:3003）：?XTransformPort=3003（socket.io polling/WS）
//   4) 事件注入（127.0.0.1:3004）：?XTransformPort=3004（内部/运维）
// WebSocket 代理：本地终结客户端 WS + 上游 WS 双向泵（二进制透传，RFB 帧兼容）
// 效果：host 网络模式下对外仅 网页(GATEWAY_PORT) + CDP(CDP_SERVICE_PORT) 两个端口；
//       3003/3004/3005 全部回环绑定，不经网关票据无法触达。
// ============================================================

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3000)
const APP_TARGET = `http://127.0.0.1:${process.env.APP_INTERNAL_PORT || 13000}`
const ALLOWED_TRANSFORM_PORTS = new Set(
  (process.env.GATEWAY_TRANSFORM_PORTS || "3003,3004,3005")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0),
)

// ---- 上游目标解析 ----
interface GatewayRoute { target: string; rewritePath: string; rewriteSearch?: string }

function resolveTarget(pathname: string, search: URLSearchParams): GatewayRoute | null {
  const xtp = search.get("XTransformPort")
  if (xtp && ALLOWED_TRANSFORM_PORTS.has(Number(xtp))) {
    const port = Number(xtp)
    // 网关查询参数模式：透传完整 path + 查询（保留 XTransformPort 供上游日志识别，业务侧已兼容）
    return { target: `http://127.0.0.1:${port}`, rewritePath: pathname }
  }
  if (pathname === "/vnc-ws" || pathname.startsWith("/vnc-ws/")) {
    // 路径模式：/vnc-ws/<rest> → 上游 /<rest>（ticket 在查询串）
    const rest = pathname.replace(/^\/vnc-ws\/?/, "")
    const qs = search.toString()
    return { target: "http://127.0.0.1:3005", rewritePath: rest ? `/${rest}` : "/", rewriteSearch: qs }
  }
  return null // 默认 → Next 应用
}

// ---- HTTP 反向代理（含 socket.io polling 长轮询）----
async function proxyFetch(req: Request, target: string, rewritePath: string): Promise<Response> {
  const inUrl = new URL(req.url)
  const outUrl = new URL(target + rewritePath)
  // hop-by-hop 头剔除
  const headers = new Headers()
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if (["host", "connection", "keep-alive", "transfer-encoding", "upgrade"].includes(lk)) return
    headers.set(k, v)
  })
  headers.set("x-forwarded-host", inUrl.host)
  headers.set("x-forwarded-proto", inUrl.protocol.replace(":", ""))
  headers.set("x-gateway", "dockyard-unified")

  const method = req.method
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer()

  let upstream: Response
  try {
    upstream = await fetch(outUrl, { method, headers, body, redirect: "manual" })
  } catch (e) {
    return new Response(`[gateway] 上游不可达（${target}）：${String(e)}`, { status: 502, headers: { "x-gateway": "dockyard-unified" } })
  }

  const resHeaders = new Headers()
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    // 剔除 transfer-encoding / content-length / content-encoding：Bun fetch 已透明解压 + 缓冲后由 Bun 重新分帧与计算长度
    // （透传 gzip 头会让浏览器对已解压的明文 body 二次解压失败 → 页面永久挂起）
    if (["transfer-encoding", "connection", "keep-alive", "content-length", "content-encoding"].includes(lk)) return
    resHeaders.set(k, v)
  })
  // 缓冲转发（HTML/JS/API/文件下载均为中小体量；避免 Bun 流式分帧与上游 chunked 冲突导致浏览器挂起）
  const buf = await upstream.arrayBuffer().catch(() => null)
  if (buf === null) {
    return new Response("[gateway] 上游响应读取失败", { status: 502, headers: { "x-gateway": "dockyard-unified" } })
  }
  return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: resHeaders })
}

// ---- WebSocket 双向泵 ----
interface UpgradedData {
  client: WebSocket | null
  upstream: WebSocket | null
  pending: (string | ArrayBuffer | Uint8Array)[]
}

function pumpUpstream(upstreamUrl: string, headers: Headers): Promise<WebSocket> {
  // Bun WebSocket 客户端：透传子协议（socket.io 需要）
  const protocols: string[] = []
  const sp = headers.get("sec-websocket-protocol")
  if (sp) protocols.push(...sp.split(",").map((s) => s.trim()).filter(Boolean))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(upstreamUrl, protocols.length ? protocols : undefined)
    ws.binaryType = "arraybuffer"
    ws.addEventListener("open", () => resolve(ws), { once: true })
    ws.addEventListener("error", (e) => reject(e), { once: true })
  })
}

Bun.serve({
  port: GATEWAY_PORT,
  idleTimeout: 0, // VNC RFB 长连接不断开
  fetch(req, srv) {
    const u = new URL(req.url)
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket"

    // ---- 网关自检 ----
    if (u.pathname === "/__gateway/health") {
      return Response.json({ ok: true, gateway: true, port: GATEWAY_PORT, app: APP_TARGET, transformPorts: [...ALLOWED_TRANSFORM_PORTS], uptimeSec: Math.round(process.uptime()) })
    }

    const route = resolveTarget(u.pathname, u.searchParams)

    // ---- WebSocket 升级：桥/HUB 透传 ----
    if (isUpgrade) {
      if (!route) {
        return new Response("[gateway] 该路径不支持 WebSocket 升级", { status: 400 })
      }
      const upstreamBase = route.target.replace(/^http/, "ws")
      const qs = route.rewriteSearch ?? u.searchParams.toString()
      const upstreamUrl = upstreamBase + route.rewritePath + (qs ? (route.rewritePath.includes("?") ? "&" : "?") + qs : "")
      const data: UpgradedData = { client: null, upstream: null, pending: [] }
      if (srv.upgrade(req, { data })) {
        // 先与上游建立连接（异步），期间客户端消息入 pending 队列
        pumpUpstream(upstreamUrl, req.headers)
          .then((up) => {
            data.upstream = up
            up.binaryType = "arraybuffer"
            up.addEventListener("message", (ev) => {
              if (data.client && data.client.readyState === 1) data.client.send(ev.data as string | ArrayBuffer)
            })
            up.addEventListener("close", () => {
              if (data.client) try { data.client.close() } catch { /* 竞态 */ }
            })
            // 冲刷 pending
            for (const m of data.pending) {
              try { up.send(m as string) } catch { /* 已关闭 */ }
            }
            data.pending.length = 0
          })
          .catch(() => {
            if (data.client) try { data.client.close(1011, "upstream unavailable") } catch { /* 竞态 */ }
          })
        return undefined as unknown as Response
      }
      return new Response("升级失败", { status: 500 })
    }

    // ---- 普通 HTTP：桥/HUB 透传 or Next 应用 ----
    if (route) {
      const qs = route.rewriteSearch ?? u.searchParams.toString()
      // 查询参数模式需要把 XTransformPort 也传给上游（health 探测按原样即可）；路径模式用新查询串
      const fullPath = route.rewritePath.includes("?") ? route.rewritePath : route.rewritePath + (qs ? `?${qs}` : "")
      return proxyFetch(req, route.target, fullPath)
    }
    return proxyFetch(req, APP_TARGET, u.pathname + (u.search || ""))
  },
  websocket: {
    open(ws) {
      const d = ws.data as UpgradedData
      d.client = ws
    },
    message(ws, message) {
      const d = ws.data as UpgradedData
      const bytes = typeof message === "string" ? message : (message as Uint8Array)
      if (d.upstream && d.upstream.readyState === 1) {
        try { d.upstream.send(bytes as string | ArrayBuffer) } catch { /* 上游关闭竞态 */ }
      } else {
        d.pending.push(bytes as string | ArrayBuffer)
        if (d.pending.length > 256) d.pending.shift() // 上游不可达时防止内存膨胀
      }
    },
    close(ws) {
      const d = (ws.data ?? null) as UpgradedData | null
      if (d?.upstream) try { d.upstream.close() } catch { /* 竞态 */ }
      if (d) d.upstream = null
    },
  },
})

console.log(`[gateway] Dockyard 统一入口网关已启动: 端口 ${GATEWAY_PORT}（对外唯一 UI 端口）→ Next ${APP_TARGET} | 桥/HUB 回环透传 (${[...ALLOWED_TRANSFORM_PORTS].join("/")})`)
