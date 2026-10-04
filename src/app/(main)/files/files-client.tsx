"use client"

// ============================================================
// 用户云盘 /files 主交互（r28a）
//   · 多标签页：文件夹路径标签（storageKey 目录层级导航；可关闭/关闭其他/全部关闭；
//     localStorage 会话恢复）+ 收藏夹页签（一键过滤 isFavorite）
//   · focus 直达：?focus=<id>（通知链接）→ 自动切到所在目录 + 滚动定位 + 高亮 + 打开预览
//   · 预览弹窗（preview-dialog）/ 文本在线编辑（text-editor-dialog）
//   · 批量：分享（share-dialog）/ 删除（userDeleteFileAction 软删入回收站）/ 取消收藏
//   · 搜索（文件名全盘模糊）+ 类型筛选 + 收藏筛选 + 排序（名称/大小/时间）
//   · 我的分享管理面板（my-shares-panel）
// ============================================================

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronRight, Download, File, FileArchive, FileAudio, FileImage, FileText, FileVideo,
  Folder, FolderOpen, Info, Loader2, MoreHorizontal, Pencil, Share2, Star, StarOff, Trash2, X,
} from "lucide-react"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { fmtBytes } from "@/lib/utils-server"
import { previewKindOf, isTextEditable } from "@/lib/preview-kind"
import { toggleFileFavoriteAction } from "@/server/actions/files"
import { userDeleteFileAction } from "@/server/actions/files-user"
import { USER_CATEGORY_LABEL, type UserFileRow } from "./types"
import { PreviewDialog } from "./preview-dialog"
import { TextEditorDialog } from "./text-editor-dialog"
import { ShareDialog } from "./share-dialog"
import { MySharesPanel } from "./my-shares-panel"

const FAV_TAB = "__fav__"
const LS_KEY = "dockyard:files:tabs:v1"
const MAX_TABS = 12

// 文件夹伪行（目录层级导航；id 前缀 folder: 供选择过滤）
type ListRow =
  | (UserFileRow & { __folder?: undefined })
  | { id: string; __folder: true; path: string; fileName: string; category: string; size: number; isFavorite: boolean; createdAt: string; fileCount: number }

interface FilesClientProps {
  rows: UserFileRow[]
  focus?: string
  truncated?: boolean
  quotaPct: number | null
}

export function FilesClient({ rows, focus, truncated, quotaPct }: FilesClientProps) {
  const router = useRouter()

  // ---- 多标签页状态（localStorage 持久化） ----
  const [tabs, setTabs] = React.useState<string[]>([])
  const [active, setActive] = React.useState("")
  const [ready, setReady] = React.useState(false)
  const restoredRef = React.useRef(false)

  // ---- 列表视图状态（全内存过滤/排序/分页） ----
  const [keyword, setKeyword] = React.useState("")
  const [category, setCategory] = React.useState("")
  const [favFilter, setFavFilter] = React.useState("")
  const [sortField, setSortField] = React.useState("createdAt")
  const [sortOrder, setSortOrder] = React.useState<"asc" | "desc">("desc")
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [selected, setSelected] = React.useState<string[]>([])

  // ---- 弹窗状态 ----
  const [previewRow, setPreviewRow] = React.useState<UserFileRow | null>(null)
  const [editorRow, setEditorRow] = React.useState<UserFileRow | null>(null)
  const [shareRows, setShareRows] = React.useState<UserFileRow[] | null>(null)
  const [deleteIds, setDeleteIds] = React.useState<string[] | null>(null)
  const [busy, setBusy] = React.useState("")

  const [highlightId, setHighlightId] = React.useState<string | null>(null)
  const [favOverride, setFavOverride] = React.useState<Record<string, boolean>>({})
  const [shareVersion, setShareVersion] = React.useState(0)
  const handledFocusRef = React.useRef<string | null>(null)

  // ---- 会话恢复（localStorage） ----
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { tabs?: unknown; active?: unknown }
        const t = Array.isArray(data.tabs) ? data.tabs.filter((x): x is string => typeof x === "string").slice(0, MAX_TABS) : []
        const a = typeof data.active === "string" ? data.active : ""
        setTabs(t)
        setActive(a === FAV_TAB || a === "" || t.includes(a) ? a : "")
      }
    } catch {
      // 忽略损坏的本地存储
    }
    restoredRef.current = true
    setReady(true)
  }, [])

  React.useEffect(() => {
    if (!restoredRef.current) return
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify({ tabs, active }))
    } catch {
      // 隐私模式等存储失败可忽略
    }
  }, [tabs, active])

  // ---- focus 直达（通知链接 /files?focus=<id>） ----
  React.useEffect(() => {
    if (!ready || !focus || handledFocusRef.current === focus) return
    const row = rows.find((r) => r.id === focus)
    if (!row) return
    handledFocusRef.current = focus
    // 切换到该文件所在目录标签（保证行可见）
    if (row.folder) {
      setTabs((t) => (t.includes(row.folder) ? t : [...t, row.folder].slice(-MAX_TABS)))
      setActive(row.folder)
    } else {
      setActive("")
    }
    setKeyword("")
    setPage(1)
    setHighlightId(focus)
    setPreviewRow(row)
    const timer = setTimeout(() => {
      document.getElementById(`file-cell-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    }, 400)
    return () => clearTimeout(timer)
  }, [ready, focus, rows])

  // ---- 收藏切换（乐观更新 + 失败回滚） ----
  const toggleFavorite = async (row: UserFileRow) => {
    const current = favOverride[row.id] ?? row.isFavorite
    const next = !current
    setFavOverride((o) => ({ ...o, [row.id]: next }))
    try {
      const res = await toggleFileFavoriteAction({ fileId: row.id })
      if (res.code !== 0) {
        setFavOverride((o) => ({ ...o, [row.id]: current }))
        toast.error(res.msg || "收藏操作失败")
      }
    } catch (e) {
      setFavOverride((o) => ({ ...o, [row.id]: current }))
      toast.error(e instanceof Error ? e.message : "收藏操作失败")
    }
  }

  // ---- 派生数据 ----
  const rowsAll = React.useMemo(
    () => rows.map((r) => ({ ...r, isFavorite: favOverride[r.id] ?? r.isFavorite })),
    [rows, favOverride]
  )

  const searching = keyword.trim().length > 0
  const activeFolder = active === FAV_TAB ? "" : active

  // 基础集合：搜索 → 全盘；收藏夹页签 → 全部收藏；否则当前目录直属文件
  const baseFiles = React.useMemo(() => {
    if (searching) {
      const q = keyword.trim().toLowerCase()
      return rowsAll.filter((r) => r.fileName.toLowerCase().includes(q) || r.storageKey.toLowerCase().includes(q))
    }
    if (active === FAV_TAB) return rowsAll.filter((r) => r.isFavorite)
    return rowsAll.filter((r) => r.folder === activeFolder)
  }, [rowsAll, searching, keyword, active, activeFolder])

  const filteredFiles = React.useMemo(() => {
    let list = baseFiles
    if (category) list = list.filter((r) => r.category === category)
    if (favFilter === "only") list = list.filter((r) => r.isFavorite)
    if (favFilter === "none") list = list.filter((r) => !r.isFavorite)
    return list
  }, [baseFiles, category, favFilter])

  // 子目录（当前目录下一层 + 各自文件总数）
  const folderRows = React.useMemo(() => {
    if (searching || active === FAV_TAB) return []
    const prefix = activeFolder ? `${activeFolder}/` : ""
    const counts = new Map<string, number>()
    for (const r of rowsAll) {
      if (!r.storageKey.startsWith(prefix)) continue
      const rest = r.storageKey.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash > 0) {
        const seg = rest.slice(0, slash)
        counts.set(seg, (counts.get(seg) || 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))
      .map(([seg, count]) => ({
        id: `folder:${prefix}${seg}`,
        __folder: true as const,
        path: `${prefix}${seg}`,
        fileName: seg,
        category: "__folder",
        size: 0,
        isFavorite: false,
        createdAt: "",
        fileCount: count,
      }))
  }, [rowsAll, searching, active, activeFolder])

  const sortedFiles = React.useMemo(() => {
    const list = [...filteredFiles]
    const dir = sortOrder === "asc" ? 1 : -1
    list.sort((a, b) => {
      if (sortField === "fileName") return a.fileName.localeCompare(b.fileName, "zh-CN") * dir
      if (sortField === "size") return (a.size - b.size) * dir
      return (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) * dir
    })
    return list
  }, [filteredFiles, sortField, sortOrder])

  const combinedRows: ListRow[] = React.useMemo(
    () => [...folderRows, ...sortedFiles],
    [folderRows, sortedFiles]
  )
  const total = combinedRows.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const pagedRows = React.useMemo(
    () => combinedRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [combinedRows, safePage, pageSize]
  )

  const selectedFiles = React.useMemo(
    () => selected.map((id) => rowsAll.find((r) => r.id === id)).filter((r): r is UserFileRow => !!r),
    [selected, rowsAll]
  )

  // ---- 标签页操作 ----
  const switchTab = (key: string) => {
    setActive(key)
    setPage(1)
    setSelected([])
  }
  const openFolder = (path: string) => {
    setTabs((t) => (t.includes(path) ? t : [...t, path].slice(-MAX_TABS)))
    switchTab(path)
  }
  const closeTab = (path: string) => {
    setTabs((t) => t.filter((x) => x !== path))
    if (active === path) switchTab("")
  }
  const closeOthers = () => {
    setTabs(activeFolder && active !== FAV_TAB ? [activeFolder] : [])
    if (active === FAV_TAB) switchTab(FAV_TAB)
  }
  const closeAll = () => {
    setTabs([])
    switchTab("")
  }

  // ---- DataTable 查询拦截（全部本地状态，不推 URL） ----
  const handleQueryChange = (patch: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === "page") setPage(Math.max(1, Number(v) || 1))
      else if (k === "pageSize") setPageSize(Math.max(10, Number(v) || 20))
      else if (k === "keyword") setKeyword(v || "")
      else if (k === "category") setCategory(v && v !== "__all__" ? v : "")
      else if (k === "fav") setFavFilter(v && v !== "__all__" ? v : "")
      else if (k === "sortField") setSortField(v || "createdAt")
      else if (k === "sortOrder") setSortOrder(v === "asc" ? "asc" : "desc")
    }
  }

  // ---- 批量操作 ----
  const batchDelete = async () => {
    if (!deleteIds || deleteIds.length === 0) return
    setBusy("delete")
    try {
      const res = await userDeleteFileAction({ fileIds: deleteIds, reason: "用户云盘删除" })
      if (res.code === 0 && res.data) {
        toast.success(`已删除 ${res.data.deleted} 个文件（软删除，已入回收站可恢复）`)
        if (res.data.failed.length > 0) {
          toast.warning(`${res.data.failed.length} 个文件未删除：${res.data.failed[0].msg}`)
        }
        setSelected([])
        router.refresh()
      } else {
        toast.error(res.msg || "删除失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败")
    } finally {
      setBusy("")
      setDeleteIds(null)
    }
  }

  const batchUnfavorite = async () => {
    const targets = selectedFiles.filter((f) => f.isFavorite)
    if (targets.length === 0) {
      toast.info("选中文件中没有已收藏的文件")
      return
    }
    setBusy("unfav")
    let ok = 0
    for (const f of targets) {
      try {
        const res = await toggleFileFavoriteAction({ fileId: f.id })
        if (res.code === 0) {
          setFavOverride((o) => ({ ...o, [f.id]: false }))
          ok++
        }
      } catch {
        // 单个失败继续
      }
    }
    setBusy("")
    toast.success(`已取消收藏 ${ok}/${targets.length} 个文件`)
    setSelected([])
  }

  // ---- 行点击 / 列定义 ----
  const onRowClick = (r: ListRow) => {
    if (r.__folder) {
      openFolder(r.path)
    } else {
      setPreviewRow(r)
    }
  }

  const columns: Column<ListRow>[] = [
    {
      key: "fileName",
      title: "文件名",
      sortable: true,
      render: (r) => {
        if (r.__folder) {
          return (
            <div className="flex items-center gap-2 min-w-0">
              <Folder className="h-4 w-4 text-amber-500 shrink-0" />
              <span className="text-sm font-medium truncate max-w-56">{r.fileName}</span>
              <Badge variant="outline" className="text-[10px] shrink-0">{r.fileCount} 个文件</Badge>
            </div>
          )
        }
        const highlighted = highlightId === r.id
        return (
          <div id={`file-cell-${r.id}`} className={`flex items-center gap-2 min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors ${highlighted ? "ring-2 ring-teal-500 bg-teal-50/60 dark:bg-teal-950/30" : ""}`}>
            {kindIcon(r)}
            <div className="min-w-0">
              <p className="text-sm font-medium truncate max-w-56" title={r.fileName}>{r.fileName}</p>
              {(searching || active === FAV_TAB) && (
                <p className="text-[10px] text-muted-foreground font-mono truncate max-w-56" title={r.storageKey}>{r.storageKey}</p>
              )}
            </div>
            {r.expired && <Badge variant="destructive" className="text-[10px] shrink-0">已过期</Badge>}
          </div>
        )
      },
    },
    {
      key: "size",
      title: "大小",
      sortable: true,
      render: (r) =>
        r.__folder ? (
          <span className="text-xs text-muted-foreground">-</span>
        ) : (
          <span className="tabular-nums text-sm">{fmtBytes(r.size)}</span>
        ),
    },
    {
      key: "category",
      title: "类型",
      render: (r) =>
        r.__folder ? (
          <Badge variant="secondary">文件夹</Badge>
        ) : (
          <Badge variant="outline">{USER_CATEGORY_LABEL[r.category] || r.category}</Badge>
        ),
    },
    {
      key: "isFavorite",
      title: "收藏",
      render: (r) =>
        r.__folder ? (
          <span className="text-xs text-muted-foreground">-</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={r.isFavorite ? `取消收藏 ${r.fileName}` : `收藏 ${r.fileName}`}
            title={r.isFavorite ? "取消收藏" : "加入收藏"}
            onClick={(e) => {
              e.stopPropagation()
              void toggleFavorite(r)
            }}
          >
            <Star className={`h-4 w-4 ${r.isFavorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
          </Button>
        ),
    },
    {
      key: "createdAt",
      title: "创建时间",
      sortable: true,
      render: (r) =>
        r.__folder ? (
          <span className="text-xs text-muted-foreground">-</span>
        ) : (
          <span className="text-xs tabular-nums">{r.createdAt}</span>
        ),
    },
  ]

  const rowActions = (r: ListRow) => {
    if (r.__folder) {
      return (
        <Button variant="ghost" size="sm" onClick={() => openFolder(r.path)} aria-label={`打开文件夹 ${r.fileName}`}>
          <FolderOpen className="h-4 w-4" />
        </Button>
      )
    }
    const editable = isTextEditable(r.mime, r.fileName) && r.size <= 1024 * 1024
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            window.open(`/api/files/download?id=${encodeURIComponent(r.id)}`, "_blank")
          }}
          aria-label={`下载 ${r.fileName}`}
        >
          <Download className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="更多操作" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setShareRows([r])}>
              <Share2 className="mr-2 h-4 w-4" /> 创建分享
            </DropdownMenuItem>
            {editable && (
              <DropdownMenuItem onClick={() => setEditorRow(r)}>
                <Pencil className="mr-2 h-4 w-4" /> 在线编辑
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => void toggleFavorite(r)}>
              {r.isFavorite ? <StarOff className="mr-2 h-4 w-4" /> : <Star className="mr-2 h-4 w-4" />}
              {r.isFavorite ? "取消收藏" : "加入收藏"}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-red-600" onClick={() => setDeleteIds([r.id])}>
              <Trash2 className="mr-2 h-4 w-4" /> 删除（入回收站）
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  // 面包屑（当前目录层级向上跳转）
  const breadcrumb = activeFolder
    ? activeFolder.split("/").map((seg, i, arr) => ({ seg, path: arr.slice(0, i + 1).join("/") }))
    : []

  return (
    <div className="space-y-4">
      {/* 配额预警（>80%） */}
      {quotaPct != null && quotaPct > 80 && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4 text-amber-600 shrink-0" />
          云盘空间已使用 {quotaPct.toFixed(0)}%{quotaPct >= 100 ? "（已超出配额，请清理或联系管理员扩容）" : "（接近配额上限，建议清理大文件）"}
        </div>
      )}
      {truncated && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4 text-amber-600 shrink-0" />
          文件总数超过 2000，列表仅显示最新 2000 条 —— 可进入子目录浏览其余文件
        </div>
      )}

      {/* 文件夹路径标签 + 收藏夹页签 */}
      <div className="rounded-lg border bg-card p-2 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="云盘目录标签">
        <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground mr-1 pl-1">
          <FolderOpen className="h-3.5 w-3.5" /> 目录
        </span>
        <TabChip active={active === ""} onClick={() => switchTab("")}>
          根目录
        </TabChip>
        {tabs.map((t) => (
          <TabChip key={t} active={active === t} onClick={() => switchTab(t)} onClose={() => closeTab(t)}>
            <span className="max-w-36 truncate inline-block">{t.split("/").pop() || t}</span>
          </TabChip>
        ))}
        <TabChip active={active === FAV_TAB} onClick={() => switchTab(FAV_TAB)} onClose={active === FAV_TAB ? () => switchTab("") : undefined}>
          <Star className="h-3 w-3 text-amber-500" />
          收藏夹
        </TabChip>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={closeOthers} disabled={tabs.length === 0 && active !== FAV_TAB}>
            关闭其他
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={closeAll} disabled={tabs.length === 0 && active !== FAV_TAB}>
            全部关闭
          </Button>
        </div>
      </div>

      {/* 面包屑 */}
      {breadcrumb.length > 0 && !searching && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap" aria-label="当前目录路径">
          <button type="button" className="hover:text-foreground" onClick={() => switchTab("")}>
            根目录
          </button>
          {breadcrumb.map((b) => (
            <React.Fragment key={b.path}>
              <ChevronRight className="h-3 w-3" />
              <button type="button" className="hover:text-foreground" onClick={() => openFolder(b.path)} title={b.path}>
                {b.seg}
              </button>
            </React.Fragment>
          ))}
        </nav>
      )}

      {/* 文件列表 */}
      <DataTable<ListRow>
        rows={pagedRows}
        total={total}
        page={safePage}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={handleQueryChange}
        onRowClick={onRowClick}
        selectedIds={selected}
        onSelectedChange={(ids) => setSelected(ids.filter((i) => !i.startsWith("folder:")))}
        batchToolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">已选 {selected.length}</Badge>
            <Button size="sm" variant="secondary" onClick={() => setShareRows(selectedFiles)} disabled={busy !== ""}>
              <Share2 className="mr-1 h-3.5 w-3.5" /> 批量分享
            </Button>
            <Button size="sm" variant="outline" onClick={() => void batchUnfavorite()} disabled={busy !== ""}>
              {busy === "unfav" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <StarOff className="mr-1 h-3.5 w-3.5" />}
              批量取消收藏
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setDeleteIds(selected)} disabled={busy !== ""}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 批量删除
            </Button>
          </div>
        }
        filters={[
          {
            key: "category",
            placeholder: "文件类型",
            options: Object.entries(USER_CATEGORY_LABEL).map(([value, label]) => ({ label, value })),
          },
          {
            key: "fav",
            placeholder: "收藏筛选",
            options: [
              { label: "仅收藏", value: "only" },
              { label: "未收藏", value: "none" },
            ],
          },
        ]}
        emptyText={
          active === FAV_TAB
            ? "收藏夹为空 —— 点击文件行的星标加入收藏"
            : searching
              ? "没有匹配的文件"
              : "当前目录为空（上传的文件、录屏与截图会出现在这里）"
        }
        columns={columns}
        rowActions={rowActions}
      />

      {/* 我的分享管理（页内折叠区） */}
      <MySharesPanel version={shareVersion} />

      {/* 预览弹窗 */}
      <PreviewDialog
        row={previewRow}
        open={!!previewRow}
        onOpenChange={(v) => !v && setPreviewRow(null)}
        onEdit={(r) => {
          setPreviewRow(null)
          setEditorRow(r)
        }}
      />

      {/* 文本在线编辑器 */}
      <TextEditorDialog row={editorRow} open={!!editorRow} onOpenChange={(v) => !v && setEditorRow(null)} />

      {/* 分享对话框 */}
      <ShareDialog
        rows={shareRows || []}
        open={!!shareRows && (shareRows?.length ?? 0) > 0}
        onOpenChange={(v) => !v && setShareRows(null)}
        onCreated={() => setShareVersion((n) => n + 1)}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={!!deleteIds && (deleteIds?.length ?? 0) > 0}
        onOpenChange={(v) => !v && setDeleteIds(null)}
        title={`删除 ${deleteIds?.length ?? 0} 个文件（软删除）`}
        destructive
        requirePhrase="DELETE"
        description={
          deleteIds && deleteIds.length > 0
            ? `确认删除选中的 ${deleteIds.length} 个文件？\n文件将进入回收站（保留期内可恢复，到期物理清除），操作全程审计留痕。`
            : ""
        }
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          await batchDelete()
        }}
      />
    </div>
  )
}

// ---- 标签 chip ----
function TabChip({
  active,
  onClick,
  onClose,
  children,
}: {
  active?: boolean
  onClick: () => void
  onClose?: () => void
  children: React.ReactNode
}) {
  return (
    <span
      role="tab"
      aria-selected={active}
      className={`group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors cursor-pointer select-none ${
        active
          ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30 font-medium text-teal-700 dark:text-teal-300"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
      onClick={onClick}
    >
      {children}
      {onClose && (
        <X
          className="h-3 w-3 opacity-40 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="关闭标签"
        />
      )}
    </span>
  )
}

// ---- mime → 图标 ----
function kindIcon(r: UserFileRow) {
  const kind = previewKindOf(r.mime, r.fileName)
  if (kind === "text") return <FileText className="h-4 w-4 text-teal-600 shrink-0" />
  if (kind === "image" || kind === "svg") return <FileImage className="h-4 w-4 text-violet-600 shrink-0" />
  if (kind === "video") return <FileVideo className="h-4 w-4 text-rose-600 shrink-0" />
  if (kind === "audio") return <FileAudio className="h-4 w-4 text-amber-600 shrink-0" />
  if (kind === "pdf") return <FileText className="h-4 w-4 text-red-500 shrink-0" />
  const m = (r.mime || "").toLowerCase()
  if (m.includes("zip") || m.includes("tar") || m.includes("compressed")) return <FileArchive className="h-4 w-4 text-orange-600 shrink-0" />
  return <File className="h-4 w-4 text-muted-foreground shrink-0" />
}
