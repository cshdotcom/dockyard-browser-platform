"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Loader2, Globe, MonitorPlay, Share2, Wifi, Zap, StopCircle, Play, Trash2, Settings2, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable, StatusBadge, type Column } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import {
  createWorkspaceAction, stopWorkspaceAction, startWorkspaceAction, deleteWorkspaceAction,
  switchProxyAction, exportWorkspaceConfigAction,
} from "@/server/actions/workspaces"
import { WorkspaceShareDialog } from "./share-dialogs"
import { cn } from "@/lib/utils"

export interface WorkspaceRow {
  id: string
  uuid: string
  name: string
  mode: string
  status: string
  ownerName: string
  isOwner: boolean
  isShared: boolean
  proxyNodeId: string | null
  singboxInstanceId: string | null
  ttlMinutes: number
  idleTimeoutMinutes: number
  cdpCallCount: number
  novncConnCount: number
  tags: string[]
  createdAt: string
  profileSnapshotId: string | null
  /** r25-d：最近一次启动失败原因（status=ERROR 时展示；引擎已自动重试 3 次） */
  lastError?: string | null
  /** r13c：共享管控状态（四级解析结果；仅 isOwner 行有意义） */
  shareControl?: { allowed: boolean; reason: string }
}

interface Props {
  rows: WorkspaceRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: { mode?: string; status?: string }
  templates: { id: string; name: string; scope: string }[]
  snapshots: { id: string; name: string }[]
  proxyNodes: { id: string; name: string; type: string; status: string }[]
  isAdmin: boolean
  currentUserId: string
  /** r14（22-c）：闲置超时策略（创建表单默认值 + 锁定态） */
  idlePolicy: { locked: boolean; minutes: number; sourceLabel: string; lockSourceLabel: string }
}

export function WorkspacesTable(props: Props) {
  const router = useRouter()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<WorkspaceRow | null>(null)
  const [proxyTarget, setProxyTarget] = React.useState<WorkspaceRow | null>(null)
  const [shareTarget, setShareTarget] = React.useState<WorkspaceRow | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])

  // r25-a 全局搜索深链 /workspaces?create=1：自动打开创建弹窗（一次性消费后从 URL 剥离）
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const sp = new URLSearchParams(window.location.search)
    if (sp.get("create") === "1") {
      setCreateOpen(true)
      sp.delete("create")
      const qs = sp.toString()
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""))
    }
  }, [])

  const query = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams()
    const current: Record<string, string | undefined> = {
      page: String(props.page), pageSize: String(props.pageSize), keyword: props.keyword,
      sortField: props.sortField, sortOrder: props.sortOrder, ...props.filters,
    }
    for (const [k, v] of Object.entries({ ...current, ...patch })) {
      if (v) params.set(k, v)
    }
    router.push(`/workspaces?${params.toString()}`)
  }

  const stop = async (row: WorkspaceRow) => {
    setBusyId(row.id)
    try {
      const res = await stopWorkspaceAction({ id: row.id })
      if (res.code === 0) { toast.success("工作区已停止"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const start = async (row: WorkspaceRow) => {
    setBusyId(row.id)
    try {
      const res = await startWorkspaceAction({ id: row.id })
      if (res.code === 0) { toast.success("工作区已启动"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const remove = async (row: WorkspaceRow) => {
    setBusyId(row.id)
    try {
      const res = await deleteWorkspaceAction({ id: row.id, reason: "" })
      if (res.code === 0) { toast.success("已移入回收站"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }

  const columns: Column<WorkspaceRow>[] = [
    {
      key: "name", title: "名称", sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <Link href={`/workspaces/${r.id}`} className="text-sm font-medium text-teal-700 dark:text-teal-300 hover:underline flex items-center gap-1.5">
            {r.mode === "cdp_light" ? <Globe className="h-3.5 w-3.5 shrink-0" /> : <MonitorPlay className="h-3.5 w-3.5 shrink-0" />}
            {r.name}
          </Link>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{r.uuid.slice(0, 16)}</p>
        </div>
      ),
    },
    {
      key: "mode", title: "模式",
      render: (r) => r.mode === "cdp_light" ? <Badge variant="secondary">CDP 轻量</Badge> : <Badge className="bg-violet-600 hover:bg-violet-600">NoVNC 重度</Badge>,
    },
    { key: "status", title: "状态", sortable: true, render: (r) => (
      <div className="min-w-0">
        <StatusBadge status={r.status} />
        {r.status === "ERROR" && r.lastError && (
          <p className="mt-1 max-w-52 truncate text-[11px] text-red-600 dark:text-red-400" title={r.lastError}>
            {r.lastError.split("\n")[0].slice(0, 90)}
          </p>
        )}
      </div>
    ) },
    {
      key: "owner", title: "归属",
      render: (r) => (
        <span className="text-xs">
          {r.isOwner ? <Badge variant="outline" className="text-[10px]">我创建的</Badge> : r.isShared ? <Badge className="bg-amber-600 hover:bg-amber-600 text-[10px]">共享给我</Badge> : <span className="text-muted-foreground">{r.ownerName}</span>}
          {!r.isOwner && !r.isShared && props.isAdmin && <p className="text-muted-foreground text-[10px] mt-0.5">{r.ownerName}</p>}
        </span>
      ),
    },
    {
      key: "network", title: "网络",
      render: (r) => {
        const node = props.proxyNodes.find((p) => p.id === r.proxyNodeId)
        return (
          <div className="text-xs">
            {node ? (
              <span className="flex items-center gap-1">
                <Wifi className="h-3 w-3 text-teal-600" />
                {node.name}
                {node.type === "internal_singbox" && <Badge variant="outline" className="text-[9px] px-1 h-4">SingBox</Badge>}
              </span>
            ) : (
              <span className="text-muted-foreground">直连</span>
            )}
            {r.tags.length > 0 && <div className="text-[10px] text-muted-foreground mt-0.5">{r.tags.map((t) => `#${t}`).join(" ")}</div>}
          </div>
        )
      },
    },
    {
      key: "timeouts", title: "TTL / 闲置",
      render: (r) => (
        <span className="text-xs tabular-nums">
          {r.ttlMinutes > 0 ? `${r.ttlMinutes}min` : "不限"} / {r.idleTimeoutMinutes > 0 ? `${r.idleTimeoutMinutes}min` : "无限"}
        </span>
      ),
    },
    {
      key: "usage", title: "用量",
      render: (r) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {r.mode === "cdp_light" ? `${r.cdpCallCount} CDP调用` : `${r.novncConnCount} 连接`}
        </span>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (r) => <span className="text-xs text-muted-foreground">{r.createdAt}</span> },
  ]

  const rowActions = (r: WorkspaceRow) => (
    <div className="flex items-center justify-end gap-1">
      <Link href={`/workspaces/${r.id}`}>
        <Button variant="ghost" size="icon" title="打开会话"><MonitorPlay className="h-4 w-4" /></Button>
      </Link>
      {r.isOwner && (
        <Button
          variant="ghost" size="icon"
          title={r.shareControl?.allowed ? "共享：把该工作区共享给其他用户（权限/有效期可选）" : `共享被管理员禁止：${r.shareControl?.reason || ""}`}
          disabled={!r.shareControl?.allowed}
          onClick={() => setShareTarget(r)}
          className={!r.shareControl?.allowed ? "opacity-40" : ""}
        >
          <Share2 className={`h-4 w-4 ${r.shareControl?.allowed ? "text-teal-600" : "text-muted-foreground"}`} />
        </Button>
      )}
      {r.status === "RUNNING" || r.status === "IDLE" ? (
        <Button variant="ghost" size="icon" title="停止" disabled={busyId === r.id} onClick={() => stop(r)}>
          <StopCircle className="h-4 w-4 text-amber-600" />
        </Button>
      ) : r.status === "STOPPED" ? (
        <Button variant="ghost" size="icon" title="启动" disabled={busyId === r.id} onClick={() => start(r)}>
          <Play className="h-4 w-4 text-emerald-600" />
        </Button>
      ) : null}
      <Button variant="ghost" size="icon" title="切换代理" onClick={() => setProxyTarget(r)}>
        <Wifi className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" title="删除（入回收站）" onClick={() => setDeleteTarget(r)}>
        <Trash2 className="h-4 w-4 text-red-500" />
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Tabs defaultValue={props.filters.mode || "all"} onValueChange={(v) => query({ mode: v === "all" ? undefined : v, page: "1" })}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="cdp_light">CDP 轻量</TabsTrigger>
            <TabsTrigger value="novnc_full">NoVNC 重度</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> 新建工作区
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={props.rows}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        keyword={props.keyword}
        sortField={props.sortField}
        sortOrder={props.sortOrder}
        filters={[
          {
            key: "status", placeholder: "状态",
            options: ["RUNNING", "IDLE", "STOPPED", "ERROR", "FROZEN", "DESTROYED"].map((s) => ({ label: s, value: s })),
          },
        ]}
        onQueryChange={query}
        rowActions={rowActions}
        selectedIds={selectedIds}
        onSelectedChange={setSelectedIds}
        batchToolbar={
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">已选 {selectedIds.length} 项</span>
            <BatchBar ids={selectedIds} onDone={() => { setSelectedIds([]); router.refresh() }} />
          </div>
        }
      />

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} templates={props.templates} snapshots={props.snapshots} proxyNodes={props.proxyNodes} idlePolicy={props.idlePolicy} />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除工作区"
        description={`「${deleteTarget?.name}」将停止底层会话并移入回收站，可在回收站有效期内恢复。`}
        destructive
        confirmText="移入回收站"
        onConfirm={async () => { if (deleteTarget) await remove(deleteTarget) }}
      />

      <ProxySwitchDialog
        target={proxyTarget}
        proxyNodes={props.proxyNodes}
        onClose={() => setProxyTarget(null)}
        onDone={() => { setProxyTarget(null); router.refresh() }}
      />

      {/* r13c：列表行内共享弹窗（与详情页同一组件；四级管控阻断原因透传） */}
      {shareTarget && (
        <WorkspaceShareDialog
          workspace={{ id: shareTarget.id, name: shareTarget.name }}
          open={!!shareTarget}
          onOpenChange={(v) => { if (!v) setShareTarget(null) }}
          onDone={() => router.refresh()}
          blockedReason={shareTarget.shareControl?.allowed ? undefined : shareTarget.shareControl?.reason}
        />
      )}
    </div>
  )
}

// ---- 批量操作工具栏 ----
function BatchBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const exec = async (op: "stop" | "delete") => {
    setBusy(true)
    let ok = 0, fail = 0
    for (const id of ids) {
      const res = op === "stop" ? await stopWorkspaceAction({ id }) : await deleteWorkspaceAction({ id, reason: "批量操作" })
      if (res.code === 0) ok++; else fail++
    }
    setBusy(false)
    toast.success(`批量操作完成：成功 ${ok} 项${fail > 0 ? `，失败 ${fail} 项` : ""}`)
    onDone()
    router.refresh()
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy || ids.length === 0} onClick={() => exec("stop")}>
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 批量停止
      </Button>
      <ConfirmDialog
        open={false}
        onOpenChange={() => {}}
        title=""
        onConfirm={() => {}}
      />
      <Button variant="outline" size="sm" className="text-red-600" disabled={busy || ids.length === 0} onClick={() => exec("delete")}>
        批量删除
      </Button>
    </>
  )
}

// ---- 创建工作区弹窗 ----
function CreateDialog({
  open, onOpenChange, templates, snapshots, proxyNodes, idlePolicy,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  templates: { id: string; name: string; scope: string }[]
  snapshots: { id: string; name: string }[]
  proxyNodes: { id: string; name: string; type: string; status: string }[]
  /** r14（22-c）：闲置超时策略（locked=表单只读；minutes=策略链解析默认值） */
  idlePolicy: { locked: boolean; minutes: number; sourceLabel: string; lockSourceLabel: string }
}) {
  const router = useRouter()
  const [form, setForm] = React.useState({
    name: "", mode: "cdp_light", templateId: "", proxyNodeId: "", profileSnapshotId: "",
    ttlMinutes: 0, idleTimeoutMinutes: 60, resolution: "1920x1080", tags: "",
  })
  const [busy, setBusy] = React.useState(false)

  // r14（22-c）：弹窗打开时按策略链解析值重置闲置超时默认值
  React.useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, idleTimeoutMinutes: Math.max(0, Math.round(idlePolicy.minutes)) }))
    }
  }, [open, idlePolicy.minutes])

  const submit = async () => {
    if (!form.name.trim()) { toast.error("请输入工作区名称"); return }
    setBusy(true)
    try {
      const res = await createWorkspaceAction({
        name: form.name.trim(), mode: form.mode,
        templateId: form.templateId || null, proxyNodeId: form.proxyNodeId || null,
        profileSnapshotId: form.profileSnapshotId || null,
        ttlMinutes: form.ttlMinutes,
        // 锁定态：传入策略值（服务端同样会强制采用解析值，双保险）
        idleTimeoutMinutes: idlePolicy.locked ? Math.max(0, Math.round(idlePolicy.minutes)) : form.idleTimeoutMinutes,
        resolution: form.resolution, tags: form.tags,
      })
      if (res.code === 0) {
        toast.success("工作区创建成功")
        onOpenChange(false)
        setForm({ ...form, name: "" })
        // 注意：push 与 refresh 同帧调用会触发 App Router 竞态（refresh 取消挂起的导航）
        // —— 表现为「创建成功但停留在列表页」。push 自身会拉取新页面 RSC，无需再 refresh。
        router.push(`/workspaces/${res.data?.id}`)
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建浏览器工作区</DialogTitle>
          <DialogDescription>CDP 轻量会话适合自动化任务；NoVNC 重度会话提供完整桌面人机交互</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>工作区名称</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：电商巡检会话" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>会话模式</Label>
            <Tabs value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v })}>
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="cdp_light"><Globe className="h-3.5 w-3.5 mr-1" />CDP 轻量</TabsTrigger>
                <TabsTrigger value="novnc_full"><MonitorPlay className="h-3.5 w-3.5 mr-1" />NoVNC 重度</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>会话模板</Label>
              <Select value={form.templateId || "none"} onValueChange={(v) => setForm({ ...form, templateId: v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="不使用模板" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不使用模板</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}（{t.scope === "GLOBAL" ? "全局" : t.scope === "GROUP" ? "组共享" : "私有"}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>网络出口</Label>
              <Select value={form.proxyNodeId || "direct"} onValueChange={(v) => setForm({ ...form, proxyNodeId: v === "direct" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="直连" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">直连（不走代理）</SelectItem>
                  {proxyNodes.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={p.status === "FAILED" || p.status === "DISABLED"}>
                      {p.name}{p.type === "internal_singbox" ? " [SingBox]" : ""} {p.status !== "HEALTHY" ? `（${p.status}）` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Profile 快照挂载</Label>
              <Select value={form.profileSnapshotId || "none"} onValueChange={(v) => setForm({ ...form, profileSnapshotId: v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="不挂载" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不挂载快照</SelectItem>
                  {snapshots.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.mode === "novnc_full" && (
              <div className="space-y-1.5">
                <Label>分辨率</Label>
                <Select value={form.resolution} onValueChange={(v) => setForm({ ...form, resolution: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["1920x1080", "1600x900", "1366x768", "1280x720"].map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>硬 TTL（分钟，0 不限）</Label>
              <PrecisionInput value={form.ttlMinutes} onChange={(v) => setForm({ ...form, ttlMinutes: v })} min={0} max={525600} suffix="min" />
            </div>
            <div className="space-y-1.5">
              <Label>闲置超时（分钟）</Label>
              {idlePolicy.locked ? (
                <div className="rounded-md border bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">由管理员策略锁定：{idlePolicy.minutes > 0 ? `${Math.round(idlePolicy.minutes)} 分钟` : "无限（永不闲置回收）"}</p>
                  <p className="text-[10px] text-muted-foreground">锁定来源：{idlePolicy.lockSourceLabel} · 不可自行调整</p>
                </div>
              ) : (
                <>
                  <PrecisionInput value={form.idleTimeoutMinutes} onChange={(v) => setForm({ ...form, idleTimeoutMinutes: v })} min={0} max={1440} suffix="min" />
                  <p className="text-[10px] text-muted-foreground">0=无限（永不闲置回收）；默认 {idlePolicy.minutes > 0 ? `${Math.round(idlePolicy.minutes)} 分钟` : "无限"}（{idlePolicy.sourceLabel}）</p>
                </>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>标签（逗号分隔）</Label>
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="巡检,电商" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 创建工作区
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- 切换代理弹窗 ----
function ProxySwitchDialog({
  target, proxyNodes, onClose, onDone,
}: {
  target: WorkspaceRow | null
  proxyNodes: { id: string; name: string; type: string; status: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const [newProxy, setNewProxy] = React.useState("direct")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (target) setNewProxy(target.proxyNodeId || "direct")
  }, [target])

  const submit = async () => {
    if (!target) return
    setBusy(true)
    try {
      const res = await switchProxyAction({ id: target.id, proxyNodeId: newProxy === "direct" ? null : newProxy })
      if (res.code === 0) {
        toast.success("代理已切换，会话使用原快照配置重启完成")
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>切换代理节点</DialogTitle>
          <DialogDescription>
            Chrome 内部代理不支持热切换：平台将保留当前 Profile 快照，销毁旧会话并以新代理重建。
            会话将短暂重启（约数秒）。
          </DialogDescription>
        </DialogHeader>
        <Select value={newProxy} onValueChange={setNewProxy}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="direct">直连（不走代理）</SelectItem>
            {proxyNodes.map((p) => (
              <SelectItem key={p.id} value={p.id} disabled={p.status === "FAILED" || p.status === "DISABLED"}>
                {p.name}{p.type === "internal_singbox" ? " [SingBox]" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 确认切换
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
