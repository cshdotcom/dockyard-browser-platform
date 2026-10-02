"use client"

// 站内通知（管理员视角只读）：全站最近通知查看

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { CheckCheck, Loader2, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { batchReadNoticesAction, batchDeleteNoticesAction } from "@/server/actions/batch"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export interface NoticeRow {
  id: string
  username: string
  title: string
  content: string
  type: string
  readAt: string | null
  createdAt: string
}

const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  ALERT: { label: "告警", cls: "bg-amber-500 hover:bg-amber-500 text-white" },
  SYSTEM: { label: "系统", cls: "bg-sky-600 hover:bg-sky-600 text-white" },
  ANNOUNCEMENT: { label: "公告", cls: "bg-teal-600 hover:bg-teal-600 text-white" },
  TOKEN_EXPIRE: { label: "Token到期", cls: "bg-secondary" },
  SECURITY: { label: "安全", cls: "bg-red-600 hover:bg-red-600 text-white" },
}

interface NoticesTableProps {
  rows: NoticeRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function NoticesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters }: NoticesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // ---- 批量操作（标记已读 / 批量删除） ----
  const [sel, setSel] = React.useState<string[]>([])
  const [batchBusy, setBatchBusy] = React.useState("")
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)

  const runNoticeBatch = async (label: string, fn: () => Promise<{ code: number; msg: string; data?: { affected: number } | null }>, okText: string) => {
    setBatchBusy(label)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(okText.replace("{n}", String(res.data?.affected ?? 0)))
        setSel([])
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBatchBusy("")
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

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        站内通知只读视图（管理员视角）：告警 / 系统 / 公告 / Token 到期 / 安全事件的站内投递记录
      </p>
      <DataTable
      selectedIds={sel}
      onSelectedChange={setSel}
      batchToolbar={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runNoticeBatch("read", () => batchReadNoticesAction({ ids: sel }), "已批量标记 {n} 条通知为已读")}>
            {batchBusy === "read" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="mr-1 h-3.5 w-3.5" />}
            批量已读
          </Button>
          <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900" disabled={!!batchBusy} onClick={() => setBatchDeleteOpen(true)}>
            {batchBusy === "delete" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
            批量删除
          </Button>
        </div>
      }
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        filters={[
          {
            key: "type",
            placeholder: "通知类型",
            options: Object.entries(TYPE_LABEL).map(([value, meta]) => ({ label: meta.label, value })),
          },
          {
            key: "read",
            placeholder: "阅读状态",
            options: [
              { label: "已读", value: "true" },
              { label: "未读", value: "false" },
            ],
          },
        ]}
        emptyText="暂无站内通知"
        columns={[
          { key: "username", title: "接收用户", render: (r) => <span className="text-sm">{r.username}</span> },
          {
            key: "title",
            title: "标题",
            render: (r) => <span className="text-sm font-medium">{r.title}</span>,
          },
          {
            key: "content",
            title: "内容",
            render: (r) => (
              <span className="text-xs text-muted-foreground block max-w-72 truncate" title={r.content}>
                {r.content}
              </span>
            ),
          },
          {
            key: "type",
            title: "类型",
            render: (r) => {
              const meta = TYPE_LABEL[r.type] || { label: r.type, cls: "bg-secondary" }
              return <Badge className={meta.cls}>{meta.label}</Badge>
            },
          },
          {
            key: "readAt",
            title: "阅读状态",
            render: (r) =>
              r.readAt ? (
                <Badge variant="secondary" className="text-[10px]">已读 {r.readAt}</Badge>
              ) : (
                <Badge className="bg-amber-500 hover:bg-amber-500 text-white text-[10px]">未读</Badge>
              ),
          },
          { key: "createdAt", title: "发送时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span> },
        ]}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && setBatchDeleteOpen(v)}
        title={`批量删除 ${sel.length} 条站内通知`}
        description={`将删除选中的 ${sel.length} 条通知记录（用户站内信中同步消失）：\n· 该操作为物理删除，删除清单写入审计日志\n· 删除后用户通知铃不再显示对应条目`}
        requirePhrase="DELETE"
        destructive
        loading={batchBusy === "delete"}
        confirmText="确认批量删除"
        onConfirm={() => runNoticeBatch("delete", () => batchDeleteNoticesAction({ ids: sel }), "已批量删除 {n} 条通知")}
      />
    </div>
  )
}
