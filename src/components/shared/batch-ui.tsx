"use client"

// 通用批量操作 UI 套件（r14：全站列表统一批量交互）
//   · BatchBar：勾选行后出现在筛选栏的批量操作条（自定义按钮插槽 + 选中计数 + 清空）
//   · useBatch<T>：勾选状态（跨页保持）+ 批量调用器（逐批调用 + 失败清单弹窗 + 完成刷新）
// 失败清单：服务端逐条 try/catch 返回 failed[]（如“运行中会话禁止删除”），
// 统一在一个 Dialog 中逐条展示，避免 toast 只显示第一条的盲区。

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/shared/confirm"
import type { ActionResult } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface BatchFailedItem {
  id: string
  reason: string
}

export function BatchBar({
  count,
  onClear,
  children,
  busy,
  label = "项",
}: {
  count: number
  onClear: () => void
  children: React.ReactNode
  busy?: boolean
  label?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50/60 dark:bg-teal-950/30 dark:border-teal-800 px-2 py-1">
      <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">已选 {count} {label}</Badge>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" />}
      {children}
      <button
        type="button"
        className="ml-1 p-1 rounded hover:bg-muted text-muted-foreground"
        onClick={onClear}
        aria-label="清空选择"
        title="清空选择"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function BatchDeleteButton({
  onClick,
  busy,
  disabled,
  children = "批量删除",
  confirmTitle = "批量删除确认",
  confirmDescription,
  requirePhrase,
  destructive = true,
}: {
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  children?: React.ReactNode
  confirmTitle?: string
  confirmDescription: string
  requirePhrase?: string
  destructive?: boolean
}) {
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={cn(destructive && "text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900")}
        onClick={onClick}
        disabled={busy || disabled}
      >
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
        {children}
      </Button>
    </>
  )
}

// ---- 批量勾选状态管理（跨页保持；切换筛选/搜索条件时自动清空）----
export function useBatch<T extends { id: string }>(rows: T[], resetKey?: string) {
  const router = useRouter()
  const [selected, setSelected] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState("")
  const [failures, setFailures] = React.useState<BatchFailedItem[] | null>(null)
  const [confirmAction, setConfirmAction] = React.useState<{ label: string; run: () => Promise<void>; description: string; requirePhrase?: string } | null>(null)

  // 筛选/搜索条件变化 → 清空选择（避免跨筛选误操作）
  React.useEffect(() => {
    setSelected([])
  }, [resetKey])

  const runBatch = async (label: string, fn: () => Promise<ActionResult<{ affected: number; failed?: BatchFailedItem[] } & Record<string, unknown>>>, opts?: { refresh?: boolean; successText?: (n: number) => string }) => {
    setBusy(label)
    try {
      const res = await fn()
      if (res.code !== 0) {
        toast.error(res.msg || "批量操作失败")
        return
      }
      const n = res.data?.affected ?? 0
      const failed = res.data?.failed ?? []
      if (failed.length > 0) {
        setFailures(failed)
        toast.warning(`批量操作完成：成功 ${n} 条，失败 ${failed.length} 条（查看失败原因）`)
      } else {
        toast.success((opts?.successText?.(n)) ?? `批量操作完成：成功 ${n} 条`)
      }
      setSelected([])
      if (opts?.refresh !== false) router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBusy("")
      setConfirmAction(null)
    }
  }

  // 危险操作 → 先弹确认框
  const confirmBatch = (label: string, description: string, fn: () => Promise<void>, requirePhrase?: string) => {
    setConfirmAction({ label, run: fn, description, requirePhrase })
  }

  return {
    selected,
    setSelected,
    busy,
    failures,
    setFailures,
    confirmAction,
    setConfirmAction,
    runBatch,
    confirmBatch,
    toggle: (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id])),
    rows,
  }
}

// ---- 批量失败清单弹窗 ----
export function BatchFailuresDialog({ failures, onClose }: { failures: BatchFailedItem[] | null; onClose: () => void }) {
  return (
    <Dialog open={!!failures} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-red-500" />
            部分条目处理失败（{failures?.length ?? 0} 条）
          </DialogTitle>
          <DialogDescription>以下条目未被执行，其余条目已成功处理。失败原因逐条列出：</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
          {failures?.map((f) => (
            <div key={f.id} className="px-3 py-2 flex items-start gap-2 text-sm">
              <Badge variant="outline" className="text-[10px] font-mono shrink-0 mt-0.5 max-w-32 truncate" title={f.id}>
                {f.id.slice(0, 10)}
              </Badge>
              <span className="text-muted-foreground min-w-0 break-words">{f.reason}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- 批量确认弹窗（组合 ConfirmDialog）----
export function BatchConfirmDialog({
  action,
  onClose,
  busy,
}: {
  action: { label: string; description: string; requirePhrase?: string; run: () => Promise<void> } | null
  onClose: () => void
  busy: boolean
}) {
  return (
    <ConfirmDialog
      open={!!action}
      onOpenChange={(v) => !v && !busy && onClose()}
      title={action?.label || "批量操作确认"}
      description={action?.description || ""}
      confirmText="确认执行"
      loading={busy}
      requirePhrase={action?.requirePhrase}
      onConfirm={async () => {
        if (action) await action.run()
      }}
    />
  )
}
