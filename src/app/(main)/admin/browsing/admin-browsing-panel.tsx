"use client"

// r28：管理后台浏览数据面板 —— 全量筛选/搜索/日期/导出/批量/手动采集
// 用户筛选：默认仅看本管理员创建的沙箱数据，可切换「全部」/搜索用户/多选用户
// 用户列表按用户名字母排序，支持搜索、多选

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { HistoryRow, BookmarkRow } from "@/server/actions/browsing"
import { listHistoryAction, listBookmarksAction, exportBrowsingAction, localDeleteBrowsingAction, triggerBrowsingCollectAction, browsingClassificationStatsAction, adminBackfillClassificationAction } from "@/server/actions/browsing"
import { CATEGORY_LABELS, SENSITIVITY_LABELS, type DataCategory } from "@/lib/data-classification"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { Search, Trash2, RotateCcw, History, Bookmark, ChevronLeft, ChevronRight, Download, Gauge, Users, X, PieChart, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface WsLite { id: string; name: string; uuid: string | null; userId: string | null }
interface ViewerInfo { userId: string; username: string; role: string; userCount: number }

function fmtDwell(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`
  return `${Math.round(ms / 60000)}分`
}
function fmtTime(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
function csvEscape(v: string | number | null | undefined): string {
  const s = String(v ?? "")
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function downloadCsv(rows: Array<Record<string, string | number | null>>, fileName: string) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const csv = "\uFEFF" + [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  a.click()
  URL.revokeObjectURL(a.href)
}

const PAGE_SIZES = [20, 50, 100]

export function AdminBrowsingPanel({
  viewer, workspaces, initialHistory, initialBookmarks,
}: {
  viewer: ViewerInfo
  workspaces: WsLite[]
  initialHistory: HistoryRow[]
  initialBookmarks: BookmarkRow[]
}) {
  const router = useRouter()
  const [tab, setTab] = useState<"history" | "bookmark">("history")
  const [rows, setRows] = useState<HistoryRow[] | BookmarkRow[]>(tab === "history" ? initialHistory : initialBookmarks)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 筛选状态
  const [keyword, setKeyword] = useState("")
  const [debouncedKw, setDebouncedKw] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [domain, setDomain] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [includeDeleted, setIncludeDeleted] = useState(false)

  // 用户筛选（默认=本管理员；ALL=全部；多选用户集合）
  const [userFilter, setUserFilter] = useState<"MINE" | "ALL" | "CUSTOM">("MINE")
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
  const [userPopover, setUserPopover] = useState(false)
  const [userSearch, setUserSearch] = useState("")

  // 归属用户推导：默认 MINE = viewer.userId 名下沙箱
  const mineWsIds = useMemo(() => workspaces.filter((w) => w.userId === viewer.userId).map((w) => w.id), [workspaces, viewer.userId])
  const customWsIds = useMemo(() => {
    if (userFilter !== "CUSTOM" || selectedUserIds.size === 0) return null
    return workspaces.filter((w) => w.userId && selectedUserIds.has(w.userId)).map((w) => w.id)
  }, [workspaces, userFilter, selectedUserIds])

  // 用户目录（从沙箱归属聚合 + 搜索）
  const [userDir, setUserDir] = useState<Array<{ id: string; username: string }>>([])
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch("/api/search?types=user&q=&take=500").then((r) => r.json())
        const list = (res?.results?.user?.items || []) as Array<{ id: string; title: string; sub?: string }>
        // 按用户名字母排序
        const mapped = list.map((u) => ({ id: String(u.id), username: u.title || "" }))
        mapped.sort((a, b) => a.username.localeCompare(b.username, "zh"))
        setUserDir(mapped)
      } catch {
        setUserDir([])
      }
    })()
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedKw(keyword), 300)
    return () => clearTimeout(t)
  }, [keyword])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const common = {
        keyword: debouncedKw || undefined,
        page, pageSize,
        includeDeleted: tab === "history" ? includeDeleted : includeDeleted,
      }
      if (tab === "history") {
        const res = await listHistoryAction({
          ...common,
          from: from ? new Date(from + "T00:00:00").toISOString() : undefined,
          to: to ? new Date(to + "T23:59:59").toISOString() : undefined,
          domain: domain || undefined,
          ...(userFilter === "MINE" && mineWsIds.length === 0 ? { userId: "__none__" } : {}),
          ...(userFilter === "CUSTOM" && customWsIds ? { workspaceId: customWsIds[0] } : {}),
        })
        setRows((res.data?.rows as HistoryRow[]) || [])
        setTotal(res.data?.total || 0)
      } else {
        const res = await listBookmarksAction({
          ...common,
          ...(userFilter === "MINE" ? { workspaceIds: mineWsIds.length ? mineWsIds : ["__none__"] } : {}),
          ...(userFilter === "CUSTOM" && customWsIds ? { workspaceIds: customWsIds } : {}),
        })
        setRows((res.data?.rows as BookmarkRow[]) || [])
        setTotal(res.data?.total || 0)
      }
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [tab, debouncedKw, page, pageSize, from, to, domain, includeDeleted, userFilter, mineWsIds, customWsIds])

  useEffect(() => { void reload() }, [reload])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) { next.delete(id) } else { next.add(id) }
    setSelected(next)
  }

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`确定删除所选 ${selected.size} 条记录？平台审计日志不受影响。`)) return
    const res = await localDeleteBrowsingAction({ ids: [...selected], kind: tab })
    if (res.code === 0) {
      toast.success(`已删除 ${res.data?.deleted || 0} 条`)
      void reload()
    } else toast.error(res.msg || "删除失败")
  }

  const handleExport = async () => {
    const res = await exportBrowsingAction({
      kind: tab, mask: true, limit: 3000,
      keyword: debouncedKw || undefined,
      from: from ? new Date(from + "T00:00:00").toISOString() : undefined,
      to: to ? new Date(to + "T23:59:59").toISOString() : undefined,
    })
    if (res.code === 0 && res.data) {
      downloadCsv(res.data.rows, res.data.fileName)
      toast.success(`已导出 ${res.data.rows.length} 条（含脱敏）`)
    } else toast.error(res.msg || "导出失败")
  }

  const handleCollect = async () => {
    const res = await triggerBrowsingCollectAction({ scope: "all" })
    if (res.code === 0 && res.data) {
      toast.success(`采集完成：新历史 ${res.data.history.inserted} 条 / 书签同步 ${res.data.bookmarks.upserted} 条`)
      void reload()
    } else toast.error(res.msg || "采集失败")
  }

  const filteredUserDir = useMemo(() => {
    if (!userSearch) return userDir
    return userDir.filter((u) => u.username.toLowerCase().includes(userSearch.toLowerCase()))
  }, [userDir, userSearch])

  const userFilterLabel = userFilter === "MINE" ? "我的沙箱" : userFilter === "ALL" ? "全部用户" : `已选 ${selectedUserIds.size} 用户`

  // r37：数据分类统计 + 存量回填（明文数据自动分类识别解析）
  const [statsOpen, setStatsOpen] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [backfillBusy, setBackfillBusy] = useState(false)
  const [stats, setStats] = useState<{
    historyByCategory: Array<{ category: string; count: number }>
    historyBySensitivity: Array<{ sensitivity: string; count: number }>
    bookmarkByCategory: Array<{ category: string; count: number }>
    bookmarkBySensitivity: Array<{ sensitivity: string; count: number }>
    highSensitivityUsers: Array<{ username: string; displayName: string | null; count: number; lastVisitAt: string | null }>
    unclassified: { history: number; bookmark: number }
    totalHistory: number
    totalBookmark: number
  } | null>(null)

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await browsingClassificationStatsAction({})
      if (res.code === 0 && res.data) setStats(res.data)
      else toast.error(res.msg)
    } finally { setStatsLoading(false) }
  }, [])

  useEffect(() => {
    if (statsOpen && !stats) void loadStats()
  }, [statsOpen, stats, loadStats])

  const runBackfill = async () => {
    setBackfillBusy(true)
    try {
      const res = await adminBackfillClassificationAction({ maxRows: 10000 })
      if (res.code === 0 && res.data) {
        toast.success(`回填完成：历史 ${res.data.historyUpdated} 条 / 书签 ${res.data.bookmarkUpdated} 条（${res.data.batches} 批）`)
        void loadStats()
      } else toast.error(res.msg)
    } finally { setBackfillBusy(false) }
  }

  return (
    <div className="space-y-4">
      {/* r37：数据分类总览（明文数据自动分类识别解析；16 类 + 三级敏感 + 高敏用户榜 + 存量回填） */}
      <div className="rounded-lg border bg-card">
        <button className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm" onClick={() => setStatsOpen(!statsOpen)}>
          <span className="flex items-center gap-2 font-medium">
            <PieChart className="h-4 w-4 text-indigo-600" /> 数据分类总览（浏览/书签自动识别解析）
            {stats && <span className="text-xs font-normal text-muted-foreground">历史 {stats.totalHistory} · 书签 {stats.totalBookmark} · 高敏 {stats.historyBySensitivity.find((s) => s.sensitivity === "HIGH")?.count || 0}</span>}
          </span>
          <span className="text-xs text-muted-foreground">{statsOpen ? "收起" : "展开"}</span>
        </button>
        {statsOpen && (
          <div className="px-3 pb-3 space-y-4 border-t pt-3">
            {statsLoading && !stats && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4"><Gauge className="h-4 w-4 animate-spin" /> 统计加载中…</div>
            )}
            {stats && (
              <>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">浏览历史分类分布</p>
                    <div className="space-y-1">
                      {stats.historyByCategory.sort((a, b) => b.count - a.count).slice(0, 10).map((c) => (
                        <div key={c.category} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 truncate">{CATEGORY_LABELS[c.category as DataCategory] || c.category}</span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, (c.count / Math.max(1, stats.historyByCategory[0]?.count || 1)) * 100)}%` }} />
                          </div>
                          <span className="tabular-nums text-muted-foreground w-12 text-right">{c.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">书签分类分布</p>
                    <div className="space-y-1">
                      {stats.bookmarkByCategory.sort((a, b) => b.count - a.count).slice(0, 10).map((c) => (
                        <div key={c.category} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 truncate">{CATEGORY_LABELS[c.category as DataCategory] || c.category}</span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full bg-teal-500" style={{ width: `${Math.min(100, (c.count / Math.max(1, stats.bookmarkByCategory[0]?.count || 1)) * 100)}%` }} />
                          </div>
                          <span className="tabular-nums text-muted-foreground w-12 text-right">{c.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">敏感级别分布（历史）</p>
                    <div className="flex gap-2 flex-wrap">
                      {stats.historyBySensitivity.map((s) => (
                        <span key={s.sensitivity} className={`text-xs px-2 py-1 rounded-md border ${s.sensitivity === "HIGH" ? "border-red-300 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300" : s.sensitivity === "SENSITIVE" ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300" : ""}`}>
                          {SENSITIVITY_LABELS[s.sensitivity as "NORMAL" | "SENSITIVE" | "HIGH"] || s.sensitivity}：{s.count}
                        </span>
                      ))}
                    </div>
                    {stats.highSensitivityUsers.length > 0 && (
                      <div className="space-y-1 mt-2">
                        <p className="text-xs font-medium text-muted-foreground">高敏访问 Top 用户（银行/政务/凭据页）</p>
                        {stats.highSensitivityUsers.map((u) => (
                          <div key={u.username} className="flex items-center justify-between text-xs border rounded px-2 py-1">
                            <span className="truncate">{u.username}{u.displayName ? `（${u.displayName}）` : ""}</span>
                            <span className="text-red-600 tabular-nums shrink-0">{u.count} 次{u.lastVisitAt ? ` · 最近 ${fmtTime(u.lastVisitAt)}` : ""}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">存量回填（升级前历史数据补分类）</p>
                    <p className="text-xs text-muted-foreground">未分类：历史 {stats.unclassified.history} 条 · 书签 {stats.unclassified.bookmark} 条</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => void runBackfill()} disabled={backfillBusy || (stats.unclassified.history + stats.unclassified.bookmark) === 0}>
                        {backfillBusy ? <Gauge className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
                        一键回填分类
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void loadStats()} disabled={statsLoading}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" /> 刷新统计
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">采集入库时已自动分类；回填仅用于升级 r37 前的存量数据（分批 1000 条防长事务）</p>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => { setTab(v as "history" | "bookmark"); setPage(1) }}>
          <TabsList>
            <TabsTrigger value="history" className="gap-1.5"><History className="h-3.5 w-3.5" />浏览历史</TabsTrigger>
            <TabsTrigger value="bookmark" className="gap-1.5"><Bookmark className="h-3.5 w-3.5" />书签</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 归属筛选 */}
        <Popover open={userPopover} onOpenChange={setUserPopover}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Users className="h-3.5 w-3.5" />{userFilterLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="start">
            <div className="space-y-2">
              <div className="flex gap-1.5">
                <Button size="sm" variant={userFilter === "MINE" ? "default" : "outline"} className="flex-1 h-7 text-xs" onClick={() => { setUserFilter("MINE"); setPage(1) }}>我的沙箱</Button>
                <Button size="sm" variant={userFilter === "ALL" ? "default" : "outline"} className="flex-1 h-7 text-xs" onClick={() => { setUserFilter("ALL"); setPage(1) }}>全部</Button>
              </div>
              <div className="text-xs text-muted-foreground pt-1 border-t">
                或按用户多选（{viewer.userCount} 个用户 · 按字母排序）
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="搜索用户…" className="h-8 pl-7 text-xs" />
              </div>
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {filteredUserDir.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
                    <Checkbox
                      checked={selectedUserIds.has(u.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selectedUserIds)
                        if (v) { next.add(u.id) } else { next.delete(u.id) }
                        setSelectedUserIds(next)
                        setUserFilter(next.size > 0 ? "CUSTOM" : "MINE")
                        setPage(1)
                      }}
                    />
                    <span className="truncate">{u.username}{u.id === viewer.userId ? "（我）" : ""}</span>
                  </label>
                ))}
                {filteredUserDir.length === 0 && <div className="text-xs text-muted-foreground p-2">无匹配用户</div>}
              </div>
              {selectedUserIds.size > 0 && (
                <Button size="sm" variant="ghost" className="w-full h-7 text-xs gap-1" onClick={() => { setSelectedUserIds(new Set()); setUserFilter("MINE") }}>
                  <X className="h-3 w-3" />清空所选用户
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} placeholder="关键词（URL/标题/域名）" className="pl-8" />
        </div>
        <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="w-36" aria-label="开始日期" />
        <span className="text-xs text-muted-foreground">至</span>
        <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="w-36" aria-label="结束日期" />
        {tab === "history" && (
          <Input value={domain} onChange={(e) => { setDomain(e.target.value); setPage(1) }} placeholder="域名" className="w-32" />
        )}
        <Button variant={userFilter === "MINE" ? "secondary" : "outline"} size="sm" onClick={() => setIncludeDeleted(!includeDeleted)}>
          {includeDeleted ? "含已删除" : "仅有效"}
        </Button>
      </div>

      {/* 操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="destructive" size="sm" disabled={selected.size === 0} onClick={handleDelete} className="gap-1.5">
          <Trash2 className="h-3.5 w-3.5" />删除所选（{selected.size}）
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />导出 CSV（脱敏）
        </Button>
        <Button variant="outline" size="sm" onClick={handleCollect} className="gap-1.5">
          <Gauge className="h-3.5 w-3.5" />立即采集
        </Button>
        <Button variant="outline" size="sm" onClick={() => void reload()} className="gap-1.5">
          <RotateCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />刷新
        </Button>
      </div>

      {/* 列表 */}
      <div className="rounded-lg border bg-card">
        <div className={rows.length > 10 ? "max-h-[62vh] overflow-y-auto" : ""}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10">
              <tr className="border-b">
                <th className="w-10 p-2"><Checkbox checked={allChecked} onCheckedChange={toggleAll} /></th>
                <th className="text-left p-2 font-medium">{tab === "history" ? "页面" : "书签"}</th>
                <th className="text-left p-2 font-medium w-36 hidden md:table-cell">沙箱</th>
                <th className="text-left p-2 font-medium w-32 hidden lg:table-cell">{tab === "history" ? "域名" : "文件夹"}</th>
                <th className="text-left p-2 font-medium w-20 hidden sm:table-cell">{tab === "history" ? "停留" : "状态"}</th>
                <th className="text-left p-2 font-medium w-36">{tab === "history" ? "访问时间" : "添加时间"}</th>
              </tr>
            </thead>
            <tbody>
              {tab === "history"
                ? (rows as HistoryRow[]).map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="p-2"><Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} /></td>
                      <td className="p-2 max-w-0">
                        <div className="truncate font-medium" title={r.title || r.url}>{r.title || "(无标题)"}</div>
                        <div className="truncate text-xs text-muted-foreground" title={r.url}>{r.url}</div>
                      </td>
                      <td className="p-2 text-xs hidden md:table-cell" title={r.workspaceUuid || ""}>{r.workspaceName}</td>
                      <td className="p-2 text-xs text-muted-foreground hidden lg:table-cell">{r.domain || "-"}</td>
                      <td className="p-2 text-xs hidden sm:table-cell">{fmtDwell(r.dwellMs)}</td>
                      <td className="p-2 text-xs text-muted-foreground">{fmtTime(r.visitAt)}</td>
                    </tr>
                  ))
                : (rows as BookmarkRow[]).map((r) => (
                    <tr key={r.id} className={`border-b last:border-0 hover:bg-muted/40 ${r.removedAt ? "opacity-50" : ""}`}>
                      <td className="p-2">
                        {!r.removedAt && <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />}
                      </td>
                      <td className="p-2 max-w-0">
                        <div className="truncate font-medium" title={r.title || r.url}>
                          {r.title || "(无标题)"}
                          {r.removedAt ? <span className="ml-2 text-xs text-red-500">用户已删</span> : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground" title={r.url}>{r.url}</div>
                      </td>
                      <td className="p-2 text-xs hidden md:table-cell" title={r.workspaceUuid || ""}>{r.workspaceName}</td>
                      <td className="p-2 text-xs text-muted-foreground hidden lg:table-cell">{r.folder || "-"}</td>
                      <td className="p-2 text-xs hidden sm:table-cell">{r.removedAt ? "已删" : "有效"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{fmtTime(r.dateAdded)}</td>
                    </tr>
                  ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={6} className="p-8 text-center text-muted-foreground text-sm">无匹配数据</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>共 {total} 条 · 第 {page}/{totalPages} 页</span>
            <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }} className="h-7 rounded border bg-background px-1">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>每页 {n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(1)}>首页</Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <input type="number" min={1} max={totalPages} value={page}
              onChange={(e) => setPage(Math.min(Math.max(1, Number(e.target.value) || 1), totalPages))}
              className="h-7 w-14 rounded border bg-background text-center text-xs" aria-label="跳转页码" />
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>尾页</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
