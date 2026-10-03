"use client"

// ============================================================
// r28 文件管理器通用面板（用户端 /files 与管理端 /admin/files 复用）
// 能力：面包屑导航 / 排序 / 分页 / 多选全选 / 批量删除-移动-复制-压缩
//      / 新建 / 重命名 / 编辑器（MD/TXT/HTML） / 预览（图片-视频-音频-PDF-文本）
//      / 搜索（文件名-内容-递归开关） / 上传 / 下载（限速） / 分享链接
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FileEntry } from "@/lib/file-explorer"
import {
  browseFilesAction, readFileAction, writeFileAction, createEntryAction, renameEntryAction,
  deleteEntriesAction, transferEntriesAction, archiveEntriesAction, extractArchiveAction,
  searchFilesAction, createShareLinkAction, listMyShareLinksAction, revokeShareLinkAction,
} from "@/server/actions/file-explorer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Folder, File, FileText, Image as ImageIcon, Video, Music, Archive, Binary,
  ChevronLeft, ChevronRight, Trash2, RotateCcw, Search, Download, Upload, Plus, Pencil,
  Copy, MoveRight, PackageOpen, Share2, X, Loader2, Home, HardDrive, Server, Eye, Save, ChevronUp,
} from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"

export type Domain = "ROOT_FS" | "STORAGE" | "HOME"

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
function fmtTime(iso: string): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const KIND_ICON: Record<string, React.ReactNode> = {
  dir: <Folder className="h-4 w-4 text-amber-500" />,
  text: <FileText className="h-4 w-4 text-sky-500" />,
  image: <ImageIcon className="h-4 w-4 text-emerald-500" />,
  video: <Video className="h-4 w-4 text-purple-500" />,
  audio: <Music className="h-4 w-4 text-pink-500" />,
  archive: <Archive className="h-4 w-4 text-orange-500" />,
  pdf: <FileText className="h-4 w-4 text-red-500" />,
  binary: <Binary className="h-4 w-4 text-slate-400" />,
}

// ---- 轻量 Markdown 渲染（标题/粗斜/行内代码/代码块/列表/引用/链接/分隔线） ----
function renderMarkdown(src: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const lines = esc(src).split("\n")
  const out: string[] = []
  let inCode = false
  let inList = false
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false }
      out.push(inCode ? "</code></pre>" : '<pre class="bg-muted rounded p-3 overflow-x-auto text-xs"><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(raw); continue }
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, '<code class="bg-muted px-1 rounded text-xs">$1</code>')
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary underline">$1</a>')
    if (/^---+$/.test(line.trim())) { if (inList) { out.push("</ul>"); inList = false }; out.push('<hr class="my-3 border-border"/>'); continue }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      if (inList) { out.push("</ul>"); inList = false }
      const size = ["text-xl", "text-lg", "text-base", "text-sm"][h[1].length - 1]
      out.push(`<div class="${size} font-semibold mt-3 mb-1">${h[2]}</div>`)
      continue
    }
    if (/^[*-]\s+/.test(line)) {
      if (!inList) { out.push('<ul class="list-disc pl-5 my-1 space-y-0.5">'); inList = true }
      out.push(`<li>${line.replace(/^[*-]\s+/, "")}</li>`)
      continue
    }
    if (inList) { out.push("</ul>"); inList = false }
    if (line.trim().startsWith("&gt;")) {
      out.push(`<blockquote class="border-l-2 border-primary/40 pl-3 text-muted-foreground my-1">${line.trim().slice(4)}</blockquote>`)
      continue
    }
    out.push(`<p class="my-1">${line || "&nbsp;"}</p>`)
  }
  if (inList) out.push("</ul>")
  if (inCode) out.push("</code></pre>")
  return out.join("\n")
}

interface EditorState {
  domain: Domain
  path: string
  name: string
  content: string
  truncated: boolean
  dirty: boolean
  mode: "edit" | "preview"
  isHtml: boolean
}

interface SearchState {
  open: boolean
  keyword: string
  recursive: boolean
  content: boolean
  hits: Array<{ rel: string; isDir: boolean; size: number; mtime: string; kind: string; contentLine?: string }>
  tookMs: number
  truncated: boolean
  searched: boolean
}

interface ShareState {
  open: boolean
  target?: FileEntry
  accessMode: "LOGIN" | "PUBLIC" | "USERS"
  expiresDays: number
  maxDownloads: number
  downloadKBps: number
  note: string
  created?: { token: string; url: string; expiresAt: string | null }
}

interface ShareLinkRow {
  token: string; fileName: string; accessMode: string; expiresAt: string | null
  viewCount: number; downloadCount: number; revokedAt: string | null; createdAt: string; url: string
}

export function FileExplorerPanel({ initialDomain, domains }: {
  initialDomain: Domain
  domains: Array<{ key: Domain; label: string; icon: React.ReactNode }>
}) {
  const [domain, setDomain] = useState<Domain>(initialDomain)
  const [curPath, setCurPath] = useState("")
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortBy, setSortBy] = useState<"name" | "size" | "mtime">("name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [keyword, setKeyword] = useState("")
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [canWrite, setCanWrite] = useState(false)

  const [preview, setPreview] = useState<FileEntry | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [searchState, setSearchState] = useState<SearchState>({ open: false, keyword: "", recursive: true, content: false, hits: [], tookMs: 0, truncated: false, searched: false })
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState("")
  const [createType, setCreateType] = useState<"dir" | "file">("dir")
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveName, setArchiveName] = useState("")
  const [archivePassword, setArchivePassword] = useState("")
  const [extractTarget, setExtractTarget] = useState<FileEntry | null>(null)
  const [extractPassword, setExtractPassword] = useState("")
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveMode, setMoveMode] = useState<"move" | "copy">("move")
  const [movePath, setMovePath] = useState("")
  const uploadRef = useRef<HTMLInputElement>(null)
  const [uploadArmed, setUploadArmed] = useState(false)
  const [shareState, setShareState] = useState<ShareState>({ open: false, accessMode: "LOGIN", expiresDays: 7, maxDownloads: 0, downloadKBps: 0, note: "" })
  const [shareLinks, setShareLinks] = useState<ShareLinkRow[]>([])
  const [shareListOpen, setShareListOpen] = useState(false)

  const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await browseFilesAction({
        domain, path: curPath, page, pageSize, sortBy, sortDir,
        keyword: keyword || undefined,
      })
      if (res.code === 0 && res.data) {
        setEntries(res.data.entries)
        setTotal(res.data.total)
        setCanWrite(res.data.canWrite)
        setSelected(new Set())
      } else toast.error(res.msg || "读取目录失败")
    } finally {
      setLoading(false)
    }
  }, [domain, curPath, page, pageSize, sortBy, sortDir, keyword])

  useEffect(() => { void reload() }, [reload])

  const go = (rel: string) => { setCurPath(rel); setPage(1) }
  const pathParts = useMemo(() => (curPath ? curPath.split("/").filter(Boolean) : []), [curPath])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const allChecked = entries.length > 0 && entries.every((e) => selected.has(e.name))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(entries.map((e) => e.name)))
  const toggleOne = (name: string) => {
    const next = new Set(selected)
    if (next.has(name)) { next.delete(name) } else { next.add(name) }
    setSelected(next)
  }
  const selectedEntries = entries.filter((e) => selected.has(e.name))

  const rawUrl = (e: FileEntry, mode: "preview" | "download" | "zip") =>
    `/api/files/raw?domain=${domain}&path=${encodeURIComponent(joinPath(curPath, e.name))}&mode=${mode}`

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`确定删除所选 ${selected.size} 项？删除后进入回收站。`)) return
    const res = await deleteEntriesAction({
      items: selectedEntries.map((e) => ({ domain, path: joinPath(curPath, e.name), isDir: e.isDir })),
    })
    if (res.code === 0) {
      toast.success(`已删除 ${res.data?.deleted || 0} 项${res.data?.failed ? `，${res.data.failed} 项失败` : ""}`)
      void reload()
    } else toast.error(res.msg || "删除失败")
  }

  const handleTransfer = async () => {
    if (selected.size === 0 || !movePath.startsWith("/")) { toast.error("请输入以 / 开头的目标相对路径（域内）"); return }
    const rel = movePath.slice(1)
    const res = await transferEntriesAction({
      items: selectedEntries.map((e) => ({ domain, path: joinPath(curPath, e.name) })),
      destDomain: domain, destDir: rel, mode: moveMode,
    })
    if (res.code === 0) {
      toast.success(`${moveMode === "move" ? "移动" : "复制"} ${res.data?.moved || 0} 项`)
      setMoveOpen(false); setMovePath("")
      void reload()
    } else toast.error(res.msg || "操作失败")
  }

  const handleArchive = async () => {
    if (selected.size === 0) return
    const res = await archiveEntriesAction({
      items: selectedEntries.map((e) => ({ domain, path: joinPath(curPath, e.name) })),
      destDomain: domain, destDir: curPath, archiveName: archiveName || "archive",
      password: archivePassword || undefined,
    })
    if (res.code === 0) {
      toast.success(`已压缩 ${res.data?.archiveName}（${fmtBytes(res.data?.size || 0)}）`)
      setArchiveOpen(false); setArchiveName(""); setArchivePassword("")
      void reload()
    } else toast.error(res.msg || "压缩失败")
  }

  const handleExtract = async () => {
    if (!extractTarget) return
    const res = await extractArchiveAction({ domain, path: joinPath(curPath, extractTarget.name), password: extractPassword || undefined })
    if (res.code === 0) {
      toast.success("解压完成")
      setExtractTarget(null); setExtractPassword("")
      void reload()
    } else toast.error(res.msg || "解压失败")
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    let ok = 0
    for (const f of Array.from(files)) {
      const fd = new FormData()
      fd.append("file", f)
      fd.append("domain", domain)
      fd.append("dir", curPath)
      const res = await fetch("/api/files/upload-explorer", { method: "POST", body: fd }).then((r) => r.json()).catch(() => null)
      if (res?.code === 0) ok++
      else toast.error(`${f.name}: ${res?.msg || "上传失败"}`)
    }
    toast.success(`上传完成 ${ok}/${files.length}`)
    setUploadArmed(false)
    void reload()
  }

  useEffect(() => {
    if (uploadArmed) { uploadRef.current?.click() }
  }, [uploadArmed])

  const openEditor = async (e: FileEntry) => {
    const res = await readFileAction({ domain, path: joinPath(curPath, e.name) })
    if (res.code !== 0 || !res.data) { toast.error(res.msg || "无法读取（可能为二进制或超大）"); return }
    setEditor({
      domain, path: joinPath(curPath, e.name), name: e.name,
      content: res.data.content, truncated: res.data.truncated, dirty: false,
      mode: "edit", isHtml: /\.html?$/i.test(e.name) || /\.md$/i.test(e.name),
    })
  }

  const saveEditor = async () => {
    if (!editor) return
    const res = await writeFileAction({ domain, path: editor.path, content: editor.content })
    if (res.code === 0) {
      toast.success(`已保存（${fmtBytes(res.data?.size || 0)}）`)
      setEditor({ ...editor, dirty: false })
      void reload()
    } else toast.error(res.msg || "保存失败")
  }

  const openPreview = (e: FileEntry) => {
    if (e.kind === "text" || e.kind === "binary") { void openEditor(e); return }
    setPreview(e)
  }

  const runSearch = async () => {
    if (!searchState.keyword.trim()) { toast.error("请输入关键词"); return }
    const res = await searchFilesAction({
      domain, path: curPath, keyword: searchState.keyword,
      recursive: searchState.recursive, content: searchState.content, maxResults: 300,
    })
    if (res.code === 0 && res.data) {
      setSearchState({ ...searchState, hits: res.data.hits, tookMs: res.data.tookMs, truncated: res.data.truncated, searched: true })
    } else toast.error(res.msg || "搜索失败")
  }

  const createShare = async () => {
    if (!shareState.target) return
    const res = await createShareLinkAction({
      domain: domain === "ROOT_FS" ? "STORAGE" : domain,
      path: joinPath(curPath, shareState.target.name),
      accessMode: shareState.accessMode, expiresDays: shareState.expiresDays,
      maxDownloads: shareState.maxDownloads || undefined,
      downloadKBps: shareState.downloadKBps || undefined,
      note: shareState.note || undefined,
    })
    if (res.code === 0 && res.data) {
      setShareState({ ...shareState, created: { token: res.data.token, url: res.data.url, expiresAt: res.data.expiresAt } })
      toast.success("分享链接已创建")
    } else toast.error(res.msg || "创建失败")
  }

  const loadShareLinks = async () => {
    const res = await listMyShareLinksAction()
    setShareLinks((res.data as ShareLinkRow[]) || [])
    setShareListOpen(true)
  }

  const breadcrumb = (
    <div className="flex items-center gap-1 flex-wrap text-sm">
      <button onClick={() => go("")} className={`px-2 py-1 rounded hover:bg-muted flex items-center gap-1 ${curPath === "" ? "bg-muted font-medium" : ""}`}>
        {domain === "ROOT_FS" ? <Server className="h-3.5 w-3.5" /> : domain === "STORAGE" ? <HardDrive className="h-3.5 w-3.5" /> : <Home className="h-3.5 w-3.5" />}
        {domain === "ROOT_FS" ? "根目录" : domain === "STORAGE" ? "存储空间" : "我的空间"}
      </button>
      {pathParts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-muted-foreground">/</span>
          <button onClick={() => go(pathParts.slice(0, i + 1).join("/"))} className={`px-1.5 py-1 rounded hover:bg-muted ${i === pathParts.length - 1 ? "font-medium" : ""}`}>
            {part}
          </button>
        </span>
      ))}
      {curPath && (
        <button onClick={() => go(pathParts.slice(0, -1).join("/"))} className="ml-2 px-1.5 py-1 rounded hover:bg-muted" title="上一级">
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        {domains.length > 1 && (
          <Tabs value={domain} onValueChange={(v) => { setDomain(v as Domain); setCurPath(""); setPage(1) }}>
            <TabsList>
              {domains.map((d) => (
                <TabsTrigger key={d.key} value={d.key} className="gap-1.5">{d.icon}{d.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {domains.length <= 1 && <div className="text-sm font-medium flex items-center gap-1.5">{domains[0]?.icon}{domains[0]?.label}</div>}
        <div className="flex-1 min-w-[200px]">{breadcrumb}</div>
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} placeholder="当前目录过滤…" className="pl-8 h-9" />
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSearchState({ ...searchState, open: !searchState.open })}>
          <Search className="h-3.5 w-3.5" />深度搜索
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSortBy(sortBy === "name" ? "size" : sortBy === "size" ? "mtime" : "name")}>
          排序：{sortBy === "name" ? "名称" : sortBy === "size" ? "大小" : "时间"}{sortDir === "asc" ? "↑" : "↓"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")} title="切换升/降序">{sortDir === "asc" ? "升序" : "降序"}</Button>
        {canWrite && (
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setCreateOpen(true); setCreateName("") }}>
              <Plus className="h-3.5 w-3.5" />新建
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setUploadArmed(true)}>
              <Upload className="h-3.5 w-3.5" />上传
            </Button>
          </>
        )}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void reload()}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}刷新
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void loadShareLinks()}>
          <Share2 className="h-3.5 w-3.5" />我的分享
        </Button>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-muted/50 border">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          {canWrite && (
            <>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => { setMoveMode("move"); setMoveOpen(true) }}><MoveRight className="h-3.5 w-3.5" />移动</Button>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => { setMoveMode("copy"); setMoveOpen(true) }}><Copy className="h-3.5 w-3.5" />复制</Button>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => setArchiveOpen(true)}><Archive className="h-3.5 w-3.5" />压缩</Button>
              <Button variant="destructive" size="sm" className="gap-1" onClick={handleDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}><X className="h-3.5 w-3.5" />取消</Button>
        </div>
      )}

      {/* 深度搜索面板 */}
      {searchState.open && (
        <div className="p-3 rounded-lg border bg-card space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <Input
              value={searchState.keyword}
              onChange={(e) => setSearchState({ ...searchState, keyword: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch() }}
              placeholder={`搜索「${curPath || "根目录"}」下的文件…`}
              className="flex-1 min-w-[200px] max-w-md"
            />
            <label className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={searchState.recursive} onCheckedChange={(v) => setSearchState({ ...searchState, recursive: !!v })} />含子目录
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={searchState.content} onCheckedChange={(v) => setSearchState({ ...searchState, content: !!v })} />搜索内容
            </label>
            <Button size="sm" onClick={() => void runSearch()} className="gap-1.5"><Search className="h-3.5 w-3.5" />搜索</Button>
            <Button variant="ghost" size="sm" onClick={() => setSearchState({ ...searchState, open: false, hits: [], searched: false })}><X className="h-3.5 w-3.5" /></Button>
          </div>
          {searchState.searched && (
            <div className="text-xs text-muted-foreground">
              命中 {searchState.hits.length} 项 · 耗时 {searchState.tookMs}ms{searchState.truncated ? "（结果已截断，建议缩小范围）" : ""}
            </div>
          )}
          {searchState.hits.length > 0 && (
            <div className="max-h-60 overflow-y-auto rounded border divide-y">
              {searchState.hits.map((h) => (
                <button key={h.rel} className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex items-center gap-2" onClick={() => {
                  const dir = h.rel.split("/").slice(0, -1).join("/")
                  go(dir)
                  setSearchState({ ...searchState, open: false })
                }}>
                  {KIND_ICON[h.kind] || <File className="h-4 w-4" />}
                  <span className="truncate flex-1">{h.rel}</span>
                  {h.contentLine && <span className="truncate text-xs text-muted-foreground max-w-40 hidden md:inline">{h.contentLine}</span>}
                  <span className="text-xs text-muted-foreground shrink-0">{h.isDir ? "-" : fmtBytes(h.size)}</span>
                </button>
              ))}
            </div>
          )}
          {searchState.searched && searchState.hits.length === 0 && (
            <div className="text-sm text-muted-foreground py-4 text-center">无匹配结果{searchState.content ? "（含内容搜索）" : ""}</div>
          )}
        </div>
      )}

      {/* 文件列表 */}
      <div className="rounded-lg border bg-card">
        <div className={entries.length > 10 ? "max-h-[58vh] overflow-y-auto" : ""}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10">
              <tr className="border-b">
                <th className="w-10 p-2"><Checkbox checked={allChecked} onCheckedChange={toggleAll} /></th>
                <th className="text-left p-2 font-medium">名称</th>
                <th className="text-left p-2 font-medium w-24 hidden sm:table-cell">大小</th>
                <th className="text-left p-2 font-medium w-36 hidden md:table-cell">修改时间</th>
                <th className="text-left p-2 font-medium w-24 hidden lg:table-cell">类型</th>
                <th className="text-right p-2 font-medium w-52">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const path = joinPath(curPath, e.name)
                const isSel = selected.has(e.name)
                return (
                  <tr key={e.name} className={`border-b last:border-0 hover:bg-muted/40 ${isSel ? "bg-primary/5" : ""}`}>
                    <td className="p-2"><Checkbox checked={isSel} onCheckedChange={() => toggleOne(e.name)} /></td>
                    <td className="p-2 max-w-0">
                      <button className="flex items-center gap-2 text-left min-w-0 group" onClick={() => { if (e.isDir) go(path); else openPreview(e) }}>
                        {KIND_ICON[e.kind] || <File className="h-4 w-4" />}
                        <span className="truncate font-medium group-hover:underline" title={path}>{e.name}</span>
                      </button>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground hidden sm:table-cell">{e.isDir ? "-" : fmtBytes(e.size)}</td>
                    <td className="p-2 text-xs text-muted-foreground hidden md:table-cell">{fmtTime(e.mtime)}</td>
                    <td className="p-2 text-xs text-muted-foreground hidden lg:table-cell">{e.isDir ? "目录" : e.kind}</td>
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-0.5">
                        {!e.isDir && (
                          <>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="预览" onClick={() => openPreview(e)}><Eye className="h-3.5 w-3.5" /></Button>
                            {(e.kind === "text" || e.kind === "binary") && canWrite && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" title="编辑" onClick={() => void openEditor(e)}><Pencil className="h-3.5 w-3.5" /></Button>
                            )}
                            <a href={rawUrl(e, "download")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" title="下载"><Download className="h-3.5 w-3.5" /></a>
                          </>
                        )}
                        {e.isDir && (
                          <a href={rawUrl(e, "zip")} className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" title="打包下载 ZIP"><Archive className="h-3.5 w-3.5" /></a>
                        )}
                        {e.kind === "archive" && canWrite && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="解压" onClick={() => { setExtractTarget(e); setExtractPassword("") }}><PackageOpen className="h-3.5 w-3.5" /></Button>
                        )}
                        {(domain === "HOME" || domain === "STORAGE") && !e.isDir && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="分享" onClick={() => { setShareState({ open: true, target: e, accessMode: "LOGIN", expiresDays: 7, maxDownloads: 0, downloadKBps: 0, note: "" }) }}><Share2 className="h-3.5 w-3.5" /></Button>
                        )}
                        {canWrite && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="重命名" onClick={() => { setRenameTarget(e); setRenameValue(e.name) }}><Pencil className="h-3.5 w-3.5" /></Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {entries.length === 0 && !loading && (
                <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">空目录</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-t">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>共 {total} 项 · 第 {page}/{totalPages} 页</span>
            <select value={pageSize} onChange={(ev) => { setPageSize(Number(ev.target.value)); setPage(1) }} className="h-7 rounded border bg-background px-1">
              {[20, 50, 100, 200].map((n) => <option key={n} value={n}>每页 {n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(1)}>首页</Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <input type="number" min={1} max={totalPages} value={page} onChange={(ev) => setPage(Math.min(Math.max(1, Number(ev.target.value) || 1), totalPages))} className="h-7 w-14 rounded border bg-background text-center text-xs" aria-label="跳转" />
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>尾页</Button>
          </div>
        </div>
      </div>

      {/* 隐藏上传 input */}
      <input ref={uploadRef} type="file" multiple className="hidden" onChange={(e) => void handleUpload(e.target.files)} />

      {/* ====== 编辑器弹窗 ====== */}
      {editor && (
        <Dialog open onOpenChange={(v) => { if (!v) { if (!editor.dirty || confirm("有未保存修改，确定关闭？")) setEditor(null) } }}>
          <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Pencil className="h-4 w-4" />{editor.name}
                {editor.truncated && <span className="text-xs text-amber-500">（超过 2MB 已截断显示）</span>}
                {editor.dirty && <span className="text-xs text-red-500">●未保存</span>}
              </DialogTitle>
            </DialogHeader>
            {editor.isHtml && (
              <Tabs value={editor.mode} onValueChange={(v) => setEditor({ ...editor, mode: v as "edit" | "preview" })}>
                <TabsList>
                  <TabsTrigger value="edit">编辑</TabsTrigger>
                  <TabsTrigger value="preview">预览</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            <div className="flex-1 min-h-0">
              {editor.mode === "edit" || !editor.isHtml ? (
                <textarea
                  value={editor.content}
                  onChange={(ev) => setEditor({ ...editor, content: ev.target.value, dirty: true })}
                  className="w-full h-[52vh] font-mono text-xs p-3 rounded border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  spellCheck={false}
                />
              ) : /\.html?$/i.test(editor.name) ? (
                <iframe srcDoc={editor.content} sandbox="allow-same-origin" className="w-full h-[52vh] rounded border bg-white" title="HTML 预览" />
              ) : (
                <div className="h-[52vh] overflow-y-auto p-4 rounded border bg-background">
                  <div className="max-w-none text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(editor.content) }} />
                </div>
              )}
            </div>
            <DialogFooter>
              <span className="text-xs text-muted-foreground mr-auto">{fmtBytes(new Blob([editor.content]).size)}</span>
              {editor.mode === "preview" && <Button variant="outline" size="sm" onClick={() => setEditor({ ...editor, mode: "edit" })}>返回编辑</Button>}
              <Button size="sm" className="gap-1.5" onClick={() => void saveEditor()} disabled={!editor.dirty}><Save className="h-3.5 w-3.5" />保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 预览弹窗 ====== */}
      {preview && (
        <Dialog open onOpenChange={(v) => { if (!v) setPreview(null) }}>
          <DialogContent className="max-w-4xl">
            <DialogHeader><DialogTitle className="flex items-center gap-2 text-base">{KIND_ICON[preview.kind]}{preview.name}</DialogTitle></DialogHeader>
            <div className="flex items-center justify-center bg-black/5 rounded p-2 min-h-[200px]">
              {preview.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={rawUrl(preview, "preview")} alt={preview.name} className="max-h-[64vh] max-w-full object-contain" />
              )}
              {preview.kind === "video" && <video src={rawUrl(preview, "preview")} controls className="max-h-[64vh] w-full" />}
              {preview.kind === "audio" && <audio src={rawUrl(preview, "preview")} controls className="w-full" />}
              {preview.kind === "pdf" && <iframe src={rawUrl(preview, "preview")} className="w-full h-[64vh] rounded" title={preview.name} />}
            </div>
            <DialogFooter>
              <span className="text-xs text-muted-foreground mr-auto">{fmtBytes(preview.size)}</span>
              <a href={rawUrl(preview, "download")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 text-sm hover:bg-primary/90"><Download className="h-3.5 w-3.5" />下载</a>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 新建弹窗 ====== */}
      {createOpen && (
        <Dialog open onOpenChange={setCreateOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>新建{createType === "dir" ? "文件夹" : "文件"}</DialogTitle></DialogHeader>
            <Tabs value={createType} onValueChange={(v) => setCreateType(v as "dir" | "file")}>
              <TabsList className="w-full">
                <TabsTrigger value="dir" className="flex-1 gap-1.5"><Folder className="h-3.5 w-3.5" />文件夹</TabsTrigger>
                <TabsTrigger value="file" className="flex-1 gap-1.5"><FileText className="h-3.5 w-3.5" />文件</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={createType === "dir" ? "文件夹名称" : "文件名.txt"} autoFocus />
            <DialogFooter>
              <Button size="sm" onClick={async () => {
                const res = await createEntryAction({ domain, dir: curPath, name: createName, type: createType })
                if (res.code === 0) { toast.success("已创建"); setCreateOpen(false); void reload() }
                else toast.error(res.msg || "创建失败")
              }}>创建</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 重命名弹窗 ====== */}
      {renameTarget && (
        <Dialog open onOpenChange={(v) => { if (!v) setRenameTarget(null) }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>重命名</DialogTitle></DialogHeader>
            <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
            <DialogFooter>
              <Button size="sm" onClick={async () => {
                const res = await renameEntryAction({ domain, path: joinPath(curPath, renameTarget.name), newName: renameValue })
                if (res.code === 0) { toast.success("已重命名"); setRenameTarget(null); void reload() }
                else toast.error(res.msg || "重命名失败")
              }}>确定</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 压缩弹窗 ====== */}
      {archiveOpen && (
        <Dialog open onOpenChange={setArchiveOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>压缩 {selected.size} 项</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Input value={archiveName} onChange={(e) => setArchiveName(e.target.value)} placeholder="压缩包名称（自动加 .zip）" />
              <Input value={archivePassword} onChange={(e) => setArchivePassword(e.target.value)} placeholder="密码（可选，加密压缩包）" type="password" />
            </div>
            <DialogFooter>
              <Button size="sm" onClick={() => void handleArchive()}>开始压缩</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 解压弹窗 ====== */}
      {extractTarget && (
        <Dialog open onOpenChange={(v) => { if (!v) setExtractTarget(null) }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>解压 {extractTarget.name}</DialogTitle></DialogHeader>
            <div className="text-xs text-muted-foreground">解压到当前目录下同名文件夹</div>
            <Input value={extractPassword} onChange={(e) => setExtractPassword(e.target.value)} placeholder="密码（加密压缩包填写）" type="password" />
            <DialogFooter>
              <Button size="sm" onClick={() => void handleExtract()}>解压</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 移动/复制弹窗 ====== */}
      {moveOpen && (
        <Dialog open onOpenChange={setMoveOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>{moveMode === "move" ? "移动" : "复制"} {selected.size} 项</DialogTitle></DialogHeader>
            <div className="text-xs text-muted-foreground">输入{domain === "ROOT_FS" ? "容器" : domain === "STORAGE" ? "存储" : "我的空间"}域内目标路径（以 / 开头）</div>
            <Input value={movePath} onChange={(e) => setMovePath(e.target.value)} placeholder="/target/dir" autoFocus />
            <DialogFooter>
              <Button size="sm" onClick={() => void handleTransfer()}>{moveMode === "move" ? "移动" : "复制"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 分享弹窗 ====== */}
      {shareState.open && shareState.target && (
        <Dialog open onOpenChange={(v) => { if (!v) setShareState({ ...shareState, open: false, created: undefined }) }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><Share2 className="h-4 w-4" />分享「{shareState.target.name}」</DialogTitle></DialogHeader>
            {shareState.created ? (
              <div className="space-y-3">
                <div className="p-3 rounded border bg-muted/50 break-all font-mono text-xs">{shareState.created.url}</div>
                <div className="text-xs text-muted-foreground">
                  有效期：{shareState.created.expiresAt ? new Date(shareState.created.expiresAt).toLocaleString("zh-CN") : "永久"}
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  void navigator.clipboard.writeText(`${location.origin}${shareState.created!.url}`)
                  toast.success("链接已复制")
                }}>复制完整链接</Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[90px_1fr] items-center gap-2 text-sm">
                  <span>访问权限</span>
                  <select value={shareState.accessMode} onChange={(e) => setShareState({ ...shareState, accessMode: e.target.value as "LOGIN" | "PUBLIC" | "USERS" })} className="h-8 rounded border bg-background px-2 text-sm">
                    <option value="LOGIN">需登录</option>
                    <option value="PUBLIC">免登录（公开）</option>
                    <option value="USERS">指定用户</option>
                  </select>
                  <span>有效期</span>
                  <select value={String(shareState.expiresDays)} onChange={(e) => setShareState({ ...shareState, expiresDays: Number(e.target.value) })} className="h-8 rounded border bg-background px-2 text-sm">
                    <option value="0">永久有效</option>
                    <option value="1">1 天</option>
                    <option value="7">7 天</option>
                    <option value="30">30 天</option>
                    <option value="90">90 天</option>
                    <option value="365">365 天</option>
                  </select>
                  <span>下载上限</span>
                  <Input type="number" min={0} value={shareState.maxDownloads} onChange={(e) => setShareState({ ...shareState, maxDownloads: Number(e.target.value) })} placeholder="0=不限次" className="h-8" />
                  <span>下载限速</span>
                  <Input type="number" min={0} value={shareState.downloadKBps} onChange={(e) => setShareState({ ...shareState, downloadKBps: Number(e.target.value) })} placeholder="0=不限速（KB/s）" className="h-8" />
                  <span>备注</span>
                  <Input value={shareState.note} onChange={(e) => setShareState({ ...shareState, note: e.target.value })} placeholder="可选" className="h-8" />
                </div>
              </div>
            )}
            <DialogFooter>
              {!shareState.created && <Button size="sm" onClick={() => void createShare()}>创建链接</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 我的分享列表 ====== */}
      {shareListOpen && (
        <Dialog open onOpenChange={setShareListOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader><DialogTitle>我的分享链接</DialogTitle></DialogHeader>
            <table className="w-full text-xs">
              <thead className="bg-muted/50"><tr className="border-b">
                <th className="text-left p-2">文件</th><th className="text-left p-2">权限</th>
                <th className="text-left p-2">有效期</th><th className="text-left p-2">查看/下载</th>
                <th className="text-right p-2">操作</th>
              </tr></thead>
              <tbody>
                {shareLinks.map((l) => (
                  <tr key={l.token} className={`border-b ${l.revokedAt ? "opacity-50" : ""}`}>
                    <td className="p-2 truncate max-w-0" title={l.fileName}>{l.fileName}</td>
                    <td className="p-2">{l.accessMode === "PUBLIC" ? "免登录" : l.accessMode === "USERS" ? "指定用户" : "需登录"}</td>
                    <td className="p-2">{l.revokedAt ? "已撤销" : l.expiresAt ? new Date(l.expiresAt).toLocaleDateString("zh-CN") : "永久"}</td>
                    <td className="p-2">{l.viewCount}/{l.downloadCount}</td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => {
                          void navigator.clipboard.writeText(`${location.origin}/api/files/share/${l.token}`)
                          toast.success("已复制")
                        }}>复制</Button>
                        {!l.revokedAt && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs text-red-500" onClick={async () => {
                            const res = await revokeShareLinkAction({ token: l.token })
                            if (res.code === 0) { toast.success("已撤销"); void loadShareLinks() }
                          }}>撤销</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {shareLinks.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">暂无分享</td></tr>}
              </tbody>
            </table>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
