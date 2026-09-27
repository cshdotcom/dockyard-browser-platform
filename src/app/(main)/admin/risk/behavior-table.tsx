"use client"

// 行为画像交互表格：riskTriggers>0 红色高亮 / 排序

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { DataTable } from "@/components/shared/data-table"
import { Badge } from "@/components/ui/badge"
import { TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { MoreHorizontal, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export interface BehaviorRow {
  id: string
  userId: string
  username: string
  role: string
  enabled: boolean
  resourcesCreated: number
  resourcesDeleted: number
  resourcesRestored: number
  mcpCalls: number
  vncDurationMin: number
  batchOps: number
  abnormalOps: number
  riskTriggers: number
  updatedAt: string
}

interface Props {
  rows: BehaviorRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "超管",
  ADMIN: "管理员",
  GROUP_ADMIN: "组管理员",
  USER: "用户",
}

interface Column {
  key: string
  title: string
  sortable?: boolean
  render: (row: BehaviorRow) => React.ReactNode
}

export function BehaviorTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
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

  const columns: Column[] = [
    {
      key: "username",
      title: "用户",
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium">{row.username}</p>
          <p className="text-xs text-muted-foreground">{ROLE_LABEL[row.role] || row.role}{!row.enabled && " · 已禁用"}</p>
        </div>
      ),
    },
    { key: "resourcesCreated", title: "创建数", sortable: true, render: (row) => <span className="tabular-nums">{row.resourcesCreated}</span> },
    { key: "resourcesDeleted", title: "删除数", sortable: true, render: (row) => <span className="tabular-nums">{row.resourcesDeleted}</span> },
    { key: "resourcesRestored", title: "恢复数", sortable: true, render: (row) => <span className="tabular-nums">{row.resourcesRestored}</span> },
    { key: "mcpCalls", title: "MCP 调用", sortable: true, render: (row) => <span className="tabular-nums">{row.mcpCalls}</span> },
    {
      key: "vncDurationMin",
      title: "VNC 时长(分)",
      sortable: true,
      render: (row) => <span className="tabular-nums">{Math.round(row.vncDurationMin * 10) / 10}</span>,
    },
    { key: "batchOps", title: "批量操作", sortable: true, render: (row) => <span className="tabular-nums">{row.batchOps}</span> },
    {
      key: "abnormalOps",
      title: "异常操作",
      sortable: true,
      render: (row) => (
        <span className={`tabular-nums ${row.abnormalOps > 0 ? "text-amber-600 font-medium" : ""}`}>{row.abnormalOps}</span>
      ),
    },
    {
      key: "riskTriggers",
      title: "风控触发",
      sortable: true,
      render: (row) => (
        <Badge variant={row.riskTriggers > 0 ? "destructive" : "outline"} className="tabular-nums">
          {row.riskTriggers}
        </Badge>
      ),
    },
    { key: "updatedAt", title: "更新时间", sortable: true, render: (row) => <span className="text-xs text-muted-foreground">{row.updatedAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="用户行为画像">
            <thead>
              <tr className="border-b bg-muted/50">
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2.5 text-left font-medium text-xs text-muted-foreground whitespace-nowrap">
                    {c.sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() =>
                          pushQuery(
                            sortField === c.key
                              ? { sortOrder: sortOrder === "asc" ? "desc" : "asc" }
                              : { sortField: c.key, sortOrder: "asc" }
                          )
                        }
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
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="h-24 text-center text-muted-foreground">暂无行为画像数据</td>
                </tr>
              )}
              {rows.map((row) => (
                <TableRow key={row.id} className={cn("hover:bg-muted/30", row.riskTriggers > 0 && "bg-red-50 dark:bg-red-950/20")}>
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2.5 align-middle">
                      {c.render(row)}
                    </td>
                  ))}
                </TableRow>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const input = e.currentTarget.elements.namedItem("kw") as HTMLInputElement
              pushQuery({ page: "1", keyword: input.value })
            }}
          >
            <Input name="kw" defaultValue={keyword || ""} placeholder="搜索用户名" className="w-48" />
            <Button type="submit" variant="secondary" size="sm">搜索</Button>
          </form>
          <Select value={undefined} onValueChange={(v) => pushQuery({ page: "1", riskOnly: v === "__all__" ? undefined : v })}>
            <SelectTrigger className="w-40 h-9"><SelectValue placeholder="全部用户" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部用户</SelectItem>
              <SelectItem value="true">仅风控触发过</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium text-foreground">{total}</span> 条 · 第 {page}/{Math.max(1, Math.ceil(total / pageSize))} 页
            </span>
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => pushQuery({ page: String(page - 1) })}>上一页</Button>
            <Button variant="outline" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => pushQuery({ page: String(page + 1) })}>下一页</Button>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <MoreHorizontal className="h-3 w-3" />
        默认按风控触发次数降序；触发次数 &gt; 0 的用户整行红色高亮
      </p>
    </div>
  )
}
