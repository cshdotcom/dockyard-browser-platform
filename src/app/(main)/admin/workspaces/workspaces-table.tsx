"use client"

// 工作区管控交互表格（增强版）：
//   · 列显隐配置（localStorage 持久化，默认精简视图）
//   · 全景列：归属双用户/模式/状态/运行时长/时间三列/容器健康/代理出口/策略快照/TTL/调用统计/删除记录
//   · 批量筛选：用户/状态/模式/代理/创建时间范围/活跃时间范围/运行时长下限 + 活跃/回收站双视图
//   · 7 种单行强制操作 + 6 种批量操作（逐条 try/catch 结果报告）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Loader2, MoreHorizontal, Square, RotateCw, Trash2, Flame, Unplug, Timer, UserRoundCog, Anchor,
  AlertTriangle, X, Columns3, ShieldCheck, ShieldX, Container, History, ArrowRightLeft, Share2,
} from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  forceStopWorkspaceAction, forceRestartWorkspaceAction, forceRecycleWorkspaceAction, forcePurgeWorkspaceAction,
  forceDisconnectVncAction, forceUpdateTtlAction, transferWorkspaceAction, batchWorkspaceAction, setWorkspaceVncLimitAction,
} from "@/server/actions/admin-workspaces"

export interface AdminWorkspaceRow {
  id: string
  uuid: string
  name: string
  mode: string
  status: string
  ownerUsername: string
  creatorUsername: string
  transferred: boolean
  groupName: string
  proxyNodeName: string
  proxyType: string
  proxyExit: string
  singboxName: string
  steelNodeName: string
  vncSessionMaxMinutes: number | null // 沙箱级 VNC 连接总时长上限（null=继承，0=不限）
  ttlMinutes: number
  idleTimeoutMinutes: number
  cdpCallCount: number
  novncConnCount: number
  hasNovncSession: boolean
  freezeReason: string | null
  crashCategory: string | null
  containerRef: string
  containerState: string
  containerStatus: string
  policySummary: {
    allowInternalNetwork: boolean
    allowSecureLocationAccess: boolean
    domainMode: string
    domainBlack: number
    domainWhite: number
    endpointBlack: number
    endpointWhite: number
  }
  runtimeSec: number
  runtimeText: string
  createdAt: string
  startedAtText: string
  lastActiveAtText: string
  lastActiveAt: string
  deletedAtText: string
  deletedByUsername: string
  deletedByType: string
  deletedReason: string
}

export interface UserOption {
  id: string
  username: string
  displayName: string | null
  role: string
}

interface Props {
  rows: AdminWorkspaceRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  view: "active" | "deleted"
  userOptions: UserOption[]
  proxyOptions: { id: string; name: string }[]
  transferTargets: UserOption[]
}

interface BatchOutcome {
  successCount: number
  failCount: number
  failures: { id: string; reason: string }[]
}

// ---- 列显隐配置：默认列 + 全量列清单（localStorage 持久化） ----
const COLS_STORAGE_KEY = "admin-ws-cols-v1"
const ALL_COL_KEYS = [
  "name", "mode", "status", "owner", "runtime", "lastActiveAt", "container", "proxy", "createdAt",
  "groupName", "startedAt", "policy", "ttl", "stats", "deleted",
] as const
type ColKey = (typeof ALL_COL_KEYS)[number]
const DEFAULT_VISIBLE: ColKey[] = ["name", "mode", "status", "owner", "runtime", "lastActiveAt", "container", "proxy", "createdAt"]

function loadVisibleCols(view: "active" | "deleted"): Set<ColKey> {
  if (view === "deleted") {
    // 回收站视图：删除记录列强制显示
    return new Set<ColKey>([...DEFAULT_VISIBLE, "deleted", "startedAt"])
  }
  try {
    const saved = localStorage.getItem(COLS_STORAGE_KEY)
    if (saved) {
      const arr = JSON.parse(saved) as string[]
      const valid = arr.filter((k) => (ALL_COL_KEYS as readonly string[]).includes(k)) as ColKey[]
      if (valid.length > 0) return new Set(valid)
    }
  } catch { /* 静默降级 */ }
  return new Set(DEFAULT_VISIBLE)
}

export function WorkspacesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters, view, userOptions, proxyOptions, transferTargets } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [sel, setSel] = React.useState<string[]>([])
  React.useEffect(() => setSel([]), [rows])
  const [busy, setBusy] = React.useState("")

  // ---- 列显隐状态 ----
  const [visibleCols, setVisibleCols] = React.useState<Set<ColKey>>(() => loadVisibleCols(view))
  React.useEffect(() => {
    setVisibleCols(loadVisibleCols(view))
  }, [view])

  const toggleCol = (k: ColKey) => {
    setVisibleCols((prev) => {
      const next = new Set(prev)
      if (next.has(k)) {
        if (next.size <= 1) return prev // 至少保留一列
        next.delete(k)
      } else next.add(k)
      if (view === "active") {
        try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...next])) } catch { /* noop */ }
      }
      return next
    })
  }
  const resetCols = () => {
    const next = new Set<ColKey>(view === "deleted" ? [...DEFAULT_VISIBLE, "deleted", "startedAt"] : DEFAULT_VISIBLE)
    setVisibleCols(next)
    if (view === "active") {
      try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...next])) } catch { /* noop */ }
    }
  }

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(name)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
      return res
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  // ---- 单行操作 ----
  const stop = (row: AdminWorkspaceRow) =>
    callAction(`stop-${row.id}`, () => forceStopWorkspaceAction({ id: row.id }))
  const restart = (row: AdminWorkspaceRow) =>
    callAction(`restart-${row.id}`, () => forceRestartWorkspaceAction({ id: row.id }))

  // ---- 单行确认弹窗状态 ----
  const [recycleTarget, setRecycleTarget] = React.useState<AdminWorkspaceRow | null>(null)
  const [purgeTarget, setPurgeTarget] = React.useState<AdminWorkspaceRow | null>(null)
  const [ttlTarget, setTtlTarget] = React.useState<AdminWorkspaceRow | null>(null)
  const [transferTarget, setTransferTarget] = React.useState<AdminWorkspaceRow | null>(null)

  // ---- TTL 弹窗 ----
  const [ttlForm, setTtlForm] = React.useState({ ttl: 0, idle: 60 })
  React.useEffect(() => {
    if (ttlTarget) setTtlForm({ ttl: ttlTarget.ttlMinutes, idle: ttlTarget.idleTimeoutMinutes })
  }, [ttlTarget])

  // ---- VNC 会话时长上限弹窗（三级策略：沙箱级覆盖用户/组）----
  const [vncLimitTarget, setVncLimitTarget] = React.useState<AdminWorkspaceRow | null>(null)
  const [vncLimitMinutes, setVncLimitMinutes] = React.useState(0)
  React.useEffect(() => {
    if (vncLimitTarget) setVncLimitMinutes(vncLimitTarget.vncSessionMaxMinutes ?? -1) // -1=继承
  }, [vncLimitTarget])

  // ---- 转移弹窗 ----
  const [transferUsername, setTransferUsername] = React.useState("")
  const [transferBusy, setTransferBusy] = React.useState(false)

  // ---- 批量弹窗 ----
  const [batchPurgeOpen, setBatchPurgeOpen] = React.useState(false)
  const [batchTtlOpen, setBatchTtlOpen] = React.useState(false)
  const [batchTtl, setBatchTtl] = React.useState({ ttl: 0, idle: 60 })
  const [batchTransferOpen, setBatchTransferOpen] = React.useState(false)
  const [batchTransferUsername, setBatchTransferUsername] = React.useState("")
  const [batchResult, setBatchResult] = React.useState<BatchOutcome | null>(null)

  const reportBatch = (name: string, d: BatchOutcome) => {
    if (d.failCount === 0) {
      toast.success(`${name}完成：成功 ${d.successCount} 条`)
    } else {
      toast.warning(`${name}部分失败：成功 ${d.successCount} / 失败 ${d.failCount}`)
      setBatchResult(d)
    }
    router.refresh()
    setSel([])
  }

  const runBatch = async (name: string, op: "STOP" | "RESTART" | "RECYCLE" | "PURGE" | "TTL" | "TRANSFER", extra?: Record<string, unknown>) => {
    setBusy(`batch-${op}`)
    try {
      const res = await batchWorkspaceAction({ ids: sel, op, ...extra })
      if (res.code === 0 && res.data) {
        reportBatch(name, res.data as BatchOutcome)
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBusy("")
    }
  }

  // ---- 筛选表单的本地状态（提交时一次性合并到 URL） ----
  const [dateForm, setDateForm] = React.useState({
    createdFrom: filters.createdFrom || "",
    createdTo: filters.createdTo || "",
    activeFrom: filters.activeFrom || "",
    activeTo: filters.activeTo || "",
    runtimeMin: filters.runtimeMin || "",
  })
  React.useEffect(() => {
    setDateForm({
      createdFrom: filters.createdFrom || "",
      createdTo: filters.createdTo || "",
      activeFrom: filters.activeFrom || "",
      activeTo: filters.activeTo || "",
      runtimeMin: filters.runtimeMin || "",
    })
  }, [filters.createdFrom, filters.createdTo, filters.activeFrom, filters.activeTo, filters.runtimeMin])

  const hasTimeFilters = !!(filters.createdFrom || filters.createdTo || filters.activeFrom || filters.activeTo || filters.runtimeMin)

  // ---- 容器健康渲染 ----
  const renderContainer = (row: AdminWorkspaceRow) => {
    if (!row.containerRef) {
      // CDP 模式或池化会话：无独立容器引用
      return row.mode === "novnc_full" ? (
        <span className="text-xs text-muted-foreground">池化/无容器</span>
      ) : (
        <span className="text-xs text-muted-foreground">Steel 托管</span>
      )
    }
    if (!row.containerState) {
      return (
        <Badge variant="outline" className="text-xs">未知容器</Badge>
      )
    }
    if (row.containerState === "running") {
      return (
        <div className="text-xs">
          <span className="inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="font-medium">运行中</span>
          </span>
          {row.containerStatus && <p className="text-muted-foreground truncate max-w-32">{row.containerStatus}</p>}
        </div>
      )
    }
    if (row.containerState === "paused") {
      return <Badge className="bg-amber-500 hover:bg-amber-500 text-xs">已暂停</Badge>
    }
    if (row.containerState === "exited" || row.containerState === "dead") {
      return (
        <div className="text-xs">
          <span className="inline-flex items-center gap-1 text-red-600 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {row.containerState === "dead" ? "已死锁" : "已退出"}
          </span>
          {row.containerStatus && <p className="text-muted-foreground truncate max-w-32">{row.containerStatus}</p>}
        </div>
      )
    }
    return <Badge variant="outline" className="text-xs">{row.containerState}</Badge>
  }

  // ---- 策略快照渲染 ----
  const renderPolicy = (row: AdminWorkspaceRow) => {
    const p = row.policySummary
    const items: React.ReactNode[] = []
    items.push(
      p.allowInternalNetwork ? (
        <Badge key="in" variant="outline" className="text-[10px] px-1 py-0 gap-0.5 text-emerald-700 border-emerald-300">
          <ShieldCheck className="h-2.5 w-2.5" />内网
        </Badge>
      ) : (
        <Badge key="in" variant="outline" className="text-[10px] px-1 py-0 gap-0.5 text-muted-foreground">
          <ShieldX className="h-2.5 w-2.5" />内网
        </Badge>
      ),
    )
    items.push(
      p.allowSecureLocationAccess ? (
        <Badge key="sec" variant="outline" className="text-[10px] px-1 py-0 gap-0.5 text-emerald-700 border-emerald-300">
          <ShieldCheck className="h-2.5 w-2.5" />安全位
        </Badge>
      ) : (
        <Badge key="sec" variant="outline" className="text-[10px] px-1 py-0 gap-0.5 text-muted-foreground">
          <ShieldX className="h-2.5 w-2.5" />安全位
        </Badge>
      ),
    )
    const counts: string[] = []
    if (p.domainMode) counts.push(`域${p.domainMode === "whitelist" ? "白" : "黑"}${p.domainBlack + p.domainWhite}`)
    if (p.endpointBlack + p.endpointWhite > 0) counts.push(`端点${p.endpointBlack + p.endpointWhite}`)
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap gap-1 max-w-36">{items}</div>
        {counts.length > 0 && <p className="text-[10px] text-muted-foreground">{counts.join(" · ")}</p>}
      </div>
    )
  }

  // ---- 全量列定义（按显隐过滤后传给 DataTable） ----
  const allColumns = [
    {
      key: "name",
      title: "名称 / UUID",
      sortable: true,
      render: (row: AdminWorkspaceRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate max-w-44">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate max-w-44">{row.uuid}</p>
          {row.crashCategory && <Badge variant="destructive" className="text-[10px] mt-0.5">{row.crashCategory}</Badge>}
        </div>
      ),
    },
    {
      key: "mode",
      title: "模式",
      render: (row: AdminWorkspaceRow) => (
        <Badge variant={row.mode === "cdp_light" ? "secondary" : "default"} className={row.mode === "novnc_full" ? "bg-teal-600 hover:bg-teal-600" : ""}>
          {row.mode === "cdp_light" ? "CDP 轻量" : "NoVNC 完整"}
        </Badge>
      ),
    },
    { key: "status", title: "状态", sortable: true, render: (row: AdminWorkspaceRow) => <StatusBadge status={row.status} /> },
    {
      key: "owner",
      title: "所有者 / 创建人",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p className="font-medium flex items-center gap-1">
            {row.ownerUsername}
            {row.transferred && (
              <span title="资源已转移（所有者 ≠ 创建人）">
                <ArrowRightLeft className="h-3 w-3 text-amber-500" />
              </span>
            )}
          </p>
          <p className="text-muted-foreground">
            {row.transferred ? `创建 ${row.creatorUsername}（已转移）` : `本人创建`}
          </p>
        </div>
      ),
    },
    {
      key: "runtime",
      title: "累计运行时长",
      sortable: true,
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p className="font-medium tabular-nums">{row.runtimeText}</p>
          {(row.status === "RUNNING" || row.status === "IDLE") && (
            <p className="text-emerald-600 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />运行中
            </p>
          )}
        </div>
      ),
    },
    {
      key: "lastActiveAt",
      title: "最近活跃",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p className="text-muted-foreground">{row.lastActiveAtText}</p>
          {row.lastActiveAt && Date.now() - new Date(row.lastActiveAt).getTime() < 5 * 60_000 && (
            <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600 px-1 py-0">5分钟内</Badge>
          )}
        </div>
      ),
    },
    {
      key: "container",
      title: "容器健康",
      render: (row: AdminWorkspaceRow) => renderContainer(row),
    },
    {
      key: "proxy",
      title: "代理出口",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          {row.proxyNodeName !== "-" ? (
            <>
              <p className="font-medium flex items-center gap-1">
                {row.proxyNodeName}
                {row.proxyType === "internal_singbox" && <Badge variant="secondary" className="text-[10px] px-1 py-0">内置</Badge>}
              </p>
              {row.proxyExit && <p className="text-muted-foreground font-mono truncate max-w-40">{row.proxyExit}</p>}
            </>
          ) : (
            <span className="text-muted-foreground">直连</span>
          )}
        </div>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: AdminWorkspaceRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
    { key: "groupName", title: "所属组", render: (row: AdminWorkspaceRow) => <span className="text-xs">{row.groupName}</span> },
    { key: "startedAt", title: "最近启动", sortable: true, render: (row: AdminWorkspaceRow) => <span className="text-xs text-muted-foreground">{row.startedAtText}</span> },
    { key: "policy", title: "策略快照", render: (row: AdminWorkspaceRow) => renderPolicy(row) },
    {
      key: "ttl",
      title: "TTL / 闲置",
      render: (row: AdminWorkspaceRow) => (
        <span className="text-xs tabular-nums">
          {row.ttlMinutes > 0 ? `${Math.round(row.ttlMinutes)} 分钟` : "不限"} / {Math.round(row.idleTimeoutMinutes)} 分钟
        </span>
      ),
    },
    {
      key: "stats",
      title: "调用 / 连接",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs tabular-nums">
          <p>CDP {row.cdpCallCount} 次</p>
          <p className="text-muted-foreground">VNC {row.novncConnCount} 连{row.freezeReason ? " · 冻结" : ""}</p>
        </div>
      ),
    },
    {
      key: "deleted",
      title: "删除记录",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p className="text-muted-foreground">{row.deletedAtText || "—"}</p>
          {row.deletedByType && (
            <p>
              <Badge variant={row.deletedByType === "ADMIN" ? "destructive" : "secondary"} className="text-[10px] px-1 py-0">
                {row.deletedByType === "ADMIN" ? "管理员" : row.deletedByType === "SYSTEM" ? "系统" : "用户"}
              </Badge>
              {row.deletedByUsername && <span className="ml-1">{row.deletedByUsername}</span>}
            </p>
          )}
          {row.deletedReason && <p className="text-muted-foreground truncate max-w-40" title={row.deletedReason}>{row.deletedReason}</p>}
        </div>
      ),
    },
  ]

  const columns = allColumns.filter((c) => (visibleCols as ReadonlySet<string>).has(c.key))

  return (
    <div className="space-y-3">
      {/* ---- 视图切换 + 筛选面板 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border overflow-hidden">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-medium ${view === "active" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
            onClick={() => pushQuery({ page: "1", view: undefined })}
          >
            活跃工作区
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 ${view === "deleted" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
            onClick={() => pushQuery({ page: "1", view: "deleted" })}
          >
            <History className="h-3 w-3" /> 回收站记录
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 bg-background hover:bg-muted text-primary`}
            onClick={() => pushQuery({ page: "1", view: "shares" })}
          >
            <Share2 className="h-3 w-3" /> 共享关系总列表
          </button>
        </div>

        <Select
          value={filters.user || undefined}
          onValueChange={(v) => pushQuery({ page: "1", user: v === "__all__" ? undefined : v })}
        >
          <SelectTrigger className="w-40"><SelectValue placeholder="按用户筛选" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部用户</SelectItem>
            {userOptions.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.username}{u.role !== "USER" ? `（${u.role === "SUPER_ADMIN" ? "超管" : u.role === "ADMIN" ? "管理员" : "组管理员"}）` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.proxy || undefined}
          onValueChange={(v) => pushQuery({ page: "1", proxy: v === "__all__" ? undefined : v })}
        >
          <SelectTrigger className="w-40"><SelectValue placeholder="按代理节点" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部代理</SelectItem>
            {proxyOptions.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* ---- 创建/活跃时间范围 + 运行时长下限 ---- */}
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            pushQuery({
              page: "1",
              createdFrom: dateForm.createdFrom || undefined,
              createdTo: dateForm.createdTo || undefined,
              activeFrom: dateForm.activeFrom || undefined,
              activeTo: dateForm.activeTo || undefined,
              runtimeMin: dateForm.runtimeMin || undefined,
            })
          }}
        >
          <Input
            type="date"
            title="创建时间起"
            value={dateForm.createdFrom}
            onChange={(e) => setDateForm({ ...dateForm, createdFrom: e.target.value })}
            className="w-32 h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            title="创建时间止"
            value={dateForm.createdTo}
            onChange={(e) => setDateForm({ ...dateForm, createdTo: e.target.value })}
            className="w-32 h-8 text-xs"
          />
          <Input
            type="date"
            title="最近活跃起"
            value={dateForm.activeFrom}
            onChange={(e) => setDateForm({ ...dateForm, activeFrom: e.target.value })}
            className="w-32 h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            title="最近活跃止"
            value={dateForm.activeTo}
            onChange={(e) => setDateForm({ ...dateForm, activeTo: e.target.value })}
            className="w-32 h-8 text-xs"
          />
          <Input
            type="number"
            min={0}
            step={0.001}
            title="累计运行时长下限（分钟，0.001 粒度）"
            placeholder="运行≥分钟"
            value={dateForm.runtimeMin}
            onChange={(e) => setDateForm({ ...dateForm, runtimeMin: e.target.value })}
            className="w-24 h-8 text-xs"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-8">时间筛选</Button>
          {hasTimeFilters && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => {
                setDateForm({ createdFrom: "", createdTo: "", activeFrom: "", activeTo: "", runtimeMin: "" })
                pushQuery({ page: "1", createdFrom: undefined, createdTo: undefined, activeFrom: undefined, activeTo: undefined, runtimeMin: undefined })
              }}
            >
              <X className="h-3.5 w-3.5 mr-1" /> 清除
            </Button>
          )}
        </form>

        {filters.user && (
          <Badge variant="outline" className="gap-1">
            用户: {userOptions.find((u) => u.id === filters.user)?.username || filters.user}
            <button type="button" onClick={() => pushQuery({ page: "1", user: undefined })} className="ml-1 hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}

        {/* ---- 列显隐配置 ---- */}
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1">
                <Columns3 className="h-3.5 w-3.5" /> 列配置
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <p className="px-2 py-1.5 text-xs text-muted-foreground">显示列（{columns.length}/{allColumns.length}）</p>
              {allColumns.map((c) => {
                const ck = c.key as ColKey
                const locked = view === "deleted" && ck === "deleted"
                return (
                  <DropdownMenuItem
                    key={c.key}
                    onSelect={(e) => { e.preventDefault(); if (!locked) toggleCol(ck) }}
                    className="text-xs"
                  >
                    <Checkbox checked={visibleCols.has(ck)} disabled={locked} className="mr-2 h-3.5 w-3.5" />
                    {typeof c.title === "string" ? c.title : String(ck)}
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); resetCols() }} className="text-xs">
                恢复默认列
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        filters={[
          { key: "mode", placeholder: "模式", options: [{ label: "CDP 轻量", value: "cdp_light" }, { label: "NoVNC 完整", value: "novnc_full" }] },
          {
            key: "status", placeholder: "状态",
            options: ["RUNNING", "IDLE", "CREATING", "STOPPED", "ERROR", "FROZEN", "DESTROYED"].map((s) => ({ label: s, value: s })),
          },
        ]}
        emptyText={view === "deleted" ? "回收站中没有工作区删除记录" : undefined}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy.startsWith(`stop-${row.id}`) || busy.startsWith(`restart-${row.id}`)}>
                {busy.startsWith(`stop-${row.id}`) || busy.startsWith(`restart-${row.id}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {view === "deleted" ? (
                <>
                  <DropdownMenuItem className="text-red-600" onClick={() => setPurgeTarget(row)}>
                    <Flame className="h-4 w-4 mr-2" /> 彻底物理删除
                  </DropdownMenuItem>
                  <p className="px-2 py-1 text-[10px] text-muted-foreground">回收站恢复请在「回收站」模块操作</p>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => stop(row)}>
                    <Square className="h-4 w-4 mr-2" /> 强制停止
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => restart(row)}>
                    <RotateCw className="h-4 w-4 mr-2" /> 强制重启
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTtlTarget(row)}>
                    <Timer className="h-4 w-4 mr-2" /> 强制修改 TTL
                  </DropdownMenuItem>
                  {row.hasNovncSession && (
                    <DropdownMenuItem onClick={() => setVncLimitTarget(row)}>
                      <Anchor className="h-4 w-4 mr-2" /> VNC 会话时长上限
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setTransferTarget(row)}>
                    <UserRoundCog className="h-4 w-4 mr-2" /> 资源转移
                  </DropdownMenuItem>
                  {row.hasNovncSession && (
                    <DropdownMenuItem
                      onClick={() => callAction(`vnc-${row.id}`, () => forceDisconnectVncAction({ id: row.id }))}
                    >
                      <Unplug className="h-4 w-4 mr-2" /> 断开 VNC 客户端
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-amber-600" onClick={() => setRecycleTarget(row)}>
                    <Trash2 className="h-4 w-4 mr-2" /> 强制移入回收站
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-red-600" onClick={() => setPurgeTarget(row)}>
                    <Flame className="h-4 w-4 mr-2" /> 彻底物理删除
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
        selectedIds={sel}
        onSelectedChange={setSel}
        batchToolbar={
          view === "active" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">已选 {sel.length} 项</span>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量停止", "STOP")}>
                {busy === "batch-STOP" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Square className="h-4 w-4 mr-1" />} 批量停止
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量重启", "RESTART")}>
                <RotateCw className="h-4 w-4 mr-1" /> 批量重启
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量回收", "RECYCLE")}>
                <Trash2 className="h-4 w-4 mr-1" /> 批量回收
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setBatchTtlOpen(true)}>
                <Timer className="h-4 w-4 mr-1" /> 批量改 TTL
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setBatchTransferOpen(true)}>
                <UserRoundCog className="h-4 w-4 mr-1" /> 批量转移
              </Button>
              <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setBatchPurgeOpen(true)}>
                <Flame className="h-4 w-4 mr-1" /> 批量物理删除（高危）
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">已选 {sel.length} 项（回收站视图仅支持物理清除）</span>
              <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setBatchPurgeOpen(true)}>
                <Flame className="h-4 w-4 mr-1" /> 批量物理删除（高危）
              </Button>
            </div>
          )
        }
      />

      {/* ---- 单行：移入回收站确认 ---- */}
      <ConfirmDialog
        open={!!recycleTarget}
        onOpenChange={(v) => !busy && setRecycleTarget(v ? recycleTarget : null)}
        title="强制移入回收站"
        description={`工作区「${recycleTarget?.name}」将软删除并进入回收站（删除来源：管理员），底层会话同步销毁，累计运行时长 ${recycleTarget?.runtimeText || "—"} 将被冻结。`}
        destructive
        confirmText="移入回收站"
        loading={busy === "recycle"}
        onConfirm={async () => {
          if (!recycleTarget) return
          await callAction("recycle", () => forceRecycleWorkspaceAction({ id: recycleTarget.id }))
        }}
      />

      {/* ---- 单行：物理删除强确认 ---- */}
      <ConfirmDialog
        open={!!purgeTarget}
        onOpenChange={(v) => !busy && setPurgeTarget(v ? purgeTarget : null)}
        title="彻底物理删除工作区"
        description={`工作区「${purgeTarget?.name}（${purgeTarget?.uuid}）」将被硬删除：底层 Steel/NoVNC 会话销毁、共享授权清除、数据库记录删除，操作不可恢复。`}
        requirePhrase="DESTROY"
        destructive
        confirmText="确认销毁"
        loading={busy === "purge"}
        onConfirm={async () => {
          if (!purgeTarget) return
          await callAction("purge", () => forcePurgeWorkspaceAction({ id: purgeTarget.id }))
        }}
      />

      {/* ---- 单行：TTL 弹窗 ---- */}
      <Dialog open={!!ttlTarget} onOpenChange={(v) => !busy && setTtlTarget(v ? ttlTarget : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>强制修改 TTL / 闲置超时</DialogTitle>
            <DialogDescription>工作区「{ttlTarget?.name}」的时间策略将被管理员覆写。</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>TTL（分钟，0=不限）</Label>
              <PrecisionInput value={ttlForm.ttl} onChange={(v) => setTtlForm({ ...ttlForm, ttl: v })} min={0} max={525600} suffix="分" />
            </div>
            <div className="space-y-1.5">
              <Label>闲置超时（分钟）</Label>
              <PrecisionInput value={ttlForm.idle} onChange={(v) => setTtlForm({ ...ttlForm, idle: v })} min={1} max={525600} suffix="分" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTtlTarget(null)} disabled={busy === "ttl"}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={busy === "ttl"}
              onClick={async () => {
                if (!ttlTarget) return
                await callAction("ttl", () => forceUpdateTtlAction({ id: ttlTarget.id, ttlMinutes: ttlForm.ttl, idleTimeoutMinutes: ttlForm.idle }))
                setTtlTarget(null)
              }}
            >
              {busy === "ttl" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 保存覆写
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 单行：VNC 会话时长上限弹窗（三级策略沙箱级）---- */}
      <Dialog open={!!vncLimitTarget} onOpenChange={(v) => !busy && setVncLimitTarget(v ? vncLimitTarget : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>VNC 会话时长上限（沙箱级策略）</DialogTitle>
            <DialogDescription>
              工作区「{vncLimitTarget?.name}」的 HelmPort 连接总时长上限。票据 60 秒时效仅为取票→建连窗口；此处限制到期服务端强制断开（客户端同步倒计时）。优先级：沙箱 &gt; 用户 &gt; 用户组 &gt; 全局默认。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Label className="w-28 shrink-0">策略</Label>
              <Select value={vncLimitMinutes < 0 ? "inherit" : vncLimitMinutes === 0 ? "unlimited" : "limit"} onValueChange={(v) => {
                if (v === "inherit") setVncLimitMinutes(-1)
                else if (v === "unlimited") setVncLimitMinutes(0)
                else if (vncLimitMinutes <= 0) setVncLimitMinutes(120)
              }}>
                <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承（用户/用户组/全局默认）</SelectItem>
                  <SelectItem value="unlimited">不限时长（显式，0）</SelectItem>
                  <SelectItem value="limit">限制时长（分钟）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {vncLimitMinutes > 0 && (
              <div className="flex items-center gap-2">
                <Label className="w-28 shrink-0">上限</Label>
                <PrecisionInput value={vncLimitMinutes} onChange={(v) => setVncLimitMinutes(Math.max(1, Math.round(v)))} min={1} max={43200} suffix="分" />
                <span className="text-xs text-muted-foreground">= {Math.floor(vncLimitMinutes / 60)} 小时 {vncLimitMinutes % 60} 分</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVncLimitTarget(null)} disabled={busy === "vcnlimit"}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={busy === "vcnlimit"}
              onClick={async () => {
                if (!vncLimitTarget) return
                await callAction("vcnlimit", () => setWorkspaceVncLimitAction({ id: vncLimitTarget.id, vncSessionMaxMinutes: vncLimitMinutes < 0 ? null : vncLimitMinutes }))
                setVncLimitTarget(null)
              }}
            >
              {busy === "vcnlimit" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 保存策略
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 单行：资源转移弹窗 ---- */}
      <Dialog open={!!transferTarget} onOpenChange={(v) => !transferBusy && setTransferTarget(v ? transferTarget : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>资源转移</DialogTitle>
            <DialogDescription>
              工作区「{transferTarget?.name}」所有者将由 {transferTarget?.ownerUsername} 变更为目标用户；原始创建人保持不变，全程审计。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>目标用户名</Label>
            <Select value={transferUsername || undefined} onValueChange={setTransferUsername}>
              <SelectTrigger><SelectValue placeholder="选择目标用户" /></SelectTrigger>
              <SelectContent>
                {transferTargets.map((u) => (
                  <SelectItem key={u.id} value={u.username}>
                    {u.username}{u.displayName ? `（${u.displayName}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)} disabled={transferBusy}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!transferUsername || transferBusy}
              onClick={async () => {
                if (!transferTarget || !transferUsername) return
                setTransferBusy(true)
                try {
                  const res = await transferWorkspaceAction({ id: transferTarget.id, targetUsername: transferUsername })
                  if (res.code === 0) {
                    toast.success("资源转移成功")
                    setTransferTarget(null)
                    setTransferUsername("")
                    router.refresh()
                  } else {
                    toast.error(res.msg)
                  }
                } finally {
                  setTransferBusy(false)
                }
              }}
            >
              {transferBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 确认转移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 批量：物理删除强确认 ---- */}
      <ConfirmDialog
        open={batchPurgeOpen}
        onOpenChange={setBatchPurgeOpen}
        title="批量物理删除（高危）"
        description={`将彻底硬删除选中的 ${sel.length} 个工作区（底层会话销毁 + 数据库记录删除），不可恢复。`}
        requirePhrase="DESTROY"
        destructive
        confirmText="批量销毁"
        loading={busy === "batch-PURGE"}
        onConfirm={async () => {
          await runBatch("批量物理删除", "PURGE")
        }}
      />

      {/* ---- 批量：TTL 弹窗 ---- */}
      <Dialog open={batchTtlOpen} onOpenChange={setBatchTtlOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量修改 TTL / 闲置超时</DialogTitle>
            <DialogDescription>选中的 {sel.length} 个工作区的时间策略将被统一覆写。</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>TTL（分钟，0=不限）</Label>
              <PrecisionInput value={batchTtl.ttl} onChange={(v) => setBatchTtl({ ...batchTtl, ttl: v })} min={0} max={525600} suffix="分" />
            </div>
            <div className="space-y-1.5">
              <Label>闲置超时（分钟）</Label>
              <PrecisionInput value={batchTtl.idle} onChange={(v) => setBatchTtl({ ...batchTtl, idle: v })} min={1} max={525600} suffix="分" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchTtlOpen(false)}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={busy === "batch-TTL"}
              onClick={async () => {
                setBatchTtlOpen(false)
                await runBatch("批量改 TTL", "TTL", { ttlMinutes: batchTtl.ttl, idleTimeoutMinutes: batchTtl.idle })
              }}
            >
              批量覆写
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 批量：转移弹窗 ---- */}
      <Dialog open={batchTransferOpen} onOpenChange={setBatchTransferOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量资源转移</DialogTitle>
            <DialogDescription>选中的 {sel.length} 个工作区所有者将变更为目标用户（逐条执行，失败不影响其他）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>目标用户名</Label>
            <Select value={batchTransferUsername || undefined} onValueChange={setBatchTransferUsername}>
              <SelectTrigger><SelectValue placeholder="选择目标用户" /></SelectTrigger>
              <SelectContent>
                {transferTargets.map((u) => (
                  <SelectItem key={u.id} value={u.username}>
                    {u.username}{u.displayName ? `（${u.displayName}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchTransferOpen(false)}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!batchTransferUsername || busy === "batch-TRANSFER"}
              onClick={async () => {
                setBatchTransferOpen(false)
                await runBatch("批量转移", "TRANSFER", { targetUsername: batchTransferUsername })
              }}
            >
              批量转移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 批量失败详情 ---- */}
      <Dialog open={!!batchResult} onOpenChange={(v) => !v && setBatchResult(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> 批量操作失败明细
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto space-y-1.5">
            {(batchResult?.failures || []).map((f) => (
              <div key={f.id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
                <X className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-mono truncate">{f.id}</p>
                  <p className="text-muted-foreground">{f.reason}</p>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchResult(null)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
