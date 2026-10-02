// ============================================================
// Dockyard VNC 网关桥（HelmPort Bridge）
// 职责：浏览器端 WebSocket ←→ 远程浏览器容器 RFB(TCP) 双向转发
//   - 单域名统一网关：经平台反向代理（?XTransformPort=3005）或独立端口
//   - 票据鉴权：HMAC-SHA256 签名 + 60s 有效期 + 单次使用（nonce 防重放）
//   - 只读票据：服务端丢弃键鼠/剪贴板输入帧（纵深防御，双保险）
//   - 模拟模式：内置 RFB 3.8 演示帧缓冲引擎（无 Docker 环境全链路可验证）
//   - 统计：每会话 帧数/字节/键鼠事件/剪贴板回环
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto"
import { deflateSync, inflateSync, constants as zconst } from "node:zlib"
import net from "node:net"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

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

const PORT = Number(process.env.VNC_BRIDGE_PORT || 3005)
// 绑定地址：默认回环（对外经统一网关嵌入）；VNC_BRIDGE_PUBLIC=port 时由 start.sh 注入 0.0.0.0 直连
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1"
const SECRET = process.env.VNC_BRIDGE_SECRET || "dockyard-dev-vnc-secret"
const DEMO_W = 640
const DEMO_H = 400
const FRAME_MS = 500 // 演示帧率：2fps 全帧 raw
const BAND_ROWS = 100 // 每条矩形带 100 行 → 单消息 256KB，规避 WS 单消息上限

// ---- RFB 多监视器布局（SetDesktopSize / ExtendedDesktopSize）----
interface ScreenLayout { id: number; x: number; y: number; w: number; h: number; flags: number }
const ENC_EDS = -308 // ExtendedDesktopSize 伪编码

function layoutEqual(a: ScreenLayout[], b: ScreenLayout[]): boolean {
  return a.length === b.length && a.every((s, i) => s.x === b[i].x && s.y === b[i].y && s.w === b[i].w && s.h === b[i].h && s.id === b[i].id)
}

// ---------------- 票据 ----------------
// ticket = b64url(payloadJson) + "." + b64url(hmac(payloadB64))
// payload: { v: workspaceId, ro: 0|1, exp: epochSec, dur: 秒(连接最大存活时长, 0=不限), n: nonce, tgt: {k:"demo"} | {k:"tcp",h,p} }
// 语义：exp = 取票→建连窗口（60s，单次防重放）；dur = 会话连接总时长上限（三级策略下发，0=默认不限）

type DialTarget = { k: "demo" } | { k: "tcp"; h: string; p: number }
interface TicketPayload { v: string; ro: 0 | 1; exp: number; dur: number; n: string; tgt: DialTarget }

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/")
  while (s.length % 4 !== 0) s += "="
  return Buffer.from(s, "base64")
}
export function signTicket(p: TicketPayload, secret = SECRET): string {
  const payloadB = Buffer.from(JSON.stringify(p), "utf8")
  const payloadB64 = b64url(payloadB)
  const sig = b64url(createHmac("sha256", secret).update(payloadB64).digest())
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
  } catch {
    return null
  }
  const got = b64urlDecode(sig)
  const expectBuf = Buffer.from(expect)
  const gotBuf = Buffer.from(got)
  if (gotBuf.length !== expectBuf.length || !timingSafeEqual(gotBuf, expectBuf)) return null
  let p: TicketPayload
  try {
    p = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as TicketPayload
  } catch {
    return null
  }
  if (typeof p.exp !== "number" || p.exp * 1000 < Date.now()) return null
  if (!p.v || !p.tgt) return null
  if (usedNonces.has(p.n)) return null // 单次使用：防重放
  usedNonces.set(p.n, p.exp)
  return p
}

// ---------------- 会话时长上限（服务端强制执行，纵深防御） ----------------
// dur=0 → 不限；dur>0 → 连接存活超过该秒数即断开（先提示后断）
function sessionDeadline(dur: number): number {
  return dur > 0 ? Date.now() + dur * 1000 : 0
}
const SESSION_LIMIT_NOTICE_MS = 1500 // 断开前提示驻留时间
function sessionLimitNoticeText(dur: number): string {
  return `[HelmPort] 会话时长已达策略上限（${Math.round(dur / 60)} 分钟），连接即将断开`
}
const usedNonces = new Map<string, number>()
setInterval(() => {
  const now = Date.now() / 1000
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n)
}, 30_000).unref?.()

// ---------------- 会话统计 ----------------
interface SessStats {
  frames: number; bytesIn: number; bytesOut: number
  keys: number; pointers: number; clipRt: number
  clients: number; startedAt: number; lastAt: number; mode: "demo" | "tcp"
}
const statsByWs = new Map<string, SessStats>()
function statOf(v: string, mode: "demo" | "tcp"): SessStats {
  let s = statsByWs.get(v)
  if (!s) {
    s = { frames: 0, bytesIn: 0, bytesOut: 0, keys: 0, pointers: 0, clipRt: 0, clients: 0, startedAt: Date.now(), lastAt: Date.now(), mode }
    statsByWs.set(v, s)
  }
  s.clients++
  return s
}

// ============================================================
// 演示 RFB 引擎：RFB 3.8 / raw 编码 / 键鼠回显 / 剪贴板回环
// 剪贴板沙箱隔离：remoteClipboard 为本实例私有字段 —— 每条连接一个独立实例，
// 天然逐会话隔离；不同沙箱 / 同一沙箱不同连接之间互不可见（跨连接不共享）。
// 平台层另有中转审计通道归属校验（vnc-proxy/clipboard 按工作区 + 会话身份校验）。
// ============================================================

// 3x5 点阵字体（数字与基础符号 —— 仅演示帧缓冲使用）
const FONT3x5: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "011", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ":": ["000", "010", "000", "010", "000"],
  ".": ["000", "000", "000", "000", "010"],
  "-": ["000", "000", "111", "000", "000"],
  " ": ["000", "000", "000", "000", "000"],
}

// 品牌锚形徽标 16x16
const LOGO_ROWS = [
  "................",
  "......####......",
  "......#..#......",
  "......#..#......",
  "..############..",
  "..#...#..#...#..",
  "..#...#..#...#..",
  "..#...#..#...#..",
  "...#..#..#..#...",
  "....#.#..#.#....",
  ".....##..##.....",
  "......####......",
  "......#..#......",
  "......####......",
  "................",
  "................",
]

// ---- QEMU 扩展剪贴板协议常量（与 noVNC 对齐：UTF-8 中文全字符支持）----
const CLIP_FORMAT_TEXT = 1
const CLIP_ACTION_CAPS = 1 << 24
const CLIP_ACTION_REQUEST = 1 << 25
const CLIP_ACTION_PEEK = 1 << 26
const CLIP_ACTION_NOTIFY = 1 << 27
const CLIP_ACTION_PROVIDE = 1 << 28

function u32be(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0, 0)
  return b
}

class DemoRfbSession {
  private buf = Buffer.alloc(0)
  private closed = false
  private pending = false
  private lastSendAt = 0
  private hsStage = 0 // 握手状态：0=待版本 1=待安全类型选择 2=待共享标志 3=协议消息
  private W = DEMO_W // 帧缓冲宽（多监视器总宽，SetDesktopSize 可变）
  private H = DEMO_H // 帧缓冲高
  private screens: ScreenLayout[] = [{ id: 0, x: 0, y: 0, w: DEMO_W, h: DEMO_H, flags: 0 }]
  private clientWantsEds = false // 客户端已请求 ExtendedDesktopSize 伪编码
  private edsAnnounced = false // 初始布局已宣告
  private fb = new Uint8Array(DEMO_W * DEMO_H * 4)
  private ptr = { x: DEMO_W / 2, y: DEMO_H / 2, active: false }
  private blooms: { x: number; y: number; r: number; hue: number; age: number }[] = []
  private keysTotal = 0
  private pointersTotal = 0
  private resizes = 0
  private remoteClipboard: string | null = null // 本连接私有（沙箱内逐会话隔离，绝不跨连接共享）
  private deadline: number // 会话时长上限截止（0=不限）
  private durSec: number // 原始时长（提示文案用）
  private limitNotified = false
  private timer: ReturnType<typeof setInterval>
  constructor(
    private ws: { send(data: Uint8Array): void; close(): void },
    private readonly: boolean,
    private stats: SessStats,
    sessionDurSec = 0, // 会话最大存活时长（秒，0=不限；票据三级策略下发）
  ) {
    this.durSec = sessionDurSec > 0 ? sessionDurSec : 0
    this.deadline = sessionDeadline(sessionDurSec)
    this.timer = setInterval(() => this.tick(), FRAME_MS)
    this.timer.unref?.()
    // 1. 版本协商：服务端宣告 RFB 003.008
    this.ws.send(Buffer.from("RFB 003.008\n", "ascii"))
  }

  onData(chunk: Buffer) {
    if (this.closed) return
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    if (this.buf.length > 512 * 1024) return this.ws.close() // 异常超大输入 → 断开
    this.pumpHandshake()
    if (this.closed || this.hsStage !== 3) return
    this.pump()
  }

  // ---- RFB 3.8 接收侧握手状态机 ----
  private pumpHandshake() {
    if (this.hsStage === 0) {
      if (this.buf.length < 12) return
      this.buf = this.buf.subarray(12) // 客户端版本（内容不校验，以服务端宣告为准）
      this.ws.send(Buffer.from([1, 1])) // 安全类型数量1：None(1)
      this.hsStage = 1
    }
    if (this.hsStage === 1) {
      if (this.buf.length < 1) return
      const choice = this.buf[0]
      this.buf = this.buf.subarray(1)
      if (choice !== 1) { this.closed = true; return this.ws.close() } // 仅支持 None
      const r = Buffer.alloc(4)
      r.writeUInt32BE(0, 0) // 安全结果 OK
      this.ws.send(r)
      this.hsStage = 2
    }
    if (this.hsStage === 2) {
      if (this.buf.length < 1) return
      this.buf = this.buf.subarray(1) // ClientInit shared 标志（忽略，恒共享）
      this.hsStage = 3
      this.sendServerInit()
    }
  }

  private sendServerInit() {
    const name = Buffer.from("Dockyard HelmPort · Isolated Sandbox Framebuffer", "utf8")
    const head = Buffer.alloc(24)
    head.writeUInt16BE(this.W, 0)
    head.writeUInt16BE(this.H, 2)
    // PixelFormat(16B)：32bpp / depth24 / LE / trueColor / max255×3 / shift16,8,0
    head.writeUInt8(32, 4); head.writeUInt8(24, 5); head.writeUInt8(0, 6); head.writeUInt8(1, 7)
    head.writeUInt16BE(255, 8); head.writeUInt16BE(255, 10); head.writeUInt16BE(255, 12)
    head.writeUInt8(16, 14); head.writeUInt8(8, 15); head.writeUInt8(0, 16)
    head.writeUInt32BE(name.length, 20)
    this.ws.send(Buffer.concat([head, name]))
    this.stats.lastAt = Date.now()
    // 宣告扩展剪贴板能力：Text 格式 + 服务端支持的全部动作
    // （Caps/Request/Notify/Provide —— 客户端据此走扩展通道：UTF-8 全字符 + zlib）
    this.sendExtCut(CLIP_ACTION_CAPS | CLIP_ACTION_REQUEST | CLIP_ACTION_PEEK | CLIP_ACTION_NOTIFY | CLIP_ACTION_PROVIDE, CLIP_FORMAT_TEXT, u32be(0))
  }

  // ---- 扩展剪贴板：服务端→客户端 ServerCutText(extended) ----
  private sendExtCut(action: number, formats: number, payload: Buffer) {
    const data = Buffer.concat([u32be(action | formats), payload])
    const head = Buffer.alloc(8)
    head.writeUInt8(3, 0) // ServerCutText
    head.writeInt32BE(-data.length, 4) // 负长度 = 扩展消息
    this.ws.send(Buffer.concat([head, data]))
  }

  // 服务端→客户端提供文本（触发客户端 clipboard 事件回显）
  private sendExtProvide(text: string) {
    const utf8 = Buffer.from(text + "\0", "utf8")
    const body = Buffer.concat([u32be(utf8.length), utf8])
    this.sendExtCut(CLIP_ACTION_PROVIDE, CLIP_FORMAT_TEXT, deflateSync(body))
  }

  private pump() {
    while (!this.closed && this.buf.length > 0) {
      const t = this.buf[0]
      if (t === 0) { // SetPixelFormat: 1 + 3pad + 16 + 3pad
        if (this.buf.length < 20) return
        this.buf = this.buf.subarray(20)
      } else if (t === 2) { // SetEncodings: 1 + 1pad + 2 + 4n
        if (this.buf.length < 4) return
        const n = this.buf.readUInt16BE(2)
        const need = 4 + 4 * n
        if (this.buf.length < need) return
        for (let i = 0; i < n; i++) {
          if (this.buf.readInt32BE(4 + 4 * i) === ENC_EDS) this.clientWantsEds = true
        }
        this.buf = this.buf.subarray(need)
        // 客户端请求 EDS 伪编码 → 宣告当前屏幕布局（含多监视器）
        if (this.clientWantsEds && !this.edsAnnounced) {
          this.edsAnnounced = true
          this.sendExtDesktopSize(0, this.W, this.H, this.screens)
        }
      } else if (t === 3) { // FramebufferUpdateRequest: 10
        if (this.buf.length < 10) return
        this.buf = this.buf.subarray(10)
        this.pending = true
      } else if (t === 4) { // KeyEvent: 1 + 1down + 2pad + 4keysym
        if (this.buf.length < 8) return
        const down = this.buf[1] === 1
        const keysym = this.buf.readUInt32BE(4)
        this.buf = this.buf.subarray(8)
        if (!this.readonly && down) {
          this.keysTotal++
          this.stats.keys++
          this.blooms.push({ x: 60 + Math.random() * (this.W - 120), y: 80 + Math.random() * (this.H - 160), r: 2, hue: (keysym * 47) % 360, age: 0 })
          if (this.blooms.length > 24) this.blooms.shift()
          this.kick()
        }
      } else if (t === 5) { // PointerEvent: 1mask + 2x + 2y
        if (this.buf.length < 6) return
        const x = this.buf.readUInt16BE(2)
        const y = this.buf.readUInt16BE(4)
        this.buf = this.buf.subarray(6)
        if (!this.readonly) {
          this.ptr = { x: Math.min(x, this.W - 1), y: Math.min(y, this.H - 1), active: true }
          this.pointersTotal++
          this.stats.pointers++
          this.kick()
        }
      } else if (t === 8) { // SetDesktopSize: 1 + 2w + 2h + 1n + 1pad + 16n（多监视器分辨率切换）
        if (this.buf.length < 7) return
        const w = this.buf.readUInt16BE(1)
        const h = this.buf.readUInt16BE(3)
        const n = this.buf[5]
        const need = 7 + 16 * n
        if (this.buf.length < need) return
        const screens: ScreenLayout[] = []
        for (let i = 0; i < n; i++) {
          const base = 7 + 16 * i
          screens.push({
            id: this.buf.readUInt32BE(base),
            x: this.buf.readUInt16BE(base + 4),
            y: this.buf.readUInt16BE(base + 6),
            w: this.buf.readUInt16BE(base + 8),
            h: this.buf.readUInt16BE(base + 10),
            flags: this.buf.readUInt32BE(base + 12),
          })
        }
        this.buf = this.buf.subarray(need)
        this.applyDesktopSize(w, h, screens)
      } else if (t === 6) { // ClientCutText：经典(latin1) 与 扩展(UTF-8+zlib) 双通道
        if (this.buf.length < 8) return
        const cutLen = this.buf.readInt32BE(4)
        if (cutLen >= 0) {
          // 经典：text 为 latin1（noVNC 兼容路径）
          if (cutLen > 8192) return this.ws.close()
          if (this.buf.length < 8 + cutLen) return
          const text = this.buf.subarray(8, 8 + cutLen).toString("utf8")
          this.buf = this.buf.subarray(8 + cutLen)
          if (!this.readonly && text) {
            this.stats.clipRt++
            const reply = Buffer.from(`[HelmPort] 已收到 ${text.length} 字符: ${text.slice(0, 64)}`, "utf8")
            const head = Buffer.alloc(8)
            head.writeUInt8(3, 0) // ServerCutText
            head.writeUInt32BE(reply.length, 4)
            this.ws.send(Buffer.concat([head, reply]))
          }
        } else {
          // 扩展：负长度 → data = flags(4B) + payload(zlib)
          const dataLen = -cutLen
          if (dataLen > 65536) return this.ws.close()
          if (this.buf.length < 8 + dataLen) return
          const data = this.buf.subarray(8, 8 + dataLen)
          this.buf = this.buf.subarray(8 + dataLen)
          if (!this.readonly && data.length >= 4) {
            const flags = data.readUInt32BE(0)
            const actions = flags & 0xff000000
            const formats = flags & 0xffff
            const payload = Buffer.from(data.subarray(4))
            if (actions === CLIP_ACTION_PROVIDE && formats & CLIP_FORMAT_TEXT) {
              // 客户端提交文本（UTF-8 + zlib）：解压 → 回显服务端 Provide
              // noVNC/pako 使用 Z_FULL_FLUSH 流（无终止块）→ finishFlush 到同步边界
              try {
                const raw = inflateSync(payload, { finishFlush: zconst.Z_SYNC_FLUSH })
                if (raw.length >= 4) {
                  const size = Math.min(raw.readUInt32BE(0), raw.length - 4)
                  const text = raw.subarray(4, 4 + size).toString("utf8").replace(/\0+$/, "")
                  if (text) {
                    this.stats.clipRt++
                    this.remoteClipboard = text
                    this.sendExtProvide(`[HelmPort] 已收到 ${text.length} 字符: ${text.slice(0, 128)}`)
                  }
                }
              } catch { /* zlib 解压失败：忽略 */ }
            } else if (actions === CLIP_ACTION_NOTIFY && formats & CLIP_FORMAT_TEXT) {
              // 客户端宣告有文本 → 请求提供
              this.sendExtCut(CLIP_ACTION_REQUEST, CLIP_FORMAT_TEXT, Buffer.alloc(0))
            } else if (actions === CLIP_ACTION_PEEK) {
              if (this.remoteClipboard) this.sendExtCut(CLIP_ACTION_NOTIFY, CLIP_FORMAT_TEXT, Buffer.alloc(0))
            } else if (actions === CLIP_ACTION_REQUEST) {
              if (this.remoteClipboard) this.sendExtProvide(this.remoteClipboard)
            }
            // Caps（客户端能力宣告）：连接时已协商，无需响应
          }
        }
      } else {
        return this.ws.close() // 未知消息类型：协议错误
      }
    }
  }

  private kick() {
    if (this.hsStage !== 3) return
    if (Date.now() - this.lastSendAt > 150) this.sendFrame()
  }

  // ---- 多监视器分辨率切换（SetDesktopSize 处理 + ExtendedDesktopSize 响应）----
  // 校验：200≤W≤3840 / 200≤H≤2160 / 1-4 屏，屏均在帧缓冲范围内且尺寸合理
  private applyDesktopSize(w: number, h: number, screens: ScreenLayout[]) {
    if (this.readonly) {
      // 只读会话：服务端拒绝调整（result=1 PROHIBITED），回送当前布局
      this.sendExtDesktopSize(1, this.W, this.H, this.screens)
      return
    }
    const valid =
      w >= 200 && w <= 3840 && h >= 200 && h <= 2160 &&
      screens.length >= 1 && screens.length <= 4 &&
      screens.every((s) => s.w >= 200 && s.h >= 200 && s.x >= 0 && s.y >= 0 && s.x + s.w <= w && s.y + s.h <= h)
    if (!valid) {
      this.sendExtDesktopSize(2, this.W, this.H, this.screens) // INVALID：回送当前布局
      return
    }
    const changed = w !== this.W || h !== this.H || !layoutEqual(screens, this.screens)
    this.W = w
    this.H = h
    this.screens = screens
    this.resizes++
    this.fb = new Uint8Array(w * h * 4)
    this.ptr = { x: Math.round(w / 2), y: Math.round(h / 2), active: this.ptr.active }
    this.blooms = []
    // 响应：result=0 + 新布局（客户端据此重设画布并全量重绘）
    this.sendExtDesktopSize(0, w, h, screens)
    if (changed) {
      this.pending = true
      this.sendFrame() // 立即按新尺寸出帧
    }
  }

  // FramebufferUpdate 包裹的 ExtendedDesktopSize 矩形：
  // rect.x=结果码 rect.y=0 rect.w/h=帧缓冲尺寸 encoding=-308 负载=1B屏数+3B填充+16B/屏
  private sendExtDesktopSize(result: number, w: number, h: number, screens: ScreenLayout[]) {
    if (this.closed) return
    const payload = Buffer.alloc(4 + 16 * screens.length)
    payload.writeUInt8(screens.length, 0)
    screens.forEach((s, i) => {
      const base = 4 + 16 * i
      payload.writeUInt32BE(s.id, base)
      payload.writeUInt16BE(s.x, base + 4)
      payload.writeUInt16BE(s.y, base + 6)
      payload.writeUInt16BE(s.w, base + 8)
      payload.writeUInt16BE(s.h, base + 10)
      payload.writeUInt32BE(s.flags, base + 12)
    })
    const head = Buffer.alloc(16)
    head.writeUInt8(0, 0) // FramebufferUpdate
    head.writeUInt16BE(1, 2) // numRects = 1
    head.writeUInt16BE(result, 4) // x = 结果码（0=成功 1=禁止 2=无效 3=资源不足）
    head.writeUInt16BE(0, 6) // y = 0
    head.writeUInt16BE(w, 8)
    head.writeUInt16BE(h, 10)
    head.writeInt32BE(ENC_EDS, 12)
    this.ws.send(Buffer.concat([head, payload]))
    this.stats.lastAt = Date.now()
  }

  private tick() {
    if (this.closed || this.hsStage !== 3) return
    // 会话时长上限强制（服务端纵深防御：到期先提示后断开，与客户端倒计时双保险）
    if (this.deadline > 0 && Date.now() >= this.deadline) {
      if (!this.limitNotified) {
        this.limitNotified = true
        const notice = Buffer.from(sessionLimitNoticeText(this.durSec), "utf8")
        const head = Buffer.alloc(8)
        head.writeUInt8(3, 0) // ServerCutText：提示断开原因（可在画面上感知）
        head.writeUInt32BE(notice.length, 4)
        this.ws.send(Buffer.concat([head, notice]))
        setTimeout(() => this.close(), SESSION_LIMIT_NOTICE_MS)
      }
      return
    }
    if (this.pending || (this.lastSendAt > 0 && Date.now() - this.lastSendAt > 2500)) this.sendFrame()
  }
  private sendFrame() {
    if (this.closed) return
    this.pending = false
    this.render(Date.now())
    const W = this.W, H = this.H
    for (let y = 0; y < H; y += BAND_ROWS) {
      const h = Math.min(BAND_ROWS, H - y)
      const head = Buffer.alloc(12)
      head.writeUInt8(0, 0) // FramebufferUpdate
      head.writeUInt16BE(1, 2) // 1 rect
      head.writeUInt16BE(0, 4) // x
      head.writeUInt16BE(y, 6) // y
      head.writeUInt16BE(W, 8) // w
      head.writeUInt16BE(h, 10) // h
      // 编码 int32 BE 0 (raw) 追加在 rect 头后
      const enc = Buffer.alloc(4)
      enc.writeInt32BE(0, 0)
      const data = Buffer.from(this.fb.buffer, this.fb.byteOffset + y * W * 4, W * h * 4)
      const msg = Buffer.concat([head, enc, data])
      this.ws.send(new Uint8Array(msg))
    }
    this.lastSendAt = Date.now()
    this.stats.frames++
    this.stats.lastAt = Date.now()
  }

  // ---- 演示帧渲染（支持多监视器布局：每屏边界高亮 + 屏号与分辨率标注）----
  private render(t: number) {
    const fb = this.fb
    const W = this.W, H = this.H
    const put = (i: number, r: number, g: number, b: number) => {
      fb[i] = b; fb[i + 1] = g; fb[i + 2] = r // LE: (r<<16)|(g<<8)|b → 字节序 B,G,R,0
    }
    // 1) 深色渐变底
    for (let y = 0; y < H; y++) {
      const k = y / H
      const r = Math.round(10 + 8 * k), g = Math.round(20 + 14 * k), b = Math.round(26 + 18 * k)
      for (let x = 0; x < W; x++) put((y * W + x) * 4, r, g, b)
    }
    // 2) 流动对角光带 ×2
    const bands = [{ speed: 0.06, width: 60, off: 0 }, { speed: -0.04, width: 36, off: 300 }]
    for (const bd of bands) {
      const pos = (t * bd.speed + bd.off) % (W + H + 600)
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const d = Math.abs(x + y - pos)
          if (d < bd.width) {
            const f = (1 - d / bd.width) * 0.22
            const i = (y * W + x) * 4
            put(i, Math.min(255, fb[i + 2] + 255 * f * 0.3), Math.min(255, fb[i + 1] + 255 * f), Math.min(255, fb[i] + 255 * f * 0.5))
          }
        }
      }
    }
    // 3) 网格（每屏内独立网格）
    for (const scr of this.screens) {
      const sw = Math.max(1, scr.w), sh = Math.max(1, scr.h)
      for (let y = scr.y; y < scr.y + sh; y += 40) for (let x = scr.x; x < scr.x + sw; x++) { if (y < H && x < W) { const i = (y * W + x) * 4; put(i, fb[i + 2] + 6, fb[i + 1] + 10, fb[i] + 10) } }
      for (let x = scr.x; x < scr.x + sw; x += 40) for (let y = scr.y; y < scr.y + sh; y++) { if (y < H && x < W) { const i = (y * W + x) * 4; put(i, fb[i + 2] + 6, fb[i + 1] + 10, fb[i] + 10) } }
    }
    // 4) 顶部状态条（整幅）
    for (let y = 0; y < 30; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      put(i, 6, 12, 16)
    }
    for (let x = 0; x < W; x++) put((29 * W + x) * 4, 20, 240, 190) // 顶部亮线
    // 5) 时钟 + 分辨率 + 屏数（3x5 字体 ×2）
    const d = new Date()
    const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0")
    this.text(`${hh}:${mm}:${ss}`, 12, 8, 2, 94, 244, 212)
    this.text(`M${this.screens.length} ${W}x${H}`, 150, 8, 2, 120, 200, 255)
    // 6) 中央品牌锚标（16x16 ×6）—— 居中于主屏（屏 0）
    const main = this.screens[0]
    const scale = 6, lw = 16
    const cx = Math.round(main.x + main.w / 2 - (lw * scale) / 2)
    const cy = Math.round(main.y + main.h / 2 - (lw * scale) / 2) - 10
    for (let r = 0; r < lw; r++) for (let c = 0; c < lw; c++) {
      if (LOGO_ROWS[r][c] !== "#") continue
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = ((cy + r * scale + dy) * W + (cx + c * scale + dx)) * 4
        if (i > 0 && i < fb.length - 3) put(i, 32, 225, 178)
      }
    }
    // 7) 底部计数条（整幅）
    for (let y = H - 26; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; put(i, 5, 9, 12) }
    this.text(`${this.keysTotal}-${this.pointersTotal}-${this.stats.frames}-R${this.resizes}`, 12, H - 16, 1, 130, 160, 155)
    // 8) 按键绽放环
    for (const bl of this.blooms) {
      bl.r += 1.6; bl.age++
      const rr = Math.round(bl.r), thick = 2
      const [br, bg] = hslToRgb(bl.hue / 360, 0.75, 0.6)
      for (let a = 0; a < 360; a += 3) {
        const px = Math.round(bl.x + rr * Math.cos((a * Math.PI) / 180))
        const py = Math.round(bl.y + rr * Math.sin((a * Math.PI) / 180))
        for (let t2 = 0; t2 < thick; t2++) {
          const i = ((py + t2) * W + px) * 4
          if (px >= 0 && px < W && py >= 0 && py < H && i < fb.length - 3) put(i, br, bg, 200)
        }
      }
    }
    this.blooms = this.blooms.filter((b) => b.r < 90)
    // 9) 指针十字准星
    if (this.ptr.active) {
      const { x, y } = this.ptr
      for (let dx = -6; dx <= 6; dx++) {
        if (Math.abs(dx) < 2) continue
        const i = (y * W + Math.min(W - 1, Math.max(0, x + dx))) * 4
        if (i >= 0 && i < fb.length - 3) put(i, 240, 250, 255)
      }
      for (let dy = -6; dy <= 6; dy++) {
        if (Math.abs(dy) < 2) continue
        const py = Math.min(H - 1, Math.max(0, y + dy))
        const i = (py * W + x) * 4
        if (i >= 0 && i < fb.length - 3) put(i, 240, 250, 255)
      }
      const i = (y * W + x) * 4
      put(i, 30, 235, 185)
    }
    // 10) 多监视器边界高亮 + 每屏标签（M1/M2/... + 分辨率）
    this.screens.forEach((scr, idx) => {
      const hue = (idx * 57) % 360
      const [er, eg] = hslToRgb(hue / 360, 0.8, 0.62)
      // 边框（3px 亮色 + 内侧 1px 暗色）
      const border = (bx: number, by: number) => {
        if (bx < 0 || bx >= W || by < 0 || by >= H) return
        const i = (by * W + bx) * 4
        if (i < fb.length - 3) put(i, er, eg, 210)
      }
      for (let x = scr.x; x < scr.x + scr.w; x++) { border(x, scr.y); border(x, scr.y + 1); border(x, scr.y + 2); border(x, scr.y + scr.h - 1) }
      for (let y = scr.y; y < scr.y + scr.h; y++) { border(scr.x, y); border(scr.x + 1, y); border(scr.x + 2, y); border(scr.x + scr.w - 1, y) }
      // 屏标签（左上角徽章底 + 文字）
      const label = `M${idx + 1} ${scr.w}x${scr.h}`
      const lw2 = label.length * 4 * 2 + 8
      for (let y = scr.y + 40; y < scr.y + 40 + 18; y++) for (let x = scr.x + 40; x < scr.x + 40 + lw2; x++) {
        if (x < W && y < H) { const i = (y * W + x) * 4; if (i < fb.length - 3) put(i, 8, 16, 20) }
      }
      this.text(label, scr.x + 44, scr.y + 45, 2, er, eg, 220)
    })
  }
  private text(s: string, x0: number, y0: number, scale: number, r: number, g: number, b: number) {
    const fb = this.fb, W = this.W, H = this.H
    let x = x0
    for (const ch of s) {
      const glyph = FONT3x5[ch] || FONT3x5[" "]
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== "1") continue
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
          const px = x + gx * scale + sx, py = y0 + gy * scale + sy
          if (px < 0 || px >= W || py < 0 || py >= H) continue
          const i = (py * W + px) * 4
          fb[i] = b; fb[i + 1] = g; fb[i + 2] = r
        }
      }
      x += 4 * scale
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))))
  }
  return [f(0), f(8), f(4)]
}

// ---------------- TCP 会话（真实容器 RFB 转发） ----------------
class TcpSession {
  private socket: net.Socket | null = null
  private closed = false
  private deadline: number
  private limitTimer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private ws: { send(data: Uint8Array): void; close(): void },
    target: { h: string; p: number },
    private stats: SessStats,
    sessionDurSec = 0, // 会话最大存活时长（秒，0=不限）
  ) {
    this.deadline = sessionDeadline(sessionDurSec)
    if (this.deadline > 0) {
      this.limitTimer = setTimeout(() => {
        // 到期：直接断开（TCP 透传无法注入提示帧，客户端倒计时负责友好提示）
        this.close()
      }, this.deadline - Date.now())
      this.limitTimer.unref?.()
    }
    this.socket = net.createConnection({ host: target.h, port: target.p })
    this.socket.setTimeout(8000, () => {
      this.close()
    })
    this.socket.on("connect", () => {
      this.socket?.setTimeout(0)
      this.stats.lastAt = Date.now()
    })
    this.socket.on("data", (d: Buffer) => {
      this.stats.bytesOut += d.length
      this.stats.lastAt = Date.now()
      try { this.ws.send(new Uint8Array(d)) } catch { this.close() }
    })
    this.socket.on("error", () => this.close())
    this.socket.on("close", () => this.close())
  }
  onData(chunk: Uint8Array) {
    if (this.closed || !this.socket) return
    this.stats.bytesIn += chunk.byteLength
    this.socket.write(chunk)
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (this.limitTimer) clearTimeout(this.limitTimer)
    try { this.socket?.destroy() } catch { /* noop */ }
    try { this.ws.close() } catch { /* noop */ }
  }
}

// ---------------- HTTP / WS 服务 ----------------
interface WsData { v: string; ro: boolean; dur: number; tgt: DialTarget; sess: DemoRfbSession | TcpSession | null; stats: SessStats }

// Bun 运行时全局服务接口（bun --hot 执行；类型宽松声明避免额外依赖）
declare const Bun: { serve<T = unknown>(cfg: Record<string, unknown>): { stop(force?: boolean): void } }

// ---- r13c: 端口占用重试退避（EADDRINUSE 不再一崩即溃）----
// 守护轮次切换瞬间可能出现短暂端口残留（旧轮孤儿进程退出中/上层清理竞态）：
// 最多 30 次（约 45 秒）退避重绑，期间打点日志供 docker logs 观测；非占用类错误立即退出
const serveOptions: Record<string, unknown> = {
  hostname: BIND_HOST,
  port: PORT,
  fetch(req, srv) {
    const u = new URL(req.url)
    if (u.pathname === "/health") {
      // r13c：跨域名部署诊断（CORS 放行 —— 健康探测无敏感信息；WS 接入本身经 HMAC 票据鉴权不受域限制）
      return Response.json(
        { ok: true, port: PORT, uptimeSec: Math.round(process.uptime()), workspaces: statsByWs.size, mode: process.env.VNC_BRIDGE_PUBLIC || "gateway" },
        { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" } },
      )
    }
    if (u.pathname === "/health" && req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" } })
    }
    if (u.pathname === "/stats") {
      const ws = u.searchParams.get("ws")
      if (ws) {
        const s = statsByWs.get(ws)
        if (!s) return Response.json({ ok: false, msg: "无该会话统计" }, { status: 404 })
        return Response.json({ ok: true, stats: s })
      }
      return Response.json({ ok: true, all: Object.fromEntries(statsByWs) })
    }
    if (u.pathname === "/internal/nonce-count") {
      // 运维自检：观察防重放注册表规模
      return Response.json({ ok: true, nonces: usedNonces.size })
    }
    // WS 升级：/ 或 /vnc/<workspaceId>（生产独立端口直连形态）
    const isVncPath = u.pathname === "/" || u.pathname.startsWith("/vnc/")
    if (isVncPath && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const vnc = u.searchParams.get("vnc") || u.pathname.replace(/^\/vnc\//, "").split("/")[0]
      const ticket = u.searchParams.get("ticket") || ""
      if (!vnc) return new Response("缺少 vnc 参数", { status: 400 })
      const payload = verifyTicket(ticket)
      if (!payload || payload.v !== vnc) return new Response("票据无效或已过期", { status: 401 })
      if (srv.upgrade(req, { data: { v: vnc, ro: payload.ro === 1, dur: typeof payload.dur === "number" ? payload.dur : 0, tgt: payload.tgt, sess: null, stats: statOf(vnc, payload.tgt.k === "demo" ? "demo" : "tcp") } })) {
        return
      }
      return new Response("升级失败", { status: 500 })
    }
    return new Response("Not Found", { status: 404 })
  },
  websocket: {
    open(ws) {
      const d = ws.data
      if (d.tgt.k === "demo") {
        d.sess = new DemoRfbSession(
          { send: (b) => ws.send(b), close: () => ws.close() },
          d.ro,
          d.stats,
          d.dur, // 会话时长上限（服务端强制）
        )
      } else {
        d.sess = new TcpSession(
          { send: (b) => ws.send(b), close: () => ws.close() },
          { h: d.tgt.h, p: d.tgt.p },
          d.stats,
          d.dur,
        )
      }
    },
    message(ws, message) {
      const d = ws.data
      const bytes = typeof message === "string" ? Buffer.from(message, "utf8") : (message as Uint8Array)
      d.stats.bytesIn += bytes.byteLength
      d.sess?.onData(Buffer.from(bytes))
    },
    close(ws) {
      const d = ws.data
      d.stats.clients = Math.max(0, d.stats.clients - 1)
      d.stats.lastAt = Date.now()
      d.sess?.close()
      d.sess = null
    },
  },
}

let server: { stop(force?: boolean): void } | null = null
for (let attempt = 1; attempt <= 30 && !server; attempt++) {
  try {
    server = Bun.serve<WsData>(serveOptions as never)
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    const inUse = /EADDRINUSE|address.*in use|port.*in use|Is port/i.test(msg)
    console.error(`[vnc-bridge] 第 ${attempt} 次监听 ${BIND_HOST}:${PORT} 失败：${msg}`)
    if (!inUse) break
    console.error(`[vnc-bridge] 端口被占用，1.5 秒后重试（守护轮次切换的短暂残留会自动释放）`)
    await new Promise((r) => setTimeout(r, 1500))
  }
}
if (!server) {
  console.error(`[vnc-bridge] 无法监听 ${BIND_HOST}:${PORT}（重试 30 次后放弃，进程退出交由守护重启）`)
  process.exit(1)
}

console.log(`[vnc-bridge] HelmPort 桥已启动: ${BIND_HOST}:${PORT}（票据HMAC校验/单次防重放/只读服务端强制）`)

// 优雅退出
process.on("SIGTERM", () => { server?.stop(true); process.exit(0) })
process.on("SIGINT", () => { server?.stop(true); process.exit(0) })
