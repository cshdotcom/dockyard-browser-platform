// 复现 HelmPort rfb-client 与真实 x11vnc 的完整协议交互（逐字节对齐客户端实现）
import net from "net"

const PORT = Number(process.argv[2] || 25900)

const ENC_RAW = 0
const ENC_COPYRECT = 1
const ENC_DESKTOP_SIZE = -223
const ENC_CURSOR = -239
const ENC_EXT_DESKTOP_SIZE = -308

// 与客户端 view16/view32/view32s 完全一致
const view16 = (b: Buffer, off: number) => b.readUInt16BE(off)
const view32s = (b: Buffer, off: number) => b.readInt32BE(off)

const sock = net.connect(PORT, "127.0.0.1")
let buf = Buffer.alloc(0)
let state = 0 // 0=version 1=types 2=result 3=serverinit 4=running
let fbW = 0, fbH = 0
const t0 = Date.now()

sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  pump()
})

function pump() {
  for (;;) {
    if (state === 0) {
      if (buf.length < 12) return
      const banner = buf.slice(0, 12).toString()
      console.log("[1] 服务端横幅:", JSON.stringify(banner.trim()))
      buf = buf.slice(12)
      sock.write("RFB 003.008\n") // 客户端固定回 3.8（与服务端版本一致）
      state = 1
      continue
    }
    if (state === 1) {
      if (buf.length < 1) return
      const count = buf[0]
      if (count === 0) {
        console.log("[2] 3.3 形态（无类型列表）")
        state = 2
        continue
      }
      if (buf.length < 1 + count) return
      const types = [...buf.slice(1, 1 + count)]
      console.log("[2] 安全类型:", types)
      buf = buf.slice(1 + count)
      sock.write(Buffer.from([types.includes(1) ? 1 : types[0]]))
      // 3.8: None 也返回 SecurityResult
      if (types.includes(1)) {
        state = 5 // 等 SecurityResult
      } else {
        state = 2
      }
      continue
    }
    if (state === 5) {
      if (buf.length < 4) return
      const r = buf.readUInt32BE(0)
      console.log("[3] SecurityResult:", r)
      buf = buf.slice(4)
      sock.write(Buffer.from([1])) // ClientInit shared=1
      state = 3
      continue
    }
    if (state === 3) {
      if (buf.length < 24) return
      fbW = view16(buf, 0)
      fbH = view16(buf, 2)
      const nameLen = buf.readInt32BE(20) // view32 —— 客户端实现
      if (buf.length < 24 + nameLen) return
      const name = buf.slice(24, 24 + nameLen).toString()
      buf = buf.slice(24 + nameLen)
      console.log(`[4] ServerInit: ${fbW}x${fbH} nameLen=${nameLen} name="${name.slice(0, 40)}"`)
      if (nameLen < 0 || nameLen > 4096) {
        console.log("!!! nameLen 异常 —— 协议失步")
        process.exit(1)
      }

      // SetPixelFormat（与客户端逐字节一致）
      const setFmt = Buffer.alloc(20)
      setFmt[0] = 0
      setFmt[4] = 32
      setFmt[5] = 24
      setFmt[6] = 1 // LE（客户端 setFmt[6]=1? —— 检查：客户端写了 1！）
      setFmt[7] = 1 // true color
      setFmt.writeUInt16BE(255, 8)
      setFmt.writeUInt16BE(255, 10)
      setFmt.writeUInt16BE(255, 12)
      setFmt[14] = 16
      setFmt[15] = 8
      setFmt[16] = 0
      sock.write(setFmt)
      console.log("[5] SetPixelFormat 已发送")

      // SetEncodings（与客户端一致）
      const encodings = [ENC_RAW, ENC_COPYRECT, ENC_DESKTOP_SIZE, ENC_CURSOR, ENC_EXT_DESKTOP_SIZE]
      const setEnc = Buffer.alloc(4 + 4 * encodings.length)
      setEnc[0] = 2
      setEnc.writeUInt16BE(encodings.length, 2)
      encodings.forEach((enc, i) => setEnc.writeInt32BE(enc, 4 + 4 * i))
      sock.write(setEnc)
      console.log("[6] SetEncodings 已发送:", encodings)

      // FramebufferUpdateRequest 全量
      const req = Buffer.alloc(10)
      req[0] = 3
      req[1] = 0
      req.writeUInt16BE(0, 2)
      req.writeUInt16BE(0, 4)
      req.writeUInt16BE(fbW, 6)
      req.writeUInt16BE(fbH, 8)
      sock.write(req)
      console.log("[7] 全量帧请求已发送")
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
        console.log(`[帧] FramebufferUpdate: ${numRects} 矩形，缓冲=${buf.length}B`)
        for (let i = 0; i < numRects; i++) {
          if (buf.length < off + 12) {
            console.log(`  等待矩形头#${i}（需要 ${off + 12}，已有 ${buf.length}）`)
            return
          }
          const x = view16(buf, off)
          const y = view16(buf, off + 2)
          const w = view16(buf, off + 4)
          const h = view16(buf, off + 6)
          const enc = view32s(buf, off + 8)
          off += 12
          console.log(`  矩形#${i}: ${w}x${h} @(${x},${y}) enc=${enc}`)
          if (enc === ENC_RAW) {
            const need = w * h * 4
            if (buf.length < off + need) {
              console.log(`  等待像素数据（需要 ${need}B = ${(need / 1048576).toFixed(1)}MB，已有 ${buf.length - off}B）`)
              return
            }
            // 采样
            const px = buf.slice(off, off + Math.min(need, 8))
            console.log(`  像素首字节: ${[...px.slice(0, 8)].join(",")}`)
            off += need
          } else if (enc === ENC_COPYRECT) {
            if (buf.length < off + 4) return
            off += 4
          } else if (enc === ENC_CURSOR) {
            const pixels = w * h * 4
            const maskBytes = Math.ceil(w / 8) * h
            if (buf.length < off + pixels + maskBytes) {
              console.log(`  等待光标数据（需要 ${pixels + maskBytes}，已有 ${buf.length - off}）`)
              return
            }
            off += pixels + maskBytes
          } else if (enc === ENC_EXT_DESKTOP_SIZE) {
            const numScreens = buf[off]
            off += 4 + 16 * numScreens
          }
          // DESKTOP_SIZE 无负载
        }
        buf = buf.slice(off)
        console.log(`[帧] 完成解析，剩余缓冲 ${buf.length}B，耗时 ${Date.now() - t0}ms`)
        // 增量请求（与客户端节奏一致）
        const req = Buffer.alloc(10)
        req[0] = 3
        req[1] = 1
        req.writeUInt16BE(0, 2)
        req.writeUInt16BE(0, 4)
        req.writeUInt16BE(fbW, 6)
        req.writeUInt16BE(fbH, 8)
        sock.write(req)
        return
      } else if (type === 3) {
        if (buf.length < 8) return
        const len = buf.readInt32BE(4)
        console.log(`[剪贴板] ServerCutText len=${len}`)
        const total = len >= 0 ? 8 + len : 8 - len
        if (buf.length < total) return
        buf = buf.slice(total)
        continue
      } else if (type === 2) {
        buf = buf.slice(1)
        console.log("[Bell]")
        continue
      } else if (type === 1) {
        if (buf.length < 8) return
        const n = view16(buf, 6)
        const need = 8 + n * 6
        if (buf.length < need) return
        buf = buf.slice(need)
        continue
      } else {
        console.log(`!!! 未知消息类型 ${type}，前16字节: ${buf.slice(0, 16).toString("hex")}`)
        console.log(`!!! ASCII: ${buf.slice(0, 40).toString().replace(/[^\x20-\x7e]/g, ".")}`)
        process.exit(1)
      }
    }
  }
}

sock.on("error", (e: Error) => { console.error("连接错误:", e.message); process.exit(1) })
setTimeout(() => { console.log("超时退出（30s）"); process.exit(0) }, 30000)
