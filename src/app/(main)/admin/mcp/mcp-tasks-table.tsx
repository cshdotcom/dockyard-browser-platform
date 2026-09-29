"use client"

// MCP 任务交互表格：详情弹窗（参数/结果/失败原因/子项前50） / 取消 / 重试入队

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Eye, Ban, RotateCcw } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cancelMcpTaskAction, retryMcpTaskAction, getMcpTaskDetailAction } from "@/server/actions/mcp-admin"

export interface McpTaskRow {
  id: string
  taskUuid: string
  name: string
  code: string
  priority: string
  status: string
  progress: number
  totalItems: number
  successItems: number
  failedItems: number
  username: string
  createdAt: string
  finishedAt: string | null
}

interface TaskDetail {
  task: {
    id: string
    taskUuid: string
    name: string
    code: string
    priority: string
    status: string
    paramsJson: string | null
    resultJson: string | null
    progress: number
    totalItems: number
    successItems: number
    failedItems: number
    failReasons: string[]
    userId: string | null
    startedAt: string | null
    finishedAt: string | null
    createdAt: string
  }
  items: { id: string; targetType: string; targetId: string; status: string; error: string | null; finishedAt: string | null }[]
}

interface Props {
  rows: McpTaskRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  userOptions?: { id: string; name: string }[]
}

const PRIORITY_CLS: Record<string, string> = {
  HIGH: "bg-red-600 text-white",
  MEDIUM: "bg-amber-600 text-white",
  LOW: "bg-slate-500 text-white",
}
const PRIORITY_LABEL: Record<string, string> = { HIGH: "高", MEDIUM: "中", LOW: "低" }

export function McpTasksTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [detail, setDetail] = React.useState<TaskDetail | null>(null)
  const [detailBusy, setDetailBusy] = React.useState(false)

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

  const openDetail = async (row: McpTaskRow) => {
    setDetailBusy(true)
    try {
      const res = await getMcpTaskDetailAction({ id: row.id })
      if (res.code === 0 && res.data) {
        setDetail(res.data as TaskDetail)
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载失败")
    } finally {
      setDetailBusy(false)
    }
  }

  const canCancel = (row: McpTaskRow) => row.status === "PENDING" || row.status === "RUNNING"
  const canRetry = (row: McpTaskRow) => ["FAILED", "PARTIAL", "CANCELLED", "ROLLED_BACK"].includes(row.status)

  const columns = [
    {
      key: "name",
      title: "任务 / UUID",
      sortable: true,
      render: (row: McpTaskRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{row.taskUuid}</p>
        </div>
      ),
    },
    {
      key: "code",
      title: "操作",
      render: (row: McpTaskRow) => <Badge variant="outline" className="text-xs font-mono">{row.code}</Badge>,
    },
    {
      key: "priority",
      title: "优先级",
      sortable: true,
      render: (row: McpTaskRow) => (
        <Badge className={`${PRIORITY_CLS[row.priority] || "bg-secondary"} text-xs`}>
          {PRIORITY_LABEL[row.priority] || row.priority}
        </Badge>
      ),
    },
    { key: "status", title: "状态", sortable: true, render: (row: McpTaskRow) => <StatusBadge status={row.status} /> },
    {
      key: "progress",
      title: "进度",
      sortable: true,
      render: (row: McpTaskRow) => (
        <div className="min-w-28">
          <p className="text-xs tabular-nums mb-1">{row.progress}%</p>
          <Progress value={row.progress} className="h-1.5" />
        </div>
      ),
    },
    {
      key: "items",
      title: "子项 成功/失败",
      render: (row: McpTaskRow) => (
        <span className="text-xs tabular-nums">
          {row.totalItems > 0 ? (
            <>
              <span className="text-emerald-600">{row.successItems}</span>
              {" / "}
              <span className={row.failedItems > 0 ? "text-red-600" : ""}>{row.failedItems}</span>
              <span className="text-muted-foreground"> / {row.totalItems}</span>
            </>
          ) : (
            "-"
          )}
        </span>
      ),
    },
    { key: "username", title: "发起用户", render: (row: McpTaskRow) => <span className="text-xs">{row.username}</span> },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: McpTaskRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
    { key: "finishedAt", title: "完成时间", sortable: true, render: (row: McpTaskRow) => <span className="text-xs text-muted-foreground">{row.finishedAt || "-"}</span> },
  ]

  return (
    <div className="space-y-3">
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
            key: "status", placeholder: "状态",
            options: ["PENDING", "RUNNING", "PAUSED", "SUCCESS", "FAILED", "PARTIAL", "ROLLED_BACK", "CANCELLED"].map((s) => ({ label: s, value: s })),
          },
          { key: "priority", placeholder: "优先级", options: [{ label: "高", value: "HIGH" }, { label: "中", value: "MEDIUM" }, { label: "低", value: "LOW" }] },
          ...(props.userOptions && props.userOptions.length > 0
            ? [{ key: "userId", placeholder: "发起用户", options: props.userOptions.map((u) => ({ label: u.name, value: u.id })) }]
            : []),
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={detailBusy}>
                {detailBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => openDetail(row)}>
                <Eye className="h-4 w-4 mr-2" /> 任务详情
              </DropdownMenuItem>
              {canCancel(row) && (
                <DropdownMenuItem onClick={() => callAction(`cancel-${row.id}`, () => cancelMcpTaskAction({ id: row.id }))}>
                  <Ban className="h-4 w-4 mr-2" /> 取消任务
                </DropdownMenuItem>
              )}
              {canRetry(row) && (
                <DropdownMenuItem onClick={() => callAction(`retry-${row.id}`, () => retryMcpTaskAction({ id: row.id }))}>
                  <RotateCcw className="h-4 w-4 mr-2" /> 重试（重新入队）
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
      />

      {/* 详情弹窗 */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {detail?.task.name}
              <Badge variant="outline" className="font-mono text-xs">{detail?.task.code}</Badge>
              <StatusBadge status={detail?.task.status || ""} />
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">{detail?.task.taskUuid}</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">进度</p>
                  <p className="font-semibold tabular-nums">{detail.task.progress}%</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">子项</p>
                  <p className="font-semibold tabular-nums">
                    {detail.task.successItems}/{detail.task.failedItems}/{detail.task.totalItems}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">开始 / 完成</p>
                  <p className="font-semibold text-xs">
                    {detail.task.startedAt ? new Date(detail.task.startedAt).toLocaleString() : "-"}
                    {" → "}
                    {detail.task.finishedAt ? new Date(detail.task.finishedAt).toLocaleString() : "-"}
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">发起用户</p>
                  <p className="font-semibold text-xs font-mono truncate">{detail.task.userId || "-"}</p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-1.5">参数 JSON</p>
                <pre className="rounded-md bg-muted/60 p-3 text-xs overflow-x-auto max-h-40">
                  {detail.task.paramsJson ? formatJson(detail.task.paramsJson) : "（无）"}
                </pre>
              </div>

              <div>
                <p className="text-sm font-medium mb-1.5">结果 JSON</p>
                <pre className="rounded-md bg-muted/60 p-3 text-xs overflow-x-auto max-h-40">
                  {detail.task.resultJson ? formatJson(detail.task.resultJson) : "（无）"}
                </pre>
              </div>

              {detail.task.failReasons.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-1.5 text-red-600">失败原因（{detail.task.failReasons.length}）</p>
                  <ScrollArea className="max-h-32">
                    <ul className="space-y-1">
                      {detail.task.failReasons.map((r, i) => (
                        <li key={i} className="text-xs rounded-md border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 px-2 py-1.5">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}

              <div>
                <p className="text-sm font-medium mb-1.5">任务子项（前 50 条）</p>
                {detail.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">（暂无子项）</p>
                ) : (
                  <ScrollArea className="max-h-56">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="text-left py-1.5 pr-2">目标类型</th>
                          <th className="text-left py-1.5 pr-2">目标 ID</th>
                          <th className="text-left py-1.5 pr-2">状态</th>
                          <th className="text-left py-1.5">错误</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.items.map((it) => (
                          <tr key={it.id} className="border-b last:border-0">
                            <td className="py-1.5 pr-2 font-mono">{it.targetType}</td>
                            <td className="py-1.5 pr-2 font-mono truncate max-w-40">{it.targetId}</td>
                            <td className="py-1.5 pr-2"><StatusBadge status={it.status} /></td>
                            <td className="py-1.5 text-muted-foreground">{it.error || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollArea>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
