"use client"

// ============================================================
// r34：消息记录页（站内信全量历史）
//
// 用户诉求：站内信在铃铛里清除后，用户仍可在「公告记录」页面看到收到的
// 所有站内信与公告记录（清除只是列表隐藏，记录页永久可查）。
//
// 功能：
//   · 类型筛选（全部/公告/告警/系统/安全/录像/截图/文件/令牌）
//   · 状态筛选（全部/未读/已读/已清除）
//   · 关键词搜索（标题+内容）
//   · 日期范围筛选（起/止 date input）
//   · 单条详情弹窗（全文 + 已读 + 跳转链接）
//   · 分页 + 移动端单列适配
// ============================================================

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import { Inbox, Search, X, ChevronLeft, ChevronRight, Megaphone, Bell, ShieldAlert, Cog, Video, Camera, FileText, KeyRound, Check, Eraser } from "lucide-react"

export interface NoticeRecordRow {
  id: string
  title: string
  content: string
  type: string
  link: string | null
  cleared: boolean
  read: boolean
  createdAt: string
  createdAtIso: string
}

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  ANNOUNCEMENT: { label: "公告", icon: <Megaphone className="h-3.5 w-3.5" />, cls: "border-sky-400/50 text-sky-600 bg-sky-50 dark:bg-sky-950/30" },
  ALERT: { label: "告警", icon: <Bell className="h-3.5 w-3.5" />, cls: "border-amber-400/50 text-amber-600 bg-amber-50 dark:bg-amber-950/30" },
  SYSTEM: { label: "系统", icon: <Cog className="h-3.5 w-3.5" />, cls: "border-slate-400/50 text-slate-600 bg-slate-50 dark:bg-slate-900/30" },
  SECURITY: { label: "安全", icon: <ShieldAlert className="h-3.5 w-3.5" />, cls: "border-red-400/50 text-red-600 bg-red-50 dark:bg-red-950/30" },
  TOKEN_EXPIRE: { label: "令牌", icon: <KeyRound className="h-3.5 w-3.5" />, cls: "border-violet-400/50 text-violet-600 bg-violet-50 dark:bg-violet-950/30" },
  RECORDING_DONE: { label: "录像", icon: <Video className="h-3.5 w-3.5" />, cls: "border-teal-400/50 text-teal-600 bg-teal-50 dark:bg-teal-950/30" },
  SCREENSHOT_DONE: { label: "截图", icon: <Camera className="h-3.5 w-3.5" />, cls: "border-cyan-400/50 text-cyan-600 bg-cyan-50 dark:bg-cyan-950/30" },
  FILE_SHARE: { label: "文件", icon: <FileText className="h-3.5 w-3.5" />, cls: "border-emerald-400/50 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30" },
}

const PAGE_SIZE = 20

export function NoticesRecordView({ rows }: { rows: NoticeRecordRow[] }) {
  const [type, setType] = React.useState<string>("ALL")
  const [status, setStatus] = React.useState<string>("ALL")
  const [kw, setKw] = React.useState("")
  const [from, setFrom] = React.useState("")
  const [to, setTo] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [detail, setDetail] = React.useState<NoticeRecordRow | null>(null)
  const [readIds, setReadIds] = React.useState<Set<string>>(new Set(rows.filter((r) => r.read).map((r) => r.id)))

  // 筛选（客户端实时；数据量 500 上限）
  const filtered = React.useMemo(() => {
    const q = kw.trim().toLowerCase()
    return rows.filter((r) => {
      if (type !== "ALL" && r.type !== type) return false
      if (status === "UNREAD" && (r.cleared || readIds.has(r.id))) return false
      if (status === "READ" && (!readIds.has(r.id) || r.cleared)) return false
      if (status === "CLEARED" && !r.cleared) return false
      if (from && r.createdAtIso < new Date(from).toISOString()) return false
      if (to && r.createdAtIso > new Date(`${to}T23:59:59`).toISOString()) return false
      if (q && !r.title.toLowerCase().includes(q) && !r.content.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, type, status, kw, from, to, readIds])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const hasFilter = type !== "ALL" || status !== "ALL" || kw || from || to

  const markRead = async (r: NoticeRecordRow) => {
    if (readIds.has(r.id)) return
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id }),
      })
      const json = (await res.json()) as { code?: number }
      if (json.code === 0) {
        setReadIds((s) => new Set([...s, r.id]))
        toast.success("已标记为已读")
      }
    } catch { /* noop */ }
  }

  const typeOpts: Array<{ value: string; label: string }> = [
    { value: "ALL", label: "全部类型" },
    ...Object.entries(TYPE_META).map(([k, v]) => ({ value: k, label: v.label })),
  ]

  return (
    <div className="space-y-4">
      {/* 公告页签切换 */}
      <div className="flex items-center gap-2 flex-wrap">
        <a href="/announcements" className={cn("rounded-md border px-3 py-1.5 text-xs font-medium transition-colors", "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400")}>
          <Megaphone className="h-3.5 w-3.5 inline mr-1" />公告列表
        </a>
        <span className={cn("rounded-md border px-3 py-1.5 text-xs font-medium", "border-teal-400 bg-teal-50 text-teal-700 dark:bg-teal-950/30 dark:text-teal-300")}>
          <Inbox className="h-3.5 w-3.5 inline mr-1" />消息记录（含已清除）
        </span>
      </div>

      {/* 筛选栏 */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-40 sm:max-w-xs">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={kw} onChange={(e) => { setKw(e.target.value); setPage(1) }} placeholder="搜索标题 / 内容…" className="pl-8 h-8 text-xs" />
            {kw && (
              <button type="button" aria-label="清空搜索" onClick={() => setKw("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select value={type} onChange={(e) => { setType(e.target.value); setPage(1) }} aria-label="类型筛选" className="h-8 rounded-md border bg-background px-2 text-xs">
            {typeOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="状态筛选" className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="ALL">全部状态</option>
            <option value="UNREAD">未读</option>
            <option value="READ">已读</option>
            <option value="CLEARED">已清除</option>
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground shrink-0">日期</span>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="开始日期" className="h-8 w-36 text-xs" />
          <span className="text-[11px] text-muted-foreground">至</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="结束日期" className="h-8 w-36 text-xs" />
          {hasFilter && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setType("ALL"); setStatus("ALL"); setKw(""); setFrom(""); setTo(""); setPage(1) }}>
              <Eraser className="h-3.5 w-3.5 mr-1" />清空筛选
            </Button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            匹配 {filtered.length} / {rows.length} 条
          </span>
        </div>
      </div>

      {/* 列表 */}
      {pageRows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {hasFilter ? `未找到匹配「${kw || "筛选条件"}」的消息` : "暂无站内信记录"}
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {pageRows.map((r) => {
            const meta = TYPE_META[r.type] || { label: r.type, icon: <Bell className="h-3.5 w-3.5" />, cls: "border-slate-400/50 text-slate-600 bg-slate-50" }
            const isRead = readIds.has(r.id)
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => { setDetail(r); if (!isRead) void markRead(r) }}
                className={cn("w-full flex items-start gap-3 p-3 text-left hover:bg-muted/40 transition-colors", r.cleared && "opacity-60")}
              >
                <span className={cn("mt-0.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0", meta.cls)}>
                  {meta.icon}{meta.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cn("text-sm truncate", isRead ? "text-muted-foreground" : "font-medium text-foreground")}>{r.title}</span>
                    {!isRead && !r.cleared && <span className="h-1.5 w-1.5 rounded-full bg-teal-500 shrink-0" />}
                    {r.cleared && <span className="text-[10px] text-muted-foreground border rounded px-1 shrink-0">已清除</span>}
                  </span>
                  <span className="block text-xs text-muted-foreground truncate mt-0.5">{r.content}</span>
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 hidden sm:block">{r.createdAt}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" className="h-8" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">{safePage} / {totalPages} 页</span>
          <Button variant="outline" size="sm" className="h-8" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* 详情弹窗 */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              {(() => {
                const meta = TYPE_META[detail?.type || ""] || { icon: <Bell className="h-4 w-4" /> }
                return meta.icon
              })()}
              <span className="truncate">{detail?.title}</span>
            </DialogTitle>
            <DialogDescription>
              {detail?.createdAt}
              {detail?.cleared && " · 已从铃铛清除（本页保留记录）"}
              {detail && readIds.has(detail.id) ? " · 已读" : " · 未读"}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] rounded-md border p-3">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{detail?.content}</pre>
          </ScrollArea>
          <DialogFooter className="sm:justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>关闭</Button>
            <div className="flex gap-2">
              {detail?.link && (
                <Button size="sm" onClick={() => { if (detail) { if (!readIds.has(detail.id)) void markRead(detail) } window.location.href = detail?.link || "#" }}>
                  <Check className="h-4 w-4 mr-1" />已读并跳转
                </Button>
              )}
              {detail && !readIds.has(detail.id) && (
                <Button variant="secondary" size="sm" onClick={() => detail && markRead(detail)}>
                  <Check className="h-4 w-4 mr-1" />标记已读
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
