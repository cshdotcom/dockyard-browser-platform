// 直接 RFB 握手 + 全帧请求：验证 x11vnc 服务的内容正确性
import net from "net"

const PORT = Number(process.argv[2] || 25900)

const sock = net.connect(PORT, "127.0.0.1")
let buf = Buffer.alloc(0)
let step = 0
let w = 0, h = 0
let serverPixfmt: Buffer | null = null
let serverName = ""
let step4Debug = 0

sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  pump()
})

function pump() {
  // 1. 版本
  if (step === 0 && buf.length >= 12) {
    const serverVersion = buf.slice(0, 12).toString().trim()
    buf = buf.slice(12)
    console.log("服务端版本:", serverVersion)
    sock.write("RFB 003.008\n")
    step = 1
    return pump()
  }
  // 2. 安全类型数量
  if (step === 1 && buf.length >= 1) {
    const nTypes = buf[0]
    if (nTypes === 0) {
      // 直接 SecurityResult
      step = 3
      buf = buf.slice(0)
      return pump()
    }
    if (buf.length < 1 + nTypes) return
    const types = [...buf.slice(1, 1 + nTypes)]
    buf = buf.slice(1 + nTypes)
    console.log("安全类型:", types)
    sock.write(Buffer.from([1])) // None
    step = 2
    return pump()
  }
  // 3. SecurityResult
  if (step === 2 && buf.length >= 4) {
    const result = buf.readUInt32BE(0)
    buf = buf.slice(4)
    console.log("SecurityResult:", result)
    // ClientInit(shared=1)
    sock.write(Buffer.from([1]))
    step = 3
    return pump()
  }
  // 4. ServerInit
  if (step === 3 && buf.length >= 24) {
    w = buf.readUInt16BE(0)
    h = buf.readUInt16BE(2)
    serverPixfmt = buf.slice(4, 20)
    const nameLen = buf.readUInt16BE(20)
    if (buf.length < 24 + nameLen) return
    serverName = buf.slice(24, 24 + nameLen).toString()
    buf = buf.slice(24 + nameLen)
    console.log(`ServerInit: ${w}x${h} 名称="${serverName}"`)
    const bitsPerPixel = serverPixfmt[0]
    console.log(`像素格式: ${bitsPerPixel}bpp depth=${serverPixfmt[3]} bigEndian=${serverPixfmt[1]}`)
    // SetPixelFormat(32bpp LE truecolor)
    const setPix = Buffer.alloc(20)
    setPix[0] = 0
    // bytes 1-3 padding；像素格式从 byte 4 开始
    setPix[4] = 32 // bits-per-pixel
    setPix[5] = 24 // depth
    setPix[6] = 0 // little-endian
    setPix[7] = 1 // true-color
    setPix.writeUInt16BE(255, 8) // red-max
    setPix.writeUInt16BE(255, 10) // green-max
    setPix.writeUInt16BE(255, 12) // blue-max
    setPix[14] = 16 // red-shift
    setPix[15] = 8 // green-shift
    setPix[16] = 0 // blue-shift
    sock.write(setPix)
    // SetEncodings: Raw(0) + CopyRect(1)
    const setEnc = Buffer.alloc(13)
    setEnc[0] = 2
    setEnc.writeUInt16BE(0, 1) // padding
    setEnc.writeUInt16BE(2, 3) // 两种编码
    setEnc.writeInt32BE(0, 5)
    setEnc.writeInt32BE(1, 9)
    sock.write(setEnc)
    // FramebufferUpdateRequest(全帧, incremental=0)
    const req = Buffer.alloc(10)
    req[0] = 3
    req[1] = 0
    req.writeUInt16BE(0, 2)
    req.writeUInt16BE(0, 4)
    req.writeUInt16BE(w, 6)
    req.writeUInt16BE(h, 8)
    sock.write(req)
    step = 4
    return pump()
  }
  // 5. FramebufferUpdate
  if (step === 4 && buf.length >= 4) {
    const msgType = buf[0]
    if (step4Debug === 0) {
      step4Debug = 1
      console.log("step4 首字节 hex:", buf.slice(0, 24).toString("hex"))
    }
    if (msgType === 1) {
      const nRects = buf.readUInt16BE(2)
      buf = buf.slice(4)
      console.log(`FramebufferUpdate: ${nRects} 个矩形`)
      // 只读第一个矩形头
      step = 5
      rectLoop(0, nRects)
    } else if (msgType === 2) {
      console.log("SetColourMapEntries（忽略）")
      buf = buf.slice(4)
    } else if (msgType === 3) {
      const len = buf.readUInt16BE(2)
      buf = buf.slice(4)
      if (buf.length >= len) {
        console.log("Bell")
        buf = buf.slice(len)
      }
    } else {
      console.log("其他消息类型:", msgType)
      buf = buf.slice(4)
    }
    return
  }
}

function rectLoop(idx: number, total: number) {
  if (idx >= total) {
    console.log("全部矩形完成")
    sock.end()
    process.exit(0)
  }
  if (buf.length < 12) {
    sock.once("data", () => {
      // 等数据到齐后继续
      waitForRect(idx, total)
    })
    return
  }
  waitForRect(idx, total)
}

let pixBytes = 0

sock.on("close", () => {
  console.log("连接关闭，累计像素字节:", pixBytes)
})

function waitForRect(idx: number, total: number) {
  if (buf.length < 12) return
  const rx = buf.readUInt16BE(0)
  const ry = buf.readUInt16BE(2)
  const rw = buf.readUInt16BE(4)
  const rh = buf.readUInt16BE(6)
  const encoding = buf.readInt32BE(8)
  const dataLen = rw * rh * 4
  if (buf.length < 12 + dataLen) return // 继续等
  const pixels = buf.slice(12, 12 + dataLen)
  buf = buf.slice(12 + dataLen)
  pixBytes += dataLen
  // 采样中心与四角
  const center = Math.floor(rh / 2) * rw * 4 + Math.floor(rw / 2) * 4
  const samples = [
    { label: "中心", pos: center },
    { label: "左上", pos: 0 },
    { label: "右上", pos: (rw - 1) * 4 },
    { label: "左下", pos: (rh - 1) * rw * 4 },
    { label: "标题区", pos: Math.floor(rh * 0.15) * rw * 4 + Math.floor(rw * 0.45) * 4 },
  ]
  const strs = samples.map((s) => {
    const p = pixels.slice(s.pos, s.pos + 4)
    return `${s.label}: rgb(${p[0]},${p[1]},${p[2]})`
  })
  console.log(`矩形#${idx}: ${rw}x${rh} @(${rx},${ry}) encoding=${encoding}`)
  console.log("  " + strs.join(" | "))
  rectLoop(idx + 1, total)
}

sock.on("error", (e) => {
  console.error("连接错误:", e.message)
  process.exit(1)
})
