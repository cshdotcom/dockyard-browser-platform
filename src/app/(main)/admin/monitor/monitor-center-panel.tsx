"use client"

// ============================================================
// r29-c：实时监控中心面板
//   · 16 宫格（RUNNING 沙箱按 VNC 连接数排序）+ 快照轮巡刷新
//   · 浮动水印（管理员账号名漂移防截屏溯源）
//   · 每格操作：观看/截图/强制跳转/关标签/消息推送/会话中断/监控授权/键鼠接管
//   · 多管理员控制互斥（接管租约 30s TTL，宫格显示持有者）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import {
  Monitor, Camera, Navigation, XCircle, MessageSquare, Power, Video, Mic, MonitorUp, Keyboard,
  Loader2, RefreshCw, Play, Eye, Lock, ChevronLeft, ChevronRight, Radio,
} from "lucide-react"
import {
  listMonitoredSandboxesAction, captureSandboxShotAction, navigateSandboxAction,
  closeSandboxTabAction, pushSandboxMessageAction, interruptSandboxAction,
  grantMonitorAction, revokeMonitorAction, controlLeaseAction,
} from "@/server/actions/monitor-actions"
import { listCloudMediaAction, deliverMediaAction, resetMediaCastAction, setFakeCameraAction } from "@/server/actions/media-cast-actions"
import { Clapperboard, ImageIcon } from "lucide-react"

interface MonitorCell {
  id: string; name: string; status: string; ownerName: string; groupName: string | null
  startedAt: string | null; novncConnCount: number; novncActiveMin: number
  hasSnapshot: boolean
  recentDomain: string | null
  grants: Array<{ channel: string; mode: string; by: string }>
  controlHolder: { adminName: string; acquiredAt: number } | null
  novncSessionId: string | null
}

const CHANNEL_LABEL: Record<string, string> = { camera: "摄像头", microphone: "麦克风", screenShare: "屏幕共享" }
const PAGE_SIZES = [4, 8, 12, 16]
const PATROL_OPTIONS = [
  { v: "0", label: "关闭轮巡" },
  { v: "5", label: "5 秒" }, { v: "10", label: "10 秒" }, { v: "15", label: "15 秒" },
  { v: "30", label: "30 秒" }, { v: "60", label: "60 秒" },
]

export function MonitorCenterPanel({ canSilent, adminName }: { canSilent: boolean; adminName: string }) {
  const [cells, setCells] = React.useState<MonitorCell[]>([])
  const [loading, setLoading] = React.useState(true)
  const [keyword, setKeyword] = React.useState("")
  const [patrolSec, setPatrolSec] = React.useState("15")
  const [gridSize, setGridSize] = React.useState(12)
  const [page, setPage] = React.useState(0)
  // 快照缓存（workspaceId → dataURL）
  const [shots, setShots] = React.useState<Record<string, string>>({})
  const [shotBusy, setShotBusy] = React.useState<Record<string, boolean>>({})
  // 水印
  const [wmOn, setWmOn] = React.useState(true)
  // 操作对话框
  const [navTarget, setNavTarget] = React.useState<MonitorCell | null>(null)
  const [navUrl, setNavUrl] = React.useState("")
  const [msgTarget, setMsgTarget] = React.useState<MonitorCell | null>(null)
  const [msgText, setMsgText] = React.useState("")
  const [grantTarget, setGrantTarget] = React.useState<MonitorCell | null>(null)
  const [grantChannel, setGrantChannel] = React.useState<"camera" | "microphone" | "screenShare">("camera")
  const [grantMode, setGrantMode] = React.useState<"CONSENT" | "SILENT">("CONSENT")
  const [grantReason, setGrantReason] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [kbTarget, setKbTarget] = React.useState<MonitorCell | null>(null)
  const [kbKey, setKbKey] = React.useState("")
  // 媒体投递
  const [mediaTarget, setMediaTarget] = React.useState<MonitorCell | null>(null)
  const [mediaFiles, setMediaFiles] = React.useState<Array<{ name: string; path: string; kind: string; sizeMb: number }>>([])
  const [mediaSeek, setMediaSeek] = React.useState("0")
  const [mediaBusy, setMediaBusy] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (kw?: string) => {
    const res = await listMonitoredSandboxesAction({ keyword: kw ?? keyword, take: 16 })
    if (res.code === 0 && res.data) {
      setCells(res.data.cells)
      setPage(0)
    }
    setLoading(false)
  }, [keyword])

  React.useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 30_000) // 列表 30s 刷新
    return () => clearInterval(t)
  }, [refresh])

  // 快照抓取（当前页可见格）
  const grabShots = React.useCallback(async (visible: MonitorCell[]) => {
    for (const c of visible) {
      if (!c.hasSnapshot) continue
      setShotBusy((p) => ({ ...p, [c.id]: true }))
      void captureSandboxShotAction({ workspaceId: c.id }).then((res) => {
        if (res.code === 0 && res.data?.b64) {
          setShots((p) => ({ ...p, [c.id]: `data:image/jpeg;base64,${res.data!.b64}` }))
        }
      }).finally(() => setShotBusy((p) => ({ ...p, [c.id]: false })))
    }
  }, [])

  React.useEffect(() => {
    const visible = cells.slice(page * gridSize, page * gridSize + gridSize)
    void grabShots(visible)
    // 快照刷新周期 = min(轮巡, 30s)；轮巡关闭时 30s 常规刷新
    const sec = patrolSec === "0" ? 30 : Math.min(Number(patrolSec), 30)
    const t = setInterval(() => {
      const vis = cells.slice(page * gridSize, page * gridSize + gridSize)
      void grabShots(vis)
    }, sec * 1000)
    return () => clearInterval(t)
  }, [cells, page, gridSize, patrolSec, grabShots])

  // 轮巡翻页
  React.useEffect(() => {
    if (patrolSec === "0" || cells.length <= gridSize) return
    const t = setInterval(() => {
      setPage((p) => (p + 1) * gridSize >= cells.length ? 0 : p + 1)
    }, Number(patrolSec) * 1000)
    return () => clearInterval(t)
  }, [patrolSec, cells.length, gridSize])

  const visible = cells.slice(page * gridSize, page * gridSize + gridSize)
  const totalPages = Math.max(1, Math.ceil(cells.length / gridSize))

  // ---- 操作 ----
  const doNavigate = async () => {
    if (!navTarget) return
    setBusy("nav")
    try {
      const res = await navigateSandboxAction({ workspaceId: navTarget.id, url: navUrl })
      if (res.code === 0) toast.success(`已强制跳转 ${res.data?.navigated || 0} 个页面`)
      else toast.error(res.msg || "跳转失败")
      setNavTarget(null)
    } finally { setBusy(null) }
  }

  const doMessage = async () => {
    if (!msgTarget) return
    setBusy("msg")
    try {
      const res = await pushSandboxMessageAction({ workspaceId: msgTarget.id, message: msgText })
      if (res.code === 0) toast.success(res.data?.delivered ? "消息已投递（页面浮层 30s）" : "投递失败（沙箱无可达页面）")
      else toast.error(res.msg || "推送失败")
      setMsgTarget(null)
    } finally { setBusy(null) }
  }

  const doInterrupt = async (c: MonitorCell) => {
    if (!confirm(`确认中断沙箱「${c.name}」的会话？用户将立即断开（工作区保留，可重新启动）`)) return
    setBusy(c.id)
    try {
      const res = await interruptSandboxAction({ workspaceId: c.id, reason: "监控中心手动中断" })
      if (res.code === 0) { toast.success("会话已中断"); void refresh() }
      else toast.error(res.msg || "中断失败")
    } finally { setBusy(null) }
  }

  const doGrant = async (revoke?: boolean) => {
    if (!grantTarget) return
    setBusy("grant")
    try {
      if (revoke) {
        const res = await revokeMonitorAction({ workspaceId: grantTarget.id, channel: grantChannel })
        if (res.code === 0) { toast.success(`已撤销 ${res.data?.revoked || 0} 项授权`); setGrantTarget(null); void refresh() }
        else toast.error(res.msg || "撤销失败")
      } else {
        const res = await grantMonitorAction({ workspaceId: grantTarget.id, channel: grantChannel, mode: grantMode, ...(grantMode === "SILENT" ? { reason: grantReason } : {}) })
        if (res.code === 0) { toast.success(grantMode === "SILENT" ? "静默特权授权已生效（强制审计中）" : "知情模式授权已下发（用户可见红点横幅）"); setGrantTarget(null); void refresh() }
        else toast.error(res.msg || "授权失败")
      }
    } finally { setBusy(null) }
  }

  const doKeyInject = async () => {
    if (!kbTarget || !kbKey) return
    setBusy("kb")
    try {
      const res = await controlLeaseAction({ workspaceId: kbTarget.id, action: "acquire" })
      if (res.code !== 0 || !res.data?.ok) {
        toast.error(res.data?.holder ? `控制互斥：${res.data.holder} 正在接管此沙箱` : "接管失败")
        return
      }
      const r = await (await import("@/server/actions/monitor-actions")).injectInputAction({ workspaceId: kbTarget.id, input: { type: "key", key: kbKey } })
      if (r.code === 0 && r.data?.ok) toast.success(`已注入按键：${kbKey}`)
      else if (r.data?.holder) toast.error(`控制互斥：${r.data.holder} 正在接管`)
      else toast.error("注入失败")
    } finally { setBusy(null) }
  }

  const loadMediaFiles = async () => {
    const res = await listCloudMediaAction({})
    if (res.code === 0 && res.data) setMediaFiles(res.data.files)
    else toast.error(res.msg || "云盘媒体清单读取失败")
  }

  const doDeliver = async (relPath: string, kind: string) => {
    if (!mediaTarget) return
    setMediaBusy(relPath)
    try {
      if (kind === "image") {
        const res = await setFakeCameraAction({ workspaceId: mediaTarget.id, relPath })
        if (res.code === 0) toast.success(`虚拟摄像头恒定帧已注入（重启 Chromium 生效：${res.data?.restart || "none"}）`)
        else toast.error(res.msg || "注入失败")
      } else {
        const res = await deliverMediaAction({ workspaceId: mediaTarget.id, relPath, seekSec: Number(mediaSeek) || 0 })
        if (res.code === 0) toast.success(`已投递至沙箱全屏播放（定点 ${mediaSeek}s）`)
        else toast.error(res.msg || "投递失败")
      }
    } finally { setMediaBusy(null) }
  }

  const doCastReset = async () => {
    if (!mediaTarget) return
    setMediaBusy("__reset")
    try {
      const res = await resetMediaCastAction({ workspaceId: mediaTarget.id })
      if (res.code === 0) toast.success(`投递已重置（终止 ${res.data?.stopped || 0} 项）`)
      else toast.error(res.msg || "重置失败")
    } finally { setMediaBusy(null) }
  }

  const doCamReset = async () => {
    if (!mediaTarget) return
    setMediaBusy("__camreset")
    try {
      const res = await setFakeCameraAction({ workspaceId: mediaTarget.id, relPath: null })
      if (res.code === 0) toast.success("虚拟摄像头已移除（恢复真实设备）")
      else toast.error(res.msg || "移除失败")
    } finally { setMediaBusy(null) }
  }

  return (
    <div className="space-y-4">
      {/* ---- 控制条 ---- */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-teal-600" />
          <Input2 value={keyword} onChange={(v) => { setKeyword(v); void refresh(v) }} placeholder="搜索沙箱/用户名" className="w-44" />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Radio className="h-4 w-4 text-indigo-600" /> 轮巡
          <Select value={patrolSec} onValueChange={setPatrolSec}>
            <SelectTrigger className="w-28 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PATROL_OPTIONS.map((o) => <SelectItem key={o.v} value={o.v}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          宫格
          <Select value={String(gridSize)} onValueChange={(v) => setGridSize(Number(v))}>
            <SelectTrigger className="w-20 h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n} 格</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          浮动水印
          <Switch checked={wmOn} onCheckedChange={setWmOn} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary">{cells.length} 个运行沙箱</Badge>
          <Button size="sm" variant="outline" onClick={() => { setLoading(true); void refresh() }}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
        </div>
      </div>

      {/* ---- 16 宫格 ---- */}
      <div className="relative">
        {wmOn && <Watermark name={adminName} />}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在装载监控网格…</div>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground text-sm">
            当前无运行中的重度沙箱（novnc_full）。用户启动工作区后自动出现在宫格。
          </div>
        ) : (
          <div className={`grid gap-3 ${gridSize <= 4 ? "grid-cols-2" : gridSize <= 8 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3 lg:grid-cols-4"}`}>
            {visible.map((c) => (
              <div key={c.id} className="rounded-lg border overflow-hidden bg-card group">
                {/* 快照区 */}
                <div className="relative aspect-video bg-black/90 flex items-center justify-center">
                  {shots[c.id] ? (
                    <img src={shots[c.id]} alt={c.name} className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-muted-foreground text-xs flex flex-col items-center gap-1">
                      {shotBusy[c.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-5 w-5 opacity-50" />}
                      {shotBusy[c.id] ? "抓取中" : c.hasSnapshot ? "待抓取" : "无 CDP"}
                    </div>
                  )}
                  {/* 授权红点（知情=脉冲红点；静默=暗紫角标仅管理员可见） */}
                  {c.grants.some((g) => g.mode === "CONSENT") && (
                    <span className="absolute top-1.5 left-1.5 flex h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" title="知情监控进行中（用户可见可切断）" />
                  )}
                  {c.grants.filter((g) => g.mode === "SILENT").length > 0 && (
                    <span className="absolute top-1.5 left-5 flex items-center gap-1 text-[10px] bg-rose-950/80 text-rose-300 px-1.5 py-0.5 rounded" title="静默特权监控（用户无感知）">
                      <Eye className="h-3 w-3" /> 静默×{c.grants.filter((g) => g.mode === "SILENT").length}
                    </span>
                  )}
                  {/* 控制租约持有者 */}
                  {c.controlHolder && (
                    <span className="absolute bottom-1.5 left-1.5 text-[10px] bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Lock className="h-3 w-3" /> {c.controlHolder.adminName} 接管中
                    </span>
                  )}
                  {/* 悬浮操作条 */}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconBtn title="抓取快照" onClick={() => void grabShots([c])} disabled={shotBusy[c.id]}><Camera className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="实时观看（跳转工作区）" onClick={() => window.open(`/workspaces/${c.id}?tab=vnc`, "_blank")}><Play className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="键鼠接管" onClick={() => setKbTarget(c)}><Keyboard className="h-3.5 w-3.5" /></IconBtn>
                    <span className="flex-1" />
                    <IconBtn title="强制跳转 URL" onClick={() => { setNavTarget(c); setNavUrl("") }}><Navigation className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="媒体投递（音视频定点/虚拟摄像头）" onClick={() => { setMediaTarget(c); setMediaFiles([]); setMediaSeek("0"); void loadMediaFiles() }}><Clapperboard className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="消息推送" onClick={() => { setMsgTarget(c); setMsgText("") }}><MessageSquare className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="会话中断" onClick={() => void doInterrupt(c)} className2="text-red-400"><Power className="h-3.5 w-3.5" /></IconBtn>
                  </div>
                </div>
                {/* 信息区 */}
                <div className="p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium truncate" title={c.name}>{c.name}</span>
                    <Badge variant={c.novncConnCount > 0 ? "default" : "secondary"} className="text-[10px] px-1 py-0">
                      {c.novncConnCount > 0 ? `${c.novncConnCount} 在看` : "空闲"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="truncate">{c.ownerName}{c.groupName ? ` · ${c.groupName}` : ""}</span>
                    <span>{c.novncActiveMin > 0 ? `活跃 ${c.novncActiveMin}m` : c.startedAt ? `启动 ${new Date(c.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "-"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] text-muted-foreground truncate" title={`最近浏览：${c.recentDomain || "-"}`}>
                      {c.recentDomain ? `↗ ${c.recentDomain}` : "无浏览记录"}
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <IconBtn title="监控授权（知情/静默）" onClick={() => setGrantTarget(c)}><Video className="h-3.5 w-3.5" /></IconBtn>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* 翻页 */}
        {cells.length > gridSize && (
          <div className="flex items-center justify-center gap-2 mt-3">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-xs text-muted-foreground">第 {page + 1} / {totalPages} 屏</span>
            <Button size="sm" variant="outline" disabled={(page + 1) * gridSize >= cells.length} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>

      {/* ---- 强制跳转对话框 ---- */}
      <Dialog open={!!navTarget} onOpenChange={(v) => !v && setNavTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Navigation className="h-4 w-4 text-amber-500" /> 强制跳转 URL</DialogTitle>
            <DialogDescription>沙箱「{navTarget?.name}」全部页面将立即导航至目标地址（审计 WARN 留痕）</DialogDescription>
          </DialogHeader>
          <input value={navUrl} onChange={(e) => setNavUrl(e.target.value)} placeholder="https://example.com" className="w-full rounded-md border px-3 py-2 text-sm" />
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={busy === "nav" || !navUrl} onClick={() => setNavTarget(null)}>取消</Button>
            <Button size="sm" disabled={busy === "nav" || !navUrl} onClick={() => void doNavigate()}>{busy === "nav" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}跳转</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 消息推送对话框 ---- */}
      <Dialog open={!!msgTarget} onOpenChange={(v) => !v && setMsgTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-teal-600" /> 消息推送</DialogTitle>
            <DialogDescription>沙箱「{msgTarget?.name}」页面顶部将显示浮层横幅（30 秒自动消失，用户可手动关闭）</DialogDescription>
          </DialogHeader>
          <textarea value={msgText} onChange={(e) => setMsgText(e.target.value)} rows={3} maxLength={500} placeholder="推送给用户的消息内容…" className="w-full rounded-md border px-3 py-2 text-sm" />
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={busy === "msg" || !msgText} onClick={() => setMsgTarget(null)}>取消</Button>
            <Button size="sm" disabled={busy === "msg" || !msgText} onClick={() => void doMessage()}>{busy === "msg" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}推送</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 监控授权对话框（双模式） ---- */}
      <Dialog open={!!grantTarget} onOpenChange={(v) => !v && setGrantTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Video className="h-4 w-4 text-teal-600" /> 硬件监视授权 · 双模式</DialogTitle>
            <DialogDescription>
              沙箱「{grantTarget?.name}」当前授权：{grantTarget && grantTarget.grants.length > 0 ? grantTarget.grants.map((g) => `${CHANNEL_LABEL[g.channel] || g.channel}（${g.mode === "SILENT" ? "静默" : "知情"}·${g.by}）`).join("，") : "无"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1.5">
              {(["camera", "microphone", "screenShare"] as const).map((ch) => (
                <button key={ch} onClick={() => setGrantChannel(ch)}
                  className={`px-2 py-1.5 rounded-lg border text-xs flex items-center justify-center gap-1 ${grantChannel === ch ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"}`}>
                  {ch === "camera" ? <Camera className="h-3.5 w-3.5" /> : ch === "microphone" ? <Mic className="h-3.5 w-3.5" /> : <MonitorUp className="h-3.5 w-3.5" />}
                  {CHANNEL_LABEL[ch]}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setGrantMode("CONSENT")}
                className={`px-2 py-2 rounded-lg border text-xs text-left ${grantMode === "CONSENT" ? "bg-teal-600 text-white border-teal-600" : "bg-background hover:bg-muted"}`}>
                <div className="font-medium flex items-center gap-1">知情模式</div>
                <div className="opacity-80 mt-0.5">用户见红点横幅，可一键切断</div>
              </button>
              <button onClick={() => setGrantMode("SILENT")} disabled={!canSilent}
                className={`px-2 py-2 rounded-lg border text-xs text-left disabled:opacity-50 ${grantMode === "SILENT" ? "bg-rose-600 text-white border-rose-600" : "bg-background hover:bg-muted"}`}>
                <div className="font-medium flex items-center gap-1">静默特权模式</div>
                <div className="opacity-80 mt-0.5">{canSilent ? "用户无感知 · 仅超管 · 强制审计" : "仅超级管理员可授权"}</div>
              </button>
            </div>
            {grantMode === "SILENT" && (
              <div>
                <div className="text-xs font-medium mb-1">授权理由（必填，取证留痕）</div>
                <textarea value={grantReason} onChange={(e) => setGrantReason(e.target.value)} rows={2} maxLength={300} className="w-full rounded-md border px-3 py-2 text-sm" placeholder="例如：涉嫌数据外泄取证，安全事件工单 #1234" />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" disabled={busy === "grant" || !grantTarget?.grants.length} onClick={() => void doGrant(true)}>撤销该通道</Button>
            <Button size="sm" disabled={busy === "grant" || (grantMode === "SILENT" && grantReason.trim().length < 4)} onClick={() => void doGrant(false)}>
              {busy === "grant" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}下发授权
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 键鼠接管对话框 ---- */}
      <Dialog open={!!kbTarget} onOpenChange={(v) => !v && setKbTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Keyboard className="h-4 w-4 text-indigo-600" /> 键鼠接管 · 控制互斥</DialogTitle>
            <DialogDescription>
              同一沙箱同一时刻仅一名管理员可注入（租约 30 秒自动过期）。输入按键注入沙箱（Enter/Tab/F5/方向键等）；
              细粒度鼠标操作请用「实时观看」进入 VNC 观看通道。
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-1.5 flex-wrap">
            {["Enter", "Tab", "Escape", "Backspace", "F5", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].map((k) => (
              <button key={k} onClick={() => setKbKey(k)} className={`px-2 py-1 rounded border text-xs font-mono ${kbKey === k ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>{k}</button>
            ))}
          </div>
          {kbTarget?.controlHolder && (
            <div className="text-xs text-amber-600">⚠ {kbTarget.controlHolder.adminName} 当前持有控制租约</div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setKbTarget(null)}>关闭</Button>
            <Button size="sm" disabled={busy === "kb" || !kbKey} onClick={() => void doKeyInject()}>{busy === "kb" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}注入 {kbKey}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 媒体投递对话框 ---- */}
      <Dialog open={!!mediaTarget} onOpenChange={(v) => !v && setMediaTarget(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Clapperboard className="h-4 w-4 text-purple-600" /> 虚拟媒体投递</DialogTitle>
            <DialogDescription>
              沙箱「{mediaTarget?.name}」—— 云盘音视频定点秒级投递（全屏播放，-autoexit 播毕自动结束）；
              图片可注入为<b>虚拟摄像头恒定帧</b>（getUserMedia 恒定返回该图）
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              定点秒
              <input value={mediaSeek} onChange={(e) => setMediaSeek(e.target.value.replace(/[^0-9]/g, ""))} className="h-8 w-24 rounded-md border bg-background px-2 text-sm" placeholder="0" />
              <span className="text-xs text-muted-foreground">（音视频从该秒开始播放）</span>
            </div>
            <div className="rounded-lg border divide-y max-h-72 overflow-y-auto">
              {mediaFiles.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">云盘无媒体文件（支持 mp4/webm/mp3/wav/jpg/png/webp…）</div>
              ) : mediaFiles.map((f) => (
                <div key={f.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                  {f.kind === "image" ? <ImageIcon className="h-3.5 w-3.5 text-emerald-600 shrink-0" /> : <Clapperboard className="h-3.5 w-3.5 text-purple-600 shrink-0" />}
                  <span className="truncate flex-1" title={f.path}>{f.name}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{f.sizeMb > 0 ? `${f.sizeMb}MB` : "-"}</span>
                  <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{f.kind === "image" ? "摄像头" : f.kind === "video" ? "视频" : "音频"}</Badge>
                  <Button size="sm" variant="secondary" className="h-7 px-2 text-xs shrink-0" disabled={mediaBusy === f.path} onClick={() => void doDeliver(f.path, f.kind)}>
                    {mediaBusy === f.path ? <Loader2 className="h-3 w-3 animate-spin" /> : f.kind === "image" ? "注入" : "投递"}
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" disabled={mediaBusy === "__camreset"} onClick={() => void doCamReset()}>移除虚拟摄像头</Button>
            <Button size="sm" variant="outline" disabled={mediaBusy === "__reset"} onClick={() => void doCastReset()}>投递重置</Button>
            <Button size="sm" variant="outline" onClick={() => setMediaTarget(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---- 小图标按钮 ----
function IconBtn({ title, onClick, disabled, children, className2 }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; className2?: string }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className={`h-6 w-6 rounded flex items-center justify-center text-white/90 hover:bg-white/20 disabled:opacity-40 ${className2 || ""}`}>
      {children}
    </button>
  )
}

// ---- 简易输入框（避免引入受控 Input 组件依赖） ----
function Input2({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`h-8 rounded-md border bg-background px-2 text-sm ${className || ""}`}
    />
  )
}

// ---- 浮动水印（管理员账号名，15s 漂移，防截屏溯源） ----
function Watermark({ name }: { name: string }) {
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15_000)
    return () => clearInterval(t)
  }, [])
  const cells: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 5; i++) {
    cells.push({ x: (i * 23 + tick * 17) % 90, y: (i * 31 + tick * 11) % 90 })
  }
  return (
    <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
      {cells.map((c, i) => (
        <span key={i} className="absolute text-[11px] text-white/15 font-mono select-none whitespace-nowrap transition-all duration-1000"
          style={{ left: `${c.x}%`, top: `${c.y}%`, transform: "rotate(-18deg)" }}>
          {name} · DOCKYARD 监控
        </span>
      ))}
    </div>
  )
}
