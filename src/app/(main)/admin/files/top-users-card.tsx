"use client"

// 用户磁盘占用 Top10 卡片（fileMeta groupBy userId sum size）

import { HardDrive } from "lucide-react"
import { fmtBytesClient } from "./fmt"

export interface UserDiskRow {
  userId: string
  username: string
  totalSize: number
  totalSizeText: string
  fileCount: number
}

export function TopUsersCard({ rows, quotaMb }: { rows: UserDiskRow[]; quotaMb: number }) {
  const max = Math.max(...rows.map((r) => r.totalSize), 1)
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-teal-600" />
          <span className="font-medium">用户磁盘占用 Top10</span>
        </div>
        <span className="text-xs text-muted-foreground">单用户配额 {quotaMb}MB</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">暂无文件占用数据</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r, idx) => (
            <div key={r.userId} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="truncate">
                  <span className="text-muted-foreground text-xs tabular-nums mr-1.5">{idx + 1}.</span>
                  {r.username}
                  <span className="ml-1.5 text-xs text-muted-foreground">{r.fileCount} 个文件</span>
                </span>
                <span className="tabular-nums text-xs font-medium">{r.totalSizeText}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${r.totalSize > quotaMb * 1024 * 1024 * 0.9 ? "bg-red-500" : "bg-teal-600"}`}
                  style={{ width: `${Math.max(3, Math.round((r.totalSize / max) * 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground border-t pt-2">
        统计口径：未删除文件（deletedAt=null）按 userId 聚合 size 总和；占用接近配额 90% 时标红。
      </p>
    </div>
  )
}
