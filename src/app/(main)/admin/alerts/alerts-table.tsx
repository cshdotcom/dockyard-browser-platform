"use client"

// 告警列表：级别/处理状态筛选 + 时间排序 + PENDING 高亮 + 标记已处理 + 详情弹窗

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2, Eye, Loader2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { handleAlertAction } from "@/server/actions/alerts"

export interface AlertRow {
  id: string
  title: string
  level: string
  content: string
  resourceType: string | null
  resourceId: string | null
  ownerName: string | null
  triggerAt: string
  handleStatus: string
  handledByName: string | null
  handledAt: string | null
  dedupeKey: string | null
  traceId: string | null
}

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  INFO: { label: "INFO", cls: "bg-sky-600 hover:bg-sky-600" },
  WARN: { label: "WARN", cls: "bg-amber-500 hover:bg-amber-500" },
  CRITICAL: { label: "CRITICAL", cls: "bg-red-600 hover:bg-red-600" },
}

const HANDLE_LABEL: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  PENDING: { label: "待处理", variant: "default" },
  HANDLED: { label: "已处理", variant: "secondary" },
  AUTO_RESOLVED: { label: "自动恢复", variant: "outline" },
}

interface AlertsTableProps {
  rows: AlertRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function AlertsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters }: AlertsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [detail, setDetail] = React.useState<AlertRow | null>(null)
  const [handleTarget, setHandleTarget] = React.useState<AlertRow | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const markHandled = async () => {
    if (!handleTarget) return
    setBusy("handle")
    try {
      const res = await handleAlertAction({ alertId: handleTarget.id })
      if (res.code === 0) {
        toast.success("告警已标记为已处理")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
      setHandleTarget(null)
    }
  }

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
          {
            key: "level",
            placeholder: "级别",
            options: [
              { label: "INFO 信息", value: "INFO" },
              { label: "WARN 警告", value: "WARN" },
              { label: "CRITICAL 严重", value: "CRITICAL" },
            ],
          },
          {
            key: "handleStatus",
            placeholder: "处理状态",
            options: [
              { label: "待处理", value: "PENDING" },
              { label: "已处理", value: "HANDLED" },
              { label: "自动恢复", value: "AUTO_RESOLVED" },
            ],
          },
        ]}
        emptyText="暂无告警记录"
        columns={[
          {
            key: "title",
            title: "标题",
            render: (r) => (
              <div className={cn("min-w-0 border-l-2 pl-2", r.handleStatus === "PENDING" ? "border-amber-500 bg-amber-50/50 dark:bg-amber-950/20" : "border-transparent")}>
                <p className="text-sm font-medium truncate max-w-64" title={r.title}>
                  {r.handleStatus === "PENDING" && <span className="inline-block h-2 w-2 rounded-full bg-amber-500 mr-1.5 align-middle" />}
                  {r.title}
                </p>
                <p className="text-xs text-muted-foreground truncate max-w-64" title={r.content}>{r.content}</p>
              </div>
            ),
          },
          {
            key: "level",
            title: "级别",
            render: (r) => {
              const meta = LEVEL_META[r.level] || { label: r.level, cls: "bg-secondary" }
              return <Badge className={cn(meta.cls, "text-white")}>{meta.label}</Badge>
            },
          },
          {
            key: "resourceType",
            title: "资源类型",
            render: (r) =>
              r.resourceType ? (
                <Badge variant="outline" className="text-[10px]">{r.resourceType}</Badge>
              ) : (
                <span className="text-muted-foreground text-xs">-</span>
              ),
          },
          { key: "ownerName", title: "归属用户", render: (r) => <span className="text-sm">{r.ownerName || "-"}</span> },
          { key: "triggerAt", title: "触发时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.triggerAt}</span> },
          {
            key: "handleStatus",
            title: "处理状态",
            render: (r) => {
              const meta = HANDLE_LABEL[r.handleStatus] || { label: r.handleStatus, variant: "secondary" as const }
              return (
                <Badge variant={meta.variant} className={cn(r.handleStatus === "PENDING" && "bg-amber-500 hover:bg-amber-500 text-white")}>
                  {meta.label}
                </Badge>
              )
            },
          },
          { key: "handledByName", title: "处理人", render: (r) => <span className="text-sm">{r.handledByName || "-"}</span> },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setDetail(r)} aria-label="查看告警详情">
              <Eye className="h-4 w-4" />
            </Button>
            {r.handleStatus === "PENDING" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-emerald-600 hover:text-emerald-700"
                onClick={() => setHandleTarget(r)}
                disabled={busy === "handle"}
                aria-label="标记已处理"
              >
                <CheckCircle2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      />
      {rows.some((r) => r.handleStatus === "PENDING") && (
        <p className="text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500 mr-1.5" />
          琥珀色标记行 = 待处理（PENDING）告警；CRITICAL 待处理请优先处置。
        </p>
      )}

      {/* 详情弹窗 */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail && (
                <Badge className={cn((LEVEL_META[detail.level] || { cls: "bg-secondary" }).cls, "text-white")}>
                  {detail.level}
                </Badge>
              )}
              {detail?.title}
            </DialogTitle>
            <DialogDescription>
              触发时间 {detail?.triggerAt} · 资源 {detail?.resourceType || "-"}
              {detail?.resourceId ? ` / ${detail.resourceId}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
                {detail.content}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">处理状态</p>
                  <p className="font-medium">{HANDLE_LABEL[detail.handleStatus]?.label || detail.handleStatus}{detail.handledAt ? ` · ${detail.handledAt}` : ""}</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">处理人</p>
                  <p className="font-medium">{detail.handledByName || "-"}</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">抑制/聚合键</p>
                  <p className="font-mono text-[10px] break-all">{detail.dedupeKey || "-"}</p>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-muted-foreground">traceId</p>
                  <p className="font-mono text-[10px] break-all">{detail.traceId || "-"}</p>
                </div>
              </div>
            </div>
          )}
          {detail?.handleStatus === "PENDING" && (
            <Button className="w-full" variant="secondary" onClick={() => { setHandleTarget(detail); setDetail(null) }}>
              <CheckCircle2 className="mr-1 h-4 w-4" />
              标记为已处理
            </Button>
          )}
        </DialogContent>
      </Dialog>

      {/* 处理确认 */}
      <ConfirmDialog
        open={!!handleTarget}
        onOpenChange={(v) => !v && setHandleTarget(null)}
        title="标记告警已处理"
        description={`确认将「${handleTarget?.title}」标记为已处理？将记录处理人与处理时间，全程审计留痕。`}
        confirmText="确认处理"
        loading={busy === "handle"}
        onConfirm={markHandled}
      />
      {busy === "handle" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在处理…
        </div>
      )}
    </div>
  )
}
