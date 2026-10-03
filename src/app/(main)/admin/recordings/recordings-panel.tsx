"use client"

// 录像管理面板（r27）：列表 / 回放播放器 / 下载 / 删除 / 备注 / 扫描 + 回收站页签
// 播放器：HTML5 <video>（src = 60 秒签名票据 URL；服务端 Range 流式 + RBAC）

import React, { useState, useTransition, useRef } from "react"
import Link from "next/link"
import {
  listRecordingsAction, playbackRecordingAction, deleteRecordingAction,
  restoreRecordingAction, purgeRecordingAction, noteRecordingAction, triggerRecordingScanAction,
  type RecordingRow,
} from "@/server/actions/recordings"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { WatermarkOverlay, PlaybackSpeedBar } from "@/components/recordings/watermark-overlay"
import type { PlaybackTicketInfo } from "@/server/actions/recordings"
import { toast } from "sonner"
import { Play, Download, Trash2, RotateCcw, StickyNote, RefreshCcw, Eye, EyeOff, Video, ArchiveRestore } from "lucide-react"
import { cn } from "@/lib/utils"

export interface RecycleEntryRow {
  recycleId: string
  recordingId: string
  resourceName: string
  reason: string | null
  deletedByType: string
  deletedAt: string
  purgeAt: string | null
  locked: boolean
  ownerUserId: string | null
}

const STATUS_MAP: Record<string, "default" | "secondary" | "destructive" | "outline" | "success"> = {
  RECORDING: "success",
  COMPLETED: "default",
  FAILED: "destructive",
}

export function RecordingsPanel({
  rows,
  recycleEntries,
  tab,
  status,
  keyword,
  canManage,
  userVisible,
  isSuper,
}: {
  rows: RecordingRow[]
  recycleEntries: RecycleEntryRow[]
  tab: "list" | "recycle"
  status: string
  keyword: string
  canManage: boolean
  userVisible: boolean
  isSuper: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [playRow, setPlayRow] = useState<RecordingRow | null>(null)
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [dlUrl, setDlUrl] = useState<string | null>(null)
  const [playTicket, setPlayTicket] = useState<PlaybackTicketInfo | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [noteRow, setNoteRow] = useState<RecordingRow | null>(null)
  const [noteText, setNoteText] = useState("")
  const [deleteRow, setDeleteRow] = useState<RecordingRow | null>(null)
  const [deleteReason, setDeleteReason] = useState("")

  // ---- 播放（签发票据 → 打开 <video> 播放器）----
  const openPlayback = (row: RecordingRow) => {
    startTransition(async () => {
      try {
        const res = await playbackRecordingAction({ id: row.id })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "回放票据签发失败")
        setPlayUrl(res.data.streamUrl)
        setDlUrl(res.data.downloadUrl)
        setPlayTicket(res.data)
        setPlayRow(row)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "回放失败")
      }
    })
  }

  const doDelete = () => {
    if (!deleteRow) return
    startTransition(async () => {
      try {
        const res = await deleteRecordingAction({ id: deleteRow.id, reason: deleteReason || undefined })
        if (res.code !== 0) throw new Error(res.msg || "删除失败")
        toast.success(`已入录像回收站（30 天内可恢复）`)
        setDeleteRow(null)
        setDeleteReason("")
        window.location.reload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "删除失败")
      }
    })
  }

  const doRestore = (e: RecycleEntryRow) => {
    startTransition(async () => {
      try {
        const res = await restoreRecordingAction({ id: e.recordingId })
        if (res.code !== 0) throw new Error(res.msg || "恢复失败")
        toast.success("录像已从回收站恢复")
        window.location.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "恢复失败")
      }
    })
  }

  const doPurge = (e: RecycleEntryRow) => {
    if (!confirm(`物理清除「${e.resourceName}」？文件与记录将彻底删除，不可恢复。`)) return
    startTransition(async () => {
      try {
        const res = await purgeRecordingAction({ id: e.recordingId })
        if (res.code !== 0) throw new Error(res.msg || "清除失败")
        toast.success(`已物理清除（释放 ${((res.data?.freedBytes || 0) / 1024 / 1024).toFixed(1)}MB）`)
        window.location.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "清除失败")
      }
    })
  }

  const doScan = () => {
    startTransition(async () => {
      try {
        const res = await triggerRecordingScanAction()
        if (res.code !== 0) throw new Error(res.msg || "扫描失败")
        toast.success(`扫描完成：${res.data?.sessions ?? 0} 个会话（终结 ${res.data?.terminated ?? 0}）`)
        window.location.reload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "扫描失败")
      }
    })
  }

  const saveNote = () => {
    if (!noteRow) return
    startTransition(async () => {
      try {
        const res = await noteRecordingAction({ id: noteRow.id, note: noteText })
        if (res.code !== 0) throw new Error(res.msg || "保存失败")
        toast.success("取证备注已保存")
        setNoteRow(null)
        window.location.reload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败")
      }
    })
  }

  const columns = [
    {
      key: "workspace",
      title: "工作区 / 用户",
      render: (r: RecordingRow) => (
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{r.workspaceName}</p>
          <p className="text-xs text-muted-foreground truncate">
            {r.username || "-"} · 会话 {r.sessionId.slice(0, 14)}… · 第 {r.segmentIndex + 1}/{r.totalSegments} 段
          </p>
        </div>
      ),
    },
    {
      key: "status",
      title: "状态",
      width: "110px",
      render: (r: RecordingRow) => (
        <div className="space-y-1">
          <StatusBadge status={r.status} map={STATUS_MAP} />
          <p className="text-[10px] text-muted-foreground">{r.policySource || "-"}</p>
        </div>
      ),
    },
    {
      key: "startedAt",
      title: "开始时间",
      sortable: true,
      render: (r: RecordingRow) => <span className="text-xs tabular-nums">{new Date(r.startedAt).toLocaleString("zh-CN")}</span>,
    },
    {
      key: "durationSec",
      title: "时长 / 大小",
      render: (r: RecordingRow) => (
        <div className="text-xs tabular-nums">
          <p>{r.durationSec > 0 ? fmtDur(r.durationSec) : r.status === "RECORDING" ? "录制中…" : "-"}</p>
          <p className="text-muted-foreground">{fmtBytes(r.sizeBytes)} · {r.resolution || "-"} · {r.fps}fps</p>
        </div>
      ),
    },
    {
      key: "views",
      title: "回放 / 下载",
      width: "100px",
      render: (r: RecordingRow) => (
        <div className="text-xs tabular-nums text-muted-foreground">
          <p><Play className="inline h-3 w-3 mr-1" />{r.viewCount} · <Download className="inline h-3 w-3 mr-1" />{r.downloadCount}</p>
          {r.note && <p className="truncate text-amber-600 dark:text-amber-400 mt-0.5" title={r.note}>取证备注</p>}
        </div>
      ),
    },
  ]

  const rowActions = (r: RecordingRow) => (
    <div className="flex items-center gap-1">
      {r.fileReady && (
        <Button variant="ghost" size="sm" onClick={() => openPlayback(r)} disabled={pending} title="回放">
          <Play className="h-4 w-4 text-teal-600" />
        </Button>
      )}
      {r.fileReady && (
        <Button variant="ghost" size="sm" onClick={() => startDownload(r)} disabled={pending} title="下载归档">
          <Download className="h-4 w-4 text-blue-600" />
        </Button>
      )}
      {canManage && r.status !== "RECORDING" && (
        <>
          <Button variant="ghost" size="sm" onClick={() => { setNoteRow(r); setNoteText(r.note || "") }} title="取证备注">
            <StickyNote className="h-4 w-4 text-amber-600" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleteRow(r)} title="删除入回收站">
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        </>
      )}
    </div>
  )

  const startDownload = (r: RecordingRow) => {
    startTransition(async () => {
      try {
        const res = await playbackRecordingAction({ id: r.id })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "下载票据签发失败")
        if (!res.data.downloadUrl) throw new Error("策略禁止导出该录像（仅允许在线回放）")
        window.open(res.data.downloadUrl, "_blank")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "下载失败")
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b">
        <Link
          href={`/admin/recordings?tab=list&status=${status}&q=${encodeURIComponent(keyword)}`}
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "list" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          录像列表
        </Link>
        <Link
          href="/admin/recordings?tab=recycle"
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
            tab === "recycle" ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          回放回收站（{recycleEntries.length}）
        </Link>
        <div className="ml-auto flex items-center gap-2 pb-1">
          {isSuper && (
            <Button variant="outline" size="sm" onClick={() => window.location.href = "/admin/feature-flags"}>
              <Video className="h-4 w-4 mr-1" />录像功能开关
            </Button>
          )}
          {canManage && (
            <Button variant="outline" size="sm" onClick={doScan} disabled={pending}>
              <RefreshCcw className={cn("h-4 w-4 mr-1", pending && "animate-spin")} />立即扫描
            </Button>
          )}
        </div>
      </div>

      {tab === "list" ? (
        <>
          {userVisible ? (
            <p className="text-xs text-muted-foreground">
              用户空间「我的录像」页对用户开放可见（可在功能开关中关闭 vnc.recordingUserVisible）
            </p>
          ) : (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <EyeOff className="h-3 w-3" />用户端录像可见性已关闭：仅管理后台可回放
            </p>
          )}
          <DataTable
            columns={columns}
            rows={rows}
            total={rows.length}
            page={1}
            pageSize={Math.max(rows.length, 1)}
            keyword={keyword}
            filters={[
              {
                key: "status",
                placeholder: "状态",
                type: "select",
                options: [
                  { label: "全部", value: "ALL" },
                  { label: "录制中", value: "RECORDING" },
                  { label: "已完成", value: "COMPLETED" },
                  { label: "失败", value: "FAILED" },
                ],
              },
            ]}
            onQueryChange={(params) => {
              const us = new URLSearchParams()
              us.set("tab", "list")
              if (params.keyword !== undefined) us.set("q", params.keyword)
              if (params.status) us.set("status", params.status)
              window.location.href = `/admin/recordings?${us.toString()}`
            }}
            rowActions={rowActions}
            emptyText="暂无录像（策略未开启或尚无完成的会话）"
            dense
          />
        </>
      ) : (
        <DataTable
          columns={[
            {
              key: "resourceName",
              title: "录像（回收站）",
              render: (e: RecycleEntryRow) => (
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{e.resourceName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {e.reason || "无删除原因"} · {e.deletedByType}
                  </p>
                </div>
              ),
            },
            {
              key: "deletedAt",
              title: "删除时间",
              render: (e: RecycleEntryRow) => <span className="text-xs tabular-nums">{new Date(e.deletedAt).toLocaleString("zh-CN")}</span>,
            },
            {
              key: "purgeAt",
              title: "计划清除",
              render: (e: RecycleEntryRow) => (
                <span className="text-xs tabular-nums">{e.purgeAt ? new Date(e.purgeAt).toLocaleDateString("zh-CN") : "—"}</span>
              ),
            },
          ]}
          rows={recycleEntries.map((e) => ({ ...e, id: e.recycleId }))}
          total={recycleEntries.length}
          page={1}
          pageSize={Math.max(recycleEntries.length, 1)}
          rowActions={(e: RecycleEntryRow) =>
            canManage ? (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => doRestore(e)} disabled={pending || e.locked} title={e.locked ? "已锁定" : "恢复"}>
                  <RotateCcw className={cn("h-4 w-4", e.locked ? "text-muted-foreground" : "text-teal-600")} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => doPurge(e)} disabled={pending || e.locked} title={e.locked ? "已锁定" : "物理清除"}>
                  <Trash2 className="h-4 w-4 text-red-600" />
                </Button>
              </div>
            ) : null
          }
          emptyText="回收站为空"
          dense
        />
      )}

      {/* ---- 播放器弹窗（HTML5 video + 签名票据流）---- */}
      <Dialog open={!!playRow} onOpenChange={(o) => !o && setPlayRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="h-4 w-4 text-teal-600" />
              {playRow?.workspaceName} · 第 {(playRow?.segmentIndex ?? 0) + 1} 段回放
            </DialogTitle>
            <DialogDescription>
              {playRow?.username} · {playRow && new Date(playRow.startedAt).toLocaleString("zh-CN")} ·{" "}
              {playRow && fmtDur(playRow.durationSec)} · {playRow && fmtBytes(playRow.sizeBytes)} · {playRow?.resolution} · {playRow?.fps}fps
            </DialogDescription>
          </DialogHeader>
          <div className="relative rounded-lg overflow-hidden bg-black">
            <video
              key={playUrl || "none"}
              ref={videoRef}
              src={playUrl || undefined}
              controls
              autoPlay
              className="w-full max-h-[60vh]"
              preload="metadata"
              controlsList="nodownload"
              disablePictureInPicture
            />
            {playTicket && (
              <WatermarkOverlay
                mode={playTicket.watermark}
                viewerName={playTicket.viewerName}
                workspaceName={playTicket.workspaceName}
                serverNow={playTicket.serverNow}
                serverTz={playTicket.serverTz}
              />
            )}
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <PlaybackSpeedBar videoRef={videoRef} />
            {playTicket && (
              <div className="text-xs text-muted-foreground">
                水印策略：{playTicket.watermark === "force" ? "强制开启" : playTicket.watermark === "on" ? "默认开启（可临时关闭）" : "关闭"}（来源 {playTicket.watermarkSource}）· 服务器时间 {playTicket.serverTz}
              </div>
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <p className="text-xs text-muted-foreground">回放与下载均已审计留痕（RECORDING_VIEW / RECORDING_DOWNLOAD）</p>
            <div className="flex gap-2">
              {dlUrl && (
                <Button variant="secondary" onClick={() => window.open(dlUrl, "_blank")}>
                  <Download className="h-4 w-4 mr-1" />下载归档
                </Button>
              )}
              <Button variant="outline" onClick={() => setPlayRow(null)}>关闭</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 删除确认 ---- */}
      <Dialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除录像入回收站</DialogTitle>
            <DialogDescription>
              「{deleteRow?.workspaceName}」第 {(deleteRow?.segmentIndex ?? 0) + 1} 段 · 30 天内可恢复，到期自动物理清除
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="删除原因（可选，建议填写取证/合规理由）"
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRow(null)}>取消</Button>
            <Button variant="destructive" onClick={doDelete} disabled={pending}>
              <Trash2 className="h-4 w-4 mr-1" />删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 取证备注 ---- */}
      <Dialog open={!!noteRow} onOpenChange={(o) => !o && setNoteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>取证备注</DialogTitle>
            <DialogDescription>「{noteRow?.workspaceName}」第 {(noteRow?.segmentIndex ?? 0) + 1} 段（案件编号 / 调查标记等）</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="例：INC-2026-1014 持续钓鱼站点调查取证"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteRow(null)}>取消</Button>
            <Button onClick={saveNote} disabled={pending}>
              <StickyNote className="h-4 w-4 mr-1" />保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
