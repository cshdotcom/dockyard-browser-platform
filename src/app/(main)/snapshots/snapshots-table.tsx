"use client"

// 快照列表交互：创建快照（选 RUNNING cdp_light 工作区）/ 删除 / 设置过期时间 / 重命名

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Camera, Clock, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  createSnapshotAction,
  deleteSnapshotAction,
  setSnapshotExpireAction,
  renameSnapshotAction,
} from "@/server/actions/snapshots"

export interface SnapshotRow {
  id: string
  name: string
  scope: string
  scopeLabel: string
  sizeBytes: number
  sizeLabel: string
  workspaceName: string
  workspaceStatus: string | null
  isOwner: boolean
  expireAt: string
  expireAtIso: string | null
  expired: boolean
  createdAt: string
}

// ISO → datetime-local（本地时区）
function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface SnapshotsTableProps {
  rows: SnapshotRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  runnableWorkspaces: { id: string; name: string }[]
}

export function SnapshotsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, runnableWorkspaces }: SnapshotsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<SnapshotRow | null>(null)
  const [expireTarget, setExpireTarget] = React.useState<SnapshotRow | null>(null)
  const [renameTarget, setRenameTarget] = React.useState<SnapshotRow | null>(null)

  // 创建快照表单
  const [fWorkspaceId, setFWorkspaceId] = React.useState("")
  const [fName, setFName] = React.useState("")
  const [creating, setCreating] = React.useState(false)

  // 过期时间表单
  const [fExpire, setFExpire] = React.useState("")
  const [expiring, setExpiring] = React.useState(false)

  // 重命名表单
  const [fRename, setFRename] = React.useState("")
  const [renaming, setRenaming] = React.useState(false)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const openCreate = () => {
    setFWorkspaceId(runnableWorkspaces[0]?.id || "")
    setFName("")
    setCreateOpen(true)
  }

  const doCreate = async () => {
    if (!fWorkspaceId) {
      toast.error("请选择一个运行中的 CDP 工作区")
      return
    }
    if (!fName.trim()) {
      toast.error("快照名称必填")
      return
    }
    setCreating(true)
    try {
      const res = await createSnapshotAction({ workspaceId: fWorkspaceId, name: fName.trim() })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`快照「${fName.trim()}」创建成功（已调用 Steel profile 导出）`)
      setCreateOpen(false)
      router.refresh()
    } finally {
      setCreating(false)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setBusy(`del-${deleteTarget.id}`)
    try {
      const res = await deleteSnapshotAction({ id: deleteTarget.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`快照「${deleteTarget.name}」已删除并移入回收站`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const openExpire = (row: SnapshotRow) => {
    setExpireTarget(row)
    setFExpire(row.expireAtIso ? isoToLocalInput(row.expireAtIso) : "")
  }

  const doExpire = async () => {
    if (!expireTarget) return
    let expireIso: string | null = null
    if (fExpire) {
      const d = new Date(fExpire)
      if (Number.isNaN(d.getTime())) {
        toast.error("过期时间格式非法")
        return
      }
      if (d.getTime() <= Date.now()) {
        toast.error("过期时间必须晚于当前时间")
        return
      }
      expireIso = d.toISOString()
    }
    setExpiring(true)
    try {
      const res = await setSnapshotExpireAction({ id: expireTarget.id, expireAtIso: expireIso })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(fExpire ? "过期时间已设置" : "已清除过期时间（永不过期）")
      setExpireTarget(null)
      router.refresh()
    } finally {
      setExpiring(false)
    }
  }

  const doRename = async () => {
    if (!renameTarget) return
    if (!fRename.trim()) {
      toast.error("名称必填")
      return
    }
    setRenaming(true)
    try {
      const res = await renameSnapshotAction({ id: renameTarget.id, name: fRename.trim() })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success("快照已重命名")
      setRenameTarget(null)
      router.refresh()
    } finally {
      setRenaming(false)
    }
  }

  const columns = [
    {
      key: "name",
      title: "快照名称",
      sortable: true,
      render: (row: SnapshotRow) => (
        <div>
          <p className="font-medium flex items-center gap-1.5">
            <Camera className="h-3.5 w-3.5 text-teal-600 shrink-0" />
            {row.name}
          </p>
          <p className="text-xs text-muted-foreground">来源：{row.workspaceName}</p>
        </div>
      ),
    },
    {
      key: "scope",
      title: "范围",
      render: (row: SnapshotRow) => (
        <Badge
          className={
            row.scope === "PRIVATE"
              ? "bg-teal-600 hover:bg-teal-600"
              : row.scope === "GROUP"
                ? "bg-amber-500 hover:bg-amber-500"
                : "bg-violet-600 hover:bg-violet-600"
          }
        >
          {row.scopeLabel}
        </Badge>
      ),
    },
    { key: "sizeBytes", title: "大小", sortable: true, render: (row: SnapshotRow) => <span className="text-sm tabular-nums">{row.sizeLabel}</span> },
    {
      key: "expireAt",
      title: "过期时间",
      sortable: true,
      render: (row: SnapshotRow) => (
        <span className={cn("text-sm", row.expired ? "text-red-600 font-medium" : row.expireAtIso ? "" : "text-teal-600 font-medium")}>
          {row.expireAt}
        </span>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: SnapshotRow) => <span className="text-sm">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          仅运行中的 CDP 轻量工作区支持导出快照；删除为软删除进入回收站
        </p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" /> 创建快照
        </Button>
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
            key: "scope",
            placeholder: "范围",
            options: [
              { label: "私有", value: "PRIVATE" },
              { label: "组共享", value: "GROUP" },
              { label: "全局", value: "GLOBAL" },
            ],
          },
        ]}
        onQueryChange={pushQuery}
        emptyText="暂无快照，从运行中的工作区导出创建"
        rowActions={(row) => {
          const canOp = row.isOwner
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setRenameTarget(row)
                  setFRename(row.name)
                }}
                title={canOp ? "重命名" : "仅所有者可操作"}
                disabled={busy !== "" || !canOp}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openExpire(row)}
                title={canOp ? "设置过期时间" : "仅所有者可操作"}
                disabled={busy !== "" || !canOp}
              >
                <Clock className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteTarget(row)}
                title={canOp ? "删除" : "仅所有者可操作"}
                className="text-red-600 hover:text-red-700"
                disabled={busy !== "" || !canOp}
              >
                {busy === `del-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          )
        }}
      />

      {/* 创建快照弹窗 */}
      <Dialog open={createOpen} onOpenChange={(v) => !creating && setCreateOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5 text-teal-600" /> 创建配置快照
            </DialogTitle>
            <DialogDescription>
              从运行中的 CDP 轻量工作区导出浏览器 profile（Steel 归档），可用于新工作区还原
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>选择工作区（运行中的 cdp_light）</Label>
              {runnableWorkspaces.length === 0 ? (
                <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-xs text-amber-700 dark:text-amber-300">
                  当前没有运行中的 CDP 轻量工作区。请先在「浏览器工作区」页面创建并启动工作区。
                </div>
              ) : (
                <Select value={fWorkspaceId} onValueChange={setFWorkspaceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择工作区" />
                  </SelectTrigger>
                  <SelectContent>
                    {runnableWorkspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="snap-name">快照名称</Label>
              <Input id="snap-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例如：采集登录态-0927" maxLength={100} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={doCreate} disabled={creating || runnableWorkspaces.length === 0} className="bg-teal-600 hover:bg-teal-700">
              {creating && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              导出并创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 设置过期时间弹窗 */}
      <Dialog open={!!expireTarget} onOpenChange={(v) => !expiring && !v && setExpireTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-teal-600" /> 设置快照过期时间
            </DialogTitle>
            <DialogDescription>
              「{expireTarget?.name}」——到期后快照将停止共享展示；清空时间表示永不过期
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="snap-expire">过期时间</Label>
              <Input
                id="snap-expire"
                type="datetime-local"
                value={fExpire}
                onChange={(e) => setFExpire(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              当前：{expireTarget?.expireAt}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setFExpire("")
                void doExpire()
              }}
              disabled={expiring}
            >
              清除过期时间
            </Button>
            <Button onClick={doExpire} disabled={expiring} className="bg-teal-600 hover:bg-teal-700">
              {expiring && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名弹窗 */}
      <Dialog open={!!renameTarget} onOpenChange={(v) => !renaming && !v && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名快照</DialogTitle>
            <DialogDescription>当前名称：{renameTarget?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="snap-rename">新名称</Label>
            <Input id="snap-rename" value={fRename} onChange={(e) => setFRename(e.target.value)} maxLength={100} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>
              取消
            </Button>
            <Button onClick={doRename} disabled={renaming} className="bg-teal-600 hover:bg-teal-700">
              {renaming && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={`删除快照「${deleteTarget?.name || ""}」`}
        description="删除为软删除并移入回收站，保留期内可恢复。已引用该快照的工作区不受影响。"
        confirmText="确认删除"
        destructive
        onConfirm={doDelete}
      />
    </div>
  )
}
