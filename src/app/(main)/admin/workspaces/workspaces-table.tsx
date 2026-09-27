"use client"

// 工作区管控交互表格：7 种单行强制操作 + 6 种批量操作（逐条 try/catch 结果报告）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Loader2, MoreHorizontal, Square, RotateCw, Trash2, Flame, Unplug, Timer, UserRoundCog,
  AlertTriangle, X,
} from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  forceStopWorkspaceAction, forceRestartWorkspaceAction, forceRecycleWorkspaceAction, forcePurgeWorkspaceAction,
  forceDisconnectVncAction, forceUpdateTtlAction, transferWorkspaceAction, batchWorkspaceAction,
} from "@/server/actions/admin-workspaces"

export interface AdminWorkspaceRow {
  id: string
  uuid: string
  name: string
  mode: string
  status: string
  ownerUsername: string
  creatorUsername: string
  groupName: string
  proxyNodeName: string
  singboxName: string
  steelNodeName: string
  ttlMinutes: number
  idleTimeoutMinutes: number
  cdpCallCount: number
  novncConnCount: number
  hasNovncSession: boolean
  freezeReason: string | null
  createdAt: string
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
  transferTargets: UserOption[]
}

interface BatchOutcome {
  successCount: number
  failCount: number
  failures: { id: string; reason: string }[]
}

export function WorkspacesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters, transferTargets } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [sel, setSel] = React.useState<string[]>([])
  React.useEffect(() => setSel([]), [rows])
  const [busy, setBusy] = React.useState("")

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

  const columns = [
    {
      key: "name",
      title: "名称 / UUID",
      sortable: true,
      render: (row: AdminWorkspaceRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{row.uuid}</p>
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
      title: "所有者",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p className="font-medium">{row.ownerUsername}</p>
          <p className="text-muted-foreground">创建人 {row.creatorUsername}</p>
        </div>
      ),
    },
    { key: "groupName", title: "所属组", render: (row: AdminWorkspaceRow) => <span className="text-xs">{row.groupName}</span> },
    {
      key: "proxy",
      title: "代理 / SingBox",
      render: (row: AdminWorkspaceRow) => (
        <div className="text-xs">
          <p>{row.proxyNodeName}</p>
          {row.singboxName !== "-" && <p className="text-muted-foreground">{row.singboxName}</p>}
        </div>
      ),
    },
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
      key: "cdpCallCount",
      title: "CDP 调用",
      sortable: true,
      render: (row: AdminWorkspaceRow) => <span className="text-xs tabular-nums">{row.cdpCallCount}</span>,
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: AdminWorkspaceRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const input = e.currentTarget.elements.namedItem("owner") as HTMLInputElement
            pushQuery({ page: "1", owner: input.value.trim() || undefined })
          }}
        >
          <Input name="owner" defaultValue={filters.owner || ""} placeholder="按所有者用户名筛选" className="w-44" />
          <Button type="submit" variant="secondary" size="sm">筛选所有者</Button>
        </form>
        {filters.owner && (
          <Badge variant="outline" className="gap-1">
            所有者: {filters.owner}
            <button type="button" onClick={() => pushQuery({ page: "1", owner: undefined })} className="ml-1 hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
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
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy.startsWith(`stop-${row.id}`) || busy.startsWith(`restart-${row.id}`)}>
                {busy.startsWith(`stop-${row.id}`) || busy.startsWith(`restart-${row.id}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => stop(row)}>
                <Square className="h-4 w-4 mr-2" /> 强制停止
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => restart(row)}>
                <RotateCw className="h-4 w-4 mr-2" /> 强制重启
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTtlTarget(row)}>
                <Timer className="h-4 w-4 mr-2" /> 强制修改 TTL
              </DropdownMenuItem>
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
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
        selectedIds={sel}
        onSelectedChange={setSel}
        batchToolbar={
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
        }
      />

      {/* ---- 单行：移入回收站确认 ---- */}
      <ConfirmDialog
        open={!!recycleTarget}
        onOpenChange={(v) => !busy && setRecycleTarget(v ? recycleTarget : null)}
        title="强制移入回收站"
        description={`工作区「${recycleTarget?.name}」将软删除并进入回收站（删除来源：管理员），底层会话同步销毁。`}
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
