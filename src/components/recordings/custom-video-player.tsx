"use client"

// ============================================================
// r34：Dockyard 自研录像回放播放器
//
// 背景（用户报障）：此前回放弹窗直接用 <video controls> —— 呈现的是 Chrome
// 内核原生控件（“他的播放器不是我们自己的播放器，而是谷歌内核的”）。
//
// 本组件 = 完全自绘控件的企业级播放器：
//   · 自绘控制栏：播放/暂停、进度条（可拖拽 seek + 缓冲可视化）、
//     当前时间/总时长、音量（含静音）、倍速（0.5x~3x）、全屏
//   · 品牌条：Dockyard 徽标 + 工作区名 + 归属水印（WatermarkOverlay 联动）
//   · 键盘可达：空格播放/暂停、←/→ 快退/快进 5s、M 静音、F 全屏
//   · 禁用右键菜单/拖拽下载（防导出旁路；配合 controlsList 与 no-download 语义）
//   · 加载/错误态自绘（加载圈 + 友好错误文案，而非浏览器默认黑屏）
// ============================================================

import * as React from "react"
import { cn } from "@/lib/utils"
import { Play, Pause, Volume2, VolumeX, Maximize2, Loader2, TriangleAlert, RotateCcw } from "lucide-react"

export interface CustomVideoPlayerProps {
  src: string
  title?: string
  subtitle?: string
  watermark?: React.ReactNode
  className?: string
}

const SPEED_STEPS = [0.5, 1, 1.25, 1.5, 2, 3]

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}

export function CustomVideoPlayer({ src, title, subtitle, watermark, className }: CustomVideoPlayerProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const seekRef = React.useRef<HTMLDivElement | null>(null)

  const [playing, setPlaying] = React.useState(false)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [current, setCurrent] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [buffered, setBuffered] = React.useState(0)
  const [volume, setVolume] = React.useState(1)
  const [muted, setMuted] = React.useState(false)
  const [speed, setSpeed] = React.useState(1)
  const [showControls, setShowControls] = React.useState(true)
  const [seeking, setSeeking] = React.useState(false)
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 事件绑定
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onLoaded = () => {
      setReady(true)
      setDuration(v.duration || 0)
      setError(null)
    }
    const onTime = () => { if (!seeking) setCurrent(v.currentTime) }
    const onProgress = () => {
      try {
        if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1))
      } catch { /* noop */ }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)
    const onErr = () => setError("录像加载失败（文件可能已被归档或清理；可稍后重试或联系管理员）")
    v.addEventListener("loadedmetadata", onLoaded)
    v.addEventListener("timeupdate", onTime)
    v.addEventListener("progress", onProgress)
    v.addEventListener("play", onPlay)
    v.addEventListener("pause", onPause)
    v.addEventListener("ended", onEnded)
    v.addEventListener("error", onErr)
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded)
      v.removeEventListener("timeupdate", onTime)
      v.removeEventListener("progress", onProgress)
      v.removeEventListener("play", onPlay)
      v.removeEventListener("pause", onPause)
      v.removeEventListener("ended", onEnded)
      v.removeEventListener("error", onErr)
    }
  }, [src, seeking])

  const togglePlay = React.useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => setError("浏览器自动播放策略限制：请点击播放按钮"))
    else v.pause()
  }, [])

  const seekTo = (sec: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(sec)) return
    v.currentTime = Math.max(0, Math.min(sec, v.duration || 0))
    setCurrent(v.currentTime)
  }

  const setVol = (val: number) => {
    const v = videoRef.current
    if (!v) return
    const nv = Math.max(0, Math.min(1, val))
    v.volume = nv
    v.muted = nv === 0
    setVolume(nv)
    setMuted(nv === 0)
  }

  const toggleMute = () => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
    if (!v.muted && v.volume === 0) { v.volume = 0.6; setVolume(0.6) }
  }

  const setRate = (rate: number) => {
    const v = videoRef.current
    if (!v) return
    v.playbackRate = rate
    setSpeed(rate)
  }

  const toggleFullscreen = () => {
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage.requestFullscreen?.().catch(() => { /* noop */ })
  }

  // 键盘控制（容器聚焦时）
  const onKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case " ": case "k": e.preventDefault(); togglePlay(); break
      case "ArrowLeft": seekTo((videoRef.current?.currentTime ?? 0) - 5); break
      case "ArrowRight": seekTo((videoRef.current?.currentTime ?? 0) + 5); break
      case "m": toggleMute(); break
      case "f": toggleFullscreen(); break
      case "ArrowUp": e.preventDefault(); setVol((videoRef.current?.volume ?? 1) + 0.1); break
      case "ArrowDown": e.preventDefault(); setVol((videoRef.current?.volume ?? 1) - 0.1); break
    }
  }

  // 进度条拖拽
  const onSeekPointer = (e: React.PointerEvent) => {
    const bar = seekRef.current
    const v = videoRef.current
    if (!bar || !v || !duration) return
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
    setSeeking(true)
    const calc = (clientX: number) => {
      const rect = bar.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      setCurrent(ratio * duration)
      return ratio * duration
    }
    calc(e.clientX)
    const move = (ev: PointerEvent) => { calc(ev.clientX) }
    const up = (ev: PointerEvent) => {
      seekTo(calc(ev.clientX))
      setSeeking(false)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // 控制栏自动隐藏（播放中 3 秒无操作）
  const bumpControls = () => {
    setShowControls(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (playing && !seeking) setShowControls(false)
    }, 3000)
  }
  React.useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [playing, seeking])

  const progressPct = duration > 0 ? (current / duration) * 100 : 0
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0

  return (
    <div
      ref={stageRef}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={bumpControls}
      onPointerLeave={() => playing && setShowControls(false)}
      onContextMenu={(e) => e.preventDefault()}
      className={cn("relative group outline-none rounded-xl overflow-hidden bg-black select-none", className)}
      data-testid="custom-video-player"
    >
      {/* 视频本体：无原生控件 */}
      <video
        key={src}
        ref={videoRef}
        src={src}
        autoPlay
        preload="metadata"
        playsInline
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
        draggable={false}
        className="w-full max-h-[62vh] bg-black"
        onClick={togglePlay}
      />

      {/* 水印层 */}
      {watermark}

      {/* 品牌条（右上角常显） */}
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-full bg-black/55 backdrop-blur px-2.5 py-1 pointer-events-none">
        <span className="h-2 w-2 rounded-full bg-teal-400" />
        <span className="text-[10px] font-semibold tracking-wide text-teal-100">DOCKYARD PLAYER</span>
      </div>

      {/* 加载/错误遮罩 */}
      {!ready && !error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3 text-teal-100">
            <Loader2 className="h-10 w-10 animate-spin text-teal-400" />
            <p className="text-xs">正在加载录像流…</p>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70">
          <div className="flex flex-col items-center gap-3 text-amber-100 max-w-xs text-center px-4">
            <TriangleAlert className="h-10 w-10 text-amber-400" />
            <p className="text-sm">{error}</p>
            <button type="button" className="rounded-md border border-amber-400/50 px-3 py-1 text-xs hover:bg-amber-400/10" onClick={() => { setError(null); setReady(false); videoRef.current?.load() }}>
              <RotateCcw className="h-3 w-3 inline mr-1" />重试加载
            </button>
          </div>
        </div>
      )}

      {/* 播放大按钮（中央，暂停时显示） */}
      {!playing && ready && !error && (
        <button
          type="button"
          aria-label="播放"
          onClick={togglePlay}
          className="absolute inset-0 z-20 flex items-center justify-center"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-teal-500/90 shadow-lg shadow-teal-500/30 transition-transform hover:scale-105">
            <Play className="h-7 w-7 text-white fill-white ml-1" />
          </span>
        </button>
      )}

      {/* 标题条（顶部左侧） */}
      {(title || subtitle) && (
        <div className={cn("absolute top-2 left-2 z-20 max-w-[60%] rounded-lg bg-black/55 backdrop-blur px-3 py-1.5 pointer-events-none transition-opacity", showControls ? "opacity-100" : "opacity-0")}>
          {title && <p className="text-xs font-medium text-white truncate">{title}</p>}
          {subtitle && <p className="text-[10px] text-white/60 truncate">{subtitle}</p>}
        </div>
      )}

      {/* 自绘控制栏 */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-20 transition-all duration-200",
          "bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-8 pb-2 px-3",
          showControls || !playing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        )}
      >
        {/* 进度条 */}
        <div
          ref={seekRef}
          role="slider"
          aria-label="播放进度"
          aria-valuenow={Math.round(progressPct)}
          tabIndex={-1}
          onPointerDown={onSeekPointer}
          className="group/bar relative h-4 flex items-center cursor-pointer touch-none"
        >
          <div className="relative h-1.5 w-full rounded-full bg-white/20 overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${bufferedPct}%` }} />
            <div className="absolute inset-y-0 left-0 bg-teal-400" style={{ width: `${progressPct}%` }} />
          </div>
          <span
            className="absolute h-3 w-3 -translate-x-1/2 rounded-full bg-teal-300 shadow shadow-teal-500/50 transition-transform group-hover/bar:scale-125"
            style={{ left: `${progressPct}%` }}
          />
        </div>

        {/* 按钮行 */}
        <div className="mt-1 flex items-center gap-1.5 text-white">
          <button type="button" aria-label={playing ? "暂停" : "播放"} onClick={togglePlay} className="rounded-md p-1.5 hover:bg-white/15">
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-white" />}
          </button>

          {/* 音量 */}
          <div className="flex items-center gap-1">
            <button type="button" aria-label={muted ? "取消静音" : "静音"} onClick={toggleMute} className="rounded-md p-1.5 hover:bg-white/15">
              {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => setVol(Number(e.target.value))}
              aria-label="音量"
              className="h-1 w-16 accent-teal-400 cursor-pointer hidden sm:block"
            />
          </div>

          <span className="ml-1 text-[11px] tabular-nums text-white/85">
            {fmtTime(current)} <span className="text-white/40">/ {fmtTime(duration)}</span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* 倍速 */}
            <div className="flex items-center rounded-md bg-white/10 p-0.5">
              {SPEED_STEPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setRate(s)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums transition-colors",
                    speed === s ? "bg-teal-400 text-black" : "text-white/70 hover:text-white",
                  )}
                >
                  {s}x
                </button>
              ))}
            </div>
            <button type="button" aria-label="全屏" onClick={toggleFullscreen} className="rounded-md p-1.5 hover:bg-white/15">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
