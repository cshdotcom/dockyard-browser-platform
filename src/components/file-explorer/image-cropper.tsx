"use client"

// ============================================================
// r35 图片在线裁剪（用户点名功能："图片在线裁剪"）
// 零依赖 canvas 实现：鼠标/触屏拖选 + 四角手柄微调 + 比例锁定
// （自由/1:1/16:9/4:3/9:16）+ 输出格式（WebP/PNG/JPEG）+ 质量。
// 产物经 multipart 上传通道落盘（配额/审计链路全复用）。
// ============================================================
import * as React from "react"
import { toast } from "sonner"
import { Crop, Loader2, RotateCw, ZoomIn, ZoomOut, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export interface ImageCropperDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  imageUrl: string
  fileName: string
  domain: string
  dir: string
  onDone: () => void
}

type Rect = { x: number; y: number; w: number; h: number }

const RATIOS: Array<{ key: string; label: string; value: number | null }> = [
  { key: "free", label: "自由比例", value: null },
  { key: "1:1", label: "1 : 1（方形）", value: 1 },
  { key: "16:9", label: "16 : 9（横屏）", value: 16 / 9 },
  { key: "9:16", label: "9 : 16（竖屏）", value: 9 / 16 },
  { key: "4:3", label: "4 : 3（传统）", value: 4 / 3 },
  { key: "3:4", label: "3 : 4（竖版）", value: 3 / 4 },
]

export function ImageCropperDialog({ open, onOpenChange, imageUrl, fileName, domain, dir, onDone }: ImageCropperDialogProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [ratio, setRatio] = React.useState<string>("free")
  const [rotate, setRotate] = React.useState(0)
  const [scale, setScale] = React.useState(1)
  const [format, setFormat] = React.useState<"image/webp" | "image/png" | "image/jpeg">("image/webp")
  const [quality, setQuality] = React.useState(92)
  const selRef = React.useRef<Rect | null>(null)
  const dragRef = React.useRef<{ mode: "move" | "nw" | "ne" | "sw" | "se" | "new"; sx: number; sy: number; orig: Rect } | null>(null)
  const [selVersion, setSelVersion] = React.useState(0) // 触发重绘

  // 载入图像
  React.useEffect(() => {
    if (!open || !imageUrl) return
    setLoading(true)
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      imgRef.current = img
      selRef.current = { x: img.width * 0.1, y: img.height * 0.1, w: img.width * 0.8, h: img.height * 0.8 }
      setLoading(false)
      setSelVersion((v) => v + 1)
    }
    img.onerror = () => { toast.error("图片加载失败"); setLoading(false) }
    img.src = imageUrl
  }, [open, imageUrl])

  // 绘制（图像 + 旋转/缩放 + 暗遮罩 + 选框）
  const draw = React.useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const sel = selRef.current
    if (!canvas || !img) return
    const rot = (rotate * Math.PI) / 180
    const swap = rotate % 180 !== 0
    const iw = (swap ? img.height : img.width) * scale
    const ih = (swap ? img.width : img.height) * scale
    const maxW = 720, maxH = 460
    const fit = Math.min(maxW / iw, maxH / ih, 1)
    const cw = Math.max(1, Math.round(iw * fit)), ch = Math.max(1, Math.round(ih * fit))
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext("2d")!
    ctx.save()
    ctx.clearRect(0, 0, cw, ch)
    ctx.translate(cw / 2, ch / 2)
    ctx.rotate(rot)
    ctx.scale(scale * fit, scale * fit)
    ctx.drawImage(img, -img.width / 2, -img.height / 2)
    ctx.restore()
    // 坐标变换：画布显示坐标 → 原图像素（含旋转）
    const toOrig = (px: number, py: number) => {
      const dx = (px - cw / 2) / (scale * fit)
      const dy = (py - ch / 2) / (scale * fit)
      const cos = Math.cos(-rot), sin = Math.sin(-rot)
      const ox = dx * cos - dy * sin + img.width / 2
      const oy = dx * sin + dy * cos + img.height / 2
      return { x: swap ? Math.min(Math.max(ox, 0), img.height) : Math.min(Math.max(ox, 0), img.width), y: swap ? Math.min(Math.max(oy, 0), img.width) : Math.min(Math.max(oy, 0), img.height) }
    }
    if (sel) {
      // 选框画布坐标（选框存原图坐标系）
      const inv = (ox: number, oy: number) => {
        const dx = ox - img.width / 2, dy = oy - img.height / 2
        const cos = Math.cos(rot), sin = Math.sin(rot)
        const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos
        return { px: cw / 2 + rx * scale * fit, py: ch / 2 + ry * scale * fit }
      }
      const p1 = inv(sel.x, sel.y), p2 = inv(sel.x + sel.w, sel.y + sel.h)
      const x = Math.min(p1.px, p2.px), y = Math.min(p1.py, p2.py)
      const w = Math.abs(p2.px - p1.px), h = Math.abs(p2.py - p1.py)
      ctx.fillStyle = "rgba(0,0,0,0.55)"
      ctx.fillRect(0, 0, cw, y)
      ctx.fillRect(0, y + h, cw, ch - y - h)
      ctx.fillRect(0, y, x, h)
      ctx.fillRect(x + w, y, cw - x - w, h)
      ctx.strokeStyle = "#14b8a6"
      ctx.lineWidth = 1.5
      ctx.strokeRect(x, y, w, h)
      // 三分线
      ctx.strokeStyle = "rgba(255,255,255,0.25)"
      ctx.lineWidth = 0.5
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(x + (w / 3) * i, y); ctx.lineTo(x + (w / 3) * i, y + h); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(x, y + (h / 3) * i); ctx.lineTo(x + w, y + (h / 3) * i); ctx.stroke()
      }
      // 四角手柄
      ctx.fillStyle = "#14b8a6"
      const hs = 7
      ;[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
      })
      // 尺寸提示
      ctx.fillStyle = "rgba(20,184,166,0.9)"
      ctx.fillRect(x, Math.max(0, y - 18), 88, 15)
      ctx.fillStyle = "#fff"
      ctx.font = "10px monospace"
      ctx.fillText(`${Math.round(sel.w)}×${Math.round(sel.h)}`, x + 4, Math.max(12, y - 7))
    }
    canvas.dataset.toOrig = "1"
    ;(canvas as HTMLCanvasElement & { __toOrig?: (px: number, py: number) => { x: number; y: number } }).__toOrig = toOrig
  }, [rotate, scale, selVersion])

  React.useEffect(() => {
    if (!loading) draw()
  }, [draw, loading])

  // 指针交互（鼠标 + 触屏统一 Pointer Events）
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const sel = selRef.current
    if (!canvas || !sel) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const toOrig = (canvas as HTMLCanvasElement & { __toOrig?: (px: number, py: number) => { x: number; y: number } }).__toOrig
    if (!toOrig) return
    const img = imgRef.current!
    const inv = (ox: number, oy: number) => {
      const rot = (rotate * Math.PI) / 180
      const swap = rotate % 180 !== 0
      const iw = (swap ? img.height : img.width) * scale
      const ih = (swap ? img.width : img.height) * scale
      const maxW = 720, maxH = 460
      const fit = Math.min(maxW / iw, maxH / ih, 1)
      const cw = canvas.width, ch = canvas.height
      const dx = ox - img.width / 2, dy = oy - img.height / 2
      const cos = Math.cos(rot), sin = Math.sin(rot)
      return { px: cw / 2 + (dx * cos - dy * sin) * scale * fit, py: ch / 2 + (dx * sin + dy * cos) * scale * fit }
    }
    const p1 = inv(sel.x, sel.y), p2 = inv(sel.x + sel.w, sel.y + sel.h)
    const x = Math.min(p1.px, p2.px), y = Math.min(p1.py, p2.py)
    const w = Math.abs(p2.px - p1.px), h = Math.abs(p2.py - p1.py)
    const hs = 10
    const hitHandle: "nw" | "ne" | "sw" | "se" | null =
      Math.abs(px - x) < hs && Math.abs(py - y) < hs ? "nw"
      : Math.abs(px - (x + w)) < hs && Math.abs(py - y) < hs ? "ne"
      : Math.abs(px - x) < hs && Math.abs(py - (y + h)) < hs ? "sw"
      : Math.abs(px - (x + w)) < hs && Math.abs(py - (y + h)) < hs ? "se"
      : null
    if (hitHandle) dragRef.current = { mode: hitHandle, sx: px, sy: py, orig: { ...sel } }
    else if (px >= x && px <= x + w && py >= y && py <= y + h) dragRef.current = { mode: "move", sx: px, sy: py, orig: { ...sel } }
    else {
      const o = toOrig(px, py)
      dragRef.current = { mode: "new", sx: px, sy: py, orig: { x: o.x, y: o.y, w: 0, h: 0 } }
      selRef.current = { x: o.x, y: o.y, w: 0, h: 0 }
      setSelVersion((v) => v + 1)
    }
    canvas.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const canvas = canvasRef.current
    if (!drag || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const toOrig = (canvas as HTMLCanvasElement & { __toOrig?: (px: number, py: number) => { x: number; y: number } }).__toOrig
    if (!toOrig) return
    const img = imgRef.current!
    const o = toOrig(px, py)
    const dxPx = px - drag.sx, dyPx = py - drag.sy
    const oStart = toOrig(drag.sx, drag.sy)
    const dOrigX = o.x - oStart.x, dOrigY = o.y - oStart.y
    const ratioValue = RATIOS.find((r) => r.key === ratio)?.value ?? null
    let next: Rect
    if (drag.mode === "move") {
      next = { ...drag.orig, x: Math.min(Math.max(0, drag.orig.x + dOrigX), img.width - drag.orig.w), y: Math.min(Math.max(0, drag.orig.y + dOrigY), img.height - drag.orig.h) }
    } else if (drag.mode === "new") {
      let w = o.x - drag.orig.x, h = o.y - drag.orig.y
      if (ratioValue) h = w / ratioValue
      next = { x: Math.min(drag.orig.x, drag.orig.x + Math.max(0, w) * (w < 0 ? 1 : 1)), y: drag.orig.y, w: Math.abs(w), h: Math.abs(h) }
      next = { x: w >= 0 ? drag.orig.x : drag.orig.x + w, y: h >= 0 ? drag.orig.y : drag.orig.y + h, w: Math.abs(w), h: Math.abs(h) }
    } else {
      // 四角缩放
      let { x, y, w, h } = drag.orig
      if (drag.mode.includes("e")) w = Math.max(8, drag.orig.w + dOrigX)
      if (drag.mode.includes("w")) { w = Math.max(8, drag.orig.w - dOrigX); x = drag.orig.x + (drag.orig.w - w) }
      if (drag.mode.includes("s")) h = Math.max(8, drag.orig.h + dOrigY)
      if (drag.mode.includes("n")) { h = Math.max(8, drag.orig.h - dOrigY); y = drag.orig.y + (drag.orig.h - h) }
      if (ratioValue) {
        // 以宽为准锁定比例
        h = w / ratioValue
        if (drag.mode.includes("n")) y = drag.orig.y + (drag.orig.h - h)
      }
      next = { x, y, w, h }
    }
    // 边界钳制
    next.x = Math.min(Math.max(0, next.x), Math.max(0, img.width - 8))
    next.y = Math.min(Math.max(0, next.y), Math.max(0, img.height - 8))
    next.w = Math.min(Math.max(8, next.w), img.width - next.x)
    next.h = Math.min(Math.max(8, next.h), img.height - next.y)
    selRef.current = next
    setSelVersion((v) => v + 1)
  }

  const onPointerUp = () => { dragRef.current = null }

  // 应用裁剪 → 上传保存
  const applyCrop = async () => {
    const img = imgRef.current
    const sel = selRef.current
    if (!img || !sel || sel.w < 8 || sel.h < 8) { toast.error("请先拖选裁剪区域"); return }
    setBusy(true)
    try {
      const out = document.createElement("canvas")
      out.width = Math.round(sel.w)
      out.height = Math.round(sel.h)
      const ctx = out.getContext("2d")!
      if (format === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height) }
      ctx.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, format, quality / 100))
      if (!blob) throw new Error("编码失败")
      const dot = fileName.lastIndexOf(".")
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName
      const newExt = format === "image/webp" ? "webp" : format === "image/png" ? "png" : "jpg"
      const newName = `${stem}-cropped-${out.width}x${out.height}.${newExt}`
      const form = new FormData()
      form.append("file", new File([blob], newName, { type: format }))
      form.append("domain", domain)
      form.append("dir", dir)
      const res = await fetch("/api/files/upload-explorer", { method: "POST", body: form })
      const json = await res.json().catch(() => ({ code: 1, msg: "响应解析失败" }))
      if (json.code === 0) {
        toast.success(`已保存裁剪结果：${newName}（${(blob.size / 1024).toFixed(1)} KB）`)
        onDone()
        onOpenChange(false)
      } else toast.error(json.msg || "保存失败")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "裁剪失败")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Crop className="h-4 w-4" />图片在线裁剪 · {fileName}</DialogTitle>
          <DialogDescription>拖选裁剪区域（四角手柄微调，支持触屏）；裁剪结果保存为新文件，原图保留。</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-2">
          {loading ? (
            <div className="flex h-72 items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />图像加载中…</div>
          ) : (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="max-w-full cursor-crosshair touch-none select-none rounded"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">比例</Label>
            <Select value={ratio} onValueChange={(v) => {
              setRatio(v)
              const rv = RATIOS.find((r) => r.key === v)?.value
              const sel = selRef.current
              const img = imgRef.current
              if (rv && sel && img) {
                const h = sel.w / rv
                selRef.current = { ...sel, h: Math.min(h, img.height - sel.y) }
                setSelVersion((x) => x + 1)
              }
            }}>
              <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{RATIOS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => { setRotate((r) => (r + 90) % 360) }}><RotateCw className="h-3.5 w-3.5" />旋转 90°</Button>
          <Button size="sm" variant="outline" className="h-8 w-7 p-0" onClick={() => setScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))} title="缩小视图"><ZoomOut className="h-3.5 w-3.5" /></Button>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
          <Button size="sm" variant="outline" className="h-8 w-7 p-0" onClick={() => setScale((s) => Math.min(4, +(s + 0.25).toFixed(2)))} title="放大视图"><ZoomIn className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => { const img = imgRef.current; if (img) { selRef.current = { x: 0, y: 0, w: img.width, h: img.height }; setSelVersion((v) => v + 1) } }}>全选</Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Label className="text-xs">格式</Label>
            <Select value={format} onValueChange={(v: "image/webp" | "image/png" | "image/jpeg") => setFormat(v)}>
              <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="image/webp">WebP（小）</SelectItem>
                <SelectItem value="image/png">PNG（无损）</SelectItem>
                <SelectItem value="image/jpeg">JPEG（兼容）</SelectItem>
              </SelectContent>
            </Select>
            {format !== "image/png" && (
              <div className="flex items-center gap-1">
                <input type="range" min={40} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} className="w-20" />
                <span className="text-xs tabular-nums text-muted-foreground">{quality}</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => void applyCrop()} disabled={busy || loading} className="gap-1">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}应用并保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
