"use client"

// ============================================================
// r34：沙箱行为时间轴面板（用户诉求落地）
//
// 用户诉求：沙箱里的记录时间轴，点击之后可以查看详情信息；
//          筛选/搜索功能；导出功能；自动分类（浏览/文件/网络/系统）。
//
// 数据源：浏览历史 / 文件操作 / 网络请求(HAR) / 系统审计事件。
// 权限：所有者本人可查（action 层已校验）；管理员全量。
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getBehaviorTimelineAction } from "@/server/actions/behavior-timeline"
import type { TimelineEvent } from "@/lib/behavior-timeline"
import { cn } from "@/lib/utils"
import { Activity, Globe, FileText, Network, Cog, Search, RefreshCw, Loader2, Download, ChevronDown } from "lucide-react"

const KIND_META: Record<string, { label: string; icon: React.ReactNode; cls: string; dot: string }> = {
  browse: { label: "浏览", icon: <Globe className="h-3.5 w-3.5" />, cls: "border-sky-400/50 text-sky-600 bg-sky-50 dark:bg-sky-950/30", dot: "bg-sky-500" },
  file: { label: "文件", icon: <FileText className="h-3.5 w-3.5" />, cls: "border-emerald-400/50 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30", dot: "bg-emerald-500" },
  network: { label: "网络", icon: <Network className="h-3.5 w-3.5" />, cls: "border-violet-400/50 text-violet-600 bg-violet-50 dark:bg-violet-950/30", dot: "bg-violet-500" },
  system: { label: "系统", icon: <Cog className="h-3.5 w-3.5" />, cls: "border-amber-400/50 text-amber-600 bg-amber-50 dark:bg-amber-950/30", dot: "bg-amber-500" },
}

const WINDOWS: Array<{ value: number; label: string }> = [
  { value: 60, label: "近 1 小时" },
  { value: 360, label: "近 6 小时" },
  { value: 1440, label: "近 24 小时" },
  { value: 10080, label: "近 7 天" },
  { value: 43200, label: "近 30 天" },
]

export function TimelinePanel({ workspaceId, workspaceName, isAdmin }: { workspaceId: string; workspaceName: string; isAdmin?: boolean }) {
  const [events, setEvents] = React.useState<TimelineEvent[]>([])
  const [counts, setCounts] = React.useState<{ browse: number; file: number; network: number; system: number }>({ browse: 0, file: 0, network: 0, system: 0 })
  const [loading, setLoading] = React.useState(false)
  const [window, setWindow] = React.useState(1440)
  const [kind, setKind] = React.useState<string>("ALL")
  const [kw, setKw] = React.useState("")
  const [detail, setDetail] = React.useState<TimelineEvent | null>(null)

  const load = React.useCallback(async (opts?: { fromMin?: number; keyword?: string }) => {
    setLoading(true)
    try {
      const res = await getBehaviorTimelineAction({
        workspaceId,
        fromMin: opts?.fromMin ?? window,
        keyword: opts?.keyword ?? (kw.trim() || undefined),
        take: 300,
      })
      if (res.code === 0 && res.data) {
        setEvents(res.data.events)
        setCounts(res.data.counts)
      } else {
        toast.error(res.msg || "时间轴加载失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "时间轴加载失败")
    } finally {
      setLoading(false)
    }
  }, [workspaceId, window, kw])

  React.useEffect(() => { void load() }, [workspaceId])

  // 搜索防抖
  React.useEffect(() => {
    const t = setTimeout(() => { void load({ keyword: kw.trim() || undefined }) }, 400)
    return () => clearTimeout(t)
  }, [kw])

  const filtered = React.useMemo(() => events.filter((e) => kind === "ALL" || e.kind === kind), [events, kind])

  const exportCsv = () => {
    const rows = [["时间", "类型", "标题", "详情", "操作者"], ...filtered.map((e) => [
      new Date(e.ts).toLocaleString("zh-CN"),
      KIND_META[e.kind]?.label || e.kind,
      e.title || "",
      (e.detail || "").replace(/"/g, "'"),
      e.actor || "",
    ])]
    const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c)}"`).join(",")).join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `timeline-${workspaceName}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${filtered.length} 条时间轴记录`)
  }

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-44 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索时间轴（标题 / URL / 详情）…" className="pl-8" />
        </div>
        <select value={window} onChange={(e) => { const v = Number(e.target.value); setWindow(v); void load({ fromMin: v }) }} aria-label="时间范围" className="h-9 rounded-md border bg-background px-2 text-sm">
          {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setKind("ALL")} className={cn("rounded-md border px-2 py-1 text-xs", kind === "ALL" ? "border-teal-400 bg-teal-50 text-teal-700" : "text-muted-foreground hover:bg-muted")}>全部</button>
          {Object.entries(KIND_META).map(([k, m]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded-md border px-2 py-1 text-xs inline-flex items-center gap-1", kind === k ? m.cls : "text-muted-foreground hover:bg-muted")}>
              {m.icon}{m.label} {counts[k as keyof typeof counts] || 0}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}刷新
        </Button>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download className="h-3.5 w-3.5" />导出 CSV
        </Button>
      </div>

      {/* 统计条 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        共 {events.length} 条事件（{isAdmin ? "管理员视角" : "我的沙箱"}）· 浏览 {counts.browse} · 文件 {counts.file} · 网络 {counts.network} · 系统 {counts.system}
        <span className="text-[10px]">点击任意条目查看详情</span>
      </div>

      {/* 时间轴 */}
      {loading && events.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无时间轴事件（{kw ? `未匹配「${kw}」` : "该时间窗口内无浏览/文件/网络/系统事件"}）
        </div>
      ) : (
        <ScrollArea className="h-[62vh] rounded-lg border bg-card p-4">
          <div className="relative">
            {/* 主轴线 */}
            <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-border" />
            <div className="space-y-1">
              {filtered.map((e, i) => {
                const meta = KIND_META[e.kind] || KIND_META.system
                return (
                  <button
                    key={`${e.ts}-${i}`}
                    type="button"
                    onClick={() => setDetail(e)}
                    className="group relative w-full text-left flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50 transition-colors"
                  >
                    <span className={cn("relative z-10 mt-1.5 h-3.5 w-3.5 rounded-full border-2 border-background shrink-0", meta.dot)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleString("zh-CN")}</span>
                        <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.icon}{meta.label}</span>
                        {e.actor && <span className="text-[10px] text-muted-foreground">@{e.actor}</span>}
                      </span>
                      <span className="block text-sm font-medium truncate mt-0.5 group-hover:underline">{e.title}</span>
                      {e.detail && <span className="block text-xs text-muted-foreground truncate">{e.detail}</span>}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1 opacity-0 group-hover:opacity-100" />
                  </button>
                )
              })}
            </div>
          </div>
        </ScrollArea>
      )}

      {/* 详情弹窗（用户诉求：点击之后可以查看详情信息） */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {detail ? KIND_META[detail.kind]?.icon : null}
              <span className="truncate">{detail?.title}</span>
            </DialogTitle>
            <DialogDescription>
              {detail ? new Date(detail.ts).toLocaleString("zh-CN") : ""}
              {detail ? ` · ${KIND_META[detail.kind]?.label || detail.kind}` : ""}
              {detail?.actor ? ` · 操作者 ${detail.actor}` : ""}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh] rounded-md border p-3">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{detail?.detail || "（无详细信息）"}</pre>
            {detail?.title && detail.title !== detail.detail && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-xs text-muted-foreground mb-1">标题</p>
                <p className="text-sm break-all">{detail.title}</p>
              </div>
            )}
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => {
              if (!detail) return
              void navigator.clipboard?.writeText(`${detail.title}\n${detail.detail || ""}`).then(() => toast.success("详情已复制"))
            }}>复制详情</Button>
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
