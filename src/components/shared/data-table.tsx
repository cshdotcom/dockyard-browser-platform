"use client"

// 通用数据表格：分页 / 多选（含跨页保持）/ 表头排序 / 工具栏筛选 / 行操作
// 企业级列表页统一底座 —— 全站列表复用

import * as React from "react"
import { ChevronDown, ChevronFirst, ChevronLast, ChevronUp, ChevronsUpDown, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export interface Column<T> {
  key: string
  title: React.ReactNode
  render?: (row: T) => React.ReactNode
  sortable?: boolean
  className?: string
  width?: string
}

export interface FilterDef {
  key: string
  placeholder?: string
  options?: { label: string; value: string }[]
  type?: "text" | "select"
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[]
  rows: T[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters?: FilterDef[]
  rowActions?: (row: T) => React.ReactNode
  onQueryChange?: (params: Record<string, string | undefined>) => void
  selectedIds?: string[]
  onSelectedChange?: (ids: string[]) => void
  emptyText?: string
  batchToolbar?: React.ReactNode
  dense?: boolean
  // 行点击（云盘列表：点击行弹预览 / 点击文件夹行进入目录；复选框与行操作列阻止冒泡）
  onRowClick?: (row: T) => void
  // 行数超过该值时表体启用纵向滚动容器（默认 5；防止长列表撑爆页面/页面被顶住无法滚动）
  scrollThreshold?: number
  // 滚动容器最大高度（默认 460px ≈ 10 行）
  scrollMaxHeight?: number
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  total,
  page,
  pageSize,
  keyword,
  sortField,
  sortOrder,
  filters = [],
  rowActions,
  onQueryChange,
  selectedIds,
  onSelectedChange,
  emptyText = "暂无数据",
  batchToolbar,
  dense,
  onRowClick,
  scrollThreshold = 5,
  scrollMaxHeight = 460,
}: DataTableProps<T>) {
  const [kw, setKw] = React.useState(keyword || "")
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allChecked = rows.length > 0 && selectedIds && rows.every((r) => selectedIds.includes(r.id))
  const selectEnabled = !!onSelectedChange

  const pushQuery = (patch: Record<string, string | undefined>) => {
    if (!onQueryChange) return
    onQueryChange(patch)
  }

  const toggleSort = (key: string) => {
    if (sortField === key) {
      pushQuery({ sortOrder: sortOrder === "asc" ? "desc" : "asc" })
    } else {
      pushQuery({ sortField: key, sortOrder: "asc" })
    }
  }

  const toggleRow = (id: string) => {
    if (!onSelectedChange || !selectedIds) return
    onSelectedChange(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id])
  }

  return (
    <div className="w-full space-y-3">
      {(filters.length > 0 || keyword !== undefined) && (
        <div className="flex flex-wrap items-center gap-2">
          {keyword !== undefined && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                pushQuery({ page: "1", keyword: kw })
              }}
              className="flex gap-2"
            >
              <Input
                placeholder="搜索关键词 / ID / UUID..."
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                className="w-56"
              />
              <Button type="submit" variant="secondary" size="sm">
                搜索
              </Button>
            </form>
          )}
          {filters.map((f) => (
            <Select
              key={f.key}
              value={undefined}
              onValueChange={(v) => pushQuery({ page: "1", [f.key]: v === "__all__" ? undefined : v })}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder={f.placeholder || f.key} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部</SelectItem>
                {(f.options || []).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          {selectedIds && selectedIds.length > 0 && batchToolbar}
          <div className="ml-auto text-xs text-muted-foreground">
            共 <span className="font-medium text-foreground">{total}</span> 条 · 第 {page}/{totalPages} 页
          </div>
        </div>
      )}

      {rows.length > scrollThreshold ? (
        // 长列表（> scrollThreshold 行）：表体纵向滚动容器 + 粘性表头 —— 防止列表撑爆页面/页面被顶住无法滚动
        <div
          className="rounded-lg border bg-card overflow-y-auto overscroll-contain"
          style={{ maxHeight: scrollMaxHeight }}
        >
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="hover:bg-transparent [&_th]:bg-card">
                {selectEnabled && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(v) => {
                        if (!onSelectedChange) return
                        if (v) onSelectedChange([...new Set([...(selectedIds || []), ...rows.map((r) => r.id)])])
                        else onSelectedChange((selectedIds || []).filter((id) => !rows.some((r) => r.id === id)))
                      }}
                    />
                  </TableHead>
                )}
              {columns.map((c) => (
                <TableHead key={c.key} className={cn(c.className, c.width)} style={c.width ? { width: c.width } : undefined}>
                  {c.sortable && onQueryChange ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.title}
                      {sortField === c.key ? (
                        sortOrder === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.title
                  )}
                </TableHead>
              ))}
              {rowActions && <TableHead className="w-32 text-right">操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length + (rowActions ? 1 : 0) + (selectEnabled ? 1 : 0)} className="h-28 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Inbox className="h-8 w-8 opacity-30" />
                    {emptyText}
                  </div>
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className={dense ? "py-1" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: "pointer" } : undefined}
              >
                {selectEnabled && (
                  <TableCell onClick={onRowClick ? (e) => e.stopPropagation() : undefined}>
                    <Checkbox checked={!!selectedIds?.includes(row.id)} onCheckedChange={() => toggleRow(row.id)} />
                  </TableCell>
                )}
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(dense && "py-2", c.className)}>
                    {c.render ? c.render(row) : ((row as Record<string, unknown>)[c.key] as React.ReactNode) ?? "-"}
                  </TableCell>
                ))}
                {rowActions && (
                  <TableCell className="text-right" onClick={onRowClick ? (e) => e.stopPropagation() : undefined}>
                    {rowActions(row)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                {selectEnabled && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(v) => {
                        if (!onSelectedChange) return
                        if (v) onSelectedChange([...new Set([...(selectedIds || []), ...rows.map((r) => r.id)])])
                        else onSelectedChange((selectedIds || []).filter((id) => !rows.some((r) => r.id === id)))
                      }}
                    />
                  </TableHead>
                )}
                {columns.map((c) => (
                  <TableHead key={c.key} className={cn(c.className, c.width)} style={c.width ? { width: c.width } : undefined}>
                    {c.sortable && onQueryChange ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => toggleSort(c.key)}
                      >
                        {c.title}
                        {sortField === c.key ? (
                          sortOrder === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      c.title
                    )}
                  </TableHead>
                ))}
                {rowActions && <TableHead className="w-32 text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length + (rowActions ? 1 : 0) + (selectEnabled ? 1 : 0)} className="h-28 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <Inbox className="h-8 w-8 opacity-30" />
                      {emptyText}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={dense ? "py-1" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: "pointer" } : undefined}
                >
                  {selectEnabled && (
                    <TableCell onClick={onRowClick ? (e) => e.stopPropagation() : undefined}>
                      <Checkbox checked={!!selectedIds?.includes(row.id)} onCheckedChange={() => toggleRow(row.id)} />
                    </TableCell>
                  )}
                  {columns.map((c) => (
                    <TableCell key={c.key} className={cn(dense && "py-2", c.className)}>
                      {c.render ? c.render(row) : ((row as Record<string, unknown>)[c.key] as React.ReactNode) ?? "-"}
                    </TableCell>
                  ))}
                  {rowActions && (
                    <TableCell className="text-right" onClick={onRowClick ? (e) => e.stopPropagation() : undefined}>
                      {rowActions(row)}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => pushQuery({ page: "1" })} title="跳到第一页">
            <ChevronFirst className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => pushQuery({ page: String(Math.max(1, page - 1)) })}>
            上一页
          </Button>
          {/* r23：页码组（当前页±2，长列表折叠为省略号；点击直达） */}
          <div className="flex items-center gap-1">
            {pageNumbers(page, totalPages).map((n, i) =>
              n === -1 ? (
                <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground select-none">…</span>
              ) : (
                <button
                  key={n}
                  type="button"
                  className={cn(
                    "h-8 min-w-8 px-2 rounded-md border text-xs transition-colors",
                    n === page
                      ? "bg-primary text-primary-foreground border-primary font-medium"
                      : "bg-background hover:bg-muted border-input",
                  )}
                  onClick={() => pushQuery({ page: String(n) })}
                  aria-label={`第 ${n} 页`}
                  aria-current={n === page ? "page" : undefined}
                >
                  {n}
                </button>
              )
            )}
          </div>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => pushQuery({ page: String(Math.min(totalPages, page + 1)) })}>
            下一页
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => pushQuery({ page: String(totalPages) })} title="跳到最后一页">
            <ChevronLast className="h-4 w-4" />
          </Button>
          {/* r23：指定页跳转 */}
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              const v = Number((e.currentTarget.elements.namedItem("jumpPage") as HTMLInputElement | null)?.value)
              if (Number.isInteger(v) && v >= 1 && v <= totalPages && v !== page) pushQuery({ page: String(v) })
            }}
          >
            <Input
              name="jumpPage"
              type="number"
              min={1}
              max={totalPages}
              defaultValue={page}
              key={`jump-${page}`}
              className="h-8 w-16 text-xs"
              title={`跳转到指定页（1-${totalPages}）`}
              aria-label="跳转到指定页"
            />
            <Button type="submit" variant="outline" size="sm" className="h-8" title="跳转">跳转</Button>
          </form>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => pushQuery({ pageSize: v, page: "1" })}
          >
            <SelectTrigger className="w-24 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 条/页
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}

// r23：分页页码组（当前页 ±2；总页数多时首尾保留 + 省略号折叠；-1 = 省略号占位）
function pageNumbers(page: number, totalPages: number): number[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out: number[] = []
  const push = (n: number) => out.push(n)
  const gap = () => out.push(-1)
  const start = Math.max(2, page - 2)
  const end = Math.min(totalPages - 1, page + 2)
  push(1)
  if (start > 2) gap()
  for (let n = start; n <= end; n++) push(n)
  if (end < totalPages - 1) gap()
  push(totalPages)
  return out
}

// 状态标签：颜色语义统一
export function StatusBadge({ status, map }: { status: string; map?: Record<string, "default" | "secondary" | "destructive" | "outline" | "success"> }) {
  const defaultMap: Record<string, "default" | "secondary" | "destructive" | "outline" | "success"> = {
    RUNNING: "success",
    ACTIVE: "success",
    ONLINE: "success",
    HEALTHY: "success",
    SUCCESS: "success",
    INFO: "secondary",
    IDLE: "secondary",
    CREATING: "default",
    RELOADING: "default",
    PENDING: "secondary",
    WARN: "default",
    DEGRADED: "default",
    WARNED: "default",
    STOPPED: "outline",
    DISABLED: "outline",
    EXPIRED: "outline",
    ISOLATED: "destructive",
    ERROR: "destructive",
    FAILED: "destructive",
    CRASHED: "destructive",
    CRITICAL: "destructive",
    DESTROYED: "outline",
    FROZEN: "destructive",
  }
  const tone = (map || defaultMap)[status] || "secondary"
  return (
    <Badge
      variant={tone === "success" ? "default" : tone === "destructive" ? "destructive" : tone === "outline" ? "outline" : "secondary"}
      className={cn(tone === "success" && "bg-emerald-600 hover:bg-emerald-600")}
    >
      {status}
    </Badge>
  )
}
