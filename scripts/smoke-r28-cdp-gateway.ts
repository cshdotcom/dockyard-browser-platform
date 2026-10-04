/**
 * r28 冒烟：CDP 公网网关（cdp-gateway:3006）
 * 覆盖：票据验签 / 正常双向转发 / 单次防重放 / 坏票据拒绝 / 连接时长上限
 * 环境：cdp-gateway 由 daemon-services 守护（:3006）；本测试起假 CDP WS 上游（:9333）
 */
import { WebSocketServer, WebSocket } from "ws"
import { createHmac, randomBytes } from "crypto"

const GW = "ws://localhost:3006"
const SECRET = process.env.CDP_GATEWAY_SECRET || "dockyard-dev-cdp-secret"
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function signTicket(p: Record<string, unknown>): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(p), "utf8"))
  const sig = b64url(createHmac("sha256", SECRET).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

async function main() {
  console.log("== r28 冒烟：CDP 公网网关 ==")

  // 0. 健康检查
  const health = await fetch("http://localhost:3006/health").then((r) => r.json()).catch(() => null)
  check("健康检查（cdp-gateway 存活）", !!health?.ok, JSON.stringify(health))

  // 1. 假 CDP 上游（:9333）
  const upstream = new WebSocketServer({ port: 9333 })
  const echoMsgs: string[] = []
  await new Promise<void>((res) => upstream.on("listening", res))
  upstream.on("connection", (ws) => {
    ws.on("message", (d: Buffer) => {
      echoMsgs.push(d.toString())
      ws.send(`ECHO:${d.toString()}`)
    })
  })

  // 2. 正常票据 → 连接 → 双向转发
  const ticket = signTicket({
    v: "ws-test", u: "user-test", tgt: "ws://127.0.0.1:9333/devtools/browser/test-uuid",
    exp: Math.floor(Date.now() / 1000) + 60, dur: 0, n: randomBytes(8).toString("hex"),
  })
  const client = new WebSocket(`${GW}/t/${ticket}`)
  const got = await new Promise<string>((res, rej) => {
    client.on("open", () => {
      client.send('{"method":"Target.getTargets"}')
    })
    client.on("message", (d: Buffer) => res(d.toString()))
    client.on("error", (e) => rej(e))
    setTimeout(() => rej(new Error("timeout")), 5000)
  }).catch((e) => String(e))
  check("票据连接 + CDP 请求转发 + 响应回传", got.startsWith("ECHO:{\"method\""), got)
  check("上游收到原始消息", echoMsgs[0]?.includes("Target.getTargets"))
  client.close()

  // 3. 同票据重放 → 拒绝
  const client2 = new WebSocket(`${GW}/t/${ticket}`)
  const replay = await new Promise<string>((res) => {
    client2.on("error", () => res("rejected"))
    client2.on("unexpected-response", (_req, res) => res(`http-${res.statusCode}`))
    client2.on("open", () => res("opened-should-not"))
    setTimeout(() => res("no-response"), 3000)
  })
  check("单次票据防重放（第二次拒绝）", replay === "rejected" || replay.startsWith("http-401"), replay)
  try { client2.close() } catch { /* noop */ }

  // 4. 伪造签名 → 401
  const forged = ticket.slice(0, -4) + "AAAA"
  const client3 = new WebSocket(`${GW}/t/${forged}`)
  const bad = await new Promise<string>((res) => {
    client3.on("error", () => res("rejected"))
    client3.on("unexpected-response", (_req, res) => res(`http-${res.statusCode}`))
    client3.on("open", () => res("opened-should-not"))
    setTimeout(() => res("no-response"), 3000)
  })
  check("伪造签名拒绝（401）", bad === "rejected" || bad.startsWith("http-401"), bad)
  try { client3.close() } catch { /* noop */ }

  // 5. 过期票据 → 拒绝
  const expired = signTicket({
    v: "ws-test", u: "u", tgt: "ws://127.0.0.1:9333/x",
    exp: Math.floor(Date.now() / 1000) - 10, dur: 0, n: randomBytes(8).toString("hex"),
  })
  const client4 = new WebSocket(`${GW}/t/${expired}`)
  const exp = await new Promise<string>((res) => {
    client4.on("error", () => res("rejected"))
    client4.on("unexpected-response", (_req, res) => res(`http-${res.statusCode}`))
    client4.on("open", () => res("opened-should-not"))
    setTimeout(() => res("no-response"), 3000)
  })
  check("过期票据拒绝", exp === "rejected" || exp.startsWith("http-401"), exp)
  try { client4.close() } catch { /* noop */ }

  // 6. 时长上限票据（dur=1s）→ 1 秒后断开
  const limited = signTicket({
    v: "ws-test", u: "u", tgt: "ws://127.0.0.1:9333/y",
    exp: Math.floor(Date.now() / 1000) + 60, dur: 1, n: randomBytes(8).toString("hex"),
  })
  const client5 = new WebSocket(`${GW}/t/${limited}`)
  const closed = await new Promise<boolean>((res) => {
    client5.on("open", () => {})
    client5.on("close", () => res(true))
    client5.on("error", () => res(true))
    setTimeout(() => res(false), 4000)
  })
  check("连接时长上限（1s 后断开）", closed)

  upstream.close()
  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200).unref?.()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
