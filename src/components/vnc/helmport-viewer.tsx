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
  Anchor, Camera, Clipboard, ClipboardPaste, Expand, Minimize2, RefreshCw, Loader2,
  MousePointer2, Hand, ShieldCheck, Eye, TriangleAlert, Zap, Radio, Keyboard, ShipWheel, Monitor,
  Languages, Timer, GripVertical, Send, PanelRightClose, PanelRightOpen, Lock, ChevronsUp,
  Crosshair, CircleDot, AppWindow, Globe, Volume2, VolumeX, VolumeOff, EyeOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { MonitorBanner } from "@/components/vnc/monitor-banner"
import { ImeSwitcher } from "./ime-switcher"
import { ShortcutPanel } from "./shortcut-panel"
import { VirtualKeyboard } from "./virtual-keyboard"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { getVncTicketAction } from "@/server/actions/workspaces"
import { manualRecordingStatusAction, manualRecordingControlAction } from "@/server/actions/recordings"
import { HelmPortRfb, edsResultMessage, type RfbDesktopSize, type RfbScreen } from "./helmport/rfb-client"
import { keysymFor } from "./helmport/keysyms"
import { cn } from "@/lib/utils"

export interface HelmPortWorkspace {
  id: string
  uuid: string
  name: string
  status: string
  /** r33：错误/回收原因（ERROR/DESTROYED 态在遮罩中直接给出可操作解释） */
  crashCategory?: string | null
  freezeReason?: string | null
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

export interface HelmPortServerPolicy {
  defaultMode: "auto" | "mouse" | "touch" // 服务端默认输入模式（workspace.vncDefaultMode）
  forceMode: "" | "mouse" | "touch" // 服务端强制输入模式（workspace.vncForceMode；空=不强制）
  watermark: boolean // 服务端水印默认（workspace.vncWatermark）
  autoQuality: boolean // 服务端自适应画质（workspace.vncAutoQuality；false=手动画质）
}

export function HelmPortViewer({ workspace, serverPolicy, allowWebKiosk, allowVncAudio = true }: { workspace: HelmPortWorkspace; serverPolicy?: HelmPortServerPolicy; allowWebKiosk?: boolean; allowVncAudio?: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  // r35：根容器 ref（全屏容器化 —— 全屏/沉浸后顶部功能栏与控制坞依然可见可用）
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  // r35：物理键盘自动抓取（window 级捕获：沉浸/非沉浸一致，无需先点舞台聚焦）
  const keyboardCaptureRef = React.useRef(false)
  const shortcutRecordingRef = React.useRef(false)
  const rfbRef = React.useRef<HelmPortRfb | null>(null)
  const statsRef = React.useRef({ frameTimes: [] as number[], bytesIn: 0, bytesOut: 0, lastMsgAt: 0 })
  const retryRef = React.useRef({ count: 0, timer: null as ReturnType<typeof setTimeout> | null, manual: false })
  const connectStartRef = React.useRef(Date.now()) // r23：建连起点（自适应画质 RTT 样本）
  const phaseRef = React.useRef<Phase>("idle")
  const buttonMaskRef = React.useRef(0)
  const touchRef = React.useRef<{ x: number; y: number; moved: boolean; timer: ReturnType<typeof setTimeout> | null; longFired: boolean } | null>(null)

  const [phase, setPhaseState] = React.useState<Phase>("idle")
  const [errMsg, setErrMsg] = React.useState("")
  const [retryIn, setRetryIn] = React.useState(0)
  const [stats, setStats] = React.useState({ fps: 0, kbps: 0, idle: 0 })
  const [fullscreen, setFullscreen] = React.useState(false)
  const [immersive, setImmersive] = React.useState(false) // 沉浸模式：全屏+指针锁定+键盘抓取（Esc 退出）
  // r35：物理键盘自动抓取开关（默认开；live 后无需点击舞台即转发按键）
  const [kbCapture, setKbCapture] = React.useState(false)
  // r35：网页模式（纯网页内容显示：隐藏全部控制栏/坞/浮层，不弹任何弹窗；管理员允许时可用）
  const [webOnly, setWebOnly] = React.useState(false)
  // r35：HUD 角标可隐藏（"左上角 RFB 标识挡住内容"用户诉求）
  const [hudOn, setHudOn] = React.useState(true)
  // r35：远程声音回传（<audio> 流式播放 + 静音/音量控制）
  const [audio, setAudio] = React.useState({ on: false, muted: false, volume: 0.8 })
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const [lastKeys, setLastKeys] = React.useState<string[]>([])
  const [clipboardText, setClipboardText] = React.useState("")
  const [clipboardReceived, setClipboardReceived] = React.useState("")
  const [pulling, setPulling] = React.useState(false)
  const [serverName, setServerName] = React.useState("")
  // —— 多监视器分辨率切换 ——
  const [desktop, setDesktop] = React.useState<RfbDesktopSize | null>(null)
  const pendingResizeRef = React.useRef<string | null>(null) // 用户发起的切换请求（结果 toast 用）
  const appliedPresetRef = React.useRef<string | null>(null) // 连接后已自动应用的偏好（避免重复下发）

  // —— r33：真·适配缩放（双向等比）：修复「显示分辨率有问题」 ——
  // 旧实现 max-w-full h-auto 只缩不小、高方向无约束 → 窄窗/高分屏出现溢出或模糊。
  // 新实现：桌面端 live 态给舞台固定视口高度，ResizeObserver 实时计算
  //   scale = min(舞台宽/帧宽, 舞台高/帧高)（可放大可缩小，严格等比无拉伸）；
  //   移动端保持宽度适配（页面滚动）。
  const [stageBox, setStageBox] = React.useState<{ w: number; h: number } | null>(null)
  const fitScale = React.useMemo(() => {
    if (!stageBox || !desktop || desktop.width < 1 || desktop.height < 1) return null
    const s = Math.min(stageBox.w / desktop.width, stageBox.h / desktop.height)
    return Number.isFinite(s) && s > 0.02 ? s : null
  }, [stageBox, desktop])

  // —— 企业级控制坞（亮色侧栏：小箭头开合 + 可拖动停靠 + 移动端底部抽屉）——
  const [dockOpen, setDockOpen] = React.useState(true)
  const [dockSide, setDockSide] = React.useState<"left" | "right">("right")
  const [dockTab, setDockTab] = React.useState<"display" | "input" | "clipboard">("display")
  const [isMobile, setIsMobile] = React.useState(false)
  React.useEffect(() => {
    if (phase !== "live" || isMobile || fullscreen) { setStageBox(null); return }
    const el = stageRef.current
    if (!el) return
    const measure = () => setStageBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [phase, isMobile, fullscreen])
  const dragRef = React.useRef<{ startX: number; moved: boolean } | null>(null)

  // —— 输入法（IME）：本地组合捕获 → Unicode keysym 注入 ——
  const [imeEnabled, setImeEnabled] = React.useState(true)
  const [imeLang, setImeLang] = React.useState("zh-CN")
  const [imeComposing, setImeComposing] = React.useState(false)
  const [imePanelText, setImePanelText] = React.useState("")
  const [imePanelSendEnter, setImePanelSendEnter] = React.useState(false)
  const imeInputRef = React.useRef<HTMLInputElement | null>(null)
  const composingRef = React.useRef(false)

  // —— r31：在线软键盘（移动端/触屏主通道；桌面亦可用于快捷组合）——
  const [virtualKbOpen, setVirtualKbOpen] = React.useState(false)

  // —— r31：手动录屏（异步启动/停止 + 15s 状态轮询）——
  const [manualRec, setManualRec] = React.useState({ active: false, busy: false, startedAt: "" as string, segments: 0, canControl: true })

  // —— r31：全屏自动高清（进入全屏自动升档，退出恢复用户档位）——
  const preFullscreenQualityRef = React.useRef<string | null>(null)

  // —— 会话时长策略（连接窗口 60s 单次 / 会话总时长三级策略默认不限）——
  const sessionLimitRef = React.useRef({ maxSec: 0, source: "无限制（默认）", connectedAt: 0 })
  const [sessionLeft, setSessionLeft] = React.useState(-1) // -1=未连接或无限制

  const readonly = workspace.mySharePermission === "VIEW" && !workspace.isOwner && !workspace.isAdmin
  const canOperate = !readonly

  // ---- 会话偏好持久化（本地浏览器，不影响其他接入端）----
  // r23：服务端全局策略作为基线（workspace.vncDefaultMode/vncForceMode/vncWatermark/vncAutoQuality 真实生效）：
  //   默认值 = 服务端策略；本地偏好仅在服务端未强制时生效；强制项直接锁定
  const policy = serverPolicy
  const forcedMode = policy?.forceMode === "mouse" || policy?.forceMode === "touch" ? policy.forceMode : null
  const [quality, setQuality] = React.useState("mid")
  const [scaleFit, setScaleFit] = React.useState(true)
  const [watermark, setWatermark] = React.useState(policy ? policy.watermark : true)
  const [inputMode, setInputMode] = React.useState<"mouse" | "touch">(policy?.defaultMode === "mouse" ? "mouse" : policy?.defaultMode === "touch" ? "touch" : "mouse")

  const setPhase = (p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }

  React.useEffect(() => {
    try {
      // r23：服务端自适应画质（workspace.vncAutoQuality）：开启时忽略本地保存值，
      // 连接建立后按首个 RTT 样本自动选择（>150ms=low，50-150ms=mid，<50ms=high）
      if (policy?.autoQuality) {
        setQuality("mid") // 基线，连接后按 RTT 校正
      } else {
        const savedQ = localStorage.getItem(`hp-quality-${workspace.id}`)
        if (savedQ && QUALITY_MAP[savedQ]) setQuality(savedQ)
      }
      const savedScale = localStorage.getItem(`hp-scale-${workspace.id}`)
      if (savedScale === "fit" || savedScale === "1:1") setScaleFit(savedScale === "fit")
      if (!policy || policy.watermark) {
        const savedWm = localStorage.getItem(`hp-wm-${workspace.id}`)
        if (savedWm === "0") setWatermark(false)
      }
      if (forcedMode) {
        setInputMode(forcedMode) // 服务端强制输入模式：本地偏好失效
      } else {
        const savedMode = localStorage.getItem(`vnc-mode-${workspace.id}`)
        if (savedMode === "mouse" || savedMode === "touch") setInputMode(savedMode)
        else if (policy?.defaultMode && policy.defaultMode !== "auto") setInputMode(policy.defaultMode)
        else if ("ontouchstart" in window || navigator.maxTouchPoints > 0) setInputMode("touch")
      }
      const savedSide = localStorage.getItem("hp-dock-side")
      if (savedSide === "left" || savedSide === "right") setDockSide(savedSide)
      const savedLang = localStorage.getItem(`hp-ime-lang-${workspace.id}`)
      if (savedLang && IME_LANGS.some((l) => l.code === savedLang)) setImeLang(savedLang)
      const savedDock = localStorage.getItem("hp-dock-open")
      const savedHud = localStorage.getItem(`hp-hud-${workspace.id}`)
      if (savedHud !== null) setHudOn(savedHud === "1")
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
    connectStartRef.current = Date.now() // r23：建连起点（自适应画质 RTT 样本）
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
          // r23：自适应画质（workspace.vncAutoQuality）：建连耗时作为 RTT 样本 → 自动档位
          if (policy?.autoQuality) {
            const rttMs = Date.now() - connectStartRef.current
            if (Number.isFinite(rttMs)) {
              const pick = rttMs > 6000 ? "low" : rttMs > 2500 ? "mid" : "high"
              setQuality(pick)
            }
          }
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

  // ---- r31：手动录屏状态轮询（连接期间 15s；断开即停止轮询）----
  React.useEffect(() => {
    if (phase !== "live" || readonly) return
    let stop = false
    const poll = async () => {
      try {
        const res = await manualRecordingStatusAction({ workspaceId: workspace.id })
        if (!stop && res.code === 0 && res.data) {
          setManualRec((m) => ({ ...m, active: res.data!.active, startedAt: res.data!.startedAt || "", segments: res.data!.segments, canControl: res.data!.canControl }))
        }
      } catch { /* 轮询失败静默 */ }
    }
    void poll()
    const t = setInterval(poll, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [phase, readonly, workspace.id])

  // r35：定时录屏 —— maxMinutes（0=不限时长）；录制中点击=停止
  const toggleManualRecording = async (maxMinutes = 0) => {
    if (manualRec.busy) return
    if (!canOperate || !manualRec.canControl) { toast.error("仅所有者/操作共享/管理员可控制录屏"); return }
    if (phase !== "live") { toast.error("请先接入远程桌面"); return }
    setManualRec((m) => ({ ...m, busy: true }))
    try {
      const res = await manualRecordingControlAction({ workspaceId: workspace.id, op: manualRec.active ? "stop" : "start", ...(maxMinutes > 0 ? { maxMinutes } : {}) })
      if (res.code === 0 && res.data) {
        toast.success(res.data.message)
        setManualRec((m) => ({ ...m, active: res.data!.active, busy: false }))
      } else {
        toast.error(res.msg || "录屏操作失败")
        setManualRec((m) => ({ ...m, busy: false }))
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "录屏操作失败")
      setManualRec((m) => ({ ...m, busy: false }))
    }
  }

  // ---- r31：全屏自动高清（进入全屏 → 自动升高清 + fit 缩放；退出 → 恢复用户档位）----
  // 无感自适应：全屏大屏观看场景带宽充足，自动升档避免低清拉伸发糊
  React.useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement
      setFullscreen(fs)
      if (fs) {
        preFullscreenQualityRef.current = quality
        setQuality("high")
        setScaleFit(true)
      } else {
        const prev = preFullscreenQualityRef.current
        if (prev && QUALITY_MAP[prev]) setQuality(prev)
      }
    }
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [quality])

  // r35：沉浸模式重写 —— ①全屏对象从"舞台"改为"整个查看器根容器"（全屏后顶部功能栏/
  // 控制坞/软键盘全部保留可见可用，修复"全屏只有画面、功能都消失"）②物理键盘 window 级
  // 抓取（不再只依赖舞台聚焦 —— 修复"沉浸/非沉浸都不能自动抓取键盘"）③pointerlockchange
  // 监听（Esc 解锁后 immersive 状态正确复位，修复状态错乱反复重启观感）
  const toggleImmersive = async () => {
    try {
      if (immersive) {
        document.exitPointerLock?.()
        if (document.fullscreenElement) await document.exitFullscreen()
        setImmersive(false)
        toast.success("已退出沉浸模式")
      } else {
        if (!document.fullscreenElement) await rootRef.current?.requestFullscreen?.()
        await stageRef.current?.requestPointerLock?.()
        setImmersive(true)
        setKbCapture(true)
        toast.success("沉浸模式：全屏容器 + 键鼠抓取（Esc 退出）")
      }
    } catch {
      toast.error("当前环境不允许沉浸模式")
    }
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await rootRef.current?.requestFullscreen()
    } catch { toast.error("当前环境不允许全屏") }
  }

  // r35：指针锁状态监听 —— Esc 解锁时自动复位沉浸态（沉浸=全屏+锁指针，二者之一退出都算退出）
  React.useEffect(() => {
    const onPl = () => {
      if (!document.pointerLockElement && immersive) setImmersive(false)
    }
    document.addEventListener("pointerlockchange", onPl)
    return () => document.removeEventListener("pointerlockchange", onPl)
  }, [immersive])

  // r35：物理键盘 window 级自动抓取 —— live 即抓取（沉浸/非沉浸一致），焦点无关：
  //   · 跳过：IME 组合中 / 本地输入框聚焦（地址栏搜索、快捷键录制、软键盘输入）
  //   · Esc：沉浸模式退出用（不转发）；F11 保留本地全屏
  //   · 网页模式（webOnly）下不抓取（"不接收打开其他功能的快捷键，保留复制等基本操作"）
  React.useEffect(() => {
    keyboardCaptureRef.current = kbCapture
  }, [kbCapture])
  React.useEffect(() => {
    if (phase !== "live" || !canOperate || readonly || webOnly) {
      setKbCapture(false)
      return
    }
    // r35：连接成功后默认开启物理键盘自动抓取（用户诉求"电脑端要能够直接就自动抓取键盘和鼠标的按键"）
    setKbCapture(true)
    const isEditableTarget = (el: EventTarget | null) => {
      const n = el as HTMLElement | null
      if (!n || !n.tagName) return false
      const t = n.tagName.toLowerCase()
      return t === "input" || t === "textarea" || t === "select" || n.isContentEditable
    }
    const onWinKeyDown = (e: KeyboardEvent) => {
      if (!keyboardCaptureRef.current) return
      if (e.isComposing || composingRef.current) return
      if (isEditableTarget(e.target)) return
      if (shortcutRecordingRef.current) return
      const keysym = keysymFor(e)
      if (keysym !== null) {
        // Esc 保留本地（退出沉浸/指针锁）；F11 保留本地全屏切换
        if (e.key === "F11") return
        e.preventDefault()
        rfbRef.current?.sendKey(keysym, true)
        const name = e.key === " " ? "Space" : e.key === "Enter" ? "Enter" : e.key.length === 1 ? e.key : e.key.replace("Arrow", "↑")
        setLastKeys((k) => [...k.slice(-5), name])
      }
    }
    const onWinKeyUp = (e: KeyboardEvent) => {
      if (!keyboardCaptureRef.current) return
      if (e.isComposing || composingRef.current) return
      if (isEditableTarget(e.target)) return
      if (shortcutRecordingRef.current) return
      if (e.key === "F11") return
      const keysym = keysymFor(e)
      if (keysym !== null) {
        e.preventDefault()
        rfbRef.current?.sendKey(keysym, false)
      }
    }
    window.addEventListener("keydown", onWinKeyDown, { capture: true })
    window.addEventListener("keyup", onWinKeyUp, { capture: true })
    return () => {
      window.removeEventListener("keydown", onWinKeyDown, { capture: true } as EventListenerOptions)
      window.removeEventListener("keyup", onWinKeyUp, { capture: true } as EventListenerOptions)
    }
  }, [phase, canOperate, readonly, webOnly])

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
  // r35：去掉 inputMode === "touch" 对鼠标事件的否决 —— 触屏设备外接鼠标（或触屏笔）
  // 也能正常拖动/选择远程网页文本（用户诉求"鼠标模式都无法拖动、选择网页上的字符"）
  const onStageMouseDown = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate) return
    e.preventDefault()
    const btn = e.button === 0 ? BTN_LEFT : e.button === 1 ? 2 : e.button === 2 ? BTN_RIGHT : 0
    buttonMaskRef.current |= btn
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }
  const onStageMouseMove = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate) return
    const { x, y } = toFbCoords(e.clientX, e.clientY)
    rfbRef.current?.sendPointer(x, y, buttonMaskRef.current)
  }
  const onStageMouseUp = (e: React.MouseEvent) => {
    if (phase !== "live" || !canOperate) return
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
  // r31 即时输入：非组合状态下（英文/数字等无 IME 语言）每次 input 直接上屏，手机/平板打字无需点发送。
  const onImeStart = () => {
    composingRef.current = true
    setImeComposing(true)
  }
  const onImeInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (composingRef.current) return // 组合中：上屏时统一处理
    const val = e.currentTarget.value
    if (!val) return
    const n = rfbRef.current?.sendUnicodeText(val) ?? 0
    if (n > 0) {
      setLastKeys((k) => [...k.slice(-5), ...Array.from(val).slice(-3)])
      e.currentTarget.value = "" // 清空缓冲（即时模式：打完即发）
    }
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
  // ---- r31：多行文本注入（换行→文本段 + Enter 键序列；剪贴板/输入面板共用）----
  const sendTextWithNewlines = (text: string): number => {
    const rfb = rfbRef.current
    if (!rfb) return 0
    const lines = text.split("\n")
    let sent = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r/g, "")
      if (line) sent += rfb.sendUnicodeText(line) || 0
      if (i < lines.length - 1) {
        rfb.sendKey(0xff0d, true)
        rfb.sendKey(0xff0d, false)
      }
    }
    return sent
  }

  // 面板输入框：显式键入（移动端软键盘主通道）—— 点发送注入，可选回车
  const sendImePanel = () => {
    const text = imePanelText.replace(/[\r]+/g, "").replace(/\n{3,}/g, "\n\n").trim()
    if (!text) { toast.error("请先输入要发送的文本"); return }
    const multi = text.includes("\n")
    const n = multi ? sendTextWithNewlines(text) : (rfbRef.current?.sendUnicodeText(text) ?? 0)
    if (imePanelSendEnter) {
      rfbRef.current?.sendKey(0xff0d, true)
      rfbRef.current?.sendKey(0xff0d, false)
    }
    if (n > 0) {
      toast.success(`已发送 ${n} 个字符${multi ? "（含换行）" : ""}${imePanelSendEnter ? " + 回车" : ""}`)
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

  // ---- 剪贴板双通道：RFB 扩展直达 + 平台中转审计通道（逐沙箱隔离；UTF-8 多语言全字符） ----
  const sendClipboard = async () => {
    // 保留换行/制表（多语言文本常见格式），剔除其余控制字符；\n 由专用多行注入通道处理
    const cleaned = clipboardText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\r\n?/g, "\n")
    if (!cleaned) { toast.error("剪贴板内容为空"); return }
    const sliced = cleaned.slice(0, 5000)
    const lines = sliced.split("\n")
    let okCount = 0
    let channelInfo = ""
    // 通道1：自研 RFB 扩展剪贴板（QEMU 协议：UTF-8 全字符 + zlib；中文/日/韩/emoji 完整支持；仅本连接缓冲）
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
    if (okCount > 0) {
      // 多行文本：剪贴板缓冲携带完整换行内容（远程 Ctrl+V 原样粘贴）；
      // 不做按键注入（会与粘贴重复键出）；多语言/emoji 经 UTF-8+zlib 通道完整传输
      toast.success(`剪贴板已投递（${channelInfo || "未知通道"}${lines.length > 1 ? ` · ${lines.length} 行` : ""}）`)
    }
  }

  // ---- 拉取远程剪贴板（r34：双通道 —— RFB 扩展（已确认支持时）+ 平台 xclip 真实读取） ----
  const pullClipboard = async () => {
    if (pulling) return
    setPulling(true)
    try {
      // 通道1：RFB 扩展（服务端 Caps 已确认支持时才发送，防 x11vnc 断连）
      try { rfbRef.current?.requestRemoteClipboard() } catch { /* 降级平台通道 */ }
      // 通道2：平台中转（xclip 直读沙箱 X 剪贴板 —— r34 真实落地）
      try {
        const res = await fetch(`/api/vnc-proxy/clipboard?workspaceId=${encodeURIComponent(workspace.id)}`, { cache: "no-store" })
        const json = (await res.json()) as { code?: number; msg?: string; data?: { text?: string; channel?: string; reason?: string } }
        if (json.code === 0) {
          if (json.data?.text) {
            setClipboardReceived(json.data.text)
            toast.success(`已拉取沙箱剪贴板 ${json.data.text.length} 字（${json.data.channel}）`)
          } else {
            toast.info(json.data?.reason || "沙箱剪贴板当前为空")
          }
        } else {
          toast.error(json.msg || "拉取失败")
        }
      } catch {
        toast.error("平台中转通道不可用")
      }
    } finally {
      setPulling(false)
    }
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

  // r35：远程声音回传 —— <audio> 流式播放（GET /api/vnc-proxy/audio 长流）+ 静音/音量
  const toggleAudio = async () => {
    if (audio.on) {
      // 已开：点击 = 静音/取消静音；Shift+点击 = 关闭
      if (audio.muted) { setAudio((a) => ({ ...a, muted: false })); if (audioRef.current) audioRef.current.muted = false; return }
      // 单击在开启态默认静音；长按/shift 关闭 —— 简化：再点一次 = 静音切到关？行为：开→(点击)静音→(点击)恢复→右键关闭
      setAudio((a) => ({ ...a, muted: true }))
      if (audioRef.current) audioRef.current.muted = true
      return
    }
    try {
      const res = await fetch(`/api/vnc-proxy/audio?workspaceId=${workspace.id}`, { method: "POST" })
      const json = await res.json().catch(() => ({ code: 1, msg: "响应解析失败" }))
      if (json.code !== 0 || !json.data?.url) {
        toast.error(json.msg || "该沙箱暂无音频能力（未启用 pulseaudio 音频设备）")
        return
      }
      setAudio({ on: true, muted: false, volume: 0.8 })
      requestAnimationFrame(() => {
        const el = audioRef.current
        if (el) {
          el.src = json.data.url as string
          el.volume = 0.8
          el.muted = false
          void el.play().catch(() => toast.error("浏览器阻止了自动播放：请再点一次声音按钮"))
        }
      })
      toast.success("远程声音回传已开启")
    } catch {
      toast.error("音频通道建立失败")
    }
  }
  const stopAudio = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = "" }
    setAudio({ on: false, muted: false, volume: 0.8 })
  }

  // r35：网页模式切换（纯网页内容显示：隐藏全部控制 UI；仅管理员 allowWebKiosk 时可用）
  const enterWebOnly = () => {
    setWebOnly(true)
    setVirtualKbOpen(false)
    toast.success("网页模式：仅显示网页内容（按 Esc 或右下角按钮退出）")
  }
  const exitWebOnly = () => {
    setWebOnly(false)
    if (audioRef.current) { audioRef.current.pause(); setAudio((a) => ({ ...a, on: false })) }
  }

  return (
    <div
      ref={rootRef}
      onContextMenu={webOnly ? (e) => e.preventDefault() : undefined}
      className={cn(
        "space-y-3",
        // r35：全屏容器化 —— 全屏/沉浸时整个查看器成为全屏元素（功能栏/控制坞/软键盘全部保留）
        (fullscreen || immersive) && "fixed inset-0 z-50 flex flex-col space-y-2 overflow-hidden bg-slate-950 p-2 sm:p-3",
        // r35：网页模式 —— 纯网页内容铺满，除极简退出按钮外无任何 UI
        webOnly && "fixed inset-0 z-[60] m-0 overflow-hidden bg-black p-0",
      )}
      onKeyDown={webOnly ? (e) => { if (e.key === "Escape") exitWebOnly() } : undefined}>
      {/* r35：远程声音回传元素（隐藏；src 由 toggleAudio 动态设置） */}
      <audio ref={audioRef} preload="none" className="hidden" />

      {/* r29-b：知情模式监控横幅（静默特权对用户不可见；红点+一键切断） */}
      {!webOnly && !fullscreen && !immersive && <MonitorBanner workspaceId={workspace.id} />}

      {/* ===== r35：网页模式（纯网页内容）—— 只有画面 + 极简退出按钮，无任何其他弹窗 ===== */}
      {webOnly && (
        <>
          <div ref={stageRef} tabIndex={0} className="absolute inset-0 overflow-hidden bg-black outline-none"
            onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp} onWheel={onStageWheel}
            onTouchStart={onStageTouchStart} onTouchMove={onStageTouchMove} onTouchEnd={onStageTouchEnd}
            onContextMenu={(e) => e.preventDefault()}>
            <canvas ref={canvasRef} width={1280} height={800}
              style={fitScale ? { width: "100%", height: "100%", objectFit: "contain" } : undefined}
              className={cn("block h-full w-full", phase !== "live" && "invisible")} />
            {phase !== "live" && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">正在建立网页模式画面…</div>
            )}
          </div>
          {/* 极简退出按钮（半透明、右下角、不遮内容；键盘 Esc 退出已绑定） */}
          <button type="button" onClick={exitWebOnly}
            className="absolute bottom-3 right-3 z-[70] rounded-full bg-slate-900/70 px-4 py-2 text-xs font-medium text-white backdrop-blur transition-opacity hover:opacity-100 sm:opacity-40"
            title="退出网页模式（Esc）">
            退出网页模式
          </button>
        </>
      )}
      {/* ===== 顶部亮色状态栏（r35：网页模式下整条隐藏；按钮行改横向滑动防溢出） ===== */}
      {!webOnly && !fullscreen && !immersive ? (
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
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
            {/* r31：手动录屏（异步启动/停止；录制中红点脉冲） */}
            {canOperate && (
              <Button size="sm" variant={manualRec.active ? "default" : "outline"}
                className={cn("h-8 gap-1", manualRec.active && "bg-red-600 hover:bg-red-500 text-white")}
                onClick={(e) => {
                  // r35：定时录屏 —— Alt/右键点击可选定时时长；普通点击=不限时（或停止）
                  if (!manualRec.active && (e.altKey || e.type === "contextmenu")) {
                    const v = window.prompt("定时录屏：输入分钟数（5-720，留空或 0 = 不限时）", "30")
                    if (v === null) return
                    const mm = Math.max(0, Math.min(720, parseInt(v, 10) || 0))
                    void toggleManualRecording(mm)
                    return
                  }
                  void toggleManualRecording()
                }}
                onContextMenu={(e) => {
                  if (!manualRec.active) { e.preventDefault(); return }
                }}
                disabled={manualRec.busy || phase !== "live"}
                title={manualRec.active ? `手动录屏进行中（${manualRec.segments} 段）· 点击停止并入库` : "开始手动录屏（点击=不限时 · Alt+点击=定时 5-720 分钟，停止后自动入库回放）"}>
                {manualRec.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDot className={cn("h-3.5 w-3.5", manualRec.active && "animate-pulse")} />}
                {!isMobile && <span>{manualRec.active ? "录制中" : "录屏"}</span>}
              </Button>
            )}
            {/* r31：在线软键盘（移动端/触屏主通道；桌面亦可快捷组合） */}
            <Button size="sm" variant={virtualKbOpen ? "default" : "outline"} className="h-8"
              onClick={() => setVirtualKbOpen(!virtualKbOpen)}
              disabled={readonly || (phase !== "live" && phase !== "connecting")}
              title="在线软键盘（完整虚拟键盘：字母/符号/功能导航层 + 修饰键组合）">
              <AppWindow className="h-3.5 w-3.5" />
              {!isMobile && <span className="ml-1">软键盘</span>}
            </Button>
            {/* r24-c：输入法切换（作用域=本沙箱 X 显示；只读镜像禁用） */}
            <ImeSwitcher workspaceId={workspace.id} disabled={readonly || (phase !== "live" && phase !== "connecting")} />
            {/* r28：远程快捷键面板（40+ 内置 + 自定义录入，绕过本地抢占） */}
            <ShortcutPanel
              sendKey={(keysym, down) => rfbRef.current?.sendKey(keysym, down)}
              disabled={readonly || phase !== "live"}
            />
            {/* r35：物理键盘自动抓取（开=本页按键直发远程，无需点击画面聚焦；输入框聚焦自动放行） */}
            <Button size="sm" variant={kbCapture ? "default" : "outline"} className={cn("h-8 gap-1", isMobile && "px-2")} onClick={() => setKbCapture(!kbCapture)}
              disabled={readonly || phase !== "live"} title="物理键盘自动抓取：开启后本页按键直接转发远程桌面（输入框聚焦时自动放行本地输入）">
              <Keyboard className="h-3.5 w-3.5" />{!isMobile && <span className="ml-1">{kbCapture ? "抓键中" : "抓键"}</span>}
            </Button>
            {/* r35：远程声音回传（沙箱音频流 → 本地播放 + 静音/音量控制） */}
            {canOperate && allowVncAudio && (
              <Button size="sm" variant={audio.on ? "default" : "outline"} className={cn("h-8", isMobile && "px-2")} onClick={() => void toggleAudio()}
                disabled={phase !== "live"} title={audio.on ? (audio.muted ? "声音回传中（已静音）· 点击取消静音" : "声音回传中 · 点击静音") : "开启远程声音回传（沙箱音频 → 本地播放）"}>
                {audio.on && !audio.muted ? <Volume2 className="h-3.5 w-3.5" /> : audio.on ? <VolumeX className="h-3.5 w-3.5" /> : <VolumeOff className="h-3.5 w-3.5" />}
              </Button>
            )}
            {/* r35：网页模式（管理员允许时可用：只显示网页内容，隐藏全部控制界面） */}
            {allowWebKiosk && canOperate && (
              <Button size="sm" variant="outline" className={cn("h-8 gap-1", isMobile && "px-2")} onClick={enterWebOnly}
                disabled={phase !== "live"} title="网页模式：只显示网页内容不显示浏览器控制栏；期间不弹出任何其他界面（Esc 退出）">
                <Globe className="h-3.5 w-3.5" />{!isMobile && <span className="ml-1">网页模式</span>}
              </Button>
            )}
            <Button size="sm" variant={immersive ? "default" : "outline"} className={cn("h-8 gap-1", isMobile && "hidden")} onClick={toggleImmersive} title="沉浸模式（全屏+键鼠抓取，Esc 退出）">
              <Crosshair className="h-3.5 w-3.5" />{immersive ? "沉浸中" : "沉浸"}
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={toggleFullscreen} title="全屏">
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        {/* 次级信息行（亮色；移动端精简避免凌乱） */}
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1 font-mono text-teal-700">
            <Monitor className="h-3 w-3" />
            {desktop ? `${desktop.width}×${desktop.height} · ${desktop.screens.length} 显示器` : "分辨率待协商"}
            {phase === "live" && desktop && (
              <span className="text-slate-400" title="当前显示缩放（严格等比，无拉伸）">
                · 显示 {phase === "live" && scaleFit && !isMobile && !fullscreen && fitScale
                  ? `${Math.round(fitScale * 100)}%（适配）`
                  : scaleFit ? "宽度适配" : "1:1 原始像素"}
              </span>
            )}
          </span>
          {manualRec.active && (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-medium text-red-600" title="手动录屏进行中（VNC 工具栏发起）">
              <CircleDot className="h-3 w-3 animate-pulse" /> REC 手动录制中{manualRec.segments > 0 ? ` · ${manualRec.segments} 段` : ""}
            </span>
          )}
          <span className="hidden md:inline-flex items-center gap-1">
            <ShieldCheck className="h-3 w-3 text-teal-600" /> 单次票据 · 60s 建连窗口（与连接时长无关）
          </span>
          <span className="hidden lg:inline-flex items-center gap-1">
            <Lock className="h-3 w-3 text-teal-600" /> 剪贴板逐沙箱隔离
          </span>
          <span className="hidden lg:inline-flex items-center gap-1">
            <Anchor className="h-3 w-3 text-teal-600" /> 平台链路纯 TCP/WS（无 UDP）
          </span>
          <span className="ml-auto font-mono text-slate-400">DEV-{deviceTag()}</span>
        </div>
      </div>
      ) : null}

      {/* ===== r35：全屏/沉浸紧凑功能栏（容器化全屏后功能完整保留） ===== */}
      {!webOnly && (fullscreen || immersive) && (
      <div className="flex flex-nowrap shrink-0 items-center gap-1.5 overflow-x-auto rounded-xl border border-slate-700/60 bg-slate-900/85 px-2 py-1.5 shadow-lg backdrop-blur [scrollbar-width:thin]">
        <span className="shrink-0 text-xs font-semibold text-teal-400">HelmPort</span>
        {statusPill()}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {phase === "live" || phase === "connecting" ? (
            <Button size="sm" variant="outline" className="h-7 border-red-800 bg-red-950/50 text-red-300 hover:bg-red-900" onClick={disconnect}>断开</Button>
          ) : (
            <Button size="sm" className="h-7 bg-gradient-to-r from-teal-500 to-emerald-600 text-white" disabled={status !== "RUNNING" && status !== "IDLE"} onClick={() => connect()}>接入</Button>
          )}
          <Button size="sm" variant="outline" className="h-7" onClick={screenshot} title="截图（含归属水印）"><Camera className="h-3.5 w-3.5" /></Button>
          {canOperate && (
            <Button size="sm" variant={manualRec.active ? "default" : "outline"} className={cn("h-7 gap-1", manualRec.active && "bg-red-600 text-white hover:bg-red-500")} onClick={() => void toggleManualRecording()} disabled={manualRec.busy || phase !== "live"} title="手动录屏">
              <CircleDot className={cn("h-3.5 w-3.5", manualRec.active && "animate-pulse")} />
            </Button>
          )}
          <Button size="sm" variant={virtualKbOpen ? "default" : "outline"} className="h-7" onClick={() => setVirtualKbOpen(!virtualKbOpen)} disabled={readonly || (phase !== "live" && phase !== "connecting")} title="软键盘"><AppWindow className="h-3.5 w-3.5" /></Button>
          <ImeSwitcher workspaceId={workspace.id} disabled={readonly || (phase !== "live" && phase !== "connecting")} />
          <ShortcutPanel sendKey={(keysym, down) => rfbRef.current?.sendKey(keysym, down)} disabled={readonly || phase !== "live"} />
          <Button size="sm" variant={immersive ? "default" : "outline"} className="h-7 gap-1" onClick={toggleImmersive} title="沉浸模式（Esc 退出）"><Crosshair className="h-3.5 w-3.5" />沉浸</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={toggleFullscreen} title="全屏">{fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}</Button>
          <Button size="sm" variant={kbCapture ? "default" : "outline"} className="h-7 gap-1" onClick={() => setKbCapture(!kbCapture)} title="物理键盘自动抓取（开=本页按键直发远程；输入框聚焦时自动放行）"><Keyboard className="h-3.5 w-3.5" />抓键</Button>
          {allowWebKiosk && canOperate && (
            <Button size="sm" variant="outline" className="h-7 gap-1" onClick={enterWebOnly} title="网页模式：只显示网页内容，隐藏全部控制界面（Esc 退出）"><Globe className="h-3.5 w-3.5" />网页</Button>
          )}
        </div>
      </div>
      )}

      {/* ===== 主体：画布舞台 + 侧边控制坞（r35：网页模式隐藏） ===== */}
      {!webOnly && (
      <div className={cn("relative min-h-0 flex-1", isMobile ? "" : "flex gap-3")}>
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
            phase === "live" && !isMobile && !fullscreen ? "h-[calc(100dvh-14.5rem)] min-h-[420px]" : "", // r33：live 态舞台高度约束（双向适配缩放前提）
            fullscreen ? "flex h-screen w-screen items-center justify-center" : "")}>
          {/* 画布：r33 真·适配缩放 —— 桌面端 JS 等比双向缩放（可放大可缩小，无拉伸）；移动端宽度适配；1:1 原始尺寸可滚动 */}
          {/* r35：1:1 溢出四向可达 —— 内容 m-auto（flex 居中在溢出时会剪掉上/左侧无法滚到；
              m-auto 方案溢出时上下左右均可滚动，正常态依旧视觉居中） */}
          <div className={cn("overflow-auto w-full", phase === "live" ? (isMobile ? "min-h-0 flex" : "h-full min-h-0 flex") : "min-h-[340px] sm:min-h-[420px] md:min-h-[520px] flex")}>
            <div className="m-auto shrink-0">
            <canvas
              ref={canvasRef}
              width={1280}
              height={800}
              style={
                phase === "live" && scaleFit && !isMobile && !fullscreen && fitScale
                  ? { width: Math.round(desktop!.width * fitScale) + "px", height: Math.round(desktop!.height * fitScale) + "px" }
                  : undefined
              }
              className={cn(
                "block",
                phase === "live" && scaleFit && (isMobile || fullscreen || !fitScale) ? "max-w-full h-auto" : "",
                phase !== "live" ? "invisible absolute" : "",
              )}
            />
            </div>
          </div>

          {/* 输入法捕获输入框（覆盖画布、透明、不拦截指针；本地 IME 组合 → Unicode 注入；
              r31 即时输入：非组合状态每键直接上屏） */}
          <input
            ref={imeInputRef}
            lang={imeLang}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-label="远程桌面输入法输入通道"
            onCompositionStart={onImeStart}
            onCompositionEnd={onImeEnd}
            onInput={onImeInput}
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
                    会话经统一网关中转（工作区 UUID + HMAC 单次票据双因子校验），原始内网地址不暴露。平台链路全程 TCP/WS、无 UDP（浏览器沙箱内保持原生网络栈，不受影响）。
                    {readonly && " 您持有只读授权：画面镜像可见，键鼠与剪贴板输入将被服务端丢弃。"}
                  </p>
                  {(status === "RUNNING" || status === "IDLE") ? (
                    <Button onClick={() => connect()} className="bg-gradient-to-r from-teal-500 to-emerald-600 text-white font-semibold hover:from-teal-400">
                      <Radio className="h-4 w-4 mr-1.5" /> 立即接入
                    </Button>
                  ) : (
                    <div className="space-y-2 text-center">
                      {/* r33：错误/回收态给出可操作解释（NoVNC 完整 ERROR 报障增强） */}
                      <Badge variant="outline" className="border-amber-500/50 text-amber-300">会话未运行（{status}）</Badge>
                      {(workspace.crashCategory || workspace.freezeReason) && (
                        <p className="max-w-md px-4 text-[11px] leading-relaxed text-slate-400">
                          原因：{workspace.crashCategory || workspace.freezeReason}
                          {status === "DESTROYED" && " —— 会话已被闲置/到期回收，工作区配置与 Profile 已保留，可返回工作区列表重新启动；如需找回可联系管理员在后台「归还」。"}
                          {status === "ERROR" && " —— 上次拉起失败（常见于节点镜像缺失/资源不足），可稍后在工作区列表重试重建。"}
                        </p>
                      )}
                    </div>
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

          {/* 画布角标 HUD（深色小片，覆盖在远程画面上，非控制栏；r35 可一键隐藏防遮挡） */}
          {phase === "live" && (
            <>
              {hudOn && (
                <div className="pointer-events-auto absolute left-2 top-2 flex items-center gap-1 rounded-md bg-slate-950/70 px-2 py-0.5 font-mono text-[10px] text-teal-300/80 backdrop-blur">
                  <span className="pointer-events-none">RFB · {workspace.uuid.slice(0, 8)} · {inputMode === "touch" ? "TOUCH" : "POINTER"}{serverName ? ` · ${serverName.slice(0, 24)}` : ""}</span>
                  <button type="button" onClick={() => { setHudOn(false); try { localStorage.setItem(`hp-hud-${workspace.id}`, "0") } catch {} }}
                    className="rounded p-0.5 text-slate-400 hover:text-white" title="隐藏左上角标识（防遮挡网页内容；刷新后保持）">
                    <EyeOff className="h-3 w-3" />
                  </button>
                </div>
              )}
              {!hudOn && (
                <button type="button" onClick={() => { setHudOn(true); try { localStorage.setItem(`hp-hud-${workspace.id}`, "1") } catch {} }}
                  className="absolute left-2 top-2 rounded-md bg-slate-950/40 px-1.5 py-0.5 text-[10px] text-slate-500 opacity-40 hover:opacity-100" title="显示左上角状态标识">
                  <Eye className="h-3 w-3" />
                </button>
              )}
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

      {/* ===== r31：在线软键盘（r35：网页模式隐藏） ===== */}
        {!webOnly && virtualKbOpen && (
          <div className={cn(isMobile ? "fixed inset-x-0 bottom-0 z-30 p-2 pb-[env(safe-area-inset-bottom)]" : "w-full")}>
            <VirtualKeyboard
              sendKey={(keysym, down) => rfbRef.current?.sendKey(keysym, down)}
              disabled={readonly || phase !== "live"}
              onClose={() => setVirtualKbOpen(false)}
            />
          </div>
        )}

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
                ? "fixed inset-x-0 bottom-0 max-h-[62vh] rounded-b-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]"
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
                      <div className="space-y-1.5">
                        <button type="button" onClick={() => { try { imeInputRef.current?.focus({ preventScroll: true }) } catch { /* noop */ } }}
                          className="w-full rounded-md border border-teal-200 bg-white px-2 py-2 text-[11px] font-medium text-teal-700 hover:bg-teal-50">
                          唤起本机键盘（当前：{IME_LANGS.find((l) => l.code === imeLang)?.label || imeLang}）
                        </button>
                        <button type="button" onClick={() => { setVirtualKbOpen(!virtualKbOpen); if (isMobile) setDockOpen(false) }}
                          className="w-full rounded-md border border-slate-200 bg-white px-2 py-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50">
                          {virtualKbOpen ? "收起在线软键盘" : "展开在线软键盘（虚拟键盘）"}
                        </button>
                      </div>
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
                      <Button size="sm" variant="outline" onClick={pullClipboard} disabled={!canOperate || pulling} className="h-8">
                        {pulling ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <ClipboardPaste className="h-3.5 w-3.5 mr-1" />}
                        {pulling ? "拉取中…" : "拉取远程剪贴板"}
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
      )}
    </div>
  )
}
