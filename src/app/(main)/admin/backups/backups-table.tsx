"use client"

// 备份恢复交互：立即备份 / 下载 / 恢复（强确认 RESTORE）/ 保留策略说明 + 风险提示

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, DatabaseBackup, Download, Loader2, ListChecks, RotateCcw, ShieldAlert } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { createBackupAction, restoreBackupAction, type RestoreBackupResult, type CreateBackupResult } from "@/server/actions/backups"

export interface BackupRow {
  id: string
  fileMetaId: string
  fileName: string
  fileDeleted: boolean
  type: string
  encrypted: boolean
  sizeBytes: number
  sizeText: string
  checksum: string | null
  status: string
  createdByUserId: string | null
  creatorName: string
  createdAt: string
}

interface BackupsTableProps {
  rows: BackupRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  canRestore: boolean
  retentionCount: number
  oldCount: number
}

export function BackupsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, canRestore, retentionCount, oldCount }: BackupsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [backupOpen, setBackupOpen] = React.useState(false)
  const [restoreTarget, setRestoreTarget] = React.useState<BackupRow | null>(null)
  const [restoreResult, setRestoreResult] = React.useState<RestoreBackupResult | null>(null)
  const [backupResult, setBackupResult] = React.useState<CreateBackupResult | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const runBackup = async () => {
    setBusy("backup")
    try {
      const res = await createBackupAction({ confirm: true })
      if (res.code === 0 && res.data) {
        setBackupResult(res.data)
        toast.success(`备份完成：${res.data.fileName}（${res.data.sizeBytes} 字节，耗时 ${res.data.durationMs}ms）`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "备份失败")
    } finally {
      setBusy("")
      setBackupOpen(false)
    }
  }

  const runRestore = async () => {
    if (!restoreTarget) return
    setBusy(`restore:${restoreTarget.id}`)
    try {
      const res = await restoreBackupAction({ backupId: restoreTarget.id })
      if (res.code === 0 && res.data) {
        setRestoreResult(res.data)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "恢复失败")
    } finally {
      setBusy("")
      setRestoreTarget(null)
    }
  }

  const download = (row: BackupRow) => {
    window.open(`/api/files/download?id=${encodeURIComponent(row.fileMetaId)}`, "_blank")
  }

  return (
    <div className="space-y-6">
      {/* 保留策略 + 恢复风险提示 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-teal-600" />
            <span className="font-medium">备份保留策略</span>
          </div>
          <p className="text-sm text-muted-foreground">
            当前保留份数 <span className="font-medium text-foreground">{retentionCount}</span> 份（backup.retentionCount）。定时任务
            <span className="font-mono mx-1 text-xs bg-muted px-1 py-0.5 rounded">db_backup</span>
            会在每次备份后按保留份数自动清理最旧备份；当前已有
            <span className={oldCount > 0 ? "text-amber-600 font-medium" : "text-foreground font-medium"}> {oldCount} </span>
            份超出保留策略的旧备份等待清理。
          </p>
        </div>
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>恢复操作风险提示（高危）</AlertTitle>
          <AlertDescription>
            <p>恢复过程：① 自动临时备份 → ② 开启维护模式 → ③ 备份内容写回数据库文件（清除 WAL/SHM） → ④ 关闭维护模式 → ⑤ CRITICAL 审计。</p>
            <p className="mt-1">恢复将使当前数据库回到备份时刻的状态（备份之后产生的全部数据会丢失）。恢复完成后需<strong>重启服务</strong>使数据库连接完全重建。仅超级管理员可执行。</p>
          </AlertDescription>
        </Alert>
      </div>

      {/* 操作区 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button onClick={() => setBackupOpen(true)} disabled={busy === "backup"}>
            {busy === "backup" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <DatabaseBackup className="mr-1 h-4 w-4" />}
            立即备份
          </Button>
          <p className="text-xs text-muted-foreground">将 SQLite 数据库文件完整复制到 storage/backups/（按配置可选 AES-256-GCM 加密）</p>
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
          { key: "type", placeholder: "备份类型", options: [{ label: "全量 FULL", value: "FULL" }, { label: "部分 PARTIAL", value: "PARTIAL" }] },
          {
            key: "status",
            placeholder: "状态",
            options: [
              { label: "成功", value: "SUCCESS" },
              { label: "失败", value: "FAILED" },
              { label: "恢复中", value: "RESTORING" },
            ],
          },
        ]}
        emptyText="暂无备份记录（点击「立即备份」创建第一份全量备份）"
        columns={[
          {
            key: "fileName",
            title: "备份文件",
            render: (r) => (
              <div className="min-w-0">
                <p className="text-sm font-mono font-medium truncate max-w-56" title={r.fileName}>{r.fileName}</p>
                {r.fileDeleted && <Badge variant="destructive" className="text-[10px] mt-0.5">文件元数据已软删</Badge>}
              </div>
            ),
          },
          {
            key: "type",
            title: "类型",
            render: (r) => <Badge variant={r.type === "FULL" ? "default" : "secondary"} className={r.type === "FULL" ? "bg-teal-600 hover:bg-teal-600" : ""}>{r.type === "FULL" ? "全量" : "临时/部分"}</Badge>,
          },
          { key: "sizeText", title: "大小", sortable: false, render: (r) => <span className="tabular-nums text-sm">{r.sizeText}</span> },
          {
            key: "encrypted",
            title: "加密",
            render: (r) =>
              r.encrypted ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-[10px]">AES-256-GCM</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">明文</Badge>
              ),
          },
          { key: "status", title: "状态", render: (r) => <StatusBadge status={r.status} /> },
          { key: "creatorName", title: "创建人", render: (r) => <span className="text-sm">{r.creatorName}</span> },
          {
            key: "checksum",
            title: "校验和(SHA256)",
            render: (r) => (
              <span className="font-mono text-[10px] text-muted-foreground" title={r.checksum || ""}>
                {r.checksum ? r.checksum.slice(0, 16) + "…" : "-"}
              </span>
            ),
          },
          { key: "createdAt", title: "创建时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span> },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => download(r)} disabled={r.fileDeleted} aria-label={`下载 ${r.fileName}`}>
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={() => setRestoreTarget(r)}
              disabled={!canRestore || r.fileDeleted || r.status !== "SUCCESS"}
              title={canRestore ? "恢复此备份" : "仅超级管理员可恢复"}
              aria-label={`恢复 ${r.fileName}`}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        )}
      />

      {/* 立即备份确认 */}
      <ConfirmDialog
        open={backupOpen}
        onOpenChange={(v) => !v && setBackupOpen(false)}
        title="立即执行全量备份"
        description="将读取当前 SQLite 数据库文件并复制到 storage/backups/ 目录（若 backup.encrypt 开启则 AES-256-GCM 加密落盘），同时登记文件元数据与备份记录并写入审计。备份期间业务不中断。"
        confirmText="开始备份"
        loading={busy === "backup"}
        onConfirm={runBackup}
      />

      {/* 恢复强确认（requirePhrase=RESTORE） */}
      <ConfirmDialog
        open={!!restoreTarget}
        onOpenChange={(v) => !v && !busy && setRestoreTarget(null)}
        title="恢复数据库（不可轻易撤销）"
        destructive
        requirePhrase="RESTORE"
        confirmText="确认恢复"
        loading={busy.startsWith("restore:")}
        description={`将把数据库恢复到备份「${restoreTarget?.fileName}」（${restoreTarget?.sizeText}${restoreTarget?.encrypted ? "，加密备份将先解密" : ""}）时刻。\n\n· 恢复前会自动做一次临时备份兜底\n· 恢复期间自动开启/关闭维护模式\n· 备份之后产生的全部数据将丢失\n· 恢复后需重启服务才能完全生效\n· 全程 CRITICAL 审计留痕`}
        onConfirm={runRestore}
      />

      {/* 备份结果 */}
      <Dialog open={!!backupResult} onOpenChange={(v) => !v && setBackupResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DatabaseBackup className="h-4 w-4 text-teal-600" />
              备份完成
            </DialogTitle>
            <DialogDescription>备份文件已写入 storage/backups/ 并登记元数据。</DialogDescription>
          </DialogHeader>
          {backupResult && (
            <div className="rounded-md bg-muted p-3 text-sm space-y-1 font-mono text-xs">
              <p><span className="text-muted-foreground">文件：</span>{backupResult.fileName}</p>
              <p><span className="text-muted-foreground">大小：</span>{backupResult.sizeBytes} 字节</p>
              <p><span className="text-muted-foreground">加密：</span>{backupResult.encrypted ? "AES-256-GCM" : "明文"}</p>
              <p><span className="text-muted-foreground">耗时：</span>{backupResult.durationMs} ms</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBackupResult(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 恢复结果（步骤进度 + 重启提示） */}
      <Dialog open={!!restoreResult} onOpenChange={(v) => !v && setRestoreResult(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              恢复执行结果
            </DialogTitle>
            <DialogDescription>恢复流程已完成，逐步进度如下：</DialogDescription>
          </DialogHeader>
          {restoreResult && (
            <div className="space-y-3">
              <ol className="space-y-1.5 text-sm list-decimal list-inside">
                {restoreResult.steps.map((s, i) => (
                  <li key={i} className="text-sm">{s}</li>
                ))}
              </ol>
              <div className="rounded-md bg-muted p-3 text-xs space-y-1 font-mono">
                <p><span className="text-muted-foreground">恢复来源：</span>{restoreResult.fileName}</p>
                <p><span className="text-muted-foreground">写回字节数：</span>{restoreResult.sizeBytes}</p>
                <p>
                  <span className="text-muted-foreground">校验和比对：</span>
                  {restoreResult.checksumMatch === null ? "备份记录无校验和（跳过）" : restoreResult.checksumMatch ? "一致 ✓" : "不一致 ✗（请立即核查）"}
                </p>
                <p><span className="text-muted-foreground">临时备份：</span>{restoreResult.tempBackupFile}</p>
              </div>
              <Alert variant="destructive">
                <ShieldAlert className="h-4 w-4" />
                <AlertTitle>需要重启服务生效</AlertTitle>
                <AlertDescription>
                  数据库文件已被替换为备份内容，正在运行的数据库连接仍指向旧内存页。请重启平台服务（重启后登录会话可能失效，需重新登录）。
                </AlertDescription>
              </Alert>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreResult(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
