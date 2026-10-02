// 通过桥（WS）复现 RFB 交互 —— 自签票据（共享密钥与桥一致）
import { createHmac, randomBytes } from "node:crypto"
import { WebSocket } from "ws"

const BRIDGE = process.argv[2] || "ws://127.0.0.1:3005/"
const WORKSPACE_ID = process.argv[3]
const TARGET_PORT = Number(process.argv[4] || 25900)
const SECRET = process.env.VNC_BRIDGE_SECRET || "dockyard-dev-vnc-secret"

const ENC_RAW = 0
const view16 = (b: Buffer, off: number) => b.readUInt16BE(off)
const view32s = (b: Buffer, off: number) => b.readInt32BE(off)

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const payload = {
  v: WORKSPACE_ID,
  ro: 0,
  dur: 0,
  exp: Math.floor(Date.now() / 1000) + 60,
  n: randomBytes(16).toString("hex"),
  tgt: { k: "tcp", h: "127.0.0.1", p: TARGET_PORT },
}
const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
const sig = b64url(createHmac("sha256", SECRET).update(payloadB64).digest())
const ticket = `${payloadB64}.${sig}`

const url = `${BRIDGE}?vnc=${encodeURIComponent(WORKSPACE_ID)}&ticket=${encodeURIComponent(ticket)}`
console.log("连接桥:", BRIDGE, "目标端口:", TARGET_PORT)

const ws = new WebSocket(url, { perMessageDeflate: false })
ws.binaryType = "nodebuffer"

let buf = Buffer.alloc(0)
let state = 0
let fbW = 0, fbH = 0
let fullFrameDone = false
const t0 = Date.now()
let msgCount = 0
let lastLog = 0

ws.on("open", () => console.log("WS 已连接桥"))
ws.on("error", (e: Error) => { console.error("WS错误:", e.message); process.exit(1) })

ws.on("message", (data: Buffer) => {
  msgCount++
  buf = Buffer.concat([buf, data])
  pump()
})

function pump() {
  for (;;) {
    if (state === 0) {
      if (buf.length < 12) return
      console.log("[1] 横幅:", JSON.stringify(buf.slice(0, 12).toString().trim()))
      buf = buf.slice(12)
      ws.send("RFB 003.008\n")
      state = 1
      continue
    }
    if (state === 1) {
      if (buf.length < 1) return
      const count = buf[0]
      if (count === 0) { state = 2; continue }
      if (buf.length < 1 + count) return
      const types = [...buf.slice(1, 1 + count)]
      console.log("[2] 安全类型:", types)
      buf = buf.slice(1 + count)
      ws.send(Buffer.from([1]))
      state = 5
      continue
    }
    if (state === 5) {
      if (buf.length < 4) return
      console.log("[3] SecurityResult:", buf.readUInt32BE(0))
      buf = buf.slice(4)
      ws.send(Buffer.from([1]))
      state = 3
      continue
    }
    if (state === 3) {
      if (buf.length < 24) return
      fbW = view16(buf, 0)
      fbH = view16(buf, 2)
      const nameLen = buf.readInt32BE(20)
      if (buf.length < 24 + nameLen) return
      console.log(`[4] ServerInit ${fbW}x${fbH} name="${buf.slice(24, 24 + nameLen).toString().slice(0, 30)}"`)
      buf = buf.slice(24 + nameLen)

      const setFmt = Buffer.alloc(20)
      setFmt[0] = 0
      setFmt[4] = 32; setFmt[5] = 24; setFmt[6] = 1; setFmt[7] = 1
      setFmt.writeUInt16BE(255, 8); setFmt.writeUInt16BE(255, 10); setFmt.writeUInt16BE(255, 12)
      setFmt[14] = 16; setFmt[15] = 8; setFmt[16] = 0
      ws.send(setFmt)

      const encodings = [ENC_RAW, 1, -223, -239, -308]
      const setEnc = Buffer.alloc(4 + 4 * encodings.length)
      setEnc[0] = 2
      setEnc.writeUInt16BE(encodings.length, 2)
      encodings.forEach((enc, i) => setEnc.writeInt32BE(enc, 4 + 4 * i))
      ws.send(setEnc)

      const req = Buffer.alloc(10)
      req[0] = 3; req[1] = 0
      req.writeUInt16BE(0, 2); req.writeUInt16BE(0, 4)
      req.writeUInt16BE(fbW, 6); req.writeUInt16BE(fbH, 8)
      ws.send(req)
      console.log("[5] SetPixelFormat/SetEncodings/全量请求 已发送")
      state = 4
      continue
    }
    if (state === 4) {
      if (buf.length < 1) return
      const type = buf[0]
      if (type === 0) {
        if (buf.length < 4) return
        const numRects = view16(buf, 2)
        let off = 4
        let rects = []
        let need = 0
        for (let i = 0; i < numRects; i++) {
          if (buf.length < off + 12) return
          const x = view16(buf, off), y = view16(buf, off + 2)
          const w = view16(buf, off + 4), h = view16(buf, off + 6)
          const enc = view32s(buf, off + 8)
          off += 12
          rects.push(`${w}x${h}@(${x},${y})enc=${enc}`)
          if (enc === ENC_RAW) {
            const n = w * h * 4
            if (buf.length < off + n) return
            if (n > 1000000 && !fullFrameDone) {
              const px = buf.slice(off, off + 4)
              console.log(`[全帧完成] ${w}x${h} 首像素=${[...px]} 耗时=${Date.now() - t0}ms 消息数=${msgCount}`)
              fullFrameDone = true
            }
            off += n
          } else if (enc === 1) {
            if (buf.length < off + 4) return
            off += 4
          } else if (enc === -239) {
            const n = w * h * 4 + Math.ceil(w / 8) * h
            if (buf.length < off + n) return
            off += n
          } else if (enc === -308) {
            if (buf.length < off + 4) return
            const ns = buf[off]
            const n = 4 + 16 * ns
            if (buf.length < off + n) return
            off += n
          }
        }
        buf = buf.slice(off)
        if (Date.now() - lastLog > 2000 || rects.length) {
          if (rects.some(r => r.includes("enc=0") && !r.includes("1920x1080"))) {
            console.log(`[增量] ${rects.join(" ")} 缓冲剩余=${buf.length}`)
          }
          lastLog = Date.now()
        }
        // 增量请求
        const req = Buffer.alloc(10)
        req[0] = 3; req[1] = 1
        req.writeUInt16BE(0, 2); req.writeUInt16BE(0, 4)
        req.writeUInt16BE(fbW, 6); req.writeUInt16BE(fbH, 8)
        ws.send(req)
        continue
      } else if (type === 3) {
        if (buf.length < 8) return
        const len = buf.readInt32BE(4)
        const total = len >= 0 ? 8 + len : 8 - len
        if (buf.length < total) return
        buf = buf.slice(total)
        continue
      } else if (type === 2) {
        buf = buf.slice(1); continue
      } else if (type === 1) {
        if (buf.length < 8) return
        const n = view16(buf, 6)
        const nd = 8 + n * 6
        if (buf.length < nd) return
        buf = buf.slice(nd); continue
      } else {
        console.log(`!!! 未知类型 ${type}: ${buf.slice(0, 24).toString("hex")}`)
        process.exit(1)
      }
    }
  }
}

setTimeout(() => {
  console.log(`\n=== 30s 总结: 消息=${msgCount} 全帧=${fullFrameDone ? "完成" : "未完成"} 缓冲积压=${buf.length}B ===`)
  process.exit(0)
}, 30000)
