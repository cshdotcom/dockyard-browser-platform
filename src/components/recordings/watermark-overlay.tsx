"use client"

// ============================================================
// r28：回放水印叠加层（防截屏溯源）
//   - 服务器时间为唯一权威源（serverNow 下发，本地仅按流逝秒递增显示）
//   - 位置周期性漂移（防固定位置裁剪规避）
//   - forced 模式不可关闭（策略链 watermark=force）
//   - on 模式默认显示，用户可临时关闭本次回放
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react"
import { EyeOff, Eye, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"

interface WatermarkOverlayProps {
  mode: "force" | "on" | "off"
  viewerName: string
  workspaceName: string
  serverNow: string
  serverTz?: string
}

function useServerClock(base: string): string {
  const [display, setDisplay] = useState(base)
  const baseMs = useMemo(() => Date.now(), [])
  const baseStr = useRef(base)
  useEffect(() => {
    const t = setInterval(() => {
      const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(baseStr.current)
      if (!m) return
      const elapsed = Math.floor((Date.now() - baseMs) / 1000)
      const [date, time] = m[1].split(" ")
      const [Y, M, D] = date.split("-").map(Number)
      const [h, min, s] = time.split(":").map(Number)
      const total = s + min * 60 + h * 3600 + elapsed
      const hh = Math.floor(total / 3600) % 24
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      setDisplay(`${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`)
    }, 1000)
    return () => clearInterval(t)
  }, [baseMs])
  return display
}

const POSITIONS = [
  "top-4 left-4", "top-4 right-4", "bottom-16 left-6", "bottom-16 right-6",
  "top-1/3 left-8", "top-2/3 right-8", "top-1/2 left-1/2 -translate-x-1/2",
]

export function WatermarkOverlay({ mode, viewerName, workspaceName, serverNow, serverTz }: WatermarkOverlayProps) {
  const [userHidden, setUserHidden] = useState(false)
  const [posIdx, setPosIdx] = useState(0)
  const clock = useServerClock(serverNow)

  useEffect(() => {
    const t = setInterval(() => setPosIdx((i) => (i + 1) % POSITIONS.length), 15_000)
    return () => clearInterval(t)
  }, [])

  if (mode === "off") return null
  if (mode === "on" && userHidden) {
    return (
      <div className="absolute bottom-2 right-2 z-10">
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 bg-black/40 text-white hover:bg-black/60" onClick={() => setUserHidden(false)}>
          <Eye className="h-3 w-3" />显示水印
        </Button>
      </div>
    )
  }

  const forced = mode === "force"
  return (
    <div className={`absolute z-10 pointer-events-none ${POSITIONS[posIdx]}`}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/45 backdrop-blur-[1px] text-white/85 text-xs font-mono shadow-lg border border-white/10 select-none">
        {forced && <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />}
        <span>{viewerName}</span>
        <span className="opacity-50">|</span>
        <span className="max-w-40 truncate">{workspaceName}</span>
        <span className="opacity-50">|</span>
        <span>{clock}</span>
        {serverTz && <span className="opacity-60">{serverTz}</span>}
      </div>
      {!forced && (
        <div className="pointer-events-auto mt-1 flex justify-end">
          <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 bg-black/40 text-white/70 hover:bg-black/60" onClick={() => setUserHidden(true)}>
            <EyeOff className="h-2.5 w-2.5" />隐藏水印（本次）
          </Button>
        </div>
      )}
    </div>
  )
}

/** 变速控制条（0.5x ~ 4x） */
export function PlaybackSpeedBar({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [rate, setRate] = useState(1)
  const speeds = [0.5, 0.75, 1, 1.5, 2, 3, 4]
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-xs text-muted-foreground mr-1">倍速</span>
      {speeds.map((s) => (
        <button
          key={s}
          onClick={() => {
            setRate(s)
            if (videoRef.current) videoRef.current.playbackRate = s
          }}
          className={`px-2 h-6 rounded text-xs border transition ${rate === s ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
        >
          {s}x
        </button>
      ))}
    </div>
  )
}
