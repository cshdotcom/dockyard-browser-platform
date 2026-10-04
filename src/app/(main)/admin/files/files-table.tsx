"use client"

// 文件列表交互（管理端）：下载 / 病毒扫描 / 立即过期 / 软删除（入回收站）
// r28a 增强：
//   · category 筛选补齐 RECORDING / SCREENSHOT / AVATAR
//   · 归属列可点击（点击 → userId 筛选自动刷新）
//   · 分布式节点筛选（多选 Popover；默认主节点；「全部节点」）
//   · isFavorite 收藏星标（只读展示）
//   · 批量操作：批量删除 / 批量立即过期（复用 deleteFileAction / expireFileAction 循环）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Download, Loader2, MoreHorizontal, Server, ShieldCheck, Star, TimerOff, Trash2, UserRound, X,
} from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { deleteFileAction, expireFileAction } from "@/server/actions/files"

export interface FileRow {
  id: string
  fileName: string
  size: number
  sizeText: string
  category: string
  userId: string | null
  username: string | null
  workspaceId: string | null
  storageNodeId: string | null
  nodeLabel: string | null
  isFavorite: boolean
  expireAt: string | null
  expired: boolean
  virusScanned: boolean
  createdAt: string
}

const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "普通文件",
  PROFILE: "配置档案",
  BACKUP: "数据库备份",
  SNAPSHOT: "环境快照",
  LOG: "日志",
  REPORT: "报表",
  RECORDING: "会话录像",
  SCREENSHOT: "屏幕截图",
  AVATAR: "头像",
}

interface FilesTableProps {
  rows: FileRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  userOptions: { label: string; value: string }[]
  nodeOptions: { label: string; value: string }[]
}

export function FilesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, userOptions, nodeOptions }: FilesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [expireTarget, setExpireTarget] = React.useState<FileRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<FileRow | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [batchExpireOpen, setBatchExpireOpen] = React.useState(false)
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  const runScan = async (row: FileRow) => {
    setBusy(`${row.id}:scan`)
    try {
      const res = await fetch("/api/files/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: row.id }),
      })
      const json = (await res.json()) as { code: number; msg: string }
      if (json.code === 0) {
        toast.success(json.msg || "扫描完成")
        router.refresh()
      } else {
        toast.error(json.msg || "扫描失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "扫描失败")
    } finally {
      setBusy("")
    }
  }

  const download = (row: FileRow) => {
    window.open(`/api/files/download?id=${encodeURIComponent(row.id)}`, "_blank")
  }

  // ---- 批量操作（循环复用单行 Action） ----
  const selectedRows = rows.filter((r) => selected.includes(r.id))

  const batchExpire = async () => {
    const targets = selectedRows
    if (targets.length === 0) return
    setBusy("batch-expire")
    let ok = 0
    let failMsg = ""
    for (const t of targets) {
      try {
        const res = await expireFileAction({ fileId: t.id })
        if (res.code === 0) ok++
        else failMsg = res.msg
      } catch {
        // 单个失败继续
      }
    }
    setBusy("")
    if (ok > 0) toast.success(`已将 ${ok}/${targets.length} 个文件设为过期`)
    if (ok < targets.length) toast.warning(`${targets.length - ok} 个文件处理失败${failMsg ? `：${failMsg}` : ""}`)
    setSelected([])
    router.refresh()
  }

  const batchDelete = async () => {
    const targets = selectedRows
    if (targets.length === 0) return
    setBusy("batch-delete")
    let ok = 0
    let failMsg = ""
    for (const t of targets) {
      try {
        const res = await deleteFileAction({ fileId: t.id, reason: "管理员批量删除" })
        if (res.code === 0) ok++
        else failMsg = res.msg
      } catch {
        // 单个失败继续
      }
    }
    setBusy("")
    if (ok > 0) toast.success(`已删除 ${ok}/${targets.length} 个文件（已入回收站）`)
    if (ok < targets.length) toast.warning(`${targets.length - ok} 个文件删除失败${failMsg ? `：${failMsg}` : ""}`)
    setSelected([])
    router.refresh()
  }

  // 节点筛选当前值（与 where.ts 语义一致：缺省 = 主节点）
  const nodeValue = filters.node || ""

  return (
    <div className="space-y-3">
      {/* 分布式节点筛选（多选；默认主节点） */}
      <div className="flex flex-wrap items-center gap-2">
        <NodeFilter value={nodeValue} options={nodeOptions} onChange={(v) => pushQuery({ node: v || undefined, page: "1" })} />
        <span className="text-xs text-muted-foreground">
          {nodeValue === "__all__" ? "当前：全部节点" : nodeValue ? "当前：所选节点集合" : "当前：主节点（默认）"}
          {total >= 0 ? ` · 命中 ${total} 条` : ""}
        </span>
      </div>

      <DataTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        selectedIds={selected}
        onSelectedChange={setSelected}
        batchToolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">已选 {selected.length}</Badge>
            <Button size="sm" variant="outline" onClick={() => setBatchExpireOpen(true)} disabled={busy !== ""}>
              {busy === "batch-expire" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <TimerOff className="mr-1 h-3.5 w-3.5" />}
              批量立即过期
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setBatchDeleteOpen(true)} disabled={busy !== ""}>
              {busy === "batch-delete" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
              批量删除
            </Button>
          </div>
        }
        filters={[
          {
            key: "category",
            placeholder: "文件类型",
            options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ label, value })),
          },
          { key: "userId", placeholder: "上传用户", options: userOptions },
        ]}
        emptyText="暂无文件（可在上方上传组件添加）"
        columns={[
          {
            key: "fileName",
            title: "文件名",
            sortable: true,
            render: (r) => (
              <div className="min-w-0">
                <p className="text-sm font-medium truncate max-w-56" title={r.fileName}>{r.fileName}</p>
                <p className="text-[10px] text-muted-foreground font-mono truncate max-w-56">{r.id}</p>
              </div>
            ),
          },
          {
            key: "size",
            title: "大小",
            sortable: true,
            render: (r) => <span className="tabular-nums text-sm">{r.sizeText}</span>,
          },
          {
            key: "category",
            title: "类型",
            render: (r) => (
              <Badge
                variant={r.category === "BACKUP" ? "default" : "secondary"}
                className={r.category === "BACKUP" ? "bg-teal-600 hover:bg-teal-600" : r.category === "RECORDING" || r.category === "SCREENSHOT" ? "border-violet-300 dark:border-violet-800" : ""}
              >
                {CATEGORY_LABEL[r.category] || r.category}
              </Badge>
            ),
          },
          {
            key: "username",
            title: "上传用户",
            render: (r) =>
              r.userId && r.username ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-sm hover:text-teal-600 hover:underline"
                  onClick={() => pushQuery({ userId: r.userId ?? undefined, page: "1" })}
                  title={`点击筛选 ${r.username} 的全部文件`}
                >
                  <UserRound className="h-3 w-3 opacity-50" />
                  {r.username}
                </button>
              ) : (
                <span className="text-sm">-</span>
              ),
          },
          {
            key: "node",
            title: "存储节点",
            render: (r) =>
              r.storageNodeId ? (
                <span className="inline-flex items-center gap-1 text-xs" title={r.storageNodeId}>
                  <Server className="h-3 w-3 opacity-50" />
                  {r.nodeLabel}
                </span>
              ) : (
                <Badge variant="outline" className="text-[10px]">主节点</Badge>
              ),
          },
          {
            key: "isFavorite",
            title: "收藏",
            render: (r) =>
              r.isFavorite ? (
                <span title="用户已收藏">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">-</span>
              ),
          },
          {
            key: "workspaceId",
            title: "关联工作区",
            render: (r) =>
              r.workspaceId ? (
                <span className="font-mono text-[10px] text-muted-foreground truncate block max-w-32" title={r.workspaceId}>{r.workspaceId}</span>
              ) : (
                <span className="text-muted-foreground text-xs">-</span>
              ),
          },
          {
            key: "expireAt",
            title: "过期时间",
            sortable: true,
            render: (r) => (
              <span className={`text-xs tabular-nums ${r.expired ? "text-red-600 font-medium" : ""}`}>
                {r.expired ? `${r.expireAt}（已过期）` : r.expireAt || "永久"}
              </span>
            ),
          },
          {
            key: "virusScanned",
            title: "病毒扫描",
            render: (r) =>
              r.virusScanned ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-[10px]">已扫描</Badge>
              ) : (
                <Badge variant="outline" className="text-amber-600 border-amber-200 text-[10px]">未扫描</Badge>
              ),
          },
          {
            key: "createdAt",
            title: "上传时间",
            sortable: true,
            render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span>,
          },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => download(r)} aria-label={`下载 ${r.fileName}`}>
              <Download className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="更多操作">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!r.virusScanned && (
                  <DropdownMenuItem onClick={() => runScan(r)} disabled={busy === `${r.id}:scan`}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    病毒扫描
                    {busy === `${r.id}:scan` && <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" />}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setExpireTarget(r)} disabled={r.expired}>
                  <TimerOff className="mr-2 h-4 w-4" />
                  立即过期
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600" onClick={() => setDeleteTarget(r)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除（入回收站）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      />

      {/* 立即过期确认 */}
      <ConfirmDialog
        open={!!expireTarget}
        onOpenChange={(v) => !v && setExpireTarget(null)}
        title="立即过期该文件"
        description={`将把「${expireTarget?.fileName}」的过期时间设为当前时刻，文件过期清理任务（file_expire_clean）将在下个周期将其软删回收。`}
        confirmText="设为过期"
        loading={busy === "expire"}
        onConfirm={async () => {
          if (expireTarget) await callAction("expire", () => expireFileAction({ fileId: expireTarget.id }))
          setExpireTarget(null)
        }}
      />

      {/* 删除确认（软删除入回收站） */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除文件（软删除）"
        destructive
        requirePhrase="DELETE"
        description={`确认删除「${deleteTarget?.fileName}」？\n文件将进入回收站（保留期后物理清除），审计全程留痕。`}
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (deleteTarget) await callAction("delete", () => deleteFileAction({ fileId: deleteTarget.id, reason: "管理员文件管理删除" }))
          setDeleteTarget(null)
        }}
      />

      {/* 批量立即过期确认 */}
      <ConfirmDialog
        open={batchExpireOpen}
        onOpenChange={(v) => !v && setBatchExpireOpen(false)}
        title={`批量立即过期（${selectedRows.length} 个文件）`}
        description={`确认将选中的 ${selectedRows.length} 个文件过期时间设为当前时刻？\n过期清理任务将在下个周期将其软删回收（进入各自归属用户的回收站）。`}
        confirmText="批量设为过期"
        loading={busy === "batch-expire"}
        onConfirm={async () => {
          await batchExpire()
        }}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && setBatchDeleteOpen(false)}
        title={`批量删除（${selectedRows.length} 个文件）`}
        destructive
        requirePhrase="DELETE"
        description={`确认删除选中的 ${selectedRows.length} 个文件？\n文件将进入回收站（保留期后物理清除），每个文件删除独立审计留痕。`}
        confirmText="批量删除"
        loading={busy === "batch-delete"}
        onConfirm={async () => {
          await batchDelete()
        }}
      />
    </div>
  )
}

// ---- 分布式节点多选筛选（默认主节点；「全部节点」一键） ----
function NodeFilter({
  value,
  options,
  onChange,
}: {
  value: string
  options: { label: string; value: string }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const isAll = value === "__all__"
  const parts = value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []
  const hasMaster = parts.includes("master")
  const selectedIds = parts.filter((p) => p !== "master" && p !== "__all__")

  const summary = isAll
    ? "全部节点"
    : selectedIds.length === 0
      ? "主节点"
      : `${hasMaster ? "主节点" : ""}${hasMaster ? " + " : ""}${selectedIds.length} 个节点`

  const emit = (nextMaster: boolean, nextIds: string[]) => {
    const partsArr: string[] = []
    if (nextMaster) partsArr.push("master")
    partsArr.push(...nextIds)
    // 空集合 = 缺省（主节点）
    onChange(partsArr.join(","))
  }

  const toggleNode = (id: string, checked: boolean) => {
    const next = checked ? [...selectedIds, id] : selectedIds.filter((x) => x !== id)
    emit(hasMaster, next)
  }

  const clearSelection = (
    <button
      type="button"
      className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
      onClick={() => {
        onChange("")
        setOpen(false)
      }}
    >
      <X className="h-3 w-3" /> 恢复默认（仅主节点）
    </button>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Server className="mr-1 h-3.5 w-3.5" />
          节点：{summary}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <div className="p-2 border-b">
          <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm">
            <Checkbox checked={isAll} onCheckedChange={(v) => onChange(v ? "__all__" : "")} />
            全部节点（含主节点与所有 BrowserNode）
          </label>
        </div>
        <div className="max-h-64 overflow-y-auto p-2 space-y-0.5">
          <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm">
            <Checkbox checked={hasMaster} onCheckedChange={(v) => emit(!!v, selectedIds)} />
            主节点（storageNodeId = 空）
          </label>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm">
              <Checkbox checked={selectedIds.includes(o.value)} onCheckedChange={(v) => toggleNode(o.value, !!v)} />
              <span className="truncate" title={o.label}>{o.label}</span>
            </label>
          ))}
          {options.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">暂无 BrowserNode 节点（仅主节点可用）</p>}
        </div>
        <div className="p-2 border-t flex items-center justify-between">
          {clearSelection}
          <span className="text-[10px] text-muted-foreground">{selectedIds.length + (hasMaster ? 1 : 0)} 项已选</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
