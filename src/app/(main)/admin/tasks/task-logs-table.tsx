"use client"

// 定时任务执行日志：分页表格（任务/状态筛选/时间排序）+ 详情弹窗（errorStack 完整堆栈）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Eye } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

export interface TaskLogRow {
  id: string
  taskCode: string
  triggerType: string
  status: string
  startAt: string
  endAt: string | null
  durationMs: number | null
  itemsProcessed: number
  summary: string | null
  errorStack: string | null
}

interface TaskLogsTableProps {
  rows: TaskLogRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  taskOptions: { label: string; value: string }[]
}

const STATUS_LABEL: Record<string, string> = {
  RUNNING: "运行中",
  SUCCESS: "成功",
  FAILED: "失败",
  TIMEOUT: "超时",
}

const TRIGGER_LABEL: Record<string, string> = {
  CRON: "定时触发",
  MANUAL: "手动触发",
}

export function TaskLogsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, taskOptions }: TaskLogsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const [detail, setDetail] = React.useState<TaskLogRow | null>(null)

  return (
    <div className="space-y-3">
      <DataTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        filters={[
          { key: "taskCode", placeholder: "任务筛选", options: taskOptions },
          {
            key: "status",
            placeholder: "执行状态",
            options: [
              { label: "运行中", value: "RUNNING" },
              { label: "成功", value: "SUCCESS" },
              { label: "失败", value: "FAILED" },
              { label: "超时", value: "TIMEOUT" },
            ],
          },
        ]}
        emptyText="暂无执行日志"
        columns={[
          {
            key: "taskCode",
            title: "任务",
            render: (r) => <span className="font-mono text-sm">{r.taskCode}</span>,
          },
          {
            key: "triggerType",
            title: "触发方式",
            render: (r) => (
              <Badge variant={r.triggerType === "MANUAL" ? "default" : "secondary"} className={r.triggerType === "MANUAL" ? "bg-teal-600 hover:bg-teal-600" : ""}>
                {TRIGGER_LABEL[r.triggerType] || r.triggerType}
              </Badge>
            ),
          },
          {
            key: "status",
            title: "状态",
            render: (r) => <StatusBadge status={r.status} />,
          },
          {
            key: "startAt",
            title: "开始时间",
            sortable: true,
            render: (r) => <span className="text-xs tabular-nums">{r.startAt}</span>,
          },
          {
            key: "durationMs",
            title: "耗时",
            sortable: true,
            render: (r) => <span className="text-xs tabular-nums">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(2)}s` : "-"}</span>,
          },
          {
            key: "itemsProcessed",
            title: "处理条数",
            sortable: true,
            render: (r) => <span className="tabular-nums">{r.itemsProcessed}</span>,
          },
          {
            key: "summary",
            title: "摘要",
            render: (r) => (
              <span className="text-xs text-muted-foreground block max-w-72 truncate" title={r.summary || ""}>
                {r.summary || "-"}
              </span>
            ),
          },
        ]}
        rowActions={(r) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(r)} aria-label="查看日志详情">
            <Eye className="h-4 w-4" />
          </Button>
        )}
      />

      {/* 详情弹窗：含完整 errorStack */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono">
              {detail?.taskCode}
              {detail && <StatusBadge status={detail.status} />}
            </DialogTitle>
            <DialogDescription>
              {detail && `${TRIGGER_LABEL[detail.triggerType] || detail.triggerType} · ${STATUS_LABEL[detail.status] || detail.status} · 开始 ${detail.startAt}${detail.endAt ? ` · 结束 ${detail.endAt}` : ""}${detail.durationMs != null ? ` · 耗时 ${(detail.durationMs / 1000).toFixed(2)}s` : ""}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">处理条数</p>
                <p className="tabular-nums font-medium">{detail?.itemsProcessed ?? 0}</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">执行状态</p>
                <p className="font-medium">{detail ? STATUS_LABEL[detail.status] || detail.status : "-"}</p>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">执行摘要</p>
              <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all">
                {detail?.summary || "（无摘要）"}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">错误堆栈（errorStack）</p>
              <ScrollArea className="h-56 rounded-md border bg-muted p-3">
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                  {detail?.errorStack || "（无错误堆栈）"}
                </pre>
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
