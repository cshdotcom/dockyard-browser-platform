"use client"

// 我的录像面板（r27 用户空间；r31 增强）：关键词搜索 + 可搜索多选沙箱筛选 + 回放播放器 + 下载
// 用户仅可查看/回放/下载（不可删除 —— 审计完整性；删除与回收站归管理后台）

import { useState, useTransition, useRef, useMemo } from "react"
import { playbackRecordingAction, type RecordingRow, type PlaybackTicketInfo } from "@/server/actions/recordings"
import { WatermarkOverlay, PlaybackSpeedBar } from "@/components/recordings/watermark-overlay"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { MultiSelectPopover, type MultiOption } from "@/components/shared/multi-select-popover"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { toast } from "sonner"
import { Play, Download, Info, MonitorPlay } from "lucide-react"

const STATUS_MAP: Record<string, "default" | "secondary" | "destructive" | "outline" | "success"> = {
  RECORDING: "success",
  COMPLETED: "default",
  FAILED: "destructive",
}

export interface WsFilterItem {
  id: string
  name: string
  status: string
  recordingCount: number
}

export function MyRecordingsPanel({ rows, keyword, wsIds, workspaces, quotaPct }: {
  rows: RecordingRow[]
  keyword: string
  wsIds: string[]
  workspaces: WsFilterItem[]
  quotaPct: number | null
}) {
  const [pending, startTransition] = useTransition()
  const [playRow, setPlayRow] = useState<RecordingRow | null>(null)
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [playTicket, setPlayTicket] = useState<PlaybackTicketInfo | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [dlUrl, setDlUrl] = useState<string | null>(null)
  const [sel, setSel] = useState<string[]>(wsIds)

  const wsOptions: MultiOption[] = useMemo(
    () => workspaces.map((w) => ({
      id: w.id,
      label: w.name,
      sub: `${w.recordingCount} 段`,
      dot: w.status === "RUNNING" || w.status === "IDLE" ? "bg-emerald-500" : "bg-slate-400",
    })),
    [workspaces],
  )

  // 多选沙箱变更 → URL 参数（服务端重新过滤）
  const applyWsFilter = (next: string[]) => {
    setSel(next)
    const us = new URLSearchParams()
    if (keyword) us.set("q", keyword)
    if (next.length > 0) us.set("ws", next.join(","))
    window.location.href = `/recordings${next.length > 0 || keyword ? `?${us.toString()}` : ""}`
  }

  const openPlayback = (r: RecordingRow) => {
    startTransition(async () => {
      try {
        const res = await playbackRecordingAction({ id: r.id })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "回放票据签发失败")
        setPlayUrl(res.data.streamUrl)
        setPlayTicket(res.data)
        setDlUrl(res.data.downloadUrl)
        setPlayRow(r)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "回放失败")
      }
    })
  }

  const columns = [
    {
      key: "workspace",
      title: "工作区 / 分段",
      render: (r: RecordingRow) => (
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{r.workspaceName}</p>
          <p className="text-xs text-muted-foreground">会话 {r.sessionId.slice(0, 14)}… · 第 {r.segmentIndex + 1}/{r.totalSegments} 段</p>
        </div>
      ),
    },
    {
      key: "status",
      title: "状态",
      width: "100px",
      render: (r: RecordingRow) => <StatusBadge status={r.status} map={STATUS_MAP} />,
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
          <p className="text-muted-foreground">{fmtBytes(r.sizeBytes)}</p>
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
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          title="下载"
          onClick={() =>
            startTransition(async () => {
              try {
                const res = await playbackRecordingAction({ id: r.id })
                if (res.code !== 0 || !res.data) throw new Error(res.msg || "下载失败")
                if (!res.data.downloadUrl) throw new Error("管理员已禁止导出该录像（仅允许在线回放）")
                window.open(res.data.downloadUrl, "_blank")
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "下载失败")
              }
            })
          }
        >
          <Download className="h-4 w-4 text-blue-600" />
        </Button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {quotaPct != null && quotaPct > 80 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4 text-amber-600 shrink-0" />
          录像空间已使用 {quotaPct.toFixed(0)}%（超出配额后最旧录像将自动归档至回收站）
        </div>
      )}
      {/* r31：可搜索多选沙箱筛选（沙箱多时快速定位） */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <MonitorPlay className="h-3.5 w-3.5" /> 沙箱筛选
        </span>
        <MultiSelectPopover
          options={wsOptions}
          selected={sel}
          onChange={applyWsFilter}
          placeholder="全部沙箱"
          searchPlaceholder="搜索沙箱名…"
          disabled={wsOptions.length === 0}
          width={320}
        />
        <span className="text-xs text-muted-foreground">共 {rows.length} 段录像</span>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        total={rows.length}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        keyword={keyword}
        onQueryChange={(params) => {
          const us = new URLSearchParams()
          if (params.keyword !== undefined) us.set("q", params.keyword)
          if (sel.length > 0) us.set("ws", sel.join(","))
          window.location.href = `/recordings${us.toString() ? `?${us.toString()}` : ""}`
        }}
        rowActions={rowActions}
        emptyText="暂无录像（会话录像由管理员策略开启后自动产生）"
        dense
      />

      <Dialog open={!!playRow} onOpenChange={(o) => !o && setPlayRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="h-4 w-4 text-teal-600" />
              {playRow?.workspaceName} · 第 {(playRow?.segmentIndex ?? 0) + 1} 段
            </DialogTitle>
            <DialogDescription>
              {playRow && new Date(playRow.startedAt).toLocaleString("zh-CN")} · {playRow && fmtDur(playRow.durationSec)} ·{" "}
              {playRow && fmtBytes(playRow.sizeBytes)}
            </DialogDescription>
          </DialogHeader>
          <div className="relative rounded-lg overflow-hidden bg-black">
            <video key={playUrl || "none"} ref={videoRef} src={playUrl || undefined} controls autoPlay className="w-full max-h-[60vh]" preload="metadata" controlsList="nodownload" disablePictureInPicture />
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
            {playTicket && !playTicket.allowExport && <span className="text-xs text-muted-foreground">该录像仅允许在线回放（禁止导出）</span>}
          </div>
          <DialogFooter className="sm:justify-between">
            <p className="text-xs text-muted-foreground">回放已审计留痕</p>
            <div className="flex gap-2">
              {dlUrl && (
                <Button variant="secondary" onClick={() => window.open(dlUrl, "_blank")}>
                  <Download className="h-4 w-4 mr-1" />下载
                </Button>
              )}
              <Button variant="outline" onClick={() => setPlayRow(null)}>关闭</Button>
            </div>
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
