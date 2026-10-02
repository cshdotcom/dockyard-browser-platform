"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft, Globe, MonitorPlay, Share2, FileJson, Terminal, Clipboard, MousePointer2, Hand,
  RefreshCw, ShieldCheck, Wifi, Loader2, Trash2, Lock, Play, StopCircle, Copy, Anchor,
  RotateCcw, LockKeyhole, FolderLock, Ban, Gauge, Infinity as InfinityIcon, Network, FileLock2, Link2, Plus, Cable,
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
  stopWorkspaceAction, startWorkspaceAction, deleteWorkspaceAction,
  revokeShareAction, exportWorkspaceConfigAction, exportHarAction, runScriptAction,
  createWorkspaceShareLinkAction, revokeWorkspaceShareLinkAction,
  refreshVncKeyAction, updateWorkspaceAction, switchProxyAction, restartBrowserProcessAction,
} from "@/server/actions/workspaces"
import { WorkspaceShareDialog } from "../share-dialogs"
import { setWorkspacePolicyOverrideAction, refreshWorkspacePolicyAction } from "@/server/actions/rules"
import { HelmPortViewer } from "@/components/vnc/helmport-viewer"
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
  /** r13c：四级共享管控（沙箱否决/用户/组/全局解析结果，供共享按钮禁用态与提示） */
  shareDisabled: boolean
  shareBlockedReason: string
  crashCategory: string | null
  policyAllowInternalNetwork: boolean | null
  policyAllowSecureLocationAccess: boolean | null
  effectivePolicy: {
    network: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; source: string }
    domain: { mode: string; black: number; white: number; rules: number }
    endpoint: { black: number; white: number }
    file: { allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean; source: string }
  } | null
  /** r14（22-c）：闲置超时四级策略链（生效值+来源徽章；locked 已按查看者角色豁免管理员） */
  idleInfo: { minutes: number; source: string; sourceLabel: string; locked: boolean; lockSourceLabel: string } | null
  /** r23：VNC 全局策略（服务端配置真实下发：默认输入模式/强制模式/水印/自适应画质） */
  vncPolicy?: {
    defaultMode: string // auto | mouse | touch
    forceMode: string // 空=不强制
    watermark: boolean
    autoQuality: boolean
  }
}

interface ShareRow { id: string; targetName: string; permission: string; expireAt: string | null; createdAt: string }
interface ShareLinkRow {
  id: string; token: string; permission: string; expireAt: string | null; revokedAt: string | null
  maxUses: number; useCount: number; lastUsedAt: string | null; note: string | null; createdAt: string
}
interface ScriptRow { id: string; name: string; description: string; scope: string }
interface HarRow { id: string; size: string; createdAt: string }
interface RunLogRow { id: string; status: string; log: string; startedAt: string }

export function WorkspaceDetail({
  workspace, shares, shareLinks, scripts, harRecords, runLogs, publicCdpEndpoint, vncBridge,
}: {
  workspace: WorkspaceDetailData
  shares: ShareRow[]
  shareLinks: ShareLinkRow[]
  scripts: ScriptRow[]
  harRecords: HarRow[]
  runLogs: RunLogRow[]
  publicCdpEndpoint?: string
  /** r13c：VNC 桥接入模式与跨域名地址（VNC_BRIDGE_PUBLIC / VNC_BRIDGE_URL） */
  vncBridge: { mode: string; url: string }
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
        <div className="flex flex-wrap items-center gap-2 max-w-full">
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
            <Button
              variant="outline" size="sm"
              onClick={() => setShareOpen(true)}
              disabled={!!workspace.shareBlockedReason}
              title={workspace.shareBlockedReason ? `共享被管理员禁止：${workspace.shareBlockedReason}` : "共享给其他用户 / 创建分享链接"}
            >
              <Share2 className={`mr-1 h-3.5 w-3.5 ${workspace.shareBlockedReason ? "opacity-50" : "text-teal-600"}`} /> 共享管理
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
          <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1">
            <span>闲置超时 {workspace.idleTimeoutMinutes > 0 ? `${Math.round(workspace.idleTimeoutMinutes)}min` : "无限（0）"}</span>
            {workspace.idleInfo && (
              <Badge
                variant="outline"
                className="text-[9px] px-1 py-0"
                title={`四级策略链生效来源：${workspace.idleInfo.sourceLabel}（沙箱＞用户＞用户组＞全局；工作区创建/编辑时锁定生效值）`}
              >
                {workspace.idleInfo.sourceLabel}
              </Badge>
            )}
            {workspace.idleInfo?.locked && (
              <Badge
                variant="outline"
                className="text-[9px] px-1 py-0 border-amber-300 text-amber-700 dark:text-amber-400"
                title={workspace.idleInfo.lockSourceLabel}
              >
                策略锁定
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">创建 {workspace.createdAt}</p>
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
            <VncPanel workspace={workspace} canOperate={canOperate} vncBridge={vncBridge} />
          </TabsContent>
        )}
        {!isVnc && (
          <TabsContent value="cdp" className="mt-4">
            <CdpPanel workspace={workspace} canOperate={canOperate} publicCdpEndpoint={publicCdpEndpoint} />
          </TabsContent>
        )}
        <TabsContent value="network" className="mt-4 space-y-4">
          {workspace.isAdmin && <SandboxPolicyPanel workspace={workspace} />}
          <NetworkPanel workspace={workspace} canOperate={canOperate} />
        </TabsContent>
        <TabsContent value="script" className="mt-4">
          <ScriptPanel workspace={workspace} scripts={scripts} runLogs={runLogs} canOperate={canOperate} />
        </TabsContent>
        <TabsContent value="har" className="mt-4">
          <HarPanel workspace={workspace} harRecords={harRecords} />
        </TabsContent>
        <TabsContent value="shares" className="mt-4">
          <SharesPanel workspace={workspace} shares={shares} shareLinks={shareLinks} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete} onOpenChange={setConfirmDelete}
        title="删除工作区" destructive confirmText="移入回收站"
        description={`「${workspace.name}」将停止底层会话并进入回收站，回收站保留期内可恢复。`}
        onConfirm={del}
      />

      <WorkspaceShareDialog
        workspace={{ id: workspace.id, name: workspace.name }}
        open={shareOpen}
        onOpenChange={setShareOpen}
        onDone={() => router.refresh()}
        blockedReason={workspace.shareBlockedReason || undefined}
      />
      <EditDialog workspace={workspace} open={editOpen} onOpenChange={setEditOpen} onDone={() => router.refresh()} />
    </div>
  )
}

// ================= NoVNC 远程桌面面板（HelmPort 品牌化查看器：自研 RFB 客户端） =================
function VncPanel({ workspace, canOperate, vncBridge }: { workspace: WorkspaceDetailData; canOperate: boolean; vncBridge: { mode: string; url: string } }) {
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

  // r13c：VNC 接入信息（跨域名部署可视化：VNC_BRIDGE_URL / VNC_BRIDGE_PUBLIC 模式透出）
  const bridgeModeLabel = vncBridge.mode === "url"
    ? "跨域名直连"
    : vncBridge.mode === "port"
      ? "独立端口直连"
      : "统一网关嵌入"
  const bridgeUrlShown = vncBridge.url
    ? (vncBridge.url.startsWith("ws") ? vncBridge.url : `wss://${vncBridge.url.replace(/^https?:\/\//, "")}`)
    : ""

  return (
    <div className="space-y-4">
      <HelmPortViewer
        workspace={{
          id: workspace.id, uuid: workspace.uuid, name: workspace.name, status: workspace.status,
          novncSessionId: workspace.novncSessionId, ownerName: workspace.ownerName,
          mySharePermission: workspace.mySharePermission, isOwner: workspace.isOwner, isAdmin: workspace.isAdmin,
        }}
        serverPolicy={workspace.vncPolicy ? {
          defaultMode: workspace.vncPolicy.defaultMode === "mouse" || workspace.vncPolicy.defaultMode === "touch" ? workspace.vncPolicy.defaultMode : "auto",
          forceMode: workspace.vncPolicy.forceMode === "mouse" || workspace.vncPolicy.forceMode === "touch" ? workspace.vncPolicy.forceMode : "",
          watermark: workspace.vncPolicy.watermark,
          autoQuality: workspace.vncPolicy.autoQuality,
        } : undefined}
      />

      {/* r13c：VNC 接入信息（跨域名部署可视化） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            <Cable className="h-4 w-4" /> VNC 接入信息
          </CardTitle>
          <CardDescription>当前接入形态：{bridgeModeLabel}（管理员可经 VNC_BRIDGE_PUBLIC / VNC_BRIDGE_URL 环境变量切换）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">接入模式</span>
            <Badge variant={bridgeUrlShown ? "default" : "outline"} className="text-[11px]">{bridgeModeLabel}</Badge>
          </div>
          {bridgeUrlShown ? (
            <div className="rounded-md border border-teal-200 bg-teal-50 dark:bg-teal-950/30 p-2.5">
              <div className="text-xs text-muted-foreground mb-1">公网 VNC 桥地址（跨域名部署）</div>
              <code className="text-xs font-mono break-all">{bridgeUrlShown}</code>
              <p className="text-[11px] text-muted-foreground mt-1">VNC 部署在其他域名时，页面取票后经该地址建立 WebSocket（反代需透传 WS 升级头与长连接；票据 HMAC 单次防重放鉴权不受域限制）</p>
            </div>
          ) : (
            <div className="rounded-md border p-2.5 text-xs text-muted-foreground">
              VNC 画面经当前访问域名自动嵌入（统一网关透传，无需额外配置）。VNC 独立域名部署时，管理员设置环境变量
              <code className="mx-1 px-1 py-0.5 rounded bg-muted font-mono">VNC_BRIDGE_URL=wss://vnc.example.com</code>
              后此处将展示公网桥地址。
            </div>
          )}
        </CardContent>
      </Card>

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
  const isExternal = h.runtime === "external"
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
      desc:
        (h as { pidsLimitMode?: string }).pidsLimitMode === "skipped-shared-uid" || h.pidsLimit === 0
          ? `CPU ${String(h.cpuLimit ?? "-")} 核 / 内存 ${String(h.memLimitMb ?? "-")}MB（同用户模式：进程数上限已降级跳过，内存上限兜底）`
          : `CPU ${String(h.cpuLimit ?? "-")} 核 / 内存 ${String(h.memLimitMb ?? "-")}MB / Pids ${String(h.pidsLimit ?? "-")}（专用用户 prlimit-uid），超限 OOM 硬终止`,
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
      ok: isExternal || h.policyManagedChromium === true,
      icon: <LockKeyhole className="h-4 w-4" />,
      title: isExternal ? "Chromium 托管策略（外部部署侧）" : "Chromium 托管策略锁",
      desc: isExternal
        ? "网络/域名/CRX 策略由外部浏览器部署侧的 Chromium 托管策略执行（平台侧不注入）"
        : "网络策略以只读 bind-mount 注入（/etc/chromium/policies/managed），只读根 FS 下沙箱内无法篡改",
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
          {isExternal && (
            <Badge className="bg-teal-600 text-white">外部浏览器 · 分离部署 {String(h.externalBrowser?.endpoint || "")}</Badge>
          )}
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
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
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
function CdpPanel({ workspace, canOperate, publicCdpEndpoint }: { workspace: WorkspaceDetailData; canOperate: boolean; publicCdpEndpoint?: string }) {
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
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base"><Terminal className="h-4 w-4 inline mr-1" />连接信息</CardTitle>
          <CardDescription>所有 CDP 指令经平台网关 Route Handler 转发（限速+黑名单拦截），不直连底层 Chrome</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {publicCdpEndpoint && (
            <div className="rounded-md border border-teal-200 bg-teal-50 dark:bg-teal-950/30 p-2.5">
              <div className="text-xs text-muted-foreground mb-1">公网网关端点（外部工具接入用）</div>
              <code className="text-xs font-mono break-all">{publicCdpEndpoint}</code>
              <p className="text-[11px] text-muted-foreground mt-1">内网穿透/域名部署场景：Puppeteer/Playwright/自定义脚本经此端点鉴权转发，无需访问内部网络</p>
            </div>
          )}
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">Steel 会话ID</span>
            <code className="text-xs font-mono">{workspace.steelSessionId ?? "-"}</code>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2.5">
            <span className="text-muted-foreground">内部 CDP 端点</span>
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
// ================= 沙箱级策略覆盖面板（四层定向最高优先 · 管理员）=================
function SandboxPolicyPanel({ workspace }: { workspace: WorkspaceDetailData }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [internal, setInternal] = React.useState<"inherit" | "allow" | "deny">(
    workspace.policyAllowInternalNetwork === true ? "allow" : workspace.policyAllowInternalNetwork === false ? "deny" : "inherit",
  )
  const [secure, setSecure] = React.useState<"inherit" | "allow" | "deny">(
    workspace.policyAllowSecureLocationAccess === true ? "allow" : workspace.policyAllowSecureLocationAccess === false ? "deny" : "inherit",
  )

  const tri = (v: "inherit" | "allow" | "deny"): boolean | null => (v === "inherit" ? null : v === "allow")

  const save = async () => {
    setBusy(true)
    try {
      const res = await setWorkspacePolicyOverrideAction({
        workspaceId: workspace.id,
        allowInternalNetwork: tri(internal),
        allowSecureLocationAccess: tri(secure),
        restartNow: true,
      })
      if (res.code === 0 && res.data) {
        const eff = res.data.effective
        toast.success("沙箱级覆盖已保存", {
          description: `生效：内网${eff.allowInternalNetwork ? "允许" : "禁止"} · 安全位置${eff.allowSecureLocationAccess ? "允许" : "禁止"}（来源 ${eff.source}）${res.data.restarted ? " · 已重启浏览器进程即时生效" : ""}`,
        })
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setBusy(true)
    try {
      const res = await refreshWorkspacePolicyAction({ id: workspace.id })
      if (res.code === 0 && res.data) {
        const eff = res.data.effective as Record<string, Record<string, unknown>>
        toast.success("策略已即时刷新", {
          description: `四层重解析完成${res.data.restarted ? " · 浏览器进程已重启生效" : ""}（网络来源 ${(eff.network as { source?: string })?.source ?? "-"} / 文件来源 ${(eff.file as { source?: string })?.source ?? "-"}）`,
        })
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "刷新失败")
    } finally {
      setBusy(false)
    }
  }

  const eff = workspace.effectivePolicy
  const sourceLabel = (src: string) =>
    src === "SANDBOX" ? "沙箱级覆盖" : src === "USER" ? "用户级" : src === "GROUP" ? "组级继承" : src === "GLOBAL" ? "全局" : src === "GLOBAL_DEFAULT" ? "全局默认" : src === "DEFAULT" ? "系统默认" : src

  const TriSeg = ({ value, onChange }: { value: "inherit" | "allow" | "deny"; onChange: (v: "inherit" | "allow" | "deny") => void }) => (
    <div className="flex items-center rounded-lg border p-0.5 shrink-0">
      {(["inherit", "deny", "allow"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === v ? (v === "allow" ? "bg-emerald-600 text-white" : v === "deny" ? "bg-red-600 text-white" : "bg-slate-600 text-white") : "text-muted-foreground hover:text-foreground",
          )}
        >{v === "inherit" ? "继承上层" : v === "deny" ? "禁止" : "允许"}</button>
      ))}
    </div>
  )

  if (workspace.mode !== "novnc_full") return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-teal-600" /> 沙箱级策略定向（单沙箱最高优先）</CardTitle>
        <CardDescription>
          本沙箱覆盖值优先于用户/用户组/全局；保存后立即重刷策略文件并重启浏览器进程（约 1 秒）。
          域名/端点/IP 黑白名单与文件限制的单沙箱定向请在「规则管理」与「策略下发中心」配置。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-lg border p-3 gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">访问内网（RFC1918 / 链路本地 / 云元数据）</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                当前生效：{eff ? `${eff.network.allowInternalNetwork ? "允许" : "禁止"}（${sourceLabel(eff.network.source)}）` : "-"}
              </p>
            </div>
            <TriSeg value={internal} onChange={setInternal} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3 gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">访问容器内安全位置（CDP/VNC 端口 / chrome://）</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                当前生效：{eff ? `${eff.network.allowSecureLocationAccess ? "允许" : "禁止"}（${sourceLabel(eff.network.source)}）` : "-"}
              </p>
            </div>
            <TriSeg value={secure} onChange={setSecure} />
          </div>
        </div>

        {eff && (
          <div className="rounded-lg border bg-muted/40 p-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">域名黑白名单</span>
              <span>{eff.domain.mode === "WHITELIST" ? `白名单严格 · 放行 ${eff.domain.white} 项` : `黑名单 · 拦截 ${eff.domain.black} 项`}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">端点级限制</span>
              <span>拦截 {eff.endpoint.black} 项 · 例外 {eff.endpoint.white} 项</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">文件下载</span>
              <span className={eff.file.allowDownload ? "text-emerald-600" : "text-red-600"}>{eff.file.allowDownload ? "允许" : "禁止"}（{sourceLabel(eff.file.source)}）</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">文件上传 / file://</span>
              <span>{eff.file.allowUpload ? "上传允许" : "上传禁止"} · {eff.file.allowFileScheme ? "file://允许" : "file://禁止"}</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 保存覆盖（即时生效）
          </Button>
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 策略即时刷新（重解析四层）
          </Button>
          <p className="text-[11px] text-muted-foreground">仅管理员可见；运行中沙箱刷新后浏览器进程自动重启（同 Profile）</p>
        </div>
      </CardContent>
    </Card>
  )
}

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
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
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
function SharesPanel({ workspace, shares, shareLinks }: { workspace: WorkspaceDetailData; shares: ShareRow[]; shareLinks: ShareLinkRow[] }) {
  const router = useRouter()
  const revoke = async (shareId: string) => {
    const res = await revokeShareAction({ shareId })
    if (res.code === 0) { toast.success("已撤销共享"); router.refresh() } else toast.error(res.msg)
  }
  const [linkCreateOpen, setLinkCreateOpen] = React.useState(false)
  // 新建链接后立即展示完整 URL（一次展示，关闭后仅列表可见）
  const [freshLink, setFreshLink] = React.useState<{ url: string; permission: string; expireAt: string | null; maxUses: number } | null>(null)

  const revokeLink = async (linkId: string) => {
    const res = await revokeWorkspaceShareLinkAction({ linkId })
    if (res.code === 0) { toast.success("已撤销分享链接"); router.refresh() } else toast.error(res.msg)
  }

  const copyLink = async (token: string) => {
    const url = `${window.location.origin}/workspaces/shared?token=${token}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("链接已复制到剪贴板")
    } catch {
      toast.info(url) // 剪贴板不可用时展示完整链接供手动复制
    }
  }

  return (
    <div className="space-y-4">
      {workspace.shareBlockedReason && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {workspace.shareBlockedReason} —— 既有共享继续生效，但不能再添加新共享/创建分享链接；管理员可在「工作区管控 → 共享关系总列表」撤销既有共享
        </div>
      )}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">共享授权列表（按用户）</CardTitle>
          <CardDescription>按用户名精确搜索并添加；只读权限仅可查看，可操作权限允许完整交互（NoVNC 含键鼠与剪贴板）</CardDescription>
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

      {/* ---- 临时分享链接（带有效期 + 权限 + 次数上限；已登录用户访问链接即自动绑定） ---- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5"><Link2 className="h-4 w-4 text-violet-500" />临时分享链接</CardTitle>
              <CardDescription>发给同事即可接入（需登录）；访问链接自动按权限绑定共享，可设有效期与次数上限</CardDescription>
            </div>
            {workspace.isOwner && (
              <Button size="sm" variant="outline" onClick={() => { setFreshLink(null); setLinkCreateOpen(true) }}>
                <Plus className="mr-1 h-4 w-4" />创建链接
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {freshLink && (
            <div className="rounded-md border border-violet-200 bg-violet-50/70 dark:bg-violet-950/30 dark:border-violet-800 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">链接已创建（完整地址仅此一次展示，可随时在列表中复制）：</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded bg-muted px-2 py-1.5 text-xs font-mono">{freshLink.url}</code>
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${freshLink.url}`).then(() => toast.success("已复制")).catch(() => toast.info(`${window.location.origin}${freshLink.url}`))}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                权限 {freshLink.permission === "OPERATE" ? "可操作" : "只读"} · {freshLink.expireAt ? `有效期至 ${freshLink.expireAt}` : "永久有效"} · 次数 {freshLink.maxUses > 0 ? `限 ${freshLink.maxUses} 次` : "不限"}
              </p>
            </div>
          )}
          {shareLinks.length === 0 && !freshLink ? (
            <p className="py-6 text-center text-sm text-muted-foreground border border-dashed rounded-lg">暂无分享链接</p>
          ) : (
            <div className="rounded-md border divide-y max-h-72 overflow-y-auto">
              {shareLinks.map((l) => {
                const dead = !!l.revokedAt || (l.expireAt ? new Date(l.expireAt).getTime() < Date.now() : false) || (l.maxUses > 0 && l.useCount >= l.maxUses)
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted truncate max-w-40" title={l.token}>{l.token.slice(0, 12)}…</code>
                        <Badge variant={l.permission === "OPERATE" ? "default" : "outline"} className={cn("text-[10px]", l.permission === "OPERATE" && "bg-teal-600 hover:bg-teal-600")}>
                          {l.permission === "OPERATE" ? "可操作" : "只读"}
                        </Badge>
                        {l.revokedAt ? (
                          <Badge variant="secondary" className="text-[10px] text-red-600">已撤销</Badge>
                        ) : dead ? (
                          <Badge variant="secondary" className="text-[10px] text-amber-600">已失效</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] text-teal-600">生效中</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {l.expireAt ? `过期 ${l.expireAt}` : "永久"}
                        {` · 已用 ${l.useCount}${l.maxUses > 0 ? `/${l.maxUses}` : ""} 次`}
                        {l.lastUsedAt ? ` · 最近使用 ${l.lastUsedAt}` : ""}
                      </p>
                      {l.note && <p className="text-xs text-muted-foreground/80 mt-0.5 truncate" title={l.note}>备注：{l.note}</p>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!l.revokedAt && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => void copyLink(l.token)} aria-label="复制链接">
                            <Copy className="h-4 w-4" />
                          </Button>
                          {workspace.isOwner && (
                            <Button variant="ghost" size="sm" className="text-red-500" onClick={() => void revokeLink(l.id)} disabled={dead} aria-label="撤销链接">
                              撤销
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 创建链接弹窗 */}
      <ShareLinkCreateDialog workspace={workspace} open={linkCreateOpen} onOpenChange={(v) => { setLinkCreateOpen(v); if (!v) setFreshLink(null) }} onCreated={(r) => { setFreshLink(r); router.refresh() }} />
    </div>
  )
}

// ---- 创建分享链接弹窗 ----
function ShareLinkCreateDialog({ workspace, open, onOpenChange, onCreated }: {
  workspace: WorkspaceDetailData
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (r: { url: string; permission: string; expireAt: string | null; maxUses: number }) => void
}) {
  const [permission, setPermission] = React.useState("VIEW")
  const [hours, setHours] = React.useState(72)
  const [maxUses, setMaxUses] = React.useState(0)
  const [note, setNote] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await createWorkspaceShareLinkAction({ workspaceId: workspace.id, permission, expireHours: hours, maxUses, note })
      if (res.code === 0 && res.data) {
        toast.success("分享链接已创建")
        onCreated({ url: res.data.url, permission: res.data.permission, expireAt: res.data.expireAt, maxUses: res.data.maxUses })
        onOpenChange(false)
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Link2 className="h-4 w-4 text-violet-500" />创建临时分享链接</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>链接权限</Label>
            <Select value={permission} onValueChange={setPermission}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="VIEW">只读（仅查看画面/数据）</SelectItem>
                <SelectItem value="OPERATE">可操作（键鼠/剪贴板/CDP）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>链接有效期（小时，0=永久）</Label>
            <PrecisionInput value={hours} onChange={setHours} min={0} max={8760} suffix="h" />
          </div>
          <div className="space-y-1.5">
            <Label>最大使用次数（0=不限；每次访问绑定记 1 次）</Label>
            <PrecisionInput value={maxUses} onChange={setMaxUses} min={0} max={1000} suffix="次" />
          </div>
          <div className="space-y-1.5">
            <Label>备注（可选，仅自己可见）</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：发给同事张三临时排查" maxLength={120} />
          </div>
          <p className="text-xs text-muted-foreground">已登录用户打开链接后自动按上述权限绑定共享；到期/超次/撤销后立即失效</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 创建链接</Button>
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
  // r14（22-c）：闲置超时策略锁定（管理员查看者已在服务端豁免）→ 字段只读且提交不携带（服务端保留现值）
  const idleLocked = !!workspace.idleInfo?.locked
  const submit = async () => {
    setBusy(true)
    try {
      const res = await updateWorkspaceAction({
        id: workspace.id, name, ttlMinutes: ttl,
        ...(idleLocked ? {} : { idleTimeoutMinutes: idle }),
        tags,
      })
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
          <div className="space-y-1.5">
            <Label>闲置超时（分钟）</Label>
            {idleLocked ? (
              <div className="rounded-md border bg-muted/50 px-3 py-2">
                <p className="text-xs text-muted-foreground">由管理员策略锁定：{idle > 0 ? `${Math.round(idle)} 分钟` : "无限"}</p>
                <p className="text-[10px] text-muted-foreground">生效来源 {workspace.idleInfo?.sourceLabel} · {workspace.idleInfo?.lockSourceLabel} · 不可自行调整</p>
              </div>
            ) : (
              <>
                <PrecisionInput value={idle} onChange={setIdle} min={0} max={1440} suffix="min" />
                <p className="text-[10px] text-muted-foreground">0=无限（永不闲置回收）</p>
              </>
            )}
          </div>
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
