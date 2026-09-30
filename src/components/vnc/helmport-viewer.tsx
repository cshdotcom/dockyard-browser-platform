"use client"

// ============================================================
// Dockyard HelmPort —— 企业级亮色远程桌面查看器（全自研，零第三方 VNC 依赖）
// 原名 LiveDesk（与第三方产品重名）→ 更名 HelmPort 并以 Next.js/React 原生重构：
//   · 自研 RFB 3.3/3.7/3.8 协议客户端（src/components/vnc/helmport/rfb-client.ts）
//   · 单次票据取票 → 断线自动重连（自动重新取票，退避重试）
//   · 只读镜像：客户端 viewOnly + 服务端桥丢输入帧 双保险
//   · 企业级亮色控制坞：右侧小箭头展开 / 可拖动停靠（桌面）/ 底部抽屉（移动端）
//   · 输入法（IME）：本地输入法组合捕获 → Unicode keysym 逐字注入（中文/日/韩/常用语言）
//   · 会话时长策略：连接窗口(60s 单次) 与 会话总时长上限（三级策略，默认不限）分离
//   · 剪贴板：逐沙箱逐会话独立缓冲（桥实例私有）+ 双通道投递 + 平台审计
//   · 帧率/带宽/键鼠 HUD 实时遥测 + 停顿看门狗 + 截图加签
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import {
  Anchor, Camera, Clipboard, Expand, Minimize2, RefreshCw, Loader2,
  MousePointer2, Hand, ShieldCheck, Eye, TriangleAlert, Zap, Radio, Keyboard, ShipWheel, Monitor,
  Languages, Timer, GripVertical, Send, PanelRightClose, PanelRightOpen, Lock, ChevronsUp,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { getVncTicketAction } from "@/server/actions/workspaces"
import { HelmPortRfb, edsResultMessage, type RfbDesktopSize, type RfbScreen } from "./helmport/rfb-client"
import { keysymFor } from "./helmport/keysyms"
import { cn } from "@/lib/utils"

export interface HelmPortWorkspace {
  id: string
  uuid: string
  name: string
  status: string
  novncSessionId: string | null
  ownerName: string
  mySharePermission: string | null // VIEW | OPERATE | null
  isOwner: boolean
  isAdmin: boolean
}

type Phase = "idle" | "connecting" | "live" | "reconnecting" | "error"

const QUALITY_MAP: Record<string, number> = { low: 2, mid: 5, high: 9 }

// ---- 多监视器分辨率预设（SetDesktopSize / ExtendedDesktopSize 协议驱动）----
interface MonitorPreset {
  key: string
  label: string
  w: number
  h: number
  cols: number // 横向并排监视器数（1=单屏 2=双屏 3=三屏）
}
const MONITOR_PRESETS: MonitorPreset[] = [
  { key: "m-640x400", label: "640×400", w: 640, h: 400, cols: 1 },
  { key: "m-1280x720", label: "1280×720", w: 1280, h: 720, cols: 1 },
  { key: "m-1600x900", label: "1600×900", w: 1600, h: 900, cols: 1 },
  { key: "m-1920x1080", label: "1920×1080", w: 1920, h: 1080, cols: 1 },
  { key: "m-2560x1440", label: "2560×1440", w: 2560, h: 1440, cols: 1 },
  { key: "m-2x1280x720", label: "双屏 2×1280×720", w: 2560, h: 720, cols: 2 },
  { key: "m-2x1920x1080", label: "双屏 2×1920×1080", w: 3840, h: 1080, cols: 2 },
  { key: "m-3x1280x720", label: "三屏 3×1280×720", w: 3840, h: 720, cols: 3 },
]

// 由预设构造屏幕布局（横向并排）
function presetScreens(p: MonitorPreset): RfbScreen[] {
  const sw = Math.floor(p.w / p.cols)
  const out: RfbScreen[] = []
  for (let i = 0; i < p.cols; i++) {
    out.push({ id: i, x: i * sw, y: 0, width: i === p.cols - 1 ? p.w - i * sw : sw, height: p.h, flags: 0 })
  }
  return out
}

// 当前布局 → 预设键（匹配则返回预设 key，否则 custom）
function desktopToPresetKey(d: RfbDesktopSize): string {
  const match = MONITOR_PRESETS.find(
    (p) => p.w === d.width && p.h === d.height && p.cols === d.screens.length &&
      presetScreens(p).every((s, i) => d.screens[i] && d.screens[i].x === s.x && d.screens[i].width === s.width),
  )
  return match ? match.key : "custom"
}

// ---- 输入法语言清单（常用语言全覆盖；本地 IME 组合 → Unicode keysym 注入）----
// 设置隐藏输入框的 lang 属性：移动端据此切换软键盘布局，桌面端辅助输入法关联。
// 注入通道与本地键盘完全一致（sendUnicodeText → RFB KeyEvent），任意语言真实可用。
const IME_LANGS: { code: string; label: string; hint: string }[] = [
  { code: "zh-CN", label: "中文（简体）", hint: "拼音/五笔等本地中文输入法" },
  { code: "zh-TW", label: "中文（繁體）", hint: "注音/倉頡等本地輸入法" },
  { code: "en-US", label: "English (US)", hint: "English keyboard" },
  { code: "ja-JP", label: "日本語", hint: "ローマ字/かな入力" },
  { code: "ko-KR", label: "한국어", hint: "두벌식/세벌식 자판" },
  { code: "fr-FR", label: "Français", hint: "Clavier AZERTY" },
  { code: "de-DE", label: "Deutsch", hint: "Deutsche Tastatur QWERTZ" },
  { code: "es-ES", label: "Español", hint: "Teclado español" },
  { code: "pt-BR", label: "Português", hint: "Teclado português ABNT" },
  { code: "it-IT", label: "Italiano", hint: "Tastiera italiana" },
  { code: "ru-RU", label: "Русский", hint: "Русская раскладка" },
  { code: "ar-SA", label: "العربية", hint: "لوحة مفاتيح عربية" },
  { code: "hi-IN", label: "हिन्दी", hint: "हिन्दी कीबोर्ड" },
  { code: "th-TH", label: "ไทย", hint: "แป้นพิมพ์ไทย" },
  { code: "vi-VN", label: "Tiếng Việt", hint: "Bàn phím tiếng Việt" },
]

// 按钮位掩码：1=左 2=中 4=右 8=滚上 16=滚下
const BTN_LEFT = 1
const BTN_RIGHT = 4
const BTN_SCROLL_UP = 8
const BTN_SCROLL_DOWN = 16

// 轻量设备指纹（水印标识用，不采集敏感信息）
function deviceTag(): string {
  if (typeof navigator === "undefined") return "------"
  const s = navigator.userAgent + "|" + (navigator.language || "") + "|" + ((typeof screen !== "undefined" && screen && screen.width) || 0) + "x" + ((typeof screen !== "undefined" && screen && screen.height) || 0)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(6, "0").slice(0, 6)
}

function wsScheme(): string {
  return typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws"
}

// 秒 → mm:ss（会话倒计时展示）
function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

// ============================================================
// 通道自动推导：根据访问域名自动拼接 WS 地址，无需任何手工配置 ——
//   0) bridge.url 显式覆盖（自建部署）
//   1) 网关查询参数模式探测：/health?XTransformPort=<port>（统一网关原生支持，任意域名可用）
//   2) 同源路径模式探测：/vnc-ws/health（网关按路径路由时成立）
//   3) 同主机直连端口（开发机/沙箱 IP 直访场景）
// 探测结果模块级缓存；WS 建连失败时翻转通道，重连自动换通道（自愈）。
// ============================================================
type BridgeChannel = "gateway-query" | "path" | "direct"
let bridgeChannelCache: { port: number; channel: BridgeChannel } | null = null

async function fetchOkJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json().catch(() => null)) as Record<string, unknown> | null
  } catch {
    return null
  }
}

async function resolveBridgeChannel(port: number): Promise<BridgeChannel> {
  if (bridgeChannelCache && bridgeChannelCache.port === port) return bridgeChannelCache.channel
  let channel: BridgeChannel
  const viaQuery = await fetchOkJson(`/health?XTransformPort=${port}`)
  if (viaQuery?.ok === true) {
    channel = "gateway-query"
  } else if ((await fetchOkJson("/vnc-ws/health"))?.ok === true) {
    channel = "path"
  } else {
    channel = "direct"
  }
  bridgeChannelCache = { port, channel }
  return channel
}

// 通道失效（WS 建连/握手失败时调用）：翻转到下一通道（探测只覆盖 HTTP，WS upgrade 可能被代理拦），
// 下次重连直接换通道；重连预算耗尽前最多轮换 gateway-query/path/direct
function invalidateBridgeChannel() {
  if (bridgeChannelCache) {
    const order: BridgeChannel[] = ["gateway-query", "path", "direct"]
    const next = order[(order.indexOf(bridgeChannelCache.channel) + 1) % order.length]
    bridgeChannelCache = { port: bridgeChannelCache.port, channel: next }
  }
}

export function HelmPortViewer({ workspace }: { workspace: HelmPortWorkspace }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const rfbRef = React.useRef<HelmPortRfb | null>(null)
  const statsRef = React.useRef({ frameTimes: [] as number[], bytesIn: 0, bytesOut: 0, lastMsgAt: 0 })
  const retryRef = React.useRef({ count: 0, timer: null as ReturnType<typeof setTimeout> | null, manual: false })
  const phaseRef = React.useRef<Phase>("idle")
  const buttonMaskRef = React.useRef(0)
  const touchRef = React.useRef<{ x: number; y: number; moved: boolean; timer: ReturnType<typeof setTimeout> | null; longFired: boolean } | null>(null)

  const [phase, setPhaseState] = React.useState<Phase>("idle")
  const [errMsg, setErrMsg] = React.useState("")
  const [retryIn, setRetryIn] = React.useState(0)
  const [stats, setStats] = React.useState({ fps: 0, kbps: 0, idle: 0 })
  const [fullscreen, setFullscreen] = React.useState(false)
  const [lastKeys, setLastKeys] = React.useState<string[]>([])
  const [clipboardText, setClipboardText] = React.useState("")
  const [clipboardReceived, setClipboardReceived] = React.useState("")
  const [serverName, setServerName] = React.useState("")
  // —— 多监视器分辨率切换 ——
  const [desktop, setDesktop] = React.useState<RfbDesktopSize | null>(null)
  const pendingResizeRef = React.useRef<string | null>(null) // 用户发起的切换请求（结果 toast 用）
  const appliedPresetRef = React.useRef<string | null>(null) // 连接后已自动应用的偏好（避免重复下发）

  // —— 企业级控制坞（亮色侧栏：小箭头开合 + 可拖动停靠 + 移动端底部抽屉）——
  const [dockOpen, setDockOpen] = React.useState(true)
  const [dockSide, setDockSide] = React.useState<"left" | "right">("right")
  const [dockTab, setDockTab] = React.useState<"display" | "input" | "clipboard">("display")
  const [isMobile, setIsMobile] = React.useState(false)
  const dragRef = React.useRef<{ startX: number; moved: boolean } | null>(null)

  // —— 输入法（IME）：本地组合捕获 → Unicode keysym 注入 ——
  const [imeEnabled, setImeEnabled] = React.useState(true)
  const [imeLang, setImeLang] = React.useState("zh-CN")
  const [imeComposing, setImeComposing] = React.useState(false)
  const [imePanelText, setImePanelText] = React.useState("")
  const [imePanelSendEnter, setImePanelSendEnter] = React.useState(false)
  const imeInputRef = React.useRef<HTMLInputElement | null>(null)
  const composingRef = React.useRef(false)

  // —— 会话时长策略（连接窗口 60s 单次 / 会话总时长三级策略默认不限）——
  const sessionLimitRef = React.useRef({ maxSec: 0, source: "无限制（默认）", connectedAt: 0 })
  const [sessionLeft, setSessionLeft] = React.useState(-1) // -1=未连接或无限制

  const readonly = workspace.mySharePermission === "VIEW" && !workspace.isOwner && !workspace.isAdmin
  const canOperate = !readonly

  // ---- 会话偏好持久化（本地浏览器，不影响其他接入端）----
  const [quality, setQuality] = React.useState("mid")
  const [scaleFit, setScaleFit] = React.useState(true)
  const [watermark, setWatermark] = React.useState(true)
  const [inputMode, setInputMode] = React.useState<"mouse" | "touch">("mouse")

  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }

  React.useEffect(() => {
    try {
      const savedQ = localStorage.getItem(`hp-quality-${workspace.id}`)
      if (savedQ && QUALITY_MAP[savedQ]) setQuality(savedQ)
      const savedScale = localStorage.getItem(`hp-scale-${workspace.id}`)
      if (savedScale === "fit" || savedScale === "1:1") setScaleFit(savedScale === "fit")
      const savedWm = localStorage.getItem(`hp-wm-${workspace.id}`)
      if (savedWm === "0") setWatermark(false)
      const savedMode = localStorage.getItem(`vnc-mode-${workspace.id}`)
      if (savedMode === "mouse" || savedMode === "touch") setInputMode(savedMode)
      else if ("ontouchstart" in window || navigator.maxTouchPoints > 0) setInputMode("touch")
      const savedSide = localStorage.getItem("hp-dock-side")
      if (savedSide === "left" || savedSide === "right") setDockSide(savedSide)
      const savedLang = localStorage.getItem(`hp-ime-lang-${workspace.id}`)
      if (savedLang && IME_LANGS.some((l) => l.code === savedLang)) setImeLang(savedLang)
      const savedDock = localStorage.getItem("hp-dock-open")
      if (savedDock === "0") setDockOpen(false)
    } catch { /* localStorage 不可用时静默降级 */ }
  }, [workspace.id])

  React.useEffect(() => {
    try { localStorage.setItem(`hp-quality-${workspace.id}`, quality) } catch { /* noop */ }
  }, [quality, workspace.id])
  React.useEffect(() => {
    try { localStorage.setItem(`hp-scale-${workspace.id}`, scaleFit ? "fit" : "1:1") } catch { /* noop */ }
  }, [scaleFit, workspace.id])
  React.useEffect(() => {
    try { localStorage.setItem(`hp-wm-${workspace.id}`, watermark ? "1" : "0") } catch { /* noop */ }
  }, [watermark, workspace.id])
  React.useEffect(() => {
    try { localStorage.setItem(`vnc-mode-${workspace.id}`, inputMode) } catch { /* noop */ }
  }, [inputMode, workspace.id])
  React.useEffect(() => {
    try { localStorage.setItem("hp-dock-side", dockSide) } catch { /* noop */ }
  }, [dockSide])
  React.useEffect(() => {
    try { localStorage.setItem(`hp-ime-lang-${workspace.id}`, imeLang) } catch { /* noop */ }
  }, [imeLang, workspace.id])
  React.useEffect(() => {
    try { localStorage.setItem("hp-dock-open", dockOpen ? "1" : "0") } catch { /* noop */ }
  }, [dockOpen])

  // 移动端检测（底部抽屉形态）
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)")
    const apply = () => setIsMobile(mq.matches)
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  // ---- 仪表统计：帧率 / 带宽 / 停顿毫秒 + 看门狗 + 会话时长倒计时 ----
  React.useEffect(() => {
    const t = setInterval(() => {
      const s = statsRef.current
      const now = Date.now()
      s.frameTimes = s.frameTimes.filter((ts) => now - ts < 5000)
      const fps = Math.round((s.frameTimes.length / 5) * 10) / 10
      const kbps = Math.round((s.bytesIn / 1024 / 5) * 10) / 10
      const idle = phaseRef.current === "live" ? now - s.lastMsgAt : 0
      setStats({ fps, kbps, idle })
      // 会话时长上限倒计时（仅当策略下发了 maxSec>0）
      const lim = sessionLimitRef.current
      if (phaseRef.current === "live" && lim.maxSec > 0 && lim.connectedAt > 0) {
        const left = lim.maxSec - (now - lim.connectedAt) / 1000
        setSessionLeft(left)
        if (left <= 60 && left > 0 && Math.floor(left) % 30 === 0) {
          toast.warning(`会话剩余 ${Math.ceil(left)} 秒（${lim.source}），到期将自动断开`)
        }
        if (left <= 0) {
          // 客户端主动断开（服务端桥另有强制断开双保险）
          retryRef.current.manual = true
          rfbRef.current?.disconnect()
          setPhase("error")
          setErrMsg(`会话连接总时长已达策略上限（${Math.round(lim.maxSec / 60)} 分钟 · 来源：${lim.source}）。如需继续使用请联系管理员调整会话时长策略。`)
        }
      } else {
        setSessionLeft(-1)
      }
      // 看门狗：live 状态下 15 秒无任何数据 → 主动断开触发自动重连（防退出保活）
      if (phaseRef.current === "live" && s.lastMsgAt > 0 && now - s.lastMsgAt > 15_000) {
        rfbRef.current?.disconnect()
      }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // ---- 建立连接：取票 → 构造经统一网关的 WS → 自研 RFB 客户端接管 ----
  const connect = React.useCallback(async () => {
    if (phaseRef.current === "connecting" || phaseRef.current === "live") return
    if (!canvasRef.current) return
    setPhase("connecting")
    setErrMsg("")
    try {
      const res = await getVncTicketAction({ id: workspace.id })
      if (res.code !== 0 || !res.data) throw new Error(res.msg || "取票失败")
      const { wsUrlQuery, bridge, readonly: ticketReadonly, sessionMaxSec = 0, limitSource = "无限制（默认）" } = res.data

      // 会话时长策略记录（倒计时 + 到期断开）
      sessionLimitRef.current = { maxSec: sessionMaxSec, source: limitSource, connectedAt: Date.now() }
      setSessionLeft(sessionMaxSec > 0 ? sessionMaxSec : -1)

      // 地址自动推导（按访问域名自动拼接，无需配置）：
      //   bridge.url 显式覆盖 > 网关查询参数 > 同源 /vnc-ws 路径 > 同主机直连端口
      let url: string
      if (bridge.url) {
        const base = (bridge.url || "").replace(/\/$/, "")
        url = base.startsWith("ws") ? `${base}/?${wsUrlQuery}` : `${wsScheme()}://${base.replace(/^https?:\/\//, "")}/?${wsUrlQuery}`
      } else {
        const channel = await resolveBridgeChannel(bridge.port)
        if (channel === "gateway-query") {
          url = `${wsScheme()}://${location.host}/?XTransformPort=${bridge.port}&${wsUrlQuery}`
        } else if (channel === "path") {
          url = `${wsScheme()}://${location.host}/vnc-ws/?${wsUrlQuery}`
        } else {
          url = `${wsScheme()}://${location.hostname}:${bridge.port}/?${wsUrlQuery}`
        }
      }

      // 仪表化 WebSocket（自研客户端用 addEventListener，多监听器共存）
      const sock = new WebSocket(url)
      sock.binaryType = "arraybuffer"
      const st = statsRef.current
      st.bytesIn = 0; st.bytesOut = 0; st.frameTimes = []; st.lastMsgAt = 0
      sock.addEventListener("message", (ev) => {
        st.lastMsgAt = Date.now()
        const size = typeof ev.data === "string" ? ev.data.length : (ev.data as ArrayBuffer).byteLength
        st.bytesIn += size
        if (size > 100_000) st.frameTimes.push(Date.now()) // 帧带消息
      })
      const protoSend = WebSocket.prototype.send
      sock.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        try {
          const size = typeof data === "string" ? data.length : data instanceof Blob ? data.size : (data as ArrayBuffer).byteLength
          st.bytesOut += size
          protoSend.call(sock, data as string)
        } catch { /* 连接关闭竞态：忽略 */ }
      }) as typeof sock.send

      const canvas = canvasRef.current
      const rfb = new HelmPortRfb(sock, {
        canvas,
        viewOnly: ticketReadonly,
        qualityLevel: QUALITY_MAP[quality] ?? 5,
        onConnected: (info) => {
          retryRef.current.count = 0
          setServerName(info.name)
          setPhase("live")
          appliedPresetRef.current = null
          sessionLimitRef.current.connectedAt = Date.now()
          // 连接后聚焦输入法捕获框（IME 通道就绪）
          try { imeInputRef.current?.focus({ preventScroll: true }) } catch { /* noop */ }
        },
        onDesktopSize: (size) => {
          setDesktop(size)
          const expected = pendingResizeRef.current
          if (size.resultCode !== 0) {
            // 失败：仅在用户主动发起时提示
            if (expected) {
              toast.error(edsResultMessage(size.resultCode))
              pendingResizeRef.current = null
            }
          } else if (expected) {
            pendingResizeRef.current = null
            toast.success(`分辨率已切换：${size.width}×${size.height} · ${size.screens.length} 显示器`)
          }
        },
        onClipboard: (text) => setClipboardReceived(text),
        onTextInput: (ch) => setLastKeys((k) => [...k.slice(-5), ch]),
        onSecurityFail: (reason) => {
          setErrMsg(`安全握手失败：${reason}`)
          retryRef.current.manual = true
        },
        onTelemetry: () => {
          // 帧计数由 message 监听推断；此回调保留扩展位
        },
        onDisconnected: (reason) => {
          rfbRef.current = null
          // 从未进入 live 就断开（通道不通）：清除探测缓存 → 重连时自动切换 path/direct 通道
          if (phaseRef.current !== "live") invalidateBridgeChannel()
          if (retryRef.current.manual) {
            retryRef.current.manual = false
            setPhase("idle")
            return
          }
          // 自动重连：票据单次有效 → 每次重连自动重新取票，退避 1/2/4/8/8s
          const attempt = ++retryRef.current.count
          if (attempt <= 5) {
            setPhase("reconnecting")
            let left = Math.min(1 << (attempt - 1), 8)
            setRetryIn(left)
            const cd = setInterval(() => { left--; setRetryIn(Math.max(0, left)) }, 1000)
            retryRef.current.timer = setTimeout(() => {
              clearInterval(cd)
              connect()
            }, Math.min(1 << (attempt - 1), 8) * 1000)
          } else {
            setPhase("error")
            setErrMsg(reason || "连接已断开且重连预算耗尽")
          }
        },
      })
      rfbRef.current = rfb
    } catch (e) {
      setPhase("error")
      setErrMsg(e instanceof Error ? e.message : "连接建立失败")
    }
  }, [workspace.id, quality])

  const disconnect = React.useCallback(() => {
    retryRef.current.manual = true
    if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
    retryRef.current.count = 0
    rfbRef.current?.disconnect()
    setPhase("idle")
    setDesktop(null)
    setSessionLeft(-1)
  }, [])

  // ---- 多监视器分辨率切换：SetDesktopSize 请求 → 服务端 EDS 确认 ----
  const applyMonitorPreset = React.useCallback((preset: MonitorPreset, viaUser: boolean) => {
    const rfb = rfbRef.current
    if (!rfb) return
    if (viaUser) {
      try { localStorage.setItem(`hp-monitor-${workspace.id}`, preset.key) } catch { /* noop */ }
    }
    const screens = presetScreens(preset)
    const ok = rfb.sendSetDesktopSize(preset.w, preset.h, screens)
    if (!ok) {
      if (viaUser) toast.error("当前状态无法切换分辨率（未连接或尺寸超出范围）")
      return
    }
    if (viaUser) pendingResizeRef.current = preset.key
  }, [workspace.id])

  // 连接建立后自动应用本会话记忆的分辨率偏好（新连接默认尺寸不同才下发）
  React.useEffect(() => {
    if (phase !== "live" || !desktop) return
    if (appliedPresetRef.current) return
    appliedPresetRef.current = "done"
    try {
      const saved = localStorage.getItem(`hp-monitor-${workspace.id}`)
      const preset = MONITOR_PRESETS.find((p) => p.key === saved)
      if (preset && (preset.w !== desktop.width || preset.h !== desktop.height || preset.cols !== desktop.screens.length)) {
        applyMonitorPreset(preset, false)
      }
    } catch { /* localStorage 不可用：跳过 */ }
  }, [phase, desktop, workspace.id, applyMonitorPreset])

  // RUNNING 状态自动接入
  React.useEffect(() => {
    if (workspace.status === "RUNNING" || workspace.status === "IDLE") {
      const t = setTimeout(() => connect(), 300)
      return () => clearTimeout(t)
    }
  }, [workspace.status, connect])

  // 卸载清理
  React.useEffect(() => {
    return () => {
      retryRef.current.manual = true
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
      try { rfbRef.current?.disconnect() } catch { /* noop */ }
    }
  }, [])

  // ---- 画质 / 缩放热调整 ----
  React.useEffect(() => {
    const rfb = rfbRef.current
    if (rfb) rfb.qualityLevel = QUALITY_MAP[quality] ?? 5
  }, [quality])

  React.useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch { toast.error("当前环境不允许全屏") }
  }

  // ================= 输入：坐标映射 =================
  const toFbCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / Math.max(1, rect.width)
    const sy = canvas.height / Math.max(1, rect.height)
    return {
      x: Math.max(0, Math.min(canvas.width - 1, Math.floor((clientX - rect.left) * sx))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.floor((clientY - rect.top) * sy))),
    }
  }

  // ================= 输入：鼠标（桌面） =================
  const onStageMouseDown = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate || inputMode === "touch") return
    e.preventDefault()
    const btn = e.button === 0 ? BTN_LEFT : e.button === 1 ? 2 : e.button === 2 ? BTN_RIGHT : 0
    buttonMaskRef.current |= btn
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }
  const onStageMouseMove = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate || inputMode === "touch") return
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }
  const onStageMouseUp = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate || inputMode === "touch") return
    const btn = e.button === 0 ? BTN_LEFT : e.button === 1 ? 2 : e.button === 2 ? BTN_RIGHT : 0
    buttonMaskRef.current &= ~btn
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }
  const onStageWheel = (e: React.WheelEvent) => {
    if (phase !== "live" || !canOperate) return
    e.preventDefault()
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    const scrollBtn = e.deltaY < 0 ? BTN_SCROLL_UP : BTN_SCROLL_DOWN
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current | scrollBtn)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }

  // ================= 输入：触屏（长按=右键 / 拖动=移动 / 双击缩放交由浏览器） =================
  const onStageTouchStart = (e: React.TouchEvent) => {
    if (phase !== "live" || !canOperate || inputMode !== "touch" || e.touches.length !== 1) return
    const t = e.touches[0]
    const { x, y } = toFbCoords(t.clientX, t.clientY)
    touchRef.current = { x: t.clientX, y: t.clientY, moved: false, timer: null, longFired: false }
    const rec = touchRef.current
    rec.timer = setTimeout(() => {
      if (touchRef.current === rec && !rec.moved) {
        rec.longFired = true
        buttonMaskRef.current |= BTN_RIGHT
        rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
        if (navigator.vibrate) navigator.vibrate(30)
      }
    }, 550)
  }
  const onStageTouchMove = (e: React.TouchEvent) => {
    if (phase !== "live" || !canOperate || inputMode !== "touch" || !touchRef.current) return
    const t = e.touches[0]
    const rec = touchRef.current
    if (Math.abs(t.clientX - rec.x) > 8 || Math.abs(t.clientY - rec.y) > 8) {
      rec.moved = true
      if (rec.timer) clearTimeout(rec.timer)
      const { x, y } = toFbCoords(t.clientX, t.clientY)
      // 拖动：按住左键移动
      buttonMaskRef.current |= BTN_LEFT
      rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
    }
  }
  const onStageTouchEnd = (e: React.TouchEvent) => {
    if (phase !== "live" || !canOperate || inputMode !== "touch" || !touchRef.current) return
    const rec = touchRef.current
    if (rec.timer) clearTimeout(rec.timer)
    const last = e.changedTouches[0]
    const { x, y } = toFbCoords(last.clientX, last.clientY)
    if (!rec.moved && !rec.longFired) {
      // 单击 = 左键点击
      rfbRef.current?.sendPointer(x, y, buttonMaskRef.current | BTN_LEFT)
      rfbRef.current?.sendPointer(x, y, buttonMaskRef.current & ~BTN_LEFT)
    } else {
      // 松开全部按钮
      buttonMaskRef.current &= ~(BTN_LEFT | BTN_RIGHT)
      rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
    }
    touchRef.current = null
  }

  // ================= 输入：键盘（keysym 直发，修饰键状态机） =================
  // IME 组合期间（isComposing / keyCode 229）不透传按键 —— 组合文本由 compositionend 统一注入
  const onStageKeyDown = (e: React.KeyboardEvent) => {
    if (phase !== "live" || !canOperate) return
    if (e.nativeEvent.isComposing || composingRef.current) return
    const keysym = keysymFor(e.nativeEvent)
    if (keysym !== null) {
      e.preventDefault()
      rfbRef.current?.sendKey(keysym, true)
      const name = e.key === " " ? "Space" : e.key === "Enter" ? "Enter" : e.key.length === 1 ? e.key : e.key.replace("Arrow", "↑")
      setLastKeys((k) => [...k.slice(-5), name])
    }
  }
  const onStageKeyUp = (e: React.KeyboardEvent) => {
    if (phase !== "live" || !canOperate) return
    if (e.nativeEvent.isComposing || composingRef.current) return
    const keysym = keysymFor(e.nativeEvent)
    if (keysym !== null) {
      e.preventDefault()
      rfbRef.current?.sendKey(keysym, false)
    }
  }

  // ================= 输入法（IME）：本地输入法组合捕获 → Unicode keysym 注入 =================
  // 通道：隐藏 input（覆盖画布、lang 属性跟随所选语言）接收本地 IME 组合；
  //       compositionend 取组合完成的最终文本 → sendUnicodeText 逐字按键注入远程（与本地键盘同一条 RFB 路径）。
  //       支持系统已安装的任意输入法（中文拼音/五笔/日文罗马字/韩文/俄文等全部语言）。
  const onImeStart = () => {
    composingRef.current = true
    setImeComposing(true)
  }
  const onImeEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false
    setImeComposing(false)
    const text = (e.data || "").trim()
    if (text) {
      const n = rfbRef.current?.sendUnicodeText(text) ?? 0
      if (n > 0) toast.success(`已注入 ${n} 个字符（${IME_LANGS.find((l) => l.code === imeLang)?.label || imeLang}）`)
      else toast.error("远程端未连接或只读模式，无法注入文本")
    }
    try { (e.target as HTMLInputElement).value = "" } catch { /* noop */ }
  }
  // 面板输入框：显式键入（移动端软键盘主通道）—— 点发送注入，可选回车
  const sendImePanel = () => {
    const text = imePanelText.replace(/[\r\n]+/g, "\n").trim()
    if (!text) { toast.error("请先输入要发送的文本"); return }
    const clean = text.replace(/\n/g, "")
    const n = rfbRef.current?.sendUnicodeText(clean) ?? 0
    if (imePanelSendEnter) {
      rfbRef.current?.sendKey(0xff0d, true)
      rfbRef.current?.sendKey(0xff0d, false)
    }
    if (n > 0) {
      toast.success(`已发送 ${n} 个字符${imePanelSendEnter ? " + 回车" : ""}`)
      setImePanelText("")
    } else toast.error("远程端未连接或只读模式，无法注入文本")
  }

  // ---- 截图（画布快照 + 品牌签名条）----
  const screenshot = () => {
    const cv = canvasRef.current
    if (!cv || phase !== "live") { toast.error("尚未连接远程桌面"); return }
    const out = document.createElement("canvas")
    const FOOTER = 46
    out.width = cv.width
    out.height = cv.height + FOOTER
    const ctx = out.getContext("2d")
    if (!ctx) return
    ctx.drawImage(cv, 0, 0)
    const grad = ctx.createLinearGradient(0, cv.height, out.width, out.height)
    grad.addColorStop(0, "#eef4f3")
    grad.addColorStop(1, "#e2edeb")
    ctx.fillStyle = grad
    ctx.fillRect(0, cv.height, out.width, FOOTER)
    ctx.fillStyle = "#0d9488"
    ctx.fillRect(0, cv.height, out.width, 2)
    ctx.fillStyle = "#0f2e2a"
    ctx.font = "bold 14px ui-sans-serif, system-ui"
    ctx.fillText("Dockyard HelmPort", 14, cv.height + 28)
    ctx.fillStyle = "#5f7a75"
    ctx.font = "12px ui-sans-serif, system-ui"
    ctx.fillText(`${workspace.name} · ${workspace.ownerName} · ${new Date().toLocaleString()} · ${deviceTag()}`, 170, cv.height + 28)
    const a = document.createElement("a")
    a.href = out.toDataURL("image/png")
    a.download = `helmport-${workspace.name}-${Date.now()}.png`
    a.click()
    toast.success("截图已下载（含归属水印签名条）")
  }

  // ---- 剪贴板双通道：RFB 扩展直达 + 平台中转审计通道（逐沙箱隔离） ----
  const sendClipboard = async () => {
    const cleaned = clipboardText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    if (!cleaned) { toast.error("剪贴板内容为空"); return }
    const sliced = cleaned.slice(0, 5000)
    let okCount = 0
    let channelInfo = ""
    // 通道1：自研 RFB 扩展剪贴板（QEMU 协议：UTF-8 全字符 + zlib；中文完整支持；仅本连接缓冲）
    try {
      const res = await rfbRef.current?.sendClipboard(sliced)
      if (res === "extended") { okCount++; channelInfo = "RFB扩展" }
      else if (res === "classic") { okCount++; channelInfo = "RFB经典" }
    } catch { /* 通道2兜底 */ }
    // 通道2：平台中转代理（后端 UTF-8 校验 + 管理员全局开关 + 审计 + 工作区归属校验）
    try {
      const res = await fetch("/api/vnc-proxy/clipboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, text: sliced }),
      })
      const json = await res.json()
      if (json.code === 0) { okCount++; channelInfo = channelInfo ? `${channelInfo}+平台` : "平台" }
      else toast.error(json.msg)
    } catch { /* 平台通道不可用不影响直达通道 */ }
    if (okCount > 0) toast.success(`剪贴板已投递（${channelInfo || "未知通道"}）`)
  }

  // ---- 控制坞拖动（桌面）：拖动中跟随指针，松开停靠较近侧 ----
  const onDockHeaderPointerDown = (e: React.PointerEvent) => {
    if (isMobile) return
    dragRef.current = { startX: e.clientX, moved: false }
    setDragging(true)
    setDragX(e.clientX)
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onDockHeaderPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    if (dragRef.current) dragRef.current.moved = true
    setDragX(e.clientX)
  }
  const onDockHeaderPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return
    setDragging(false)
    const mid = window.innerWidth / 2
    const side = e.clientX < mid ? "left" : "right"
    if (side !== dockSide) {
      setDockSide(side)
      toast.success(`控制坞已停靠到${side === "left" ? "左" : "右"}侧`)
    }
  }
  const [dragging, setDragging] = React.useState(false)
  const [dragX, setDragX] = React.useState(0)

  const statusPill = () => {
    if (phase === "live") {
      const stalled = stats.idle > 5000
      return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border",
          stalled
            ? "bg-amber-50 text-amber-700 border-amber-200"
            : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
          <span className="relative flex h-2 w-2">
            <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-75", stalled ? "bg-amber-400" : "bg-emerald-400", "animate-ping")} />
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", stalled ? "bg-amber-500" : "bg-emerald-500")} />
          </span>
          {stalled ? "等待画面…" : "已连接"}
          <span className="opacity-60 font-normal">{stats.fps}fps · {stats.kbps}KB/s</span>
        </span>
      )
    }
    if (phase === "connecting") return <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs text-teal-700"><Loader2 className="h-3 w-3 animate-spin" /> 建立通道…</span>
    if (phase === "reconnecting") return <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-700"><RefreshCw className="h-3 w-3 animate-spin" /> 重连中 {retryIn}s（自动重新取票）</span>
    if (phase === "error") return <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700"><TriangleAlert className="h-3 w-3" /> 连接异常</span>
    return <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">未连接</span>
  }

  // 会话时长策略胶囊：票据 60s = 建连窗口；此处展示的是"连接总时长上限"（三级策略，默认不限）
  const sessionPill = () => {
    if (phase !== "live" && phase !== "connecting") return null
    if (sessionLeft < 0) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600" title="连接总时长不受限（未命中沙箱/用户/用户组时长策略）。票据 60 秒时效仅为取票→建连窗口，与连接时长无关。">
          <Timer className="h-3 w-3 text-teal-600" /> 会话时长：不限
        </span>
      )
    }
    const warn = sessionLeft <= 60
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
        warn ? "bg-red-50 text-red-700 border-red-200 animate-pulse" : "bg-sky-50 text-sky-700 border-sky-200")}
        title={`来源：${sessionLimitRef.current.source}。到期自动断开（服务端双保险）。`}>
        <Timer className="h-3 w-3" /> 剩余 {fmtCountdown(sessionLeft)}
        <span className="font-normal opacity-70">· {sessionLimitRef.current.source}</span>
      </span>
    )
  }

  const status = workspace.status
  const dockWidth = 288

  return (
    <div className="space-y-3">
      {/* ===== 顶部亮色状态栏（企业级浅色主题） ===== */}
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 pr-2 mr-1 border-r border-slate-200">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 shadow-sm">
              <ShipWheel className="h-4 w-4 text-white" strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-tight text-slate-800">HelmPort<span className="ml-1 text-[10px] font-normal text-teal-600 align-middle">by Dockyard</span></div>
              <div className="text-[10px] text-slate-400 max-w-40 truncate">{workspace.name} · {workspace.ownerName}</div>
            </div>
          </div>

          {statusPill()}
          {sessionPill()}

          {readonly && (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
              <Eye className="h-3 w-3 mr-1" /> 只读镜像（服务端拦截输入）
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {phase === "live" || phase === "connecting" ? (
              <Button size="sm" variant="outline" className="h-8 border-red-200 bg-red-50 text-red-700 hover:bg-red-100" onClick={disconnect}>
                断开
              </Button>
            ) : (
              <Button size="sm" className="h-8 bg-gradient-to-r from-teal-500 to-emerald-600 text-white font-semibold hover:from-teal-400 hover:to-emerald-500 disabled:opacity-40"
                disabled={status !== "RUNNING" && status !== "IDLE"} onClick={() => connect()}>
                <Radio className="h-3.5 w-3.5 mr-1" /> 接入桌面
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8" onClick={screenshot} title="截图（含归属水印签名条）">
              <Camera className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={toggleFullscreen} title="全屏">
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        {/* 次级信息行（亮色） */}
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1 font-mono text-teal-700">
            <Monitor className="h-3 w-3" />
            {desktop ? `${desktop.width}×${desktop.height} · ${desktop.screens.length} 显示器` : "分辨率待协商"}
          </span>
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="h-3 w-3 text-teal-600" /> 单次票据 · 60s 建连窗口（与连接时长无关）
          </span>
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3 text-teal-600" /> 剪贴板逐沙箱隔离
          </span>
          <span className="inline-flex items-center gap-1">
            <Anchor className="h-3 w-3 text-teal-600" /> 纯 TCP/WS 链路（无 UDP）
          </span>
          <span className="ml-auto font-mono text-slate-400">DEV-{deviceTag()}</span>
        </div>
      </div>

      {/* ===== 主体：画布舞台 + 侧边控制坞 ===== */}
      <div className={cn("relative", isMobile ? "" : "flex gap-3")}>
        {/* ===== 画面舞台（远程桌面内容区） ===== */}
        <div ref={stageRef} tabIndex={0}
          onKeyDown={onStageKeyDown} onKeyUp={onStageKeyUp}
          onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp}
          onWheel={onStageWheel}
          onTouchStart={onStageTouchStart} onTouchMove={onStageTouchMove} onTouchEnd={onStageTouchEnd}
          onContextMenu={(e) => e.preventDefault()}
          className={cn("relative overflow-hidden rounded-xl border border-slate-300 bg-[#070b0e] outline-none transition-shadow select-none",
            phase === "live" ? "shadow-[0_2px_20px_-6px_rgba(13,148,136,0.35)] cursor-default" : "",
            isMobile ? "w-full" : cn("flex-1 min-w-0", !dockOpen && "w-full"),
            fullscreen ? "flex h-screen w-screen items-center justify-center" : "")}>
          {/* 画布：自适应缩放或 1:1 */}
          <div className={cn("flex w-full items-center justify-center overflow-auto", phase === "live" ? "min-h-0" : "min-h-[340px] sm:min-h-[420px] md:min-h-[520px]")}>
            <canvas
              ref={canvasRef}
              width={1280}
              height={800}
              className={cn(
                "block",
                phase === "live" && scaleFit ? "max-w-full h-auto" : "",
                phase !== "live" ? "invisible absolute" : "",
              )}
            />
          </div>

          {/* 输入法捕获输入框（覆盖画布、透明、不拦截指针；本地 IME 组合 → Unicode 注入） */}
          <input
            ref={imeInputRef}
            lang={imeLang}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="远程桌面输入法输入通道"
            onCompositionStart={onImeStart}
            onCompositionEnd={onImeEnd}
            className="pointer-events-none absolute left-1/2 top-1/2 h-px w-px opacity-0"
          />

          {/* 状态遮罩（亮色卡片风格） */}
          {phase !== "live" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-slate-900/95 via-slate-800/95 to-slate-900/95 backdrop-blur-[2px]">
              {phase === "idle" && (
                <>
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400/20 to-emerald-600/20 border border-teal-500/30">
                    <ShipWheel className="h-8 w-8 text-teal-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-100">HelmPort 远程桌面 · {workspace.name}</p>
                  <p className="max-w-md px-6 text-center text-xs leading-relaxed text-slate-400">
                    会话经统一网关中转（工作区 UUID + HMAC 单次票据双因子校验），原始内网地址不暴露。全链路纯 TCP/WS，无 UDP。
                    {readonly && " 您持有只读授权：画面镜像可见，键鼠与剪贴板输入将被服务端丢弃。"}
                  </p>
                  {(status === "RUNNING" || status === "IDLE") ? (
                    <Button onClick={() => connect()} className="bg-gradient-to-r from-teal-500 to-emerald-600 text-white font-semibold hover:from-teal-400">
                      <Radio className="h-4 w-4 mr-1.5" /> 立即接入
                    </Button>
                  ) : (
                    <Badge variant="outline" className="border-slate-600 text-slate-400">会话未运行（{status}）</Badge>
                  )}
                </>
              )}
              {phase === "connecting" && (
                <>
                  <Loader2 className="h-10 w-10 animate-spin text-teal-400" />
                  <p className="text-sm text-slate-200">正在建立通道…</p>
                  <p className="text-xs text-slate-500">取票 → 网关桥 → RFB 握手（版本协商/安全类型/像素格式）</p>
                </>
              )}
              {phase === "reconnecting" && (
                <>
                  <RefreshCw className="h-10 w-10 animate-spin text-amber-400" />
                  <p className="text-sm text-slate-200">连接中断，{retryIn} 秒后自动重连（重新取票）</p>
                  <Button size="sm" variant="outline" className="border-slate-600 text-slate-200" onClick={() => { if (retryRef.current.timer) clearTimeout(retryRef.current.timer); connect() }}>
                    立即重试
                  </Button>
                </>
              )}
              {phase === "error" && (
                <>
                  <TriangleAlert className="h-10 w-10 text-red-400" />
                  <p className="max-w-md px-6 text-center text-sm text-red-300">{errMsg || "连接失败"}</p>
                  <Button size="sm" variant="outline" className="border-red-500/40 text-red-300 hover:bg-red-500/10" onClick={() => { retryRef.current.count = 0; connect() }}>
                    重新连接
                  </Button>
                </>
              )}
            </div>
          )}

          {/* 归属水印（平铺斜置） */}
          {watermark && (phase === "live" || phase === "connecting") && (
            <div className="pointer-events-none absolute inset-0 select-none overflow-hidden">
              {Array.from({ length: 5 }).map((_, r) => (
                <div key={r} className="absolute left-0 w-[200%] whitespace-nowrap text-[11px] font-medium tracking-wider text-white/[0.07] -rotate-[18deg]" style={{ top: `${r * 22 + 8}%`, marginLeft: `${(r % 2) * 12}%` }}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span key={i} className="mr-24 inline-block">{workspace.ownerName} · {new Date().toLocaleDateString()} · DEV-{deviceTag()}</span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* 画布角标 HUD（深色小片，覆盖在远程画面上，非控制栏） */}
          {phase === "live" && (
            <>
              <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-950/70 px-2 py-0.5 font-mono text-[10px] text-teal-300/80 backdrop-blur">
                RFB · {workspace.uuid.slice(0, 8)} · {inputMode === "touch" ? "TOUCH" : "POINTER"}{serverName ? ` · ${serverName.slice(0, 24)}` : ""}
              </div>
              {imeComposing && (
                <div className="pointer-events-none absolute left-2 top-8 rounded-md bg-teal-500/90 px-2 py-0.5 text-[10px] font-medium text-white shadow">
                  输入法组合中（{IME_LANGS.find((l) => l.code === imeLang)?.label || imeLang}）→ 上屏自动注入
                </div>
              )}
              {lastKeys.length > 0 && (
                <div className="pointer-events-none absolute bottom-2 left-2 flex gap-1">
                  {lastKeys.map((k, i) => (
                    <span key={i} className="rounded bg-slate-950/70 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300/80 backdrop-blur">{k}</span>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 触屏手势提示 */}
          {inputMode === "touch" && phase === "live" && (
            <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-950/70 px-2 py-1 text-[10px] text-slate-300 backdrop-blur">
              单击=左键 · 长按=右键 · 拖动=移动
            </div>
          )}
        </div>

        {/* ===== 折叠态小箭头（桌面：侧缘竖条；移动端：底部悬浮按钮） ===== */}
        {!dockOpen && (
          isMobile ? (
            <button type="button" onClick={() => setDockOpen(true)}
              className="fixed bottom-5 right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-500/30 border border-white/40"
              title="展开控制坞" aria-label="展开控制坞">
              <ChevronsUp className="h-5 w-5" />
            </button>
          ) : (
            <button type="button" onClick={() => setDockOpen(true)}
              className={cn("sticky top-1/2 z-10 flex h-24 w-6 -translate-y-1/2 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm hover:text-teal-600 hover:border-teal-200 transition-colors",
                dockSide === "right" ? "" : "")}
              title="展开控制坞" aria-label="展开控制坞">
              <PanelRightOpen className={cn("h-4 w-4", dockSide === "left" && "rotate-180")} />
            </button>
          )
        )}

        {/* ===== 亮色控制坞（桌面侧栏可拖动停靠 / 移动端底部抽屉） ===== */}
        {dockOpen && (
          <aside
            className={cn(
              "z-20 rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60 flex flex-col",
              isMobile
                ? "fixed inset-x-0 bottom-0 max-h-[62vh] rounded-b-none border-x-0 border-b-0"
                : cn("shrink-0", dockSide === "left" ? "order-first" : ""),
              dragging ? "fixed top-1/2 -translate-y-1/2" : "",
            )}
            style={dragging && !isMobile ? { left: Math.max(8, Math.min(window.innerWidth - 60, dragX - dockWidth / 2)), width: dockWidth } : (!isMobile ? { width: dockWidth } : undefined)}
          >
            {/* 坞头（拖动手柄 + 开合） */}
            <div
              onPointerDown={onDockHeaderPointerDown}
              onPointerMove={onDockHeaderPointerMove}
              onPointerUp={onDockHeaderPointerUp}
              onPointerCancel={onDockHeaderPointerUp}
              className={cn("flex items-center gap-2 border-b border-slate-100 px-3 py-2 select-none", !isMobile && "cursor-grab active:cursor-grabbing")}
              title={isMobile ? "控制坞" : "拖动可停靠到左侧/右侧"}
            >
              <GripVertical className="h-4 w-4 text-slate-300" />
              <span className="text-xs font-semibold text-slate-700">控制坞</span>
              <span className="text-[10px] text-slate-400">{isMobile ? "底部抽屉" : "可拖动"}</span>
              <button type="button" onClick={() => setDockOpen(false)}
                className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                title="收起控制坞" aria-label="收起控制坞">
                <PanelRightClose className={cn("h-4 w-4", dockSide === "left" && "rotate-180")} />
              </button>
            </div>

            {/* 页签 */}
            <div className="flex border-b border-slate-100 px-2 pt-1.5 gap-1">
              {([["display", "显示", Monitor], ["input", "输入", Keyboard], ["clipboard", "剪贴板", Clipboard]] as const).map(([key, label, Icon]) => (
                <button key={key} type="button" onClick={() => setDockTab(key)}
                  className={cn("flex items-center gap-1 rounded-t-md px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                    dockTab === key ? "border-teal-500 text-teal-700 bg-teal-50/60" : "border-transparent text-slate-500 hover:text-slate-700")}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3 max-h-[46vh] md:max-h-none">
              {/* ---- 显示页签 ---- */}
              {dockTab === "display" && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500">多监视器分辨率（SetDesktopSize / EDS 协议）</Label>
                    <Select
                      value={desktop ? desktopToPresetKey(desktop) : undefined}
                      onValueChange={(k) => { const p = MONITOR_PRESETS.find((m) => m.key === k); if (p) applyMonitorPreset(p, true) }}
                      disabled={readonly || phase !== "live"}
                    >
                      <SelectTrigger className="h-9 text-xs" title="多监视器分辨率切换">
                        <Monitor className="h-3.5 w-3.5 mr-1 text-teal-600" />
                        <SelectValue placeholder={phase === "live" ? "选择分辨率布局" : "未连接"} />
                      </SelectTrigger>
                      <SelectContent>
                        <p className="px-2 py-1 text-[10px] text-muted-foreground">单屏</p>
                        {MONITOR_PRESETS.filter((p) => p.cols === 1).map((p) => (
                          <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                        ))}
                        <p className="px-2 py-1 text-[10px] text-muted-foreground border-t mt-1">多监视器</p>
                        {MONITOR_PRESETS.filter((p) => p.cols > 1).map((p) => (
                          <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                        ))}
                        {desktop && desktopToPresetKey(desktop) === "custom" && (
                          <SelectItem value="custom" disabled>自定义 {desktop.width}×{desktop.height} · {desktop.screens.length} 屏</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500">画质档位</Label>
                    <Select value={quality} onValueChange={setQuality} disabled={readonly}>
                      <SelectTrigger className="h-9 text-xs"><Zap className="h-3.5 w-3.5 mr-1 text-teal-600" /><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">流畅</SelectItem>
                        <SelectItem value="mid">均衡</SelectItem>
                        <SelectItem value="high">高清</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <span className="text-xs text-slate-600">自适应缩放（fit / 1:1）</span>
                    <button type="button" onClick={() => setScaleFit(!scaleFit)} disabled={readonly}
                      className={cn("relative h-5 w-9 rounded-full transition-colors", scaleFit ? "bg-teal-500" : "bg-slate-300")}>
                      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", scaleFit ? "left-[18px]" : "left-0.5")} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <span className="text-xs text-slate-600">归属溯源水印</span>
                    <button type="button" onClick={() => setWatermark(!watermark)}
                      className={cn("relative h-5 w-9 rounded-full transition-colors", watermark ? "bg-teal-500" : "bg-slate-300")}>
                      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", watermark ? "left-[18px]" : "left-0.5")} />
                    </button>
                  </div>
                </>
              )}

              {/* ---- 输入页签（输入法 IME + 指针模式） ---- */}
              {dockTab === "input" && (
                <>
                  <div className="flex items-center rounded-lg border border-slate-100 bg-slate-50/60 p-1">
                    <button type="button" onClick={() => setInputMode("mouse")} disabled={!canOperate}
                      className={cn("flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors", inputMode === "mouse" ? "bg-teal-500 text-white shadow-sm" : "text-slate-500 hover:text-slate-700")}
                      title="鼠标指针模式（PC 默认）">
                      <MousePointer2 className="h-3.5 w-3.5" /> 鼠标模式
                    </button>
                    <button type="button" onClick={() => setInputMode("touch")} disabled={!canOperate}
                      className={cn("flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors", inputMode === "touch" ? "bg-teal-500 text-white shadow-sm" : "text-slate-500 hover:text-slate-700")}
                      title="触屏模式（移动端默认：长按=右键 拖动=移动）">
                      <Hand className="h-3.5 w-3.5" /> 触屏模式
                    </button>
                  </div>

                  <div className="rounded-lg border border-teal-100 bg-teal-50/50 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Languages className="h-4 w-4 text-teal-600" />
                      <span className="text-xs font-semibold text-slate-700">输入法（IME）</span>
                      <button type="button" onClick={() => setImeEnabled(!imeEnabled)}
                        className={cn("ml-auto relative h-5 w-9 rounded-full transition-colors", imeEnabled ? "bg-teal-500" : "bg-slate-300")}
                        title={imeEnabled ? "开启：在远程画面上直接使用本地输入法打字（组合上屏自动注入）" : "关闭：仅按键直发"}>
                        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", imeEnabled ? "left-[18px]" : "left-0.5")} />
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-slate-500">
                      开启后点击远程画面即可用本机输入法（中文/日文/韩文/英/法/德/俄等全部常用语言）直接打字，组合上屏瞬间逐字注入当前沙箱 —— 仅作用于本沙箱（{workspace.uuid.slice(0, 8)}），与其他沙箱完全隔离互不影响。
                    </p>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-slate-500">输入语言（切换移动端键盘布局 / 桌面输入法关联）</Label>
                      <Select value={imeLang} onValueChange={(v) => setImeLang(v)}>
                        <SelectTrigger className="h-8 text-xs"><Languages className="h-3 w-3 mr-1 text-teal-600" /><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {IME_LANGS.map((l) => (
                            <SelectItem key={l.code} value={l.code}>
                              <span className="flex items-center gap-2">{l.label}<span className="text-[10px] text-muted-foreground">{l.hint}</span></span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {imeEnabled && phase === "live" && (
                      <button type="button" onClick={() => imeInputRef.current?.focus({ preventScroll: true })}
                        className="w-full rounded-md border border-teal-200 bg-white px-2 py-1.5 text-[11px] text-teal-700 hover:bg-teal-50">
                        点击聚焦输入法通道（当前：{IME_LANGS.find((l) => l.code === imeLang)?.label || imeLang}）
                      </button>
                    )}
                  </div>

                  <div className="space-y-1.5 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                    <Label className="text-xs text-slate-600">输入面板（移动端软键盘主通道）</Label>
                    <textarea
                      lang={imeLang}
                      value={imePanelText}
                      onChange={(e) => setImePanelText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendImePanel() } }}
                      disabled={!canOperate || phase !== "live"}
                      placeholder={`在此用本机输入法打字（${IME_LANGS.find((l) => l.code === imeLang)?.label || ""}），回车或点击发送注入远程桌面…`}
                      className="min-h-16 w-full rounded-md border border-slate-200 bg-white p-2 text-sm focus:border-teal-400 focus:outline-none"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={sendImePanel} disabled={!canOperate || phase !== "live" || !imePanelText.trim()}
                        className="bg-teal-600 text-white hover:bg-teal-500 h-8">
                        <Send className="h-3.5 w-3.5 mr-1" /> 发送到远程
                      </Button>
                      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
                        <input type="checkbox" checked={imePanelSendEnter} onChange={(e) => setImePanelSendEnter(e.target.checked)} className="accent-teal-500 h-3 w-3" />
                        发送后附加回车
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* ---- 剪贴板页签（双通道 + 沙箱隔离标识） ---- */}
              {dockTab === "clipboard" && (
                <>
                  <div className="flex items-center gap-2 rounded-lg border border-teal-100 bg-teal-50/50 px-3 py-2">
                    <Lock className="h-3.5 w-3.5 text-teal-600" />
                    <span className="text-[11px] text-slate-600">剪贴板已按沙箱隔离：缓冲仅属于当前会话（{workspace.uuid.slice(0, 8)}），任何其他沙箱/用户无法读取，桥服务端逐连接独立缓冲。</span>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500">投递到远程桌面（UTF-8 全字符 · 上限 5000 字）</Label>
                    <textarea
                      className="min-h-20 w-full rounded-md border border-slate-200 bg-white p-2 text-sm focus:border-teal-400 focus:outline-none"
                      placeholder="粘贴要投递到远程桌面的文本…"
                      value={clipboardText}
                      onChange={(e) => setClipboardText(e.target.value)}
                      disabled={!canOperate}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={sendClipboard} disabled={!canOperate} className="bg-teal-600 text-white hover:bg-teal-500 h-8">
                        <Clipboard className="h-3.5 w-3.5 mr-1" /> 投递
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => rfbRef.current?.requestRemoteClipboard()} disabled={!canOperate} className="h-8">
                        拉取远程剪贴板
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500">远程桌面回传（仅本沙箱缓冲）</Label>
                    <textarea
                      className="min-h-20 w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-sm font-mono text-emerald-700"
                      placeholder="远程桌面回传的剪贴板内容将显示在这里…"
                      value={clipboardReceived}
                      readOnly
                    />
                    <Button size="sm" variant="outline" disabled={!clipboardReceived} className="h-8"
                      onClick={() => { navigator.clipboard.writeText(clipboardReceived).then(() => toast.success("已复制到本地剪贴板")).catch(() => toast.error("复制失败")) }}>
                      复制回传内容
                    </Button>
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-400 border-t border-slate-100 pt-2">
                    双通道：自研 RFB QEMU 扩展直达（UTF-8 + zlib）与平台审计中转（管理员全局开关管控、操作留痕）互为兜底；两通道均以工作区为隔离边界。
                  </p>
                </>
              )}
            </div>

            {/* 坞脚：快捷状态 */}
            <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
              <Keyboard className="h-3 w-3" /> {canOperate ? "点击画面获得键盘焦点" : "只读会话（输入被服务端丢弃）"}
              <span className="ml-auto font-mono">{phase === "live" ? `${stats.fps}fps` : "--"}</span>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
