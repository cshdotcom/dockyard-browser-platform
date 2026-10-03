"use client"

// 回收站交互表格：恢复 / 物理清除 / 锁定解锁 / 延期 / 批量 / 一键清空全站

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, RotateCcw, Lock, LockOpen, Trash2, CalendarClock, MoreHorizontal, X, AlertTriangle, Flame } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  adminRestoreRecycleAction, adminPurgeRecycleAction, toggleRecycleLockAction, batchRecycleAction, purgeAllRecycleAction,
} from "@/server/actions/recycle"

export interface RecycleRow {
  id: string
  resourceType: string
  resourceName: string | null
  resourceId: string
  ownerUsername: string
  creatorUsername: string
  deletedByUsername: string
  deletedByType: string
  reason: string | null
  locked: boolean
  recoverDeadline: string | null
  purgeAt: string | null
  restoredAt: string | null
  createdAt: string
}

interface Props {
  tab: "pending" | "restored"
  rows: RecycleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

interface BatchOutcome {
  successCount: number
  failCount: number
  failures: { id: string; reason: string }[]
}

const SOURCE_LABEL: Record<string, { label: string; cls: string }> = {
  USER: { label: "用户", cls: "bg-secondary text-secondary-foreground" },
  ADMIN: { label: "管理员", cls: "bg-amber-600 text-white" },
  SYSTEM: { label: "系统定时", cls: "bg-slate-600 text-white" },
}

// datetime-local 值 → ISO（本地时区）
function toLocalIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function RecycleTable(props: Props) {
  const { tab, rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
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

  // ---- 弹窗状态 ----
  const [purgeTarget, setPurgeTarget] = React.useState<RecycleRow | null>(null)
  const [extendTarget, setExtendTarget] = React.useState<RecycleRow | null>(null)
  const [extendValue, setExtendValue] = React.useState("")
  const [extendBusy, setExtendBusy] = React.useState(false)
  const [batchPurgeOpen, setBatchPurgeOpen] = React.useState(false)
  const [batchExtendOpen, setBatchExtendOpen] = React.useState(false)
  const [batchExtendValue, setBatchExtendValue] = React.useState("")
  const [purgeAllOpen, setPurgeAllOpen] = React.useState(false)
  const [batchResult, setBatchResult] = React.useState<BatchOutcome | null>(null)

  const defaultExtend = () => {
    const d = new Date(Date.now() + 7 * 86400_000)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

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

  const runBatch = async (name: string, op: "RESTORE" | "PURGE" | "LOCK" | "UNLOCK" | "EXTEND", purgeAt?: string) => {
    setBusy(`batch-${op}`)
    try {
      const res = await batchRecycleAction({ ids: sel, op, purgeAt })
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
      key: "resourceName",
      title: "资源",
      render: (row: RecycleRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.resourceName || "-"}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{row.resourceId}</p>
        </div>
      ),
    },
    {
      key: "resourceType",
      title: "资源类型",
      render: (row: RecycleRow) => <Badge variant="outline" className="text-xs font-mono">{row.resourceType}</Badge>,
    },
    {
      key: "owner",
      title: "所有者 / 创建人",
      render: (row: RecycleRow) => (
        <div className="text-xs">
          <p className="font-medium">{row.ownerUsername}</p>
          <p className="text-muted-foreground">创建 {row.creatorUsername}</p>
        </div>
      ),
    },
    {
      key: "deletedByType",
      title: "删除来源",
      render: (row: RecycleRow) => {
        const s = SOURCE_LABEL[row.deletedByType] || { label: row.deletedByType, cls: "bg-secondary" }
        return (
          <div className="text-xs">
            <Badge className={`${s.cls} text-xs`}>{s.label}</Badge>
            <p className="text-muted-foreground mt-1">{row.deletedByUsername}</p>
          </div>
        )
      },
    },
    {
      key: "reason",
      title: "删除原因",
      render: (row: RecycleRow) => (
        <span className="text-xs text-muted-foreground line-clamp-2 max-w-40">{row.reason || "-"}</span>
      ),
    },
    {
      key: "locked",
      title: "锁定",
      render: (row: RecycleRow) =>
        row.locked ? (
          <Badge className="bg-amber-600 hover:bg-amber-600 gap-1"><Lock className="h-3 w-3" /> 保护中</Badge>
        ) : (
          <Badge variant="outline">未锁定</Badge>
        ),
    },
    {
      key: "recoverDeadline",
      title: "恢复截止",
      sortable: true,
      render: (row: RecycleRow) => <span className="text-xs tabular-nums">{row.recoverDeadline || "不限"}</span>,
    },
    {
      key: "purgeAt",
      title: "物理清除时间",
      sortable: true,
      render: (row: RecycleRow) => <span className="text-xs tabular-nums">{row.purgeAt || "-"}</span>,
    },
    { key: "createdAt", title: "删除时间", sortable: true, render: (row: RecycleRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
    ...(tab === "restored"
      ? [{ key: "restoredAt", title: "恢复时间", render: (row: RecycleRow) => <span className="text-xs text-emerald-600">{row.restoredAt || "-"}</span> }]
      : []),
  ]

  return (
    <div className="space-y-3">
      {/* 用户视角筛选（所有者/创建人文本筛选） */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const input = e.currentTarget.elements.namedItem("owner") as HTMLInputElement
            pushQuery({ page: "1", owner: input.value.trim() || undefined })
          }}
        >
          <Input name="owner" defaultValue={filters.owner || ""} placeholder="按所有者用户名" className="w-40" />
          <Button type="submit" variant="secondary" size="sm">筛选</Button>
        </form>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const input = e.currentTarget.elements.namedItem("creator") as HTMLInputElement
            pushQuery({ page: "1", creator: input.value.trim() || undefined })
          }}
        >
          <Input name="creator" defaultValue={filters.creator || ""} placeholder="按创建人用户名" className="w-40" />
          <Button type="submit" variant="secondary" size="sm">筛选</Button>
        </form>
        {filters.owner && (
          <Badge variant="outline" className="gap-1">
            所有者: {filters.owner}
            <button type="button" onClick={() => pushQuery({ page: "1", owner: undefined })}><X className="h-3 w-3" /></button>
          </Badge>
        )}
        {filters.creator && (
          <Badge variant="outline" className="gap-1">
            创建人: {filters.creator}
            <button type="button" onClick={() => pushQuery({ page: "1", creator: undefined })}><X className="h-3 w-3" /></button>
          </Badge>
        )}
        {tab === "pending" && (
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            disabled={!!busy}
            onClick={() => setPurgeAllOpen(true)}
          >
            <Flame className="h-4 w-4 mr-1" /> 一键清空全站
          </Button>
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
          {
            key: "resourceType", placeholder: "资源类型",
            options: ["WORKSPACE", "SINGBOX", "PROXY_NODE", "BROWSER_NODE", "HOST_NODE", "TEMPLATE", "SNAPSHOT", "FILE", "SCRIPT", "API_TOKEN", "GROUP", "RECORDING"].map((v) => ({ label: v, value: v })),
          },
          {
            key: "deletedByType", placeholder: "删除来源",
            options: [
              { label: "用户", value: "USER" },
              { label: "管理员", value: "ADMIN" },
              { label: "系统定时", value: "SYSTEM" },
            ],
          },
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {tab === "pending" && (
                <>
                  <DropdownMenuItem onClick={() => callAction(`restore-${row.id}`, () => adminRestoreRecycleAction({ id: row.id }))}>
                    <RotateCcw className="h-4 w-4 mr-2" /> 恢复资源
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => callAction(`lock-${row.id}`, () => toggleRecycleLockAction({ id: row.id }))}>
                    {row.locked ? <LockOpen className="h-4 w-4 mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
                    {row.locked ? "解锁" : "锁定保护"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      setExtendValue(defaultExtend())
                      setExtendTarget(row)
                    }}
                  >
                    <CalendarClock className="h-4 w-4 mr-2" /> 延期清除
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-red-600" onClick={() => setPurgeTarget(row)}>
                    <Trash2 className="h-4 w-4 mr-2" /> 物理清除
                  </DropdownMenuItem>
                </>
              )}
              {tab === "restored" && (
                <>
                  <DropdownMenuItem onClick={() => callAction(`lock-${row.id}`, () => toggleRecycleLockAction({ id: row.id }))}>
                    {row.locked ? <LockOpen className="h-4 w-4 mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
                    {row.locked ? "解锁" : "锁定保护"}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-red-600" onClick={() => setPurgeTarget(row)}>
                    <Trash2 className="h-4 w-4 mr-2" /> 清除回收记录
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
        selectedIds={tab === "pending" ? sel : undefined}
        onSelectedChange={tab === "pending" ? setSel : undefined}
        batchToolbar={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">已选 {sel.length} 项</span>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量恢复", "RESTORE")}>
              <RotateCcw className="h-4 w-4 mr-1" /> 批量恢复
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量锁定", "LOCK")}>
              <Lock className="h-4 w-4 mr-1" /> 批量锁定
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runBatch("批量解锁", "UNLOCK")}>
              <LockOpen className="h-4 w-4 mr-1" /> 批量解锁
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { setBatchExtendValue(defaultExtend()); setBatchExtendOpen(true) }}>
              <CalendarClock className="h-4 w-4 mr-1" /> 批量延期
            </Button>
            <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setBatchPurgeOpen(true)}>
              <Trash2 className="h-4 w-4 mr-1" /> 批量清除
            </Button>
          </div>
        }
      />

      {/* 单条物理清除确认 */}
      <ConfirmDialog
        open={!!purgeTarget}
        onOpenChange={(v) => !busy && setPurgeTarget(v ? purgeTarget : null)}
        title="物理清除"
        description={`「${purgeTarget?.resourceName || purgeTarget?.resourceId}」将被从数据库中彻底硬删除，不可恢复。`}
        requirePhrase="PURGE"
        destructive
        confirmText="彻底删除"
        loading={busy === "purge"}
        onConfirm={async () => {
          if (!purgeTarget) return
          await callAction("purge", () => adminPurgeRecycleAction({ id: purgeTarget.id }))
        }}
      />

      {/* 单条延期弹窗 */}
      <Dialog open={!!extendTarget} onOpenChange={(v) => !extendBusy && setExtendTarget(v ? extendTarget : null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>延期物理清除</DialogTitle>
            <DialogDescription>调整「{extendTarget?.resourceName || extendTarget?.resourceId}」的 purgeAt 时间（锁定保护不受自动过期影响）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>新的物理清除时间</Label>
            <Input type="datetime-local" value={extendValue} onChange={(e) => setExtendValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendTarget(null)} disabled={extendBusy}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={extendBusy || !extendValue}
              onClick={async () => {
                if (!extendTarget || !extendValue) return
                const iso = toLocalIso(extendValue)
                if (!iso) return toast.error("时间格式不合法")
                setExtendBusy(true)
                try {
                  const res = await batchRecycleAction({ ids: [extendTarget.id], op: "EXTEND", purgeAt: iso })
                  if (res.code === 0) {
                    toast.success("延期成功")
                    setExtendTarget(null)
                    router.refresh()
                  } else {
                    toast.error(res.msg)
                  }
                } finally {
                  setExtendBusy(false)
                }
              }}
            >
              {extendBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 确认延期
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量物理清除确认 */}
      <ConfirmDialog
        open={batchPurgeOpen}
        onOpenChange={setBatchPurgeOpen}
        title="批量物理清除"
        description={`将彻底硬删除选中的 ${sel.length} 条回收站记录（锁定条目自动跳过并计入失败）。`}
        requirePhrase="PURGE"
        destructive
        confirmText="批量清除"
        loading={busy === "batch-PURGE"}
        onConfirm={async () => {
          await runBatch("批量清除", "PURGE")
        }}
      />

      {/* 批量延期弹窗 */}
      <Dialog open={batchExtendOpen} onOpenChange={setBatchExtendOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量延期物理清除</DialogTitle>
            <DialogDescription>选中的 {sel.length} 条记录的 purgeAt 将统一调整。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label>新的物理清除时间</Label>
            <Input type="datetime-local" value={batchExtendValue} onChange={(e) => setBatchExtendValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchExtendOpen(false)}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!!busy || !batchExtendValue}
              onClick={async () => {
                const iso = toLocalIso(batchExtendValue)
                if (!iso) return toast.error("时间格式不合法")
                setBatchExtendOpen(false)
                await runBatch("批量延期", "EXTEND", iso)
              }}
            >
              批量延期
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一键清空全站 */}
      <ConfirmDialog
        open={purgeAllOpen}
        onOpenChange={setPurgeAllOpen}
        title="一键清空全站回收站"
        description={"将物理清除全站所有「未恢复且未锁定」的回收站条目。\n此操作会执行真正的数据库硬删除，且不可恢复；锁定保护条目将安全跳过。"}
        requirePhrase="PURGE ALL"
        destructive
        confirmText="清空全站"
        loading={busy === "purgeAll"}
        onConfirm={async () => {
          setBusy("purgeAll")
          try {
            const res = await purgeAllRecycleAction()
            if (res.code === 0 && res.data) {
              const d = res.data as BatchOutcome
              if (d.failCount === 0) toast.success(`全站清空完成：共清除 ${d.successCount} 条`)
              else {
                toast.warning(`清空完成：成功 ${d.successCount} / 失败 ${d.failCount}`)
                setBatchResult(d)
              }
              router.refresh()
              setSel([])
            } else {
              toast.error(res.msg)
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "操作失败")
          } finally {
            setBusy("")
          }
        }}
      />

      {/* 批量失败详情 */}
      <Dialog open={!!batchResult} onOpenChange={(v) => !v && setBatchResult(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> 操作失败明细
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
