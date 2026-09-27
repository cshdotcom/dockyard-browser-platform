"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft, Globe, MonitorPlay, Share2, FileJson, Terminal, Clipboard, MousePointer2, Hand,
  RefreshCw, ShieldCheck, Wifi, Loader2, Trash2, Lock, Play, StopCircle, Copy,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import {
  stopWorkspaceAction, startWorkspaceAction, deleteWorkspaceAction, shareWorkspaceAction,
  revokeShareAction, exportWorkspaceConfigAction, exportHarAction, runScriptAction,
  refreshVncKeyAction, updateWorkspaceAction, switchProxyAction,
} from "@/server/actions/workspaces"
import { cn } from "@/lib/utils"

export interface WorkspaceDetailData {
  id: string; uuid: string; name: string; mode: string; status: string
  tags: string[]; ttlMinutes: number; idleTimeoutMinutes: number
  cdpCallCount: number; cdpBlockedCount: number
  novncConnCount: number; novncFps: number; novncActiveMin: number
  cdpUrl: string | null; steelSessionId: string | null; novncSessionId: string | null
  createdAt: string; updatedAt: string
  proxyName: string | null; proxyType: string | null; proxyStatus: string | null
  singboxId: string | null; singboxName: string | null
  snapshotId: string | null; snapshotName: string | null; snapshotSize: number
  ownerName: string; ownerEmail: string | null; creatorName: string | null
  isOwner: boolean; mySharePermission: string | null; isAdmin: boolean
  crashCategory: string | null
}

interface ShareRow { id: string; targetName: string; permission: string; expireAt: string | null; createdAt: string }
interface ScriptRow { id: string; name: string; description: string; scope: string }
interface HarRow { id: string; size: string; createdAt: string }
interface RunLogRow { id: string; status: string; log: string; startedAt: string }

export function WorkspaceDetail({
  workspace, shares, scripts, harRecords, runLogs,
}: {
  workspace: WorkspaceDetailData
  shares: ShareRow[]
  scripts: ScriptRow[]
  harRecords: HarRow[]
  runLogs: RunLogRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)

  const isVnc = workspace.mode === "novnc_full"
  const canOperate = workspace.isOwner || workspace.isAdmin || workspace.mySharePermission === "OPERATE"

  const stop = async () => {
    setBusy("stop")
    try {
      const res = await stopWorkspaceAction({ id: workspace.id })
      if (res.code === 0) { toast.success("已停止"); router.refresh() } else toast.error(res.msg)
    } finally { setBusy(null) }
  }
  const start = async () => {
    setBusy("start")
    try {
      const res = await startWorkspaceAction({ id: workspace.id })
      if (res.code === 0) { toast.success("已启动"); router.refresh() } else toast.error(res.msg)
    } finally { setBusy(null) }
  }
  const del = async () => {
    setBusy("del")
    try {
      const res = await deleteWorkspaceAction({ id: workspace.id, reason: "" })
      if (res.code === 0) { toast.success("已移入回收站"); router.push("/workspaces") } else toast.error(res.msg)
    } finally { setBusy(null) }
  }
  const exportConfig = async () => {
    setBusy("export")
    try {
      const res = await exportWorkspaceConfigAction({ id: workspace.id })
      if (res.code === 0) {
        const blob = new Blob([JSON.stringify(res.data?.config, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url; a.download = `workspace-${workspace.uuid.slice(0, 8)}.json`; a.click()
        URL.revokeObjectURL(url)
        toast.success("配置已导出")
      } else toast.error(res.msg)
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/workspaces" className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> 返回工作区列表
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            {isVnc ? <MonitorPlay className="h-6 w-6" /> : <Globe className="h-6 w-6" />}
            {workspace.name}
            <StatusBadge status={workspace.status} />
            {isVnc ? <Badge className="bg-violet-600 hover:bg-violet-600">NoVNC</Badge> : <Badge variant="secondary">CDP</Badge>}
            {!workspace.isOwner && workspace.mySharePermission && (
              <Badge variant="outline">{workspace.mySharePermission === "OPERATE" ? "共享-可操作" : "共享-只读"}</Badge>
            )}
          </h1>
          <p className="text-xs text-muted-foreground font-mono">UUID {workspace.uuid}</p>
        </div>
        <div className="flex items-center gap-2">
          {(workspace.status === "RUNNING" || workspace.status === "IDLE") && canOperate && (
            <Button variant="outline" size="sm" onClick={stop} disabled={!!busy}>
              {busy === "stop" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <StopCircle className="mr-1 h-3.5 w-3.5" />} 停止
            </Button>
          )}
          {workspace.status === "STOPPED" && canOperate && (
            <Button variant="outline" size="sm" onClick={start} disabled={!!busy}>
              {busy === "start" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} 启动
            </Button>
          )}
          {workspace.isOwner && (
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 className="mr-1 h-3.5 w-3.5" /> 共享管理
            </Button>
          )}
          {workspace.isOwner && (
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>编辑配置</Button>
          )}
          <Button variant="outline" size="sm" onClick={exportConfig} disabled={!!busy}>
            <FileJson className="mr-1 h-3.5 w-3.5" /> 导出配置
          </Button>
          {workspace.isOwner && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 删除
            </Button>
          )}
        </div>
      </div>

      {/* 信息卡片 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">当前所有者</p>
          <p className="text-sm font-medium mt-1">{workspace.ownerName}</p>
          <p className="text-xs text-muted-foreground">{workspace.ownerEmail ?? "-"} · {workspace.creatorName ? `创建人 ${workspace.creatorName}` : ""}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">网络出口</p>
          <p className="text-sm font-medium mt-1 flex items-center gap-1">
            <Wifi className="h-3.5 w-3.5" /> {workspace.proxyName ?? "直连"}
          </p>
          <p className="text-xs text-muted-foreground">
            {workspace.proxyType === "internal_singbox" && workspace.singboxName ? `内置 SingBox：${workspace.singboxName}` : workspace.proxyType === "internal_singbox" ? "内置SingBox" : "外部代理"}
            {workspace.proxyStatus ? ` · ${workspace.proxyStatus}` : ""}
          </p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">生命周期</p>
          <p className="text-sm font-medium mt-1 tabular-nums">TTL {workspace.ttlMinutes > 0 ? `${workspace.ttlMinutes}min` : "不限"}</p>
          <p className="text-xs text-muted-foreground">闲置超时 {workspace.idleTimeoutMinutes}min · 创建 {workspace.createdAt}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">运行统计</p>
          <p className="text-sm font-medium mt-1 tabular-nums">
            {isVnc ? `${workspace.novncConnCount} 连接 · ${Math.round(workspace.novncFps)}fps` : `${workspace.cdpCallCount} CDP调用`}
          </p>
          <p className="text-xs text-muted-foreground">
            {isVnc ? `活跃 ${Math.round(workspace.novncActiveMin)}min` : `拦截 ${workspace.cdpBlockedCount} 次黑名单指令`}
          </p>
        </CardContent></Card>
      </div>

      {/* 主体 */}
      <Tabs defaultValue={isVnc ? "vnc" : "cdp"}>
        <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 h-auto">
          {isVnc && <TabsTrigger value="vnc"><MonitorPlay className="h-3.5 w-3.5 mr-1" />远程桌面</TabsTrigger>}
          {!isVnc && <TabsTrigger value="cdp"><Terminal className="h-3.5 w-3.5 mr-1" />CDP 控制</TabsTrigger>}
          <TabsTrigger value="network"><Wifi className="h-3.5 w-3.5 mr-1" />网络与代理</TabsTrigger>
          <TabsTrigger value="script"><Terminal className="h-3.5 w-3.5 mr-1" />脚本注入</TabsTrigger>
          <TabsTrigger value="har"><FileJson className="h-3.5 w-3.5 mr-1" />HAR / 录播</TabsTrigger>
          <TabsTrigger value="shares"><Share2 className="h-3.5 w-3.5 mr-1" />共享授权</TabsTrigger>
        </TabsList>

        {isVnc && (
          <TabsContent value="vnc" className="mt-4">
            <VncPanel workspace={workspace} canOperate={canOperate} />
          </TabsContent>
        )}
        {!isVnc && (
          <TabsContent value="cdp" className="mt-4">
            <CdpPanel workspace={workspace} canOperate={canOperate} />
          </TabsContent>
        )}
        <TabsContent value="network" className="mt-4">
          <NetworkPanel workspace={workspace} canOperate={canOperate} />
        </TabsContent>
        <TabsContent value="script" className="mt-4">
          <ScriptPanel workspace={workspace} scripts={scripts} runLogs={runLogs} canOperate={canOperate} />
        </TabsContent>
        <TabsContent value="har" className="mt-4">
          <HarPanel workspace={workspace} harRecords={harRecords} />
        </TabsContent>
        <TabsContent value="shares" className="mt-4">
          <SharesPanel workspace={workspace} shares={shares} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete} onOpenChange={setConfirmDelete}
        title="删除工作区" destructive confirmText="移入回收站"
        description={`「${workspace.name}」将停止底层会话并进入回收站，回收站保留期内可恢复。`}
        onConfirm={del}
      />

      <ShareDialog workspace={workspace} open={shareOpen} onOpenChange={setShareOpen} onDone={() => router.refresh()} />
      <EditDialog workspace={workspace} open={editOpen} onOpenChange={setEditOpen} onDone={() => router.refresh()} />
    </div>
  )
}

// ================= NoVNC 远程桌面面板 =================
function VncPanel({ workspace, canOperate }: { workspace: WorkspaceDetailData; canOperate: boolean }) {
  const router = useRouter()
  const [mode, setMode] = React.useState<"mouse" | "touch">(detectMode())
  const [watermark, setWatermark] = React.useState(true)
  const [clipboardOpen, setClipboardOpen] = React.useState(false)
  const [clipboardText, setClipboardText] = React.useState("")
  const [connected, setConnected] = React.useState(workspace.status === "RUNNING")

  function detectMode(): "mouse" | "touch" {
    if (typeof window === "undefined") return "mouse"
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0
    return isTouch ? "touch" : "mouse"
  }

  // 会话参数持久化：记住输入模式（仅本地浏览器，不影响其他接入端）
  React.useEffect(() => {
    const saved = window.localStorage.getItem(`vnc-mode-${workspace.id}`)
    if (saved === "mouse" || saved === "touch") setMode(saved)
  }, [workspace.id])
  React.useEffect(() => {
    window.localStorage.setItem(`vnc-mode-${workspace.id}`, mode)
  }, [mode, workspace.id])

  const refreshKey = async () => {
    const res = await refreshVncKeyAction({ id: workspace.id })
    if (res.code === 0) { toast.success("VNC 临时密钥已刷新"); router.refresh() } else toast.error(res.msg)
  }

  const sendClipboard = async () => {
    // UTF-8 校验过滤非法控制字符后经后端代理通道投递
    const cleaned = clipboardText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    if (!cleaned) { toast.error("剪贴板内容为空"); return }
    try {
      const res = await fetch("/api/vnc-proxy/clipboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, text: cleaned.slice(0, 5000) }),
      })
      const json = await res.json()
      if (json.code === 0) toast.success("剪贴板内容已投递到远程桌面")
      else toast.error(json.msg)
    } catch {
      toast.error("剪贴板投递失败")
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            <MonitorPlay className="h-4 w-4" /> 远程桌面
            <Badge variant={connected ? "default" : "outline"} className={connected ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
              {connected ? "已连接" : "未连接"}
            </Badge>
            <Badge variant="secondary">{mode === "mouse" ? "鼠标模式" : "触屏模式"}</Badge>
          </CardTitle>
          <CardDescription>
            NoVNC 会话经由平台统一网关代理中转（工作区UUID+专属密钥双因子校验），原始内网地址不暴露给浏览器。
            {workspace.mySharePermission === "VIEW" && " 您仅有只读权限：仅可查看画面，键鼠输入被服务端拦截。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 工具栏 */}
          <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg border bg-muted/40 p-2">
            <div className="flex items-center rounded-md border bg-background p-0.5">
              <button
                type="button"
                onClick={() => setMode("mouse")}
                disabled={workspace.mySharePermission === "VIEW"}
                className={cn("flex items-center gap-1 rounded px-2.5 py-1 text-xs", mode === "mouse" ? "bg-teal-600 text-white" : "text-muted-foreground")}
                title="鼠标指针模式（PC默认）"
              >
                <MousePointer2 className="h-3.5 w-3.5" /> 鼠标
              </button>
              <button
                type="button"
                onClick={() => setMode("touch")}
                disabled={workspace.mySharePermission === "VIEW"}
                className={cn("flex items-center gap-1 rounded px-2.5 py-1 text-xs", mode === "touch" ? "bg-teal-600 text-white" : "text-muted-foreground")}
                title="触屏模式（移动端默认，支持双指缩放）"
              >
                <Hand className="h-3.5 w-3.5" /> 触屏
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={() => setClipboardOpen(!clipboardOpen)}>
              <Clipboard className="h-3.5 w-3.5 mr-1" /> 剪贴板
            </Button>
            <Button variant="outline" size="sm" onClick={refreshKey} disabled={!canOperate}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> 刷新密钥
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConnected(!connected)} disabled={workspace.status !== "RUNNING"}>
              {connected ? "断开" : "连接"}
            </Button>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} className="accent-teal-600" />
                水印
              </label>
              <span>分辨率锁定 · 画质自适应</span>
            </div>
          </div>

          {/* 画面区域：真实部署时为 noVNC canvas 经 ws 代理；此处呈现连接画面与状态 */}
          <div className="relative rounded-lg border overflow-hidden bg-slate-900" style={{ aspectRatio: "16/10" }}>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 gap-2">
              {connected ? (
                <>
                  <MonitorPlay className="h-12 w-12 opacity-60" />
                  <p className="text-sm">远程桌面会话 {workspace.novncSessionId?.slice(0, 14)}</p>
                  <p className="text-xs opacity-70">画面经由统一网关 WS 通道传输（{workspace.novncConnCount} 客户端接入）</p>
                  {mode === "touch" && <p className="text-xs opacity-70">触屏模式：单击=左键 · 长按=右键 · 双指缩放画面</p>}
                </>
              ) : (
                <>
                  <Lock className="h-10 w-10 opacity-50" />
                  <p className="text-sm">未连接 · {workspace.status === "RUNNING" ? "点击工具栏「连接」接入" : "会话未运行"}</p>
                </>
              )}
            </div>
            {watermark && connected && (
              <div className="absolute inset-0 pointer-events-none select-none flex items-center justify-center">
                <span className="text-white/10 text-4xl font-bold rotate-[-20deg]">{workspace.ownerName} · {new Date().toLocaleDateString()}</span>
              </div>
            )}
          </div>

          {/* 剪贴板面板 */}
          {clipboardOpen && (
            <div className="mt-3 rounded-lg border p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                中文剪贴板中转：支持中文/全角/特殊符号完整读写；经后端代理通道 UTF-8 校验转发（双向，受管理员全局开关管控，上限5000字符）
              </p>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm min-h-20"
                placeholder="粘贴要投递到远程桌板的文本…"
                value={clipboardText}
                onChange={(e) => setClipboardText(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={sendClipboard} disabled={!canOperate}>投递到远程桌面 →</Button>
                <Button
                  size="sm" variant="outline"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText()
                      setClipboardText(text)
                      toast.success("已从本地剪贴板读取")
                    } catch { toast.error("浏览器未授权剪贴板读取") }
                  }}
                >
                  ← 读取本地剪贴板
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ================= CDP 控制面板 =================
function CdpPanel({ workspace, canOperate }: { workspace: WorkspaceDetailData; canOperate: boolean }) {
  const [throttle, setThrottle] = React.useState({ download: 0, upload: 0, latency: 0 })
  const [domain, setDomain] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const applyThrottle = async () => {
    setBusy(true)
    try {
      // 网络节流经网关 CDP 通道下发（Network.emulateNetworkConditions）
      const res = await fetch("/api/cdp/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspace.id,
          method: "Network.emulateNetworkConditions",
          params: { downloadThroughput: throttle.download * 1024, uploadThroughput: throttle.upload * 1024, latency: throttle.latency },
        }),
      })
      const json = await res.json()
      if (json.code === 0) toast.success("网络节流参数已下发")
      else toast.error(json.msg)
    } finally { setBusy(false) }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base"><Terminal className="h-4 w-4 inline mr-1" />连接信息</CardTitle>
          <CardDescription>所有 CDP 指令经平台网关 Route Handler 转发（限速+黑名单拦截），不直连底层 Chrome</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">Steel 会话ID</span>
            <code className="text-xs font-mono">{workspace.steelSessionId ?? "-"}</code>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">CDP 端点</span>
            <code className="text-xs font-mono">{workspace.cdpUrl ?? "-"}</code>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">CDP 调用量 / 拦截</span>
            <span className="tabular-nums">{workspace.cdpCallCount} / {workspace.cdpBlockedCount}</span>
          </div>
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 inline mr-1" />
            高危 CDP 指令（Browser.close、命令行执行类）已列入网关黑名单；单工作区每分钟指令数受限流保护。
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">网络节流模拟</CardTitle>
          <CardDescription>预设 3G/4G 或自定义延迟与带宽（精度 0.001），经 CDP Network 域下发</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            {[
              { label: "3G", v: { download: 0.05, upload: 0.02, latency: 400 } },
              { label: "4G", v: { download: 10, upload: 5, latency: 60 } },
              { label: "恢复", v: { download: 0, upload: 0, latency: 0 } },
            ].map((p) => (
              <Button key={p.label} variant="secondary" size="sm" onClick={() => setThrottle(p.v)}>{p.label}</Button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">下行 Mbps</Label>
              <PrecisionInput value={throttle.download} onChange={(v) => setThrottle({ ...throttle, download: v })} min={0} max={10000} suffix="Mb" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">上行 Mbps</Label>
              <PrecisionInput value={throttle.upload} onChange={(v) => setThrottle({ ...throttle, upload: v })} min={0} max={10000} suffix="Mb" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">延迟 ms</Label>
              <PrecisionInput value={throttle.latency} onChange={(v) => setThrottle({ ...throttle, latency: v })} min={0} max={10000} suffix="ms" />
            </div>
          </div>
          <Button size="sm" onClick={applyThrottle} disabled={busy || !canOperate}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 下发节流参数
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ================= 网络与代理面板 =================
function NetworkPanel({ workspace, canOperate }: { workspace: WorkspaceDetailData; canOperate: boolean }) {
  const router = useRouter()
  const [proxy, setProxy] = React.useState(workspace.proxyName ?? "direct")
  const [busy, setBusy] = React.useState(false)
  const [proxyNodes, setProxyNodes] = React.useState<{ id: string; name: string; type: string; status: string }[]>([])

  React.useEffect(() => {
    fetch("/api/search?q=").catch(() => {})
    // 代理列表由服务端注入的 data-api 提供
  }, [])

  const switchProxy = async () => {
    setBusy(true)
    try {
      const node = proxyNodes.find((p) => p.name === proxy)
      const res = await switchProxyAction({ id: workspace.id, proxyNodeId: node ? node.id : null })
      if (res.code === 0) { toast.success("代理已切换"); router.refresh() } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">代理与出口网络</CardTitle>
        <CardDescription>
          当前出口：{workspace.proxyName ?? "直连"}{workspace.proxyType === "internal_singbox" && workspace.singboxId ? (
            <> · <Link href={`/admin/singbox?focus=${workspace.singboxId}`} className="text-teal-600 underline">查看 SingBox 实例 {workspace.singboxName}</Link></>
          ) : null}
          。切换代理将保留 Profile 快照并重启会话。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-sm space-y-1.5">
          <Label>切换代理节点</Label>
          <Select value={proxy} onValueChange={setProxy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">直连</SelectItem>
              {proxyNodes.map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" variant="outline" onClick={switchProxy} disabled={busy || !canOperate}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 确认切换（会话将重启）
        </Button>
      </CardContent>
    </Card>
  )
}

// ================= 脚本注入面板 =================
function ScriptPanel({ workspace, scripts, runLogs, canOperate }: { workspace: WorkspaceDetailData; scripts: ScriptRow[]; runLogs: RunLogRow[]; canOperate: boolean }) {
  const router = useRouter()
  const [scriptId, setScriptId] = React.useState(scripts[0]?.id ?? "")
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    if (!scriptId) { toast.error("请选择脚本"); return }
    setBusy(true)
    try {
      const res = await runScriptAction({ workspaceId: workspace.id, scriptId })
      if (res.code === 0) {
        toast.success(res.data?.status === "BLOCKED" ? "脚本被沙箱拦截（命中高危模式）" : "脚本已执行")
        router.refresh()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">执行脚本</CardTitle>
          <CardDescription>JS 脚本经网关沙箱校验后下发 Steel 会话自动执行；支持绑定域名执行</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={scriptId} onValueChange={setScriptId}>
            <SelectTrigger><SelectValue placeholder="选择脚本模板" /></SelectTrigger>
            <SelectContent>
              {scripts.length === 0 && <SelectItem value="_" disabled>暂无可执行脚本</SelectItem>}
              {scripts.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}（{s.scope === "GLOBAL" ? "全局" : s.scope === "GROUP" ? "组" : "私有"}）</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={run} disabled={busy || !canOperate || !scriptId}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 执行脚本
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">执行日志</CardTitle>
          <CardDescription>最近10次脚本执行记录</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-64 overflow-y-auto rounded-md border divide-y text-xs">
            {runLogs.length === 0 && <p className="py-6 text-center text-muted-foreground">暂无执行记录</p>}
            {runLogs.map((l) => (
              <div key={l.id} className="p-2.5">
                <div className="flex items-center justify-between">
                  <StatusBadge status={l.status} />
                  <span className="text-muted-foreground">{l.startedAt}</span>
                </div>
                <p className="mt-1 text-muted-foreground break-all">{l.log}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ================= HAR / 录播面板 =================
function HarPanel({ workspace, harRecords }: { workspace: WorkspaceDetailData; harRecords: HarRow[] }) {
  const [busy, setBusy] = React.useState(false)
  const generate = async () => {
    setBusy(true)
    try {
      const res = await exportHarAction({ id: workspace.id })
      if (res.code === 0) {
        // 下载HAR
        window.location.href = `/api/har/download?recordId=${res.data?.recordId}`
        toast.success("HAR 已生成")
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">HAR 网络记录 / CDP 事件录播</CardTitle>
        <CardDescription>网关缓存 CDP Network 域事件，组装标准 HAR 导出；CDP 事件序列持久化可回放复现页面行为（非视频录播）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" onClick={generate} disabled={busy || workspace.mode !== "cdp_light"}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 生成并下载 HAR
        </Button>
        <div className="rounded-md border divide-y text-xs">
          {harRecords.length === 0 && <p className="py-4 text-center text-muted-foreground">暂无 HAR 记录</p>}
          {harRecords.map((h) => (
            <div key={h.id} className="flex items-center justify-between p-2.5">
              <span>{h.createdAt} · {h.size}</span>
              <a href={`/api/har/download?recordId=${h.id}`} className="text-teal-600 underline">下载</a>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ================= 共享授权面板 =================
function SharesPanel({ workspace, shares }: { workspace: WorkspaceDetailData; shares: ShareRow[] }) {
  const router = useRouter()
  const revoke = async (shareId: string) => {
    const res = await revokeShareAction({ shareId })
    if (res.code === 0) { toast.success("已撤销共享"); router.refresh() } else toast.error(res.msg)
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">共享授权列表</CardTitle>
        <CardDescription>被授权用户可访问此工作区；只读权限仅可查看，可操作权限允许完整交互（NoVNC 含键鼠与剪贴板）</CardDescription>
      </CardHeader>
      <CardContent>
        {shares.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground border border-dashed rounded-lg">暂未共享给其他用户</p>
        ) : (
          <div className="rounded-md border divide-y">
            {shares.map((s) => (
              <div key={s.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <span className="font-medium">{s.targetName}</span>
                  <Badge variant={s.permission === "OPERATE" ? "default" : "outline"} className={cn("ml-2 text-[10px]", s.permission === "OPERATE" && "bg-teal-600 hover:bg-teal-600")}>
                    {s.permission === "OPERATE" ? "可操作" : "只读"}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    创建 {s.createdAt}{s.expireAt ? ` · 过期 ${s.expireAt}` : " · 永久有效"}
                  </p>
                </div>
                {workspace.isOwner && (
                  <Button variant="ghost" size="sm" className="text-red-500" onClick={() => revoke(s.id)}>撤销</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---- 共享弹窗 ----
function ShareDialog({ workspace, open, onOpenChange, onDone }: { workspace: WorkspaceDetailData; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [username, setUsername] = React.useState("")
  const [permission, setPermission] = React.useState("VIEW")
  const [hours, setHours] = React.useState(24)
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await shareWorkspaceAction({ workspaceId: workspace.id, targetUsername: username.trim(), permission, expireHours: hours })
      if (res.code === 0) { toast.success("共享授权已创建"); onOpenChange(false); setUsername(""); onDone() }
      else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>共享工作区</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>目标用户名</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入要共享的用户名" />
          </div>
          <div className="space-y-1.5">
            <Label>权限</Label>
            <Select value={permission} onValueChange={setPermission}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="VIEW">只读（仅查看画面/数据）</SelectItem>
                <SelectItem value="OPERATE">可操作（键鼠/剪贴板/CDP）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>有效期（小时，0=永久）</Label>
            <PrecisionInput value={hours} onChange={setHours} min={0} max={8760} suffix="h" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !username.trim()}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 确认共享
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- 编辑配置弹窗 ----
function EditDialog({ workspace, open, onOpenChange, onDone }: { workspace: WorkspaceDetailData; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = React.useState(workspace.name)
  const [ttl, setTtl] = React.useState(workspace.ttlMinutes)
  const [idle, setIdle] = React.useState(workspace.idleTimeoutMinutes)
  const [tags, setTags] = React.useState(workspace.tags.join(","))
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await updateWorkspaceAction({ id: workspace.id, name, ttlMinutes: ttl, idleTimeoutMinutes: idle, tags })
      if (res.code === 0) { toast.success("配置已更新"); onOpenChange(false); onDone() }
      else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>编辑工作区配置</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>硬TTL（分钟，0不限）</Label><PrecisionInput value={ttl} onChange={setTtl} min={0} max={525600} suffix="min" /></div>
          <div className="space-y-1.5"><Label>闲置超时（分钟）</Label><PrecisionInput value={idle} onChange={setIdle} min={1} max={1440} suffix="min" /></div>
          <div className="space-y-1.5"><Label>标签（逗号分隔）</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
