"use client"

// r28：我的浏览数据（用户空间）—— 历史记录 / 书签
// 沙箱隔离：顶部沙箱 Tab（仅本人沙箱），切换后列表按 workspaceId 过滤
// 用户可本地删除（软标记）；审计归档不受影响

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { HistoryRow, BookmarkRow } from "@/server/actions/browsing"
import { listHistoryAction, listBookmarksAction, myBrowsingWorkspacesAction, localDeleteBrowsingAction } from "@/server/actions/browsing"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { MultiSelectPopover, type MultiOption } from "@/components/shared/multi-select-popover"
import { Search, Trash2, RotateCcw, History, Bookmark, ChevronLeft, ChevronRight, Loader2, MonitorPlay } from "lucide-react"
import { toast } from "sonner"

interface WsItem { id: string; name: string; uuid: string | null; status: string; historyCount: number; bookmarkCount: number }

function fmtDwell(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`
  return `${Math.round(ms / 60000)} 分钟`
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function MyBrowsingPanel({ initialTab }: { initialTab: string }) {
  const router = useRouter()
  const [tab, setTab] = useState<"history" | "bookmark">(initialTab === "bookmark" ? "bookmark" : "history")
  const [workspaces, setWorkspaces] = useState<WsItem[]>([])
  const [activeWs, setActiveWs] = useState<string>("ALL")
  const [multiWs, setMultiWs] = useState<string[]>([]) // r31：可搜索多选沙箱（沙箱多时主筛选）
  const [keyword, setKeyword] = useState("")
  const [debouncedKw, setDebouncedKw] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [rows, setRows] = useState<HistoryRow[] | BookmarkRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deletedShown, setDeletedShown] = useState(false)

  useEffect(() => {
    ;(async () => {
      const res = await myBrowsingWorkspacesAction()
      setWorkspaces((res.data as WsItem[]) || [])
    })()
  }, [router])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedKw(keyword), 300)
    return () => clearTimeout(t)
  }, [keyword])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      // r31：多选优先；无多选时保留单选 Tab 语义（activeWs）
      const wsFilter = multiWs.length > 0 ? multiWs : activeWs !== "ALL" ? [activeWs] : undefined
      if (tab === "history") {
        const res = await listHistoryAction({
          keyword: debouncedKw || undefined,
          ...(wsFilter && wsFilter.length === 1 ? { workspaceId: wsFilter[0] } : {}),
          ...(wsFilter && wsFilter.length > 1 ? { workspaceIds: wsFilter } : {}),
          page, pageSize,
        })
        setRows((res.data?.rows as HistoryRow[]) || [])
        setTotal(res.data?.total || 0)
      } else {
        const res = await listBookmarksAction({
          keyword: debouncedKw || undefined,
          ...(wsFilter && wsFilter.length === 1 ? { workspaceId: wsFilter[0] } : {}),
          ...(wsFilter && wsFilter.length > 1 ? { workspaceIds: wsFilter } : {}),
          page, pageSize,
          includeRemoved: deletedShown,
        })
        setRows((res.data?.rows as BookmarkRow[]) || [])
        setTotal(res.data?.total || 0)
      }
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }, [tab, debouncedKw, activeWs, multiWs, page, pageSize, deletedShown])

  useEffect(() => {
    void reload()
  }, [reload])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))

  const toggleAll = () => {
    if (allChecked) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.id)))
  }
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`确定删除所选 ${selected.size} 条记录？删除后平台审计不受影响，您的列表将不再显示。`)) return
    const res = await localDeleteBrowsingAction({ ids: [...selected], kind: tab })
    if (res.code === 0) {
      toast.success(`已删除 ${res.data?.deleted || 0} 条记录`)
      void reload()
    } else toast.error(res.msg || "删除失败")
  }

  const wsBadge = (status: string) =>
    status === "RUNNING" ? "bg-emerald-500" : "bg-slate-400"

  // r31：多选沙箱选项（含计数与状态点）
  const wsOptions: MultiOption[] = useMemo(
    () => workspaces.map((w) => ({
      id: w.id,
      label: w.name,
      sub: tab === "history" ? `${w.historyCount} 条` : `${w.bookmarkCount} 条`,
      dot: wsBadge(w.status),
    })),
    [workspaces, tab],
  )
  const quickTabs = workspaces.slice(0, 8) // 快速单选 Tab（沙箱多时折叠，用多选筛选器）

  return (
    <div className="space-y-4">
      {/* 沙箱快速 Tab（用户自己的沙箱；前 8 个单选直达） */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => { setActiveWs("ALL"); setMultiWs([]); setPage(1) }}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${activeWs === "ALL" && multiWs.length === 0 ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
        >
          全部沙箱
        </button>
        {quickTabs.map((w) => (
          <button
            key={w.id}
            onClick={() => { setActiveWs(w.id); setMultiWs([]); setPage(1) }}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition flex items-center gap-1.5 ${activeWs === w.id && multiWs.length === 0 ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}
            title={w.uuid || ""}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${wsBadge(w.status)}`} />
            {w.name}
            <span className="opacity-70">
              {tab === "history" ? `·${w.historyCount}` : `·${w.bookmarkCount}`}
            </span>
          </button>
        ))}
        {workspaces.length === 0 && <span className="text-xs text-muted-foreground">暂无沙箱</span>}
      </div>

      {/* r31：可搜索多选沙箱筛选（沙箱多时的主筛选器；与快速 Tab 互斥） */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <MonitorPlay className="h-3.5 w-3.5" /> 多选沙箱
        </span>
        <MultiSelectPopover
          options={wsOptions}
          selected={multiWs}
          onChange={(next) => { setMultiWs(next); if (next.length > 0) setActiveWs("ALL"); setPage(1) }}
          placeholder={multiWs.length === 0 && activeWs !== "ALL" ? "单选模式（Tab 已选）" : "不筛选"}
          searchPlaceholder="搜索沙箱名…"
          disabled={workspaces.length === 0}
          width={320}
        />
        <span className="text-xs text-muted-foreground">共 {total} 条</span>
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => { setTab(v as "history" | "bookmark"); setPage(1) }}>
          <TabsList>
            <TabsTrigger value="history" className="gap-1.5"><History className="h-3.5 w-3.5" />浏览历史</TabsTrigger>
            <TabsTrigger value="bookmark" className="gap-1.5"><Bookmark className="h-3.5 w-3.5" />书签</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
            placeholder={tab === "history" ? "搜索 URL / 标题 / 域名" : "搜索书签 / 文件夹"}
            className="pl-8"
          />
        </div>
        {tab === "bookmark" && (
          <Button variant="outline" size="sm" onClick={() => setDeletedShown(!deletedShown)}>
            {deletedShown ? "隐藏已删除" : "查看已删除"}
          </Button>
        )}
        <Button variant="destructive" size="sm" disabled={selected.size === 0} onClick={handleDelete} className="gap-1.5">
          <Trash2 className="h-3.5 w-3.5" />删除所选（{selected.size}）
        </Button>
        <Button variant="outline" size="sm" onClick={() => void reload()} className="gap-1.5">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}刷新
        </Button>
      </div>

      {/* 列表：>10 行滚动 */}
      <div className="rounded-lg border bg-card">
        <div className={rows.length > 10 ? "max-h-[62vh] overflow-y-auto" : ""}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10">
              <tr className="border-b">
                <th className="w-10 p-2">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                </th>
                <th className="text-left p-2 font-medium">{tab === "history" ? "页面" : "书签"}</th>
                <th className="text-left p-2 font-medium w-32 hidden md:table-cell">{tab === "history" ? "域名" : "文件夹"}</th>
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
                      <td className="p-2 text-xs text-muted-foreground hidden md:table-cell">{r.domain || "-"}</td>
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
                          {r.removedAt ? <span className="ml-2 text-xs text-red-500">已删除</span> : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground" title={r.url}>{r.url}</div>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground hidden md:table-cell">{r.folder || "-"}</td>
                      <td className="p-2 text-xs hidden sm:table-cell">{r.removedAt ? "已删" : "有效"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{fmtTime(r.dateAdded)}</td>
                    </tr>
                  ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={5} className="p-8 text-center text-muted-foreground text-sm">
                  {tab === "history" ? "暂无浏览历史（沙箱运行时自动采集）" : "暂无书签（沙箱运行时自动同步）"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 分页：首页/上下页/尾页/页码跳转/每页条数 */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>共 {total} 条 · 第 {page}/{totalPages} 页</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
              className="h-7 rounded border bg-background px-1"
            >
              {[20, 50, 100].map((n) => <option key={n} value={n}>每页 {n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(1)}>首页</Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={page}
              onChange={(e) => {
                const v = Math.min(Math.max(1, Number(e.target.value) || 1), totalPages)
                setPage(v)
              }}
              className="h-7 w-14 rounded border bg-background text-center text-xs"
              aria-label="跳转页码"
            />
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>尾页</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
