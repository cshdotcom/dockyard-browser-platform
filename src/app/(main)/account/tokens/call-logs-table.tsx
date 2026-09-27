"use client"

// 令牌调用日志：路径 / 方法 / 状态码 / 耗时 / 当时是否已过期 / 时间 / 来源 IP

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { DataTable } from "@/components/shared/data-table"
import { Badge } from "@/components/ui/badge"

export interface CallLogRow {
  id: string
  path: string
  method: string
  status: number
  durationMs: number
  wasExpired: boolean
  ip: string | null
  tokenName: string
  createdAt: string
}

const METHOD_COLOR: Record<string, string> = {
  GET: "text-emerald-600",
  POST: "text-teal-600",
  PUT: "text-amber-600",
  PATCH: "text-amber-600",
  DELETE: "text-red-600",
}

interface CallLogsTableProps {
  rows: CallLogRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  tokenOptions: { id: string; name: string }[]
}

export function CallLogsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, tokenOptions }: CallLogsTableProps) {
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

  const columns = [
    {
      key: "tokenName",
      title: "令牌",
      render: (row: CallLogRow) => <span className="text-sm font-medium">{row.tokenName}</span>,
    },
    {
      key: "method",
      title: "方法",
      render: (row: CallLogRow) => (
        <span className={`text-xs font-semibold font-mono ${METHOD_COLOR[row.method] || ""}`}>{row.method}</span>
      ),
    },
    {
      key: "path",
      title: "请求路径",
      render: (row: CallLogRow) => <code className="text-xs font-mono break-all">{row.path}</code>,
    },
    {
      key: "status",
      title: "状态码",
      sortable: true,
      render: (row: CallLogRow) => (
        <span
          className={
            row.status >= 500
              ? "text-red-600 font-semibold tabular-nums"
              : row.status >= 400
                ? "text-orange-600 font-semibold tabular-nums"
                : "text-emerald-600 font-semibold tabular-nums"
          }
        >
          {row.status}
        </span>
      ),
    },
    {
      key: "durationMs",
      title: "耗时",
      sortable: true,
      render: (row: CallLogRow) => (
        <span className={`text-sm tabular-nums ${row.durationMs > 1000 ? "text-amber-600" : ""}`}>{row.durationMs} ms</span>
      ),
    },
    {
      key: "wasExpired",
      title: "当时已过期",
      render: (row: CallLogRow) =>
        row.wasExpired ? <Badge variant="destructive" className="text-xs">已过期</Badge> : <span className="text-xs text-muted-foreground">—</span>,
    },
    { key: "ip", title: "来源 IP", render: (row: CallLogRow) => <span className="text-xs font-mono">{row.ip || "-"}</span> },
    { key: "createdAt", title: "调用时间", sortable: true, render: (row: CallLogRow) => <span className="text-sm">{row.createdAt}</span> },
  ]

  return (
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
          key: "tokenId",
          placeholder: "按令牌筛选",
          options: tokenOptions.map((t) => ({ label: t.name, value: t.id })),
        },
      ]}
      onQueryChange={pushQuery}
      emptyText="暂无调用记录"
      dense
    />
  )
}
