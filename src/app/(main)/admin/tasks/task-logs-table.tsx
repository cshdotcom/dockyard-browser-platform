"use client"

// r23-b：定时任务执行日志（增强）
// - 筛选：任务 / 状态 / 触发类型（CRON/MANUAL）+ 日期范围（开始时间起/止）
// - 清理旧日志弹窗（天数 / 状态 / 可选限定任务）→ cleanupTaskLogsAction
// - 详情弹窗（errorStack 完整堆栈）保持

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { CalendarRange, Eye, Loader2, Trash2, X } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { PrecisionInput } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cleanupTaskLogsAction } from "@/server/actions/tasks"

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
  output: string | null // r24-a：参数化执行体完整输出（outputJson）
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

  const [detail, setDetail] = React.useState<TaskLogRow | null>(null)

  // ---- 清理旧日志弹窗状态 ----
  const [cleanupOpen, setCleanupOpen] = React.useState(false)
  const [cleanDays, setCleanDays] = React.useState(30)
  const [cleanStatus, setCleanStatus] = React.useState<string>("ALL")
  const [cleanTaskCode, setCleanTaskCode] = React.useState<string>("__all__")
  const [cleaning, setCleaning] = React.useState(false)

  React.useEffect(() => {
    if (cleanupOpen) setCleanTaskCode(filters.taskCode || "__all__") // 默认限定当前筛选任务
  }, [cleanupOpen, filters.taskCode])

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const runCleanup = async () => {
    if (!Number.isInteger(cleanDays) || cleanDays < 1 || cleanDays > 3650) {
      toast.error("保留天数必须在 1 - 3650 之间")
      return
    }
    setCleaning(true)
    try {
      const res = await cleanupTaskLogsAction({
        days: Math.round(cleanDays),
        status: cleanStatus,
        taskCode: cleanTaskCode === "__all__" ? undefined : cleanTaskCode,
      })
      if (res.code === 0 && res.data) {
        toast.success(`已清理 ${res.data.deleted} 条执行日志`)
        setCleanupOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清理失败")
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* 工具栏：开始时间范围筛选（起/止）+ 清理旧日志入口 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1.5" title="按执行开始时间范围筛选">
          <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            type="date"
            value={filters.logFrom || ""}
            onChange={(e) => pushQuery({ page: "1", logFrom: e.target.value || undefined })}
            className="w-36"
            aria-label="开始时间起（YYYY-MM-DD）"
          />
          <span className="text-xs text-muted-foreground">至</span>
          <Input
            type="date"
            value={filters.logTo || ""}
            onChange={(e) => pushQuery({ page: "1", logTo: e.target.value || undefined })}
            className="w-36"
            aria-label="开始时间止（YYYY-MM-DD）"
          />
          {(filters.logFrom || filters.logTo) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => pushQuery({ page: "1", logFrom: undefined, logTo: undefined })}
              title="清空时间范围筛选"
            >
              <X className="h-3.5 w-3.5" /> 清空
            </Button>
          )}
        </div>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)} title="按天数/状态/任务批量删除旧执行日志">
            <Trash2 className="mr-1 h-3.5 w-3.5" /> 清理旧日志
          </Button>
        </div>
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
          {
            key: "triggerType",
            placeholder: "触发类型",
            options: [
              { label: "定时触发", value: "CRON" },
              { label: "手动触发", value: "MANUAL" },
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

      {/* 详情弹窗：含完整 errorStack（可展开查看） */}
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
              <p className="text-xs text-muted-foreground">执行输出（脚本 stdout / 响应体）</p>
              {detail?.output ? (
                <ScrollArea className="h-56 rounded-md border bg-muted p-3">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">{detail.output}</pre>
                </ScrollArea>
              ) : (
                <div className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">（无执行输出；仅参数化执行体（Shell/任务链/Webhook）产生完整输出）</div>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">错误堆栈（errorStack）</p>
              {detail?.errorStack ? (
                <ScrollArea className="h-56 rounded-md border bg-muted p-3">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">{detail.errorStack}</pre>
                </ScrollArea>
              ) : (
                <div className="rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">（无错误堆栈）</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 清理旧日志弹窗：天数 / 状态 / 可选限定任务 */}
      <Dialog open={cleanupOpen} onOpenChange={(v) => !cleaning && setCleanupOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-red-500" />
              清理旧执行日志
            </DialogTitle>
            <DialogDescription>
              删除指定天数之前的执行日志（物理删除，不可恢复）；不清理当天及保留期内的日志。默认清理全部任务的旧日志。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>保留最近（天数）</Label>
              <PrecisionInput value={cleanDays} onChange={setCleanDays} min={1} max={3650} step={1} suffix="天" />
              <p className="text-xs text-muted-foreground">清理 N 天前（不含最近 N 天）的日志，1 - 3650</p>
            </div>
            <div className="space-y-1.5">
              <Label>限定执行状态</Label>
              <Select value={cleanStatus} onValueChange={setCleanStatus}>
                <SelectTrigger aria-label="清理的日志状态">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部状态</SelectItem>
                  <SelectItem value="SUCCESS">仅成功（SUCCESS）</SelectItem>
                  <SelectItem value="FAILED">仅失败（FAILED）</SelectItem>
                  <SelectItem value="TIMEOUT">仅超时（TIMEOUT）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>限定任务（可选）</Label>
              <Select value={cleanTaskCode} onValueChange={setCleanTaskCode}>
                <SelectTrigger aria-label="清理的任务范围">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="__all__">全部任务</SelectItem>
                  {taskOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="font-mono text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filters.taskCode && (
                <p className="text-xs text-muted-foreground">已按当前筛选预选任务 {filters.taskCode}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={cleaning}>
              取消
            </Button>
            <Button variant="destructive" onClick={runCleanup} disabled={cleaning}>
              {cleaning && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              清理旧日志
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
