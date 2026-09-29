"use client"

// ============================================================
// Dockyard HelmPort —— 品牌化现代远程桌面查看器（全自研，零第三方 VNC 依赖）
// 原名 LiveDesk（与第三方产品重名）→ 更名 HelmPort 并以 Next.js/React 原生重构：
//   · 自研 RFB 3.3/3.7/3.8 协议客户端（src/components/vnc/helmport/rfb-client.ts）
//   · 单次票据取票 → 断线自动重连（自动重新取票，退避重试）
//   · 只读镜像：客户端 viewOnly + 服务端桥丢输入帧 双保险
//   · 帧率/带宽/键鼠 HUD 实时遥测 + 停顿看门狗
//   · 品牌水印 / 截图加签 / 中文剪贴板双通道（QEMU 扩展协议）
//   · 触屏-鼠标模式记忆 / 画质档位 / 自适应缩放
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import {
  Anchor, Camera, Clipboard, ClipboardCheck, Expand, Minimize2, RefreshCw, Loader2,
  MousePointer2, Hand, ShieldCheck, Eye, TriangleAlert, Zap, Radio, Keyboard, ShipWheel, Monitor,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  const [clipboardOpen, setClipboardOpen] = React.useState(false)
  const [clipboardText, setClipboardText] = React.useState("")
  const [clipboardReceived, setClipboardReceived] = React.useState("")
  const [serverName, setServerName] = React.useState("")
  // —— 多监视器分辨率切换 ——
  const [desktop, setDesktop] = React.useState<RfbDesktopSize | null>(null)
  const pendingResizeRef = React.useRef<string | null>(null) // 用户发起的切换请求（结果 toast 用）
  const appliedPresetRef = React.useRef<string | null>(null) // 连接后已自动应用的偏好（避免重复下发）

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

  // ---- 仪表统计：帧率 / 带宽 / 停顿毫秒 + 看门狗 ----
  React.useEffect(() => {
    const t = setInterval(() => {
      const s = statsRef.current
      const now = Date.now()
      s.frameTimes = s.frameTimes.filter((ts) => now - ts < 5000)
      const fps = Math.round((s.frameTimes.length / 5) * 10) / 10
      const kbps = Math.round((s.bytesIn / 1024 / 5) * 10) / 10
      const idle = phaseRef.current === "live" ? now - s.lastMsgAt : 0
      setStats({ fps, kbps, idle })
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
      const { wsUrlQuery, bridge, readonly: ticketReadonly } = res.data

      let url: string
      if (bridge.mode === "gateway") {
        url = `${wsScheme()}://${location.host}/?XTransformPort=${bridge.port}&${wsUrlQuery}`
      } else if (bridge.mode === "port") {
        url = `${wsScheme()}://${location.hostname}:${bridge.port}/?${wsUrlQuery}`
      } else {
        const base = (bridge.url || "").replace(/\/$/, "")
        url = base.startsWith("ws") ? `${base}/?${wsUrlQuery}` : `${wsScheme()}://${base.replace(/^https?:\/\//, "")}/?${wsUrlQuery}`
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
          try { stageRef.current?.focus() } catch { /* noop */ }
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
        onSecurityFail: (reason) => {
          setErrMsg(`安全握手失败：${reason}`)
          retryRef.current.manual = true
        },
        onTelemetry: () => {
          // 帧计数由 message 监听推断；此回调保留扩展位
        },
        onDisconnected: (reason) => {
          rfbRef.current = null
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
  const onStageKeyDown = (e: React.KeyboardEvent) => {
    if (phase !== "live" || !canOperate) return
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
    const keysym = keysymFor(e.nativeEvent)
    if (keysym !== null) {
      e.preventDefault()
      rfbRef.current?.sendKey(keysym, false)
    }
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
    grad.addColorStop(0, "#0c1518")
    grad.addColorStop(1, "#10201c")
    ctx.fillStyle = grad
    ctx.fillRect(0, cv.height, out.width, FOOTER)
    ctx.fillStyle = "#2fd9b5"
    ctx.fillRect(0, cv.height, out.width, 2)
    ctx.fillStyle = "#e6f7f2"
    ctx.font = "bold 14px ui-sans-serif, system-ui"
    ctx.fillText("Dockyard HelmPort", 14, cv.height + 28)
    ctx.fillStyle = "#9fc4bb"
    ctx.font = "12px ui-sans-serif, system-ui"
    ctx.fillText(`${workspace.name} · ${workspace.ownerName} · ${new Date().toLocaleString()} · ${deviceTag()}`, 170, cv.height + 28)
    const a = document.createElement("a")
    a.href = out.toDataURL("image/png")
    a.download = `helmport-${workspace.name}-${Date.now()}.png`
    a.click()
    toast.success("截图已下载（含归属水印签名条）")
  }

  // ---- 剪贴板双通道：RFB 扩展直达 + 平台中转审计通道 ----
  const sendClipboard = async () => {
    const cleaned = clipboardText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    if (!cleaned) { toast.error("剪贴板内容为空"); return }
    const sliced = cleaned.slice(0, 5000)
    let okCount = 0
    let channelInfo = ""
    // 通道1：自研 RFB 扩展剪贴板（QEMU 协议：UTF-8 全字符 + zlib；中文完整支持）
    try {
      const res = await rfbRef.current?.sendClipboard(sliced)
      if (res === "extended") { okCount++; channelInfo = "RFB扩展" }
      else if (res === "classic") { okCount++; channelInfo = "RFB经典" }
    } catch { /* 通道2兜底 */ }
    // 通道2：平台中转代理（后端 UTF-8 校验 + 管理员全局开关 + 审计）
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

  const statusPill = () => {
    if (phase === "live") {
      const stalled = stats.idle > 5000
      return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          stalled ? "bg-amber-500/15 text-amber-300 border border-amber-500/30" : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30")}>
          <span className="relative flex h-2 w-2">
            <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-75", stalled ? "bg-amber-400" : "bg-emerald-400", "animate-ping")} />
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", stalled ? "bg-amber-500" : "bg-emerald-500")} />
          </span>
          {stalled ? "等待画面…" : "已连接"}
          <span className="opacity-60 font-normal">{stats.fps}fps · {stats.kbps}KB/s</span>
        </span>
      )
    }
    if (phase === "connecting") return <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-2.5 py-1 text-xs text-teal-300"><Loader2 className="h-3 w-3 animate-spin" /> 建立加密通道…</span>
    if (phase === "reconnecting") return <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300"><RefreshCw className="h-3 w-3 animate-spin" /> 重连中 {retryIn}s（自动重新取票）</span>
    if (phase === "error") return <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-300"><TriangleAlert className="h-3 w-3" /> 连接异常</span>
    return <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs text-slate-300">未连接</span>
  }

  const status = workspace.status

  return (
    <div className="space-y-3">
      {/* ===== 顶部驾驶舱工具栏 ===== */}
      <div className="rounded-xl border bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 px-3 py-2.5 shadow-lg">
        <div className="flex flex-wrap items-center gap-2">
          {/* 品牌标识 */}
          <div className="flex items-center gap-2 pr-2 mr-1 border-r border-slate-700/60">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-emerald-600 shadow-md shadow-teal-500/20">
              <ShipWheel className="h-4 w-4 text-slate-950" strokeWidth={2.4} />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-tight text-slate-50">HelmPort<span className="ml-1 text-[10px] font-normal text-teal-400/80 align-middle">by Dockyard</span></div>
              <div className="text-[10px] text-slate-500 max-w-40 truncate">{workspace.name}</div>
            </div>
          </div>

          {statusPill()}

          {readonly && (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300">
              <Eye className="h-3 w-3 mr-1" /> 只读镜像（服务端拦截输入）
            </Badge>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {/* 多监视器分辨率切换（SetDesktopSize / ExtendedDesktopSize 协议） */}
            <Select
              value={desktop ? desktopToPresetKey(desktop) : undefined}
              onValueChange={(k) => {
                const p = MONITOR_PRESETS.find((m) => m.key === k)
                if (p) applyMonitorPreset(p, true)
              }}
              disabled={readonly || phase !== "live"}
            >
              <SelectTrigger className="h-8 w-[150px] border-slate-700 bg-slate-900 text-xs" title="多监视器分辨率切换">
                <Monitor className="h-3 w-3 mr-1 text-teal-400" />
                <SelectValue placeholder={phase === "live" ? "分辨率" : "未连接"} />
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

            {/* 画质 */}
            <Select value={quality} onValueChange={setQuality} disabled={readonly}>
              <SelectTrigger className="h-8 w-[92px] border-slate-700 bg-slate-900 text-xs">
                <Zap className="h-3 w-3 mr-1 text-teal-400" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">流畅</SelectItem>
                <SelectItem value="mid">均衡</SelectItem>
                <SelectItem value="high">高清</SelectItem>
              </SelectContent>
            </Select>

            {/* 输入模式（记忆持久化） */}
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-900 p-0.5">
              <button type="button" onClick={() => setInputMode("mouse")} disabled={!canOperate}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors", inputMode === "mouse" ? "bg-teal-600 text-white shadow" : "text-slate-400 hover:text-slate-200")}
                title="鼠标指针模式（PC 默认）">
                <MousePointer2 className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setInputMode("touch")} disabled={!canOperate}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors", inputMode === "touch" ? "bg-teal-600 text-white shadow" : "text-slate-400 hover:text-slate-200")}
                title="触屏模式（移动端默认：长按=右键 拖动=移动）">
                <Hand className="h-3.5 w-3.5" />
              </button>
            </div>

            <Button size="sm" variant="ghost" className="h-8 border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-teal-300" onClick={() => setClipboardOpen(!clipboardOpen)}>
              <Clipboard className="h-3.5 w-3.5 mr-1" /> 剪贴板
            </Button>
            <Button size="sm" variant="ghost" className="h-8 border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-teal-300" onClick={screenshot}>
              <Camera className="h-3.5 w-3.5 mr-1" /> 截图
            </Button>
            <Button size="sm" variant="ghost" className="h-8 border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-teal-300" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
            </Button>
            {phase === "live" || phase === "connecting" ? (
              <Button size="sm" variant="ghost" className="h-8 border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20" onClick={disconnect}>
                断开
              </Button>
            ) : (
              <Button size="sm" className="h-8 bg-gradient-to-r from-teal-500 to-emerald-600 text-slate-950 font-semibold hover:from-teal-400 hover:to-emerald-500 disabled:opacity-40"
                disabled={status !== "RUNNING" && status !== "IDLE"} onClick={() => connect()}>
                <Radio className="h-3.5 w-3.5 mr-1" /> 接入桌面
              </Button>
            )}
          </div>
        </div>

        {/* 次级设置行 */}
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800/80 pt-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1 font-mono text-teal-400/90">
            <Monitor className="h-3 w-3" />
            {desktop ? `${desktop.width}×${desktop.height} · ${desktop.screens.length} 显示器` : "分辨率待协商"}
          </span>
          <label className="flex cursor-pointer items-center gap-1.5 hover:text-slate-300">
            <input type="checkbox" checked={scaleFit} onChange={(e) => setScaleFit(e.target.checked)} className="accent-teal-500 h-3 w-3" />
            自适应缩放
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 hover:text-slate-300">
            <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} className="accent-teal-500 h-3 w-3" />
            归属水印
          </label>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3 text-teal-500" /> 票据单次有效 · 60s 时效</span>
          <span className="inline-flex items-center gap-1"><Keyboard className="h-3 w-3 text-teal-500" /> 点击画面获得键盘焦点</span>
          <span className="ml-auto font-mono text-slate-600">DEV-{deviceTag()}</span>
        </div>
      </div>

      {/* ===== 画面舞台 ===== */}
      <div ref={stageRef} tabIndex={0}
        onKeyDown={onStageKeyDown} onKeyUp={onStageKeyUp}
        onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp}
        onWheel={onStageWheel}
        onTouchStart={onStageTouchStart} onTouchMove={onStageTouchMove} onTouchEnd={onStageTouchEnd}
        onContextMenu={(e) => e.preventDefault()}
        className={cn("relative overflow-hidden rounded-xl border border-slate-800 bg-[#070b0e] outline-none transition-shadow select-none",
          phase === "live" ? "shadow-[0_0_32px_-8px_rgba(45,212,191,0.35)] cursor-default" : "",
          fullscreen ? "flex h-screen w-screen items-center justify-center" : "")}>
        {/* 画布：自适应缩放或 1:1 */}
        <div className={cn("flex w-full items-center justify-center overflow-auto", phase === "live" ? "min-h-0" : "min-h-[420px] md:min-h-[520px]")}>
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

        {/* 状态遮罩 */}
        {phase !== "live" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-slate-950/90 via-slate-900/90 to-slate-950/90 backdrop-blur-[2px]">
            {phase === "idle" && (
              <>
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400/20 to-emerald-600/20 border border-teal-500/30">
                  <ShipWheel className="h-8 w-8 text-teal-400" />
                </div>
                <p className="text-sm font-medium text-slate-200">HelmPort 远程桌面 · {workspace.name}</p>
                <p className="max-w-md px-6 text-center text-xs leading-relaxed text-slate-500">
                  会话经统一网关中转（工作区 UUID + HMAC 单次票据双因子校验），原始内网地址不暴露。自研 RFB 协议客户端（Next.js 原生实现）。
                  {readonly && " 您持有只读授权：画面镜像可见，键鼠与剪贴板输入将被服务端丢弃。"}
                </p>
                {(status === "RUNNING" || status === "IDLE") ? (
                  <Button onClick={() => connect()} className="bg-gradient-to-r from-teal-500 to-emerald-600 text-slate-950 font-semibold hover:from-teal-400">
                    <Radio className="h-4 w-4 mr-1.5" /> 立即接入
                  </Button>
                ) : (
                  <Badge variant="outline" className="border-slate-700 text-slate-400">会话未运行（{status}）</Badge>
                )}
              </>
            )}
            {phase === "connecting" && (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-teal-400" />
                <p className="text-sm text-slate-300">正在建立加密通道…</p>
                <p className="text-xs text-slate-500">取票 → 网关桥 → RFB 握手（版本协商/安全类型/像素格式）</p>
              </>
            )}
            {phase === "reconnecting" && (
              <>
                <RefreshCw className="h-10 w-10 animate-spin text-amber-400" />
                <p className="text-sm text-slate-300">连接中断，{retryIn} 秒后自动重连（重新取票）</p>
                <Button size="sm" variant="outline" className="border-slate-700 text-slate-300" onClick={() => { if (retryRef.current.timer) clearTimeout(retryRef.current.timer); connect() }}>
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

        {/* 画布角标 HUD */}
        {phase === "live" && (
          <>
            <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-slate-950/70 px-2 py-0.5 font-mono text-[10px] text-teal-300/80 backdrop-blur">
              RFB · {workspace.uuid.slice(0, 8)} · {inputMode === "touch" ? "TOUCH" : "POINTER"}{serverName ? ` · ${serverName.slice(0, 24)}` : ""}
            </div>
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
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-slate-950/70 px-2 py-1 text-[10px] text-slate-400 backdrop-blur">
            单击=左键 · 长按=右键 · 拖动=移动 · 滚轮=滚动
          </div>
        )}
      </div>

      {/* ===== 剪贴板抽屉（双通道 + 回显） ===== */}
      {clipboardOpen && (
        <div className="rounded-xl border bg-slate-950/60 p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClipboardCheck className="h-3.5 w-3.5 text-teal-500" />
            中文剪贴板双通道：自研 RFB QEMU 扩展直达（UTF-8 + zlib）+ 平台审计中转（上限 5000 字符，受管理员全局开关管控）
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1.5">
              <textarea
                className="w-full rounded-lg border bg-background p-2 text-sm min-h-20 focus:border-teal-500"
                placeholder="粘贴要投递到远程桌面的文本…"
                value={clipboardText}
                onChange={(e) => setClipboardText(e.target.value)}
                disabled={!canOperate}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={sendClipboard} disabled={!canOperate} className="bg-teal-600 text-white hover:bg-teal-500">
                  <Clipboard className="h-3.5 w-3.5 mr-1" /> 投递到远程桌面
                </Button>
                <Button size="sm" variant="outline" onClick={() => rfbRef.current?.requestRemoteClipboard()} disabled={!canOperate}>
                  拉取远程剪贴板
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <textarea
                className="w-full rounded-lg border bg-muted/40 p-2 text-sm min-h-20 font-mono text-emerald-300"
                placeholder="远程桌面回传的剪贴板内容将显示在这里（打开抽屉时自动请求）…"
                value={clipboardReceived}
                readOnly
              />
              <Button size="sm" variant="outline" disabled={!clipboardReceived} onClick={() => { navigator.clipboard.writeText(clipboardReceived).then(() => toast.success("已复制到本地剪贴板")).catch(() => toast.error("复制失败")) }}>
                复制回传内容
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
