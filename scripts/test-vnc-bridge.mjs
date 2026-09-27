// LiveDesk 桥协议级验证：票据签发 → WS 升级 → RFB 3.8 握手 → 帧接收 → 剪贴板回环 → 单次票据防重放
import { createHmac } from "node:crypto"
import WebSocket from "ws"

const BRIDGE = "ws://127.0.0.1:3005"
const SECRET = "dockyard-dev-vnc-secret"

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function signTicket(p) {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(p), "utf8"))
  const sig = b64url(createHmac("sha256", SECRET).update(payloadB64).digest())
  return payloadB64 + "." + sig
}

const WS_ID = "test-ws-" + Date.now()
const payload = { v: WS_ID, ro: 0, exp: Math.floor(Date.now() / 1000) + 60, n: "n-" + Math.random().toString(16).slice(2), tgt: { k: "demo" } }
const ticket = signTicket(payload)

console.log("[1] 票据已签发（demo 目标）:", ticket.slice(0, 40) + "…")

const ws = new WebSocket(`${BRIDGE}/?vnc=${WS_ID}&ticket=${encodeURIComponent(ticket)}`)
let stage = "version"
let buf = Buffer.alloc(0)
let frames = 0
let cutEcho = null
const t0 = Date.now()

ws.on("open", () => console.log("[2] WS 升级成功（票据校验通过）"))
ws.on("message", (data, isBinary) => {
  const chunk = Buffer.from(data)
  buf = Buffer.concat([buf, chunk])

  if (stage === "version") {
    if (buf.length >= 12) {
      const ver = buf.subarray(0, 12).toString("ascii")
      console.log("[3] 服务端版本协商:", JSON.stringify(ver.trim()), buf.length, "bytes")
      if (!ver.startsWith("RFB 003.008")) throw new Error("版本协商失败: " + ver)
      buf = buf.subarray(12)
      ws.send(Buffer.from("RFB 003.008\n", "ascii")) // 客户端回应版本
      stage = "sectypes"
    }
  }
  if (stage === "sectypes") {
    if (buf.length >= 2) {
      const count = buf[0]
      console.log(`[4] 安全类型列表: count=${count}, type=${buf[1]}`)
      if (count !== 1 || buf[1] !== 1) throw new Error("期望 None 安全类型")
      buf = buf.subarray(2)
      ws.send(Buffer.from([1])) // 选择 None
      stage = "secresult"
    }
  }
  if (stage === "secresult") {
    if (buf.length >= 4) {
      const r = buf.readUInt32BE(0)
      console.log("[5] 安全校验结果:", r === 0 ? "OK(0)" : r)
      if (r !== 0) throw new Error("安全校验失败")
      buf = buf.subarray(4)
      ws.send(Buffer.from([1])) // ClientInit: shared=1
      stage = "serverinit"
    }
  }
  if (stage === "serverinit") {
    if (buf.length >= 24) {
      const w = buf.readUInt16BE(0), h = buf.readUInt16BE(2)
      const nameLen = buf.readUInt32BE(20)
      if (buf.length >= 24 + nameLen) {
        const name = buf.subarray(24, 24 + nameLen).toString("utf8")
        console.log(`[6] ServerInit: ${w}x${h}, 桌面名=${JSON.stringify(name)}`)
        buf = buf.subarray(24 + nameLen)
        // SetEncodings: raw
        const enc = Buffer.alloc(8)
        enc.writeUInt8(2, 0); enc.writeUInt16BE(1, 2); enc.writeInt32BE(0, 4)
        ws.send(enc)
        // FramebufferUpdateRequest: 全屏 非增量
        const req = Buffer.alloc(10)
        req.writeUInt8(3, 0); req.writeUInt8(0, 1)
        req.writeUInt16BE(0, 2); req.writeUInt16BE(0, 4); req.writeUInt16BE(w, 6); req.writeUInt16BE(h, 8)
        ws.send(req)
        stage = "frames"
        // 发送 ClientCutText 测试中文回环
        const text = Buffer.from("中文剪贴板测试 Dockyard", "utf8")
        const cut = Buffer.alloc(8 + text.length)
        cut.writeUInt8(6, 0); cut.writeUInt32BE(text.length, 4)
        text.copy(cut, 8)
        ws.send(cut)
        console.log("[7] 已发送 FramebufferUpdateRequest + ClientCutText(中文)")
      }
    }
  }
  if (stage === "frames") {
    // 解析 ServerCutText（经典回显 / 扩展能力宣告）与 FramebufferUpdate
    while (buf.length > 0) {
      const t = buf[0]
      if (t === 3) {
        if (buf.length < 8) return
        const len = buf.readInt32BE(4)
        if (len >= 0) {
          if (buf.length < 8 + len) return
          cutEcho = buf.subarray(8, 8 + len).toString("utf8")
          buf = buf.subarray(8 + len)
          console.log("[8] ServerCutText 回执:", JSON.stringify(cutEcho))
        } else {
          // 扩展剪贴板消息（能力宣告等）：跳过
          const dataLen = -len
          if (buf.length < 8 + dataLen) return
          buf = buf.subarray(8 + dataLen)
          console.log(`[8+] 扩展剪贴板消息已接收并跳过（${dataLen}B payload）`)
        }
      } else if (t === 0) {
        if (buf.length < 16) return
        const numRects = buf.readUInt16BE(2)
        const w = buf.readUInt16BE(8), h = buf.readUInt16BE(10)
        const enc = buf.readInt32BE(12)
        const dataLen = w * h * 4
        if (buf.length < 16 + dataLen) return
        frames++
        if (frames <= 2 || frames % 20 === 0) console.log(`[9] 帧#${frames}: FramebufferUpdate ${numRects} rect ${w}x${h} enc=${enc} (${dataLen} bytes raw)`)
        buf = buf.subarray(16 + dataLen)
        // 继续请求增量帧（驱动演示引擎持续发送）
        const req = Buffer.alloc(10)
        req.writeUInt8(3, 0); req.writeUInt8(1, 1)
        req.writeUInt16BE(0, 2); req.writeUInt16BE(0, 4); req.writeUInt16BE(640, 6); req.writeUInt16BE(400, 8)
        ws.send(req)
      } else {
        throw new Error("意外消息类型: " + t)
      }
    }
  }
})

ws.on("error", (e) => { console.error("WS ERROR:", e.message); process.exit(1) })

setTimeout(() => {
  console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)}s 内接收 ${frames} 帧，剪贴板回环: ${cutEcho ? "✓ 成功" : "✗ 失败"} ---`)
  if (frames < 3) { console.error("帧数不足，FAIL"); process.exit(1) }
  ws.close()
  // 单次票据防重放验证：同票据二连
  const ws2 = new WebSocket(`${BRIDGE}/?vnc=${WS_ID}&ticket=${encodeURIComponent(ticket)}`)
  ws2.on("unexpected-response", (_req, res) => {
    console.log(`[10] 单次票据防重放: HTTP ${res.statusCode} ${res.statusCode === 401 ? "✓ 拦截成功" : "✗ 未拦截"}`)
    process.exit(res.statusCode === 401 ? 0 : 1)
  })
  ws2.on("error", (e) => console.log("[10] 重放连接被拒绝:", e.message))
}, 5000)
