"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft, Globe, MonitorPlay, Share2, FileJson, Terminal, Clipboard, MousePointer2, Hand,
  RefreshCw, ShieldCheck, Wifi, Loader2, Trash2, Lock, Play, StopCircle, Copy, Anchor,
  RotateCcw, LockKeyhole, FolderLock, Ban, Gauge, Infinity as InfinityIcon, Network, FileLock2,
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
  refreshVncKeyAction, updateWorkspaceAction, switchProxyAction, restartBrowserProcessAction,
} from "@/server/actions/workspaces"
import { LiveDeskViewer } from "@/components/vnc/live-desk-viewer"
import { cn } from "@/lib/utils"

export interface WorkspaceDetailData {
  id: string; uuid: string; name: string; mode: string; status: string
  tags: string[]; ttlMinutes: number; idleTimeoutMinutes: number
  cdpCallCount: number; cdpBlockedCount: number
  novncConnCount: number; novncFps: number; novncActiveMin: number
  cdpUrl: string | null; steelSessionId: string | null; novncSessionId: string | null
  containerRef: string | null; hardening: Record<string, unknown> | null
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

// ================= NoVNC 远程桌面面板（LiveDesk 品牌化查看器） =================
function VncPanel({ workspace, canOperate }: { workspace: WorkspaceDetailData; canOperate: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const refreshKey = async () => {
    setBusy(true)
    try {
      const res = await refreshVncKeyAction({ id: workspace.id })
      if (res.code === 0) { toast.success("VNC 临时密钥已刷新"); router.refresh() } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  // 防退出运维：容器内浏览器进程级重启（同一 Profile 秒级拉起）
  const restartBrowser = async () => {
    setBusy(true)
    try {
      const res = await restartBrowserProcessAction({ id: workspace.id })
      if (res.code === 0) {
        toast.success(res.data?.simulated ? "已触发浏览器进程重启（模拟通道）" : "已触发浏览器进程重启，同一 Profile 秒级拉起")
        router.refresh()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <LiveDeskViewer
        workspace={{
          id: workspace.id, uuid: workspace.uuid, name: workspace.name, status: workspace.status,
          novncSessionId: workspace.novncSessionId, ownerName: workspace.ownerName,
          mySharePermission: workspace.mySharePermission, isOwner: workspace.isOwner, isAdmin: workspace.isAdmin,
        }}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> 会话管控
          </CardTitle>
          <CardDescription>
            NoVNC 会话经平台统一网关中转（工作区 UUID + HMAC 单次票据双因子校验），原始内网地址不暴露给浏览器。
            {workspace.mySharePermission === "VIEW" && " 您仅有只读权限：仅可查看画面，键鼠输入在服务端被拦截。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshKey} disabled={!canOperate || busy}>
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy && "animate-spin")} /> 刷新临时密钥
            </Button>
            <Button variant="outline" size="sm" onClick={restartBrowser} disabled={!canOperate || busy} title="容器内浏览器进程退出后由 supervisor 以同一 Profile 自动拉起；此按钮用于卡死时手动触发">
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> 重启浏览器进程
            </Button>
            <span className="text-xs text-muted-foreground">
              防退出：浏览器进程退出后 1 秒内自动以同一 Profile 拉起（supervisor 循环 + RestartPolicy=always + 看门狗自动重建）
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">接入客户端</div>
              <div className="mt-1 font-semibold">{workspace.novncConnCount} 个</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">实时帧率</div>
              <div className="mt-1 font-semibold">{Math.round(workspace.novncFps)} fps</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">活跃时长</div>
              <div className="mt-1 font-semibold">{Math.round(workspace.novncActiveMin)} min</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">会话通道</div>
              <div className="mt-1 font-mono text-[11px] font-semibold truncate">{workspace.novncSessionId?.slice(0, 16) || "-"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <IsolationPanel hardening={workspace.hardening} containerRef={workspace.containerRef} />
    </div>
  )
}

// ================= 安全隔离面板（硬隔离 + 防退出可视化） =================
function IsolationPanel({ hardening, containerRef }: { hardening: Record<string, unknown> | null; containerRef: string | null }) {
  const h = hardening || {}
  const items: { ok: boolean; icon: React.ReactNode; title: string; desc: string }[] = [
    {
      ok: h.readOnlyRootfs !== false,
      icon: <LockKeyhole className="h-4 w-4" />,
      title: "根文件系统只读",
      desc: "容器以 ReadOnlyRootfs 运行，系统目录任何位置不可写入",
    },
    {
      ok: h.capDropAll !== false,
      icon: <Ban className="h-4 w-4" />,
      title: "Capabilities 全部丢弃",
      desc: "CapDrop=ALL + no-new-privileges，禁止 setuid 提权",
    },
    {
      ok: h.isolatedProfileVolume !== false,
      icon: <FolderLock className="h-4 w-4" />,
      title: "仅挂载本人 Profile 卷",
      desc: "唯一持久卷为该用户专属目录；其他用户的资料与文件不在容器命名空间内（不可见即不可读）",
    },
    {
      ok: h.noexecDownloads !== false,
      icon: <Ban className="h-4 w-4" />,
      title: "下载目录 noexec",
      desc: "下载的软件落至 noexec tmpfs，运行即报权限错误（Permission denied）",
    },
    {
      ok: h.restartPolicy === "always",
      icon: <InfinityIcon className="h-4 w-4" />,
      title: "防退出：supervisor 循环",
      desc: "浏览器关闭/崩溃后 1 秒内以同一 Profile 自动拉起；容器级 RestartPolicy=always",
    },
    {
      ok: h.oomHardKill !== false,
      icon: <Gauge className="h-4 w-4" />,
      title: "资源硬限制",
      desc: `CPU ${String(h.cpuLimit ?? "-")} 核 / 内存 ${String(h.memLimitMb ?? "-")}MB / Pids ${String(h.pidsLimit ?? "-")}，超限 OOM 硬终止`,
    },
    {
      ok: h.allowInternalNetwork !== true,
      icon: <Network className="h-4 w-4" />,
      title: h.allowInternalNetwork === true ? "内网访问：管理员已放行" : "内网访问拦截",
      desc:
        h.allowInternalNetwork === true
          ? "管理员授权该用户/组访问私有网段（10/172.16/192.168/169.254 等）"
          : "私有网段/链路本地/云元数据全部拦截（Chromium 托管策略 URLBlocklist + WebRTC 防泄漏）",
    },
    {
      ok: h.allowSecureLocationAccess !== true,
      icon: <FileLock2 className="h-4 w-4" />,
      title: h.allowSecureLocationAccess === true ? "安全位置：管理员已放行" : "安全位置拦截",
      desc:
        h.allowSecureLocationAccess === true
          ? "管理员授权访问容器内安全位置（本机 CDP/VNC、file://、平台内部端点）"
          : "本机 CDP:9222/VNC:5900、file:// 协议、chrome:// 管理页、平台内部端点全部封禁；代理设置锁定不可改",
    },
    {
      ok: h.policyManagedChromium === true,
      icon: <LockKeyhole className="h-4 w-4" />,
      title: "Chromium 托管策略锁",
      desc: "网络策略以只读 bind-mount 注入（/etc/chromium/policies/managed），只读根 FS 下沙箱内无法篡改",
    },
    {
      ok: h.iccDisabledNetwork !== false,
      icon: <Ban className="h-4 w-4" />,
      title: "容器互访封禁（ICC）",
      desc: "会话网络容器间互访封禁，跨用户浏览器网络不可达（防横向探测）",
    },
  ]
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> 安全隔离 · 防退出
          {h.provisioned === "simulated" && <Badge variant="secondary">沙箱演示规格</Badge>}
          {containerRef && (
            <Badge className="bg-teal-600 hover:bg-teal-600">
              <Anchor className="h-3 w-3 mr-1" /> 容器 {containerRef.slice(0, 20)}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          每个会话运行在独立硬隔离容器中：用户无法以任何形式退出浏览器（闪退后立即恢复同一配置环境）；
          对其他用户资料与任何其他文件无读取权限；下载软件运行直接报权限错误；
          网络访问按管理员策略执行（内网 / 容器安全位置，默认全部拒绝）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <div key={it.title} className={cn("flex gap-2 rounded-lg border p-2.5", it.ok ? "border-emerald-500/25 bg-emerald-500/[0.06]" : "border-slate-200 bg-muted/30")}>
              <div className={cn("mt-0.5 shrink-0 rounded-md p-1.5", it.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>
                {it.icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-xs font-semibold">
                  {it.title}
                  {it.ok && <ShieldCheck className="h-3 w-3 text-emerald-600" />}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{it.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
