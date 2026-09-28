// ============================================================
// HelmPort RFB 协议客户端（自研，零第三方依赖）
// 直接以 Next.js/React 组件生态运行 —— 替代 @novnc/novnc 依赖
//
// 协议能力：
//   · RFB 3.3 / 3.7 / 3.8 版本协商与安全握手（None 安全校验）
//   · ServerInit 像素格式解析 → SetPixelFormat 强制 32bpp LE true-color（16/8/0）
//   · 编码：Raw(0) / CopyRect(1) / 桌面尺寸伪编码(-223) / 光标伪编码(-239)
//   · 输入：PointerEvent / KeyEvent（keysym，修饰键状态机）
//   · QEMU 扩展剪贴板：Caps/Request/Notify/Provide + zlib（CompressionStream，
//     不可用时降级经典 latin1 通道）—— UTF-8 中文完整支持
//   · 帧率节流（画质档位驱动增量请求节奏）+ 数据面字节统计
// 安全：只读模式客户端丢弃输入；单次票据由服务端桥二次丢弃（双保险）
// ============================================================

// ---- QEMU 扩展剪贴板常量 ----
const CLIP_FORMAT_TEXT = 1
const CLIP_ACTION_CAPS = 1 << 24
const CLIP_ACTION_REQUEST = 1 << 25
const CLIP_ACTION_PEEK = 1 << 26
const CLIP_ACTION_NOTIFY = 1 << 27
const CLIP_ACTION_PROVIDE = 1 << 28

// ---- 编码常量 ----
const ENC_RAW = 0
const ENC_COPYRECT = 1
const ENC_DESKTOP_SIZE = -223
const ENC_CURSOR = -239

export interface RfbServerInfo {
  width: number
  height: number
  name: string
  version: string
}

export interface RfbTelemetry {
  bytesIn: number
  bytesOut: number
  frameCount: number
  lastMessageAt: number
}

export interface HelmPortRfbOptions {
  canvas: HTMLCanvasElement
  viewOnly?: boolean
  qualityLevel?: number // 0-9（帧请求节奏：0≈4fps … 9≈即刻）
  onConnected?: (info: RfbServerInfo) => void
  onDisconnected?: (reason: string) => void
  onSecurityFail?: (reason: string) => void
  onClipboard?: (text: string) => void
  onBell?: () => void
  onTelemetry?: (t: RfbTelemetry) => void
}

enum State {
  HandshakeVersion,
  HandshakeSecurity,
  HandshakeSecurityResult,
  HandshakeInit,
  Running,
  Closed,
}
export class HelmPortRfb {
  private ws: WebSocket
  private opts: HelmPortRfbOptions
  private state = State.HandshakeVersion
  private buf = new Uint8Array(0)
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private fbW = 0
  private fbH = 0
  private serverVersion = "3.8"
  private telemetry: RfbTelemetry = { bytesIn: 0, bytesOut: 0, frameCount: 0, lastMessageAt: 0 }
  private reqTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private pointerState = 0
  private zlibStreams = new Map<number, { parts: Uint8Array[] }>()
  private manualClose = false
  private clientInitSent = false

  constructor(ws: WebSocket, opts: HelmPortRfbOptions) {
    this.ws = ws
    this.opts = opts
    this.canvas = opts.canvas
    this.ctx = this.canvas.getContext("2d", { alpha: false })
    this.ws.binaryType = "arraybuffer"
    this.ws.addEventListener("message", (ev) => this.onData(ev.data as ArrayBuffer))
    this.ws.addEventListener("close", () => this.finish("连接已关闭"))
    this.ws.addEventListener("error", () => this.finish("连接错误"))
    if (this.ws.readyState === WebSocket.OPEN) this.handleOpen()
    else this.ws.addEventListener("open", () => this.handleOpen(), { once: true })
  }

  private handleOpen() {
    // 等待服务端版本横幅（由 onData 状态机处理）
  }

  // ================= 数据接收与解析 =================

  private onData(data: ArrayBuffer) {
    if (this.state === State.Closed) return
    const incoming = new Uint8Array(data)
    this.telemetry.bytesIn += data.byteLength
    this.telemetry.lastMessageAt = Date.now()
    // 拼接缓冲
    const merged = new Uint8Array(this.buf.length + incoming.length)
    merged.set(this.buf)
    merged.set(incoming, this.buf.length)
    this.buf = merged
    this.pump()
  }

  private pump() {
    // 循环解析直至缓冲不足
    for (;;) {
      if (this.state === State.HandshakeVersion) {
        if (this.buf.length < 12) return
        const banner = ascii(this.buf.subarray(0, 12))
        const m = banner.match(/RFB (\d{3})\.(\d{3})\n/)
        if (!m) {
          this.opts.onSecurityFail?.("非 RFB 协议横幅")
          return this.disconnect()
        }
        const svMajor = Number(m[1])
        const svMinor = Number(m[2])
        // 回复版本：回显服务端版本（高于 3.8 时以 3.8 应答），行为以服务端版本为准
        this.serverVersion = `${svMajor}.${svMinor}`
        const replyMajor = Math.min(svMajor, 3)
        const replyMinor = svMajor >= 3 && svMajor < 4 ? Math.min(svMinor, 8) : 8
        this.sendRaw(new TextEncoder().encode(`RFB ${String(replyMajor).padStart(3, "0")}.${String(replyMinor).padStart(3, "0")}\n`))
        this.buf = this.buf.subarray(12)
        this.state = State.HandshakeSecurity
        continue
      }
      if (this.state === State.HandshakeSecurity) {
        const major = Number(this.serverVersion.split(".")[0])
        const minor = Number(this.serverVersion.split(".")[1])
        if (major === 3 && minor < 7) {
          // RFB 3.3：直接 u32 安全类型（无选择阶段、无 SecurityResult）
          if (this.buf.length < 4) return
          const type = view32(this.buf, 0)
          this.buf = this.buf.subarray(4)
          if (type !== 1) {
            this.opts.onSecurityFail?.(`服务端要求不支持的认证方式（type=${type}）`)
            return this.disconnect()
          }
          this.state = State.HandshakeInit
          continue
        }
        // 3.7+：u8 数量 + 类型列表
        if (this.buf.length < 1) return
        const count = this.buf[0]
        if (count === 0) {
          // 失败：紧跟 u32 长度 + 原因文本
          if (this.buf.length < 4) return
          const len = view32(this.buf, 1)
          if (this.buf.length < 5 + len) return
          const reason = utf8(this.buf.subarray(5, 5 + len))
          this.opts.onSecurityFail?.(reason || "安全握手失败")
          return this.disconnect()
        }
        if (this.buf.length < 1 + count) return
        const types: number[] = []
        for (let i = 0; i < count; i++) types.push(this.buf[1 + i])
        this.buf = this.buf.subarray(1 + count)
        if (!types.includes(1)) {
          this.opts.onSecurityFail?.(`无可用免密安全类型（提供：${types.join(",")}）`)
          return this.disconnect()
        }
        // 选择 None(1)（票据鉴权已在网关桥完成）
        this.sendRaw(new Uint8Array([1]))
        // RFB 3.8：None 后服务端回 SecurityResult；3.7：无
        if (major === 3 && minor >= 8) this.state = State.HandshakeSecurityResult
        else this.state = State.HandshakeInit
        continue
      }
      if (this.state === State.HandshakeSecurityResult) {
        if (this.buf.length < 4) return
        const result = view32(this.buf, 0)
        this.buf = this.buf.subarray(4)
        if (result !== 0) {
          // 3.8 失败携带原因
          if (this.buf.length >= 4) {
            const len = view32(this.buf, 0)
            if (this.buf.length >= 4 + len) {
              const reason = utf8(this.buf.subarray(4, 4 + len))
              this.opts.onSecurityFail?.(reason || "安全校验失败")
              return this.disconnect()
            }
          }
          this.opts.onSecurityFail?.("安全校验失败")
          return this.disconnect()
        }
        this.state = State.HandshakeInit
        continue
      }
      if (this.state === State.HandshakeInit) {
        // ClientInit 仅发送一次（后续 pump 重入不重复发送 —— 多余字节会被服务端判为协议错误）
        if (!this.clientInitSent) {
          this.clientInitSent = true
          this.sendRaw(new Uint8Array([1])) // shared=1 共享会话
        }
        // ServerInit: w(2) h(2) pixfmt(16) nameLen(4) name
        if (this.buf.length < 24) return
        this.fbW = view16(this.buf, 0)
        this.fbH = view16(this.buf, 2)
        const nameLen = view32(this.buf, 20)
        if (this.buf.length < 24 + nameLen) return
        const name = utf8(this.buf.subarray(24, 24 + nameLen))
        this.buf = this.buf.subarray(24 + nameLen)

        this.canvas.width = this.fbW
        this.canvas.height = this.fbH
        this.ctx = this.canvas.getContext("2d", { alpha: false })
        if (this.ctx) {
          this.ctx.fillStyle = "#070b0e"
          this.ctx.fillRect(0, 0, this.fbW, this.fbH)
        }

        // 请求我方像素格式：32bpp LE truecolor（R16 G8 B0）
        const setFmt = new Uint8Array(20)
        setFmt[0] = 0 // SetPixelFormat
        // bytes 4..19：Pixel Format
        setFmt[4] = 32
        setFmt[5] = 24
        setFmt[6] = 1 // little endian
        setFmt[7] = 1 // true color
        set16(setFmt, 8, 255)
        set16(setFmt, 10, 255)
        set16(setFmt, 12, 255)
        setFmt[14] = 16
        setFmt[15] = 8
        setFmt[16] = 0
        this.sendRaw(setFmt)

        // SetEncodings：Raw + CopyRect + 桌面尺寸 + 光标伪编码
        const encodings = [ENC_RAW, ENC_COPYRECT, ENC_DESKTOP_SIZE, ENC_CURSOR]
        const setEnc = new Uint8Array(4 + 4 * encodings.length)
        setEnc[0] = 2
        set16(setEnc, 2, encodings.length)
        encodings.forEach((enc, i) => set32s(setEnc, 4 + 4 * i, enc))
        this.sendRaw(setEnc)

        // QEMU 扩展剪贴板能力宣告
        this.sendExtClipboard(CLIP_ACTION_CAPS | CLIP_ACTION_REQUEST | CLIP_ACTION_NOTIFY | CLIP_ACTION_PROVIDE, CLIP_FORMAT_TEXT, new Uint8Array(0))

        // 全量帧请求
        this.requestFramebufferUpdate(false)
        this.state = State.Running
        this.opts.onConnected?.({ width: this.fbW, height: this.fbH, name, version: this.serverVersion })

        // 保活：3 秒无增量则补发请求（x11vnc 某些配置需要）
        this.keepaliveTimer = setInterval(() => {
          if (this.state === State.Running && Date.now() - this.telemetry.lastMessageAt > 3000) {
            this.requestFramebufferUpdate(true)
          }
        }, 3000)
        continue
      }
      if (this.state === State.Running) {
        if (!this.parseServerMessage()) return
        continue
      }
      return
    }
  }

  // ---- 运行期服务器消息解析 ----
  private parseServerMessage(): boolean {
    if (this.buf.length < 1) return false
    const type = this.buf[0]
    switch (type) {
      case 0: {
        // FramebufferUpdate: pad(1) numRects(2)
        if (this.buf.length < 4) return false
        const numRects = view16(this.buf, 2)
        let off = 4
        for (let i = 0; i < numRects; i++) {
          if (this.buf.length < off + 12) return false
          const x = view16(this.buf, off)
          const y = view16(this.buf, off + 2)
          const w = view16(this.buf, off + 4)
          const h = view16(this.buf, off + 6)
          const enc = view32s(this.buf, off + 8)
          off += 12
          if (enc === ENC_RAW) {
            const need = w * h * 4
            if (this.buf.length < off + need) return false
            this.blitRaw(x, y, w, h, this.buf.subarray(off, off + need))
            off += need
          } else if (enc === ENC_COPYRECT) {
            if (this.buf.length < off + 4) return false
            const srcX = view16(this.buf, off)
            const srcY = view16(this.buf, off + 2)
            this.copyRect(x, y, w, h, srcX, srcY)
            off += 4
          } else if (enc === ENC_DESKTOP_SIZE) {
            // 伪编码：无数据负载（w/h 即新尺寸）
            this.fbW = w
            this.fbH = h
            this.canvas.width = w
            this.canvas.height = h
            this.ctx = this.canvas.getContext("2d", { alpha: false })
          } else if (enc === ENC_CURSOR) {
            const pixels = w * h * 4
            const maskBytes = Math.ceil(w / 8) * h
            if (this.buf.length < off + pixels + maskBytes) return false
            this.applyCursor(x, y, w, h, this.buf.subarray(off, off + pixels + maskBytes))
            off += pixels + maskBytes
          } else {
            // 未请求的编码：协议错误 → 断开
            this.finish(`收到未协商的编码 ${enc}，协议错误`)
            return false
          }
        }
        this.buf = this.buf.subarray(off)
        this.telemetry.frameCount++
        this.opts.onTelemetry?.({ ...this.telemetry })
        // 帧请求节奏：画质档位（0-9 → 250ms - 0ms 延迟）
        this.scheduleNextRequest()
        return true
      }
      case 1: {
        // SetColourMapEntries: pad(3) firstColour(2) nColours(2) + n*6
        if (this.buf.length < 8) return false
        const n = view16(this.buf, 6)
        const need = 8 + n * 6
        if (this.buf.length < need) return false
        this.buf = this.buf.subarray(need)
        return true
      }
      case 2: {
        // Bell
        this.buf = this.buf.subarray(1)
        this.opts.onBell?.()
        return true
      }
      case 3: {
        // ServerCutText: pad(3) len(4, 有符号)
        if (this.buf.length < 8) return false
        const len = view32s(this.buf, 4)
        if (len >= 0) {
          // 经典：UTF-8 直读（桥侧即 UTF-8 回显）
          if (this.buf.length < 8 + len) return false
          const text = utf8(this.buf.subarray(8, 8 + len))
          this.buf = this.buf.subarray(8 + len)
          if (text) this.opts.onClipboard?.(text)
          return true
        }
        // 扩展（负长度）：flags(4) + payload
        const dataLen = -len
        if (this.buf.length < 8 + dataLen) return false
        const data = this.buf.subarray(8, 8 + dataLen)
        this.buf = this.buf.subarray(8 + dataLen)
        this.handleExtClipboard(data)
        return true
      }
      default: {
        this.finish(`未知服务器消息类型 ${type}，协议错误`)
        return false
      }
    }
  }

  // ================= 帧绘制 =================

  private blitRaw(x: number, y: number, w: number, h: number, pixels: Uint8Array) {
    if (!this.ctx) return
    const img = this.ctx.createImageData(w, h)
    // 我方请求格式：LE 32bpp BGRA 字节序（B,G,R,0）
    img.data.set(pixels.subarray(0, w * h * 4))
    this.ctx.putImageData(img, x, y)
  }

  private copyRect(x: number, y: number, w: number, h: number, srcX: number, srcY: number) {
    if (!this.ctx) return
    this.ctx.drawImage(this.canvas, srcX, srcY, w, h, x, y, w, h)
  }

  private applyCursor(x: number, y: number, w: number, h: number, data: Uint8Array) {
    try {
      const pixelsLen = w * h * 4
      const pixels = data.subarray(0, pixelsLen)
      const mask = data.subarray(pixelsLen)
      const out = document.createElement("canvas")
      out.width = w
      out.height = h
      const ctx = out.getContext("2d")!
      const img = ctx.createImageData(w, h)
      img.data.set(pixels)
      // 掩码：1 = 透明
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const bit = (mask[row * Math.ceil(w / 8) + (col >> 3)] >> (7 - (col & 7))) & 1
          if (bit) img.data[(row * w + col) * 4 + 3] = 0
        }
      }
      ctx.putImageData(img, 0, 0)
      this.canvas.style.cursor = `url(${out.toDataURL()}) ${x} ${y}, default`
    } catch {
      this.canvas.style.cursor = "default"
    }
  }

  // ================= 增量请求节奏 =================

  private scheduleNextRequest() {
    if (this.reqTimer) return
    const q = Math.min(Math.max(this.opts.qualityLevel ?? 5, 0), 9)
    const delay = Math.max(0, 250 - q * 28) // 0→250ms, 9→0ms
    this.reqTimer = setTimeout(() => {
      this.reqTimer = null
      if (this.state === State.Running) this.requestFramebufferUpdate(true)
    }, delay)
  }

  private requestFramebufferUpdate(incremental: boolean) {
    const msg = new Uint8Array(10)
    msg[0] = 3
    msg[1] = incremental ? 1 : 0
    set16(msg, 2, 0)
    set16(msg, 4, 0)
    set16(msg, 6, this.fbW)
    set16(msg, 8, this.fbH)
    this.sendRaw(msg)
  }

  // ================= 输入事件（客户端发送） =================

  sendPointer(x: number, y: number, mask: number) {
    if (this.state !== State.Running || this.opts.viewOnly) return
    this.pointerState = mask
    const msg = new Uint8Array(6)
    msg[0] = 5
    msg[1] = mask & 0xff
    set16(msg, 2, Math.max(0, Math.min(x, 65535)))
    set16(msg, 4, Math.max(0, Math.min(y, 65535)))
    this.sendRaw(msg)
  }

  get pointerMask() {
    return this.pointerState
  }

  sendKey(keysym: number, down: boolean) {
    if (this.state !== State.Running || this.opts.viewOnly) return
    const msg = new Uint8Array(8)
    msg[0] = 4
    msg[1] = down ? 1 : 0
    set32(msg, 4, keysym)
    this.sendRaw(msg)
  }

  // ================= 剪贴板（QEMU 扩展 + 经典降级） =================

  async sendClipboard(text: string): Promise<"extended" | "classic" | "failed"> {
    if (this.state !== State.Running || this.opts.viewOnly) return "failed"
    const sliced = text.slice(0, 5000)
    if (!sliced) return "failed"
    // 扩展通道：zlib(u32 size + utf8 + \0)
    if (typeof CompressionStream !== "undefined") {
      try {
        const body = new Uint8Array(4 + new TextEncoder().encode(sliced).length + 1)
        set32(body, 0, new TextEncoder().encode(sliced).length + 1)
        body.set(new TextEncoder().encode(sliced), 4)
        const compressed = await deflateZlib(body)
        this.sendExtClipboard(CLIP_ACTION_PROVIDE, CLIP_FORMAT_TEXT, compressed)
        return "extended"
      } catch {
        /* 降级经典 */
      }
    }
    // 经典通道（latin1 安全子集才可用，否则失败由平台中转通道兜底）
    if (/^[\x00-\xff]*$/.test(sliced)) {
      const bytes = new Uint8Array(sliced.length)
      for (let i = 0; i < sliced.length; i++) bytes[i] = sliced.charCodeAt(i) & 0xff
      const msg = new Uint8Array(8 + bytes.length)
      msg[0] = 6
      set32(msg, 4, bytes.length)
      msg.set(bytes, 8)
      this.sendRaw(msg)
      return "classic"
    }
    return "failed"
  }

  requestRemoteClipboard() {
    // 服务端有内容时触发 Provide 回传
    this.sendExtClipboard(CLIP_ACTION_REQUEST, CLIP_FORMAT_TEXT, new Uint8Array(0))
  }

  private sendExtClipboard(action: number, formats: number, payload: Uint8Array) {
    if (this.state !== State.Running && action !== CLIP_ACTION_CAPS) return
    const data = new Uint8Array(4 + payload.length)
    set32(data, 0, (action | formats) >>> 0)
    data.set(payload, 4)
    const msg = new Uint8Array(8 + data.length)
    msg[0] = 6
    set32s(msg, 4, -data.length) // 负长度 = 扩展消息
    msg.set(data, 8)
    this.sendRaw(msg)
  }

  private handleExtClipboard(data: Uint8Array) {
    if (data.length < 4) return
    const flags = view32(data, 0)
    const action = flags & 0xff000000
    const formats = flags & 0xffff
    const payload = data.subarray(4)
    if ((action & CLIP_ACTION_PROVIDE) !== 0 && (formats & CLIP_FORMAT_TEXT) !== 0) {
      // 服务端提供文本：zlib 解压 → u32 size + utf8
      inflateZlib(payload)
        .then((raw) => {
          if (raw.length < 4) return
          const size = Math.min(view32(raw, 0), raw.length - 4)
          const text = utf8(raw.subarray(4, 4 + size)).replace(/\0+$/, "")
          if (text) this.opts.onClipboard?.(text)
        })
        .catch(() => { /* 解压失败忽略 */ })
    } else if ((action & CLIP_ACTION_NOTIFY) !== 0 && (formats & CLIP_FORMAT_TEXT) !== 0) {
      // 服务端宣告有内容 → 主动请求
      this.sendExtClipboard(CLIP_ACTION_REQUEST, CLIP_FORMAT_TEXT, new Uint8Array(0))
    }
    // CAPS / REQUEST / PEEK：无需处理（请求已由 NOTIFY 驱动）
  }

  // ================= 生命周期 =================

  get qualityLevel() {
    return this.opts.qualityLevel ?? 5
  }

  set qualityLevel(q: number) {
    this.opts.qualityLevel = Math.min(Math.max(q, 0), 9)
    if (this.reqTimer) {
      clearTimeout(this.reqTimer)
      this.reqTimer = null
      this.scheduleNextRequest()
    }
  }

  get serverInfo() {
    return { width: this.fbW, height: this.fbH }
  }

  disconnect() {
    this.manualClose = true
    this.finish("客户端主动断开")
  }

  private finish(reason: string) {
    if (this.state === State.Closed) return
    this.state = State.Closed
    if (this.reqTimer) clearTimeout(this.reqTimer)
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.reqTimer = null
    this.keepaliveTimer = null
    this.zlibStreams.clear()
    try { if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close() } catch { /* noop */ }
    this.opts.onDisconnected?.(this.manualClose ? "手动断开" : reason)
  }

  private sendRaw(data: Uint8Array) {
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.telemetry.bytesOut += data.byteLength
    try { this.ws.send(data) } catch { /* 竞态忽略 */ }
  }
}

// ================= 二进制工具 =================

function view16(b: Uint8Array, off: number): number {
  return (b[off] << 8) | b[off + 1]
}
function view32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
}
function view32s(b: Uint8Array, off: number): number {
  const u = view32(b, off)
  return u >= 0x80000000 ? u - 0x100000000 : u
}
function set16(b: Uint8Array, off: number, v: number) {
  b[off] = (v >> 8) & 0xff
  b[off + 1] = v & 0xff
}
function set32(b: Uint8Array, off: number, v: number) {
  b[off] = (v >>> 24) & 0xff
  b[off + 1] = (v >>> 16) & 0xff
  b[off + 2] = (v >>> 8) & 0xff
  b[off + 3] = v & 0xff
}
function set32s(b: Uint8Array, off: number, v: number) {
  set32(b, off, v < 0 ? v + 0x100000000 : v)
}
function ascii(b: Uint8Array): string {
  let s = ""
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}
function utf8(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b)
  } catch {
    return ascii(b)
  }
}

// zlib（RFC1950）压缩/解压：浏览器原生流（write/close 全程 await，异常可捕获降级）
async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate")
  const writer = cs.writable.getWriter()
  const writeP = writer.write(data as unknown as BufferSource).then(() => writer.close())
  const chunks: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  await writeP.catch(() => { /* 关闭竞态：数据已完整读出即可 */ })
  const total = chunks.reduce((a, c) => a + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate")
  const writer = ds.writable.getWriter()
  const writeP = writer.write(data as unknown as BufferSource).then(() => writer.close())
  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  await writeP.catch(() => { /* 关闭竞态：数据已完整读出即可 */ })
  const total = chunks.reduce((a, c) => a + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}
