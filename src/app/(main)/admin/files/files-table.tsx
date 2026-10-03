"use client"

// 文件列表交互：下载 / 病毒扫描 / 立即过期 / 软删除（入回收站）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Download, Loader2, MoreHorizontal, ShieldCheck, TimerOff, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { deleteFileAction, expireFileAction } from "@/server/actions/files"

export interface FileRow {
  id: string
  fileName: string
  size: number
  sizeText: string
  category: string
  userId: string | null
  username: string | null
  workspaceId: string | null
  expireAt: string | null
  expired: boolean
  virusScanned: boolean
  createdAt: string
}

const CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "普通文件",
  PROFILE: "配置档案",
  BACKUP: "数据库备份",
  SNAPSHOT: "环境快照",
  LOG: "日志",
  REPORT: "报表",
}

interface FilesTableProps {
  rows: FileRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  userOptions: { label: string; value: string }[]
}

export function FilesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, userOptions }: FilesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [expireTarget, setExpireTarget] = React.useState<FileRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<FileRow | null>(null)

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  const runScan = async (row: FileRow) => {
    setBusy(`${row.id}:scan`)
    try {
      const res = await fetch("/api/files/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: row.id }),
      })
      const json = (await res.json()) as { code: number; msg: string }
      if (json.code === 0) {
        toast.success(json.msg || "扫描完成")
        router.refresh()
      } else {
        toast.error(json.msg || "扫描失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "扫描失败")
    } finally {
      setBusy("")
    }
  }

  const download = (row: FileRow) => {
    window.open(`/api/files/download?id=${encodeURIComponent(row.id)}`, "_blank")
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
            key: "category",
            placeholder: "文件类型",
            options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ label, value })),
          },
          { key: "userId", placeholder: "上传用户", options: userOptions },
        ]}
        emptyText="暂无文件（可在上方上传组件添加）"
        columns={[
          {
            key: "fileName",
            title: "文件名",
            sortable: true,
            render: (r) => (
              <div className="min-w-0">
                <p className="text-sm font-medium truncate max-w-56" title={r.fileName}>{r.fileName}</p>
                <p className="text-[10px] text-muted-foreground font-mono truncate max-w-56">{r.id}</p>
              </div>
            ),
          },
          {
            key: "size",
            title: "大小",
            sortable: true,
            render: (r) => <span className="tabular-nums text-sm">{r.sizeText}</span>,
          },
          {
            key: "category",
            title: "类型",
            render: (r) => (
              <Badge variant={r.category === "BACKUP" ? "default" : "secondary"} className={r.category === "BACKUP" ? "bg-teal-600 hover:bg-teal-600" : ""}>
                {CATEGORY_LABEL[r.category] || r.category}
              </Badge>
            ),
          },
          {
            key: "username",
            title: "上传用户",
            render: (r) => (
              r.userId ? (
                // r31：点击归属 → 自动筛选该用户文件（统一“归属点击筛选”交互）
                <button
                  type="button"
                  className="text-sm hover:text-teal-600 hover:underline"
                  title={`点击筛选 ${r.username || r.userId} 的全部文件`}
                  onClick={() => pushQuery({ page: "1", userId: r.userId! })}
                >
                  {r.username || "-"}
                </button>
              ) : (
                <span className="text-sm">{r.username || "-"}</span>
              )
            ),
          },
          {
            key: "workspaceId",
            title: "关联工作区",
            render: (r) =>
              r.workspaceId ? (
                <span className="font-mono text-[10px] text-muted-foreground truncate block max-w-32" title={r.workspaceId}>{r.workspaceId}</span>
              ) : (
                <span className="text-muted-foreground text-xs">-</span>
              ),
          },
          {
            key: "expireAt",
            title: "过期时间",
            sortable: true,
            render: (r) => (
              <span className={`text-xs tabular-nums ${r.expired ? "text-red-600 font-medium" : ""}`}>
                {r.expired ? `${r.expireAt}（已过期）` : r.expireAt || "永久"}
              </span>
            ),
          },
          {
            key: "virusScanned",
            title: "病毒扫描",
            render: (r) =>
              r.virusScanned ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-[10px]">已扫描</Badge>
              ) : (
                <Badge variant="outline" className="text-amber-600 border-amber-200 text-[10px]">未扫描</Badge>
              ),
          },
          {
            key: "createdAt",
            title: "上传时间",
            sortable: true,
            render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span>,
          },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => download(r)} aria-label={`下载 ${r.fileName}`}>
              <Download className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="更多操作">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!r.virusScanned && (
                  <DropdownMenuItem onClick={() => runScan(r)} disabled={busy === `${r.id}:scan`}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    病毒扫描
                    {busy === `${r.id}:scan` && <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" />}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setExpireTarget(r)} disabled={r.expired}>
                  <TimerOff className="mr-2 h-4 w-4" />
                  立即过期
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600" onClick={() => setDeleteTarget(r)}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除（入回收站）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      />

      {/* 立即过期确认 */}
      <ConfirmDialog
        open={!!expireTarget}
        onOpenChange={(v) => !v && setExpireTarget(null)}
        title="立即过期该文件"
        description={`将把「${expireTarget?.fileName}」的过期时间设为当前时刻，文件过期清理任务（file_expire_clean）将在下个周期将其软删回收。`}
        confirmText="设为过期"
        loading={busy === "expire"}
        onConfirm={async () => {
          if (expireTarget) await callAction("expire", () => expireFileAction({ fileId: expireTarget.id }))
          setExpireTarget(null)
        }}
      />

      {/* 删除确认（软删除入回收站） */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除文件（软删除）"
        destructive
        requirePhrase="DELETE"
        description={`确认删除「${deleteTarget?.fileName}」？\n文件将进入回收站（保留期后物理清除），审计全程留痕。`}
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (deleteTarget) await callAction("delete", () => deleteFileAction({ fileId: deleteTarget.id, reason: "管理员文件管理删除" }))
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
