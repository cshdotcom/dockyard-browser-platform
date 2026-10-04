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
  listShareTargetOptionsAction, extendShareLinkAction,
} from "@/server/actions/file-explorer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MultiSelectPopover } from "@/components/shared/multi-select-popover"
import { getFileExplorerPrefsAction, saveFileExplorerPrefsAction, type ExplorerFavorite, type ExplorerTabPref } from "@/server/actions/explorer-prefs"
import { SuperEditor } from "./super-editor"
import { ImageCropperDialog } from "./image-cropper"
import {
  Folder, File, FileText, Image as ImageIcon, Video, Music, Archive, Binary,
  ChevronLeft, ChevronRight, Trash2, RotateCcw, Search, Download, Upload, Plus, Pencil,
  Copy, MoveRight, PackageOpen, Share2, X, Loader2, Home, HardDrive, Server, Eye, Save, ChevronUp, ChevronDown, Clock, Crop,
  Star, MoreVertical, FolderInput,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type Domain = "ROOT_FS" | "STORAGE" | "HOME" | "RECORDING" | "SCREENSHOT"

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
  customExpiry: string // r31：自定义到期时刻（datetime-local 原始值；非空时优先）
  maxDownloads: number
  downloadKBps: number
  note: string
  allowedUserIds: string[] // r31：用户多选
  allowedGroupIds: string[] // r31：用户组多选
  created?: { token: string; url: string; expiresAt: string | null }
}

interface ShareLinkRow {
  token: string; fileName: string; isDir: boolean; accessMode: string; expiresAt: string | null
  viewCount: number; downloadCount: number; revokedAt: string | null; createdAt: string; url: string
}

interface ShareTargets {
  users: Array<{ id: string; username: string; displayName: string | null }>
  groups: Array<{ id: string; name: string; memberCount: number }>
}

export function FileExplorerPanel({ initialDomain, initialPath, domains, focusFileName }: {
  initialDomain: Domain
  initialPath?: string // r31：深链定位（如 /admin/files?path=home/<userId> 用户资料直达）
  domains: Array<{ key: Domain; label: string; icon: React.ReactNode }>
  focusFileName?: string // r33：?focus=<FileMetaId> 深链：目录载入后自动选中并高亮该文件
}) {
  const [domain, setDomain] = useState<Domain>(initialDomain)
  const [curPath, setCurPath] = useState(
    initialPath && initialPath !== "/" ? initialPath.replace(/^\/+/, "").replace(/\/+$/, "") : "",
  )
  // —— r31：多标签页 + 收藏夹 + 跨端同步 ——
  const [tabs, setTabs] = useState<ExplorerTabPref[]>([{ id: "t1", domain: initialDomain, path: initialPath ? initialPath.replace(/^\/+/, "").replace(/\/+$/, "") : "" }])
  const [activeTabId, setActiveTabId] = useState("t1")
  const [favorites, setFavorites] = useState<ExplorerFavorite[]>([])
  // r34：收藏夹折叠（>8 条）与搜索
  const [favExpanded, setFavExpanded] = useState(false)
  const [favSearchOpen, setFavSearchOpen] = useState(false)
  const [favSearch, setFavSearch] = useState("")
  // r34：标签页搜索 + 多选批量关闭
  const [tabSearchOpen, setTabSearchOpen] = useState(false)
  const [tabSearch, setTabSearch] = useState("")
  const [tabSelIds, setTabSelIds] = useState<Set<string>>(new Set())
  const prefsLoadedRef = useRef(false)
  const prefsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const allowedDomains = useMemo(() => new Set(domains.map((d) => d.key)), [domains])
  const domainLabel = (d: Domain) => d === "ROOT_FS" ? "根目录" : d === "STORAGE" ? "存储空间" : d === "RECORDING" ? "我的录像" : d === "SCREENSHOT" ? "我的截图" : "我的空间"
  const tabTitle = (t: ExplorerTabPref) => (t.path ? t.path.split("/").filter(Boolean).pop() || t.path : domainLabel(t.domain))

  // 载入用户偏好（首次挂载：恢复上次会话的多标签与收藏夹 → 跨端同步）
  useEffect(() => {
    if (prefsLoadedRef.current) return
    prefsLoadedRef.current = true
    ;(async () => {
      const res = await getFileExplorerPrefsAction()
      const data = res.data
      if (res.code !== 0 || !data) return
      // r31 深链优先：外层携带 initialPath 时忽略持久化的激活标签，直接定位深链目录
      if (initialPath) {
        setFavorites(data.favorites)
        const next = [{ id: "t1", domain: initialDomain, path: initialPath.replace(/^\/+/, "").replace(/\/+$/, "") }]
        setTabs(next)
        return
      }
      setFavorites(data.favorites)
      // 过滤当前用户可用的域（用户端无 STORAGE/ROOT_FS 权限时回退）
      const restored = data.openTabs
        .map((t) => ({ ...t, domain: (allowedDomains.has(t.domain) ? t.domain : initialDomain) as Domain }))
      setTabs(restored)
      const active = restored.find((t) => t.id === data.activeTabId) || restored[0]
      if (active) {
        setActiveTabId(active.id)
        setDomain(active.domain as Domain)
        setCurPath(active.path)
      }
    })().catch(() => null)
  }, [allowedDomains, initialDomain])

  // 偏好保存（去抖 1.2s：标签/收藏/激活态变化即同步到账号 → 任意设备恢复）
  const schedulePrefsSave = useCallback((next: { tabs?: ExplorerTabPref[]; activeTabId?: string; favorites?: ExplorerFavorite[] }) => {
    if (!prefsLoadedRef.current) return
    if (prefsSaveTimer.current) clearTimeout(prefsSaveTimer.current)
    prefsSaveTimer.current = setTimeout(() => {
      void saveFileExplorerPrefsAction({
        favorites: next.favorites ?? favorites,
        openTabs: next.tabs ?? tabs,
        activeTabId: next.activeTabId ?? activeTabId,
      }).then((res) => {
        if (res.code !== 0) { /* 静默：不影响本地使用 */ }
      }).catch(() => null)
    }, 1200)
  }, [favorites, tabs, activeTabId])

  // —— 标签操作：切换/新建/关闭/关闭其他/全部关闭 ——
  const switchTab = (tabId: string) => {
    const t = tabs.find((x) => x.id === tabId)
    if (!t || tabId === activeTabId) return
    setActiveTabId(tabId)
    setDomain(t.domain as Domain)
    setCurPath(t.path)
    setPage(1)
    schedulePrefsSave({ activeTabId: tabId })
  }
  const openNewTab = (d: Domain, path: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const next = [...tabs, { id, domain: d, path }].slice(-12) // 上限 12 个
    setTabs(next)
    setActiveTabId(id)
    setDomain(d)
    setCurPath(path)
    setPage(1)
    schedulePrefsSave({ tabs: next, activeTabId: id })
  }
  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) { toast.info("至少保留一个标签页"); return }
    const idx = tabs.findIndex((t) => t.id === tabId)
    const next = tabs.filter((t) => t.id !== tabId)
    setTabs(next)
    schedulePrefsSave({ tabs: next })
    if (tabId === activeTabId) {
      const fallback = next[Math.max(0, idx - 1)]
      setActiveTabId(fallback.id)
      setDomain(fallback.domain as Domain)
      setCurPath(fallback.path)
      setPage(1)
      schedulePrefsSave({ tabs: next, activeTabId: fallback.id })
    }
  }
  // r34：标签多选切换
  const toggleTabSel = (tabId: string) => {
    setTabSelIds((s) => {
      const next = new Set(s)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      return next
    })
  }

  // r34：批量关闭选中标签（至少保留 1 个）
  const closeTabBatch = (ids: string[]) => {
    if (ids.length >= tabs.length) { toast.info("至少保留一个标签页（可先新建再批量关闭）"); return }
    const next = tabs.filter((t) => !ids.includes(t.id))
    setTabs(next)
    setTabSelIds(new Set())
    if (ids.includes(activeTabId)) {
      setActiveTabId(next[0].id)
      setDomain(next[0].domain as Domain)
      setCurPath(next[0].path)
    }
    schedulePrefsSave({ tabs: next, activeTabId: ids.includes(activeTabId) ? next[0].id : activeTabId })
    toast.success(`已批量关闭 ${ids.length} 个标签页`)
  }

  const closeOtherTabs = () => {
    const active = tabs.find((t) => t.id === activeTabId)!
    const next = [active]
    setTabs(next)
    schedulePrefsSave({ tabs: next })
    toast.success("已关闭其他标签页")
  }
  const closeAllTabs = () => {
    const next = [{ id: `t-${Date.now()}`, domain: initialDomain, path: "" }]
    setTabs(next)
    setActiveTabId(next[0].id)
    setDomain(initialDomain)
    setCurPath("")
    setPage(1)
    schedulePrefsSave({ tabs: next, activeTabId: next[0].id })
    toast.success("已关闭全部标签（新开一个）")
  }

  // —— 收藏夹：收藏当前目录 / 移除 / 跳转 ——
  const toggleFavoriteCurrent = () => {
    const exists = favorites.find((f) => f.domain === domain && f.path === curPath)
    if (exists) {
      const next = favorites.filter((f) => f.id !== exists.id)
      setFavorites(next)
      schedulePrefsSave({ favorites: next })
      toast.success("已从收藏夹移除")
      return
    }
    if (favorites.length >= 60) { toast.error("收藏夹已达上限（60）"); return }
    const fav: ExplorerFavorite = {
      id: `f-${Date.now()}`,
      domain,
      path: curPath,
      title: curPath ? (curPath.split("/").filter(Boolean).pop() || curPath) : domainLabel(domain),
    }
    const next = [...favorites, fav]
    setFavorites(next)
    schedulePrefsSave({ favorites: next })
    toast.success(`已收藏「${fav.title}」（跨设备同步）`)
  }
  const removeFavorite = (id: string) => {
    const next = favorites.filter((f) => f.id !== id)
    setFavorites(next)
    schedulePrefsSave({ favorites: next })
  }
  const gotoFavorite = (f: ExplorerFavorite) => {
    const d = (allowedDomains.has(f.domain) ? f.domain : initialDomain) as Domain
    // 在当前标签页打开（目录跳转）
    setDomain(d)
    setCurPath(d === f.domain ? f.path : "")
    setPage(1)
    // 同步到当前标签
    setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, domain: d, path: d === f.domain ? f.path : "" } : t)))
  }
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
  // r33：focus 深链定位（一次性：命中后自动选中 + 高亮 + 滚动到可见）
  const [focusHit, setFocusHit] = useState(false)
  const focusAppliedRef = useRef(false)
  const focusRowRef = useRef<HTMLTableRowElement | null>(null)
  useEffect(() => {
    if (focusHit && focusRowRef.current) {
      focusRowRef.current.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [focusHit])

  const [preview, setPreview] = useState<FileEntry | null>(null)
  const [cropTarget, setCropTarget] = useState<FileEntry | null>(null)
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
  const [shareState, setShareState] = useState<ShareState>({ open: false, accessMode: "LOGIN", expiresDays: 7, customExpiry: "", maxDownloads: 0, downloadKBps: 0, note: "", allowedUserIds: [], allowedGroupIds: [] })
  const [shareLinks, setShareLinks] = useState<ShareLinkRow[]>([])
  const [shareListOpen, setShareListOpen] = useState(false)
  // r31：分享目标选项（用户+组；USERS 模式双多选可搜索）
  const [shareTargets, setShareTargets] = useState<ShareTargets>({ users: [], groups: [] })
  const [extendTarget, setExtendTarget] = useState<ShareLinkRow | null>(null)
  const [extendValue, setExtendValue] = useState("")

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
        // r33：focus 深链 —— 首次载入后自动选中并高亮目标文件（通知直达/录像「更多」入口；仅一次）
        if (focusFileName && !focusAppliedRef.current && res.data.entries.some((e) => e.name === focusFileName)) {
          focusAppliedRef.current = true
          setSelected(new Set([focusFileName]))
          setFocusHit(true)
        } else {
          setSelected(new Set())
        }
      } else toast.error(res.msg || "读取目录失败")
    } finally {
      setLoading(false)
    }
  }, [domain, curPath, page, pageSize, sortBy, sortDir, keyword, focusFileName])

  useEffect(() => { void reload() }, [reload])

  const go = (rel: string) => {
    setCurPath(rel)
    setPage(1)
    // 同步到当前标签（保持标签页与导航一致）
    setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, path: rel } : t)))
  }
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

  // r34：上传进度跟踪 + 可取消（用户诉求：上传进度查看并可操作）
  const [uploads, setUploads] = useState<Array<{ name: string; size: number; sent: number; status: "uploading" | "done" | "error" | "cancelled"; msg?: string }>>([])
  const activeXhrRef = useRef<XMLHttpRequest | null>(null) // 当前正在上传的 XHR（可中断）

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const initial = Array.from(files).map((f) => ({ name: f.name, size: f.size, sent: 0, status: "uploading" as const }))
    setUploads(initial)
    let ok = 0
    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx]
      const patch = (up: Partial<{ sent: number; status: "uploading" | "done" | "error" | "cancelled"; msg?: string }>) =>
        setUploads((us) => us.map((u, i) => (i === idx ? { ...u, ...up } : u)))
      // 前序已被取消的文件直接跳过（不发起请求）
      if (uploadsRef.current?.[idx]?.status === "cancelled") continue
      // XHR：progress 事件 + 可 abort（fetch 无进度且不可取消）
      const result = await new Promise<{ code: number; msg?: string }>((resolve) => {
        const fd = new FormData()
        fd.append("file", f)
        fd.append("domain", domain)
        fd.append("dir", curPath)
        const xhr = new XMLHttpRequest()
        activeXhrRef.current = xhr
        xhr.open("POST", "/api/files/upload-explorer")
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) patch({ sent: ev.loaded })
        }
        xhr.onload = () => {
          try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({ code: 1, msg: "上传响应解析失败" }) }
        }
        xhr.onerror = () => resolve({ code: 1, msg: "网络错误" })
        xhr.onabort = () => resolve({ code: 1, msg: "已取消" })
        xhr.send(fd)
      })
      activeXhrRef.current = null
      if (result.code === 0) { ok++; patch({ status: "done", sent: f.size }) }
      else patch({ status: result.msg === "已取消" ? "cancelled" : "error", msg: result.msg })
    }
    toast.success(`上传完成 ${ok}/${files.length}`)
    setUploadArmed(false)
    // 保留进度条 8 秒供查看后自动清理
    setTimeout(() => setUploads([]), 8000)
    void reload()
  }

  // 上传状态只读镜像（串行批次里读取当前标记）
  const uploadsRef = useRef<Array<{ name: string; size: number; sent: number; status: string; msg?: string }>>([])
  useEffect(() => { uploadsRef.current = uploads }, [uploads])

  const cancelUpload = (name: string) => {
    // 中断进行中的 XHR + 标记批次中同名目标为取消（串行队列后续跳过）
    try { activeXhrRef.current?.abort() } catch { /* noop */ }
    setUploads((us) => us.map((u) => (u.name === name && u.status === "uploading" ? { ...u, status: "cancelled", msg: "已取消" } : u)))
    toast.info(`已取消：${name}`)
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
    if (shareState.accessMode === "USERS" && shareState.allowedUserIds.length === 0 && shareState.allowedGroupIds.length === 0) {
      toast.error("USERS 模式需至少选择一位用户或一个用户组")
      return
    }
    // 自定义到期时刻（datetime-local 原始值 → ISO；含时区信息由用户本地时区解释）
    let expiresAtIso: string | undefined
    if (shareState.customExpiry) {
      const t = new Date(shareState.customExpiry).getTime()
      if (!Number.isFinite(t) || t <= Date.now() + 60_000) {
        toast.error("自定义到期时间必须晚于当前时间至少 1 分钟")
        return
      }
      expiresAtIso = new Date(t).toISOString()
    }
    const res = await createShareLinkAction({
      domain: domain === "ROOT_FS" ? "STORAGE" : domain,
      path: joinPath(curPath, shareState.target.name),
      accessMode: shareState.accessMode,
      expiresDays: expiresAtIso ? 0 : shareState.expiresDays,
      ...(expiresAtIso ? { expiresAt: expiresAtIso } : {}),
      ...(shareState.accessMode === "USERS" ? { allowedUserIds: shareState.allowedUserIds, allowedGroupIds: shareState.allowedGroupIds } : {}),
      maxDownloads: shareState.maxDownloads || undefined,
      downloadKBps: shareState.downloadKBps || undefined,
      note: shareState.note || undefined,
    })
    if (res.code === 0 && res.data) {
      setShareState({ ...shareState, created: { token: res.data.token, url: res.data.url, expiresAt: res.data.expiresAt } })
      toast.success("分享链接已创建")
    } else toast.error(res.msg || "创建失败")
  }

  // r31：打开分享弹窗时预取目标选项（用户+组）
  const openShareDialog = async (e: FileEntry) => {
    setShareState({ open: true, target: e, accessMode: "LOGIN", expiresDays: 7, customExpiry: "", maxDownloads: 0, downloadKBps: 0, note: "", allowedUserIds: [], allowedGroupIds: [] })
    if (shareTargets.users.length === 0 && shareTargets.groups.length === 0) {
      const res = await listShareTargetOptionsAction({})
      if (res.code === 0 && res.data) setShareTargets({ users: res.data.users, groups: res.data.groups })
    }
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
          <Tabs value={domain} onValueChange={(v) => {
            const d = v as Domain
            setDomain(d); setCurPath(""); setPage(1)
            setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, domain: d, path: "" } : t)))
            schedulePrefsSave({})
          }}>
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

      {/* ====== r31：多标签页条（新建/切换/关闭/关闭其他/全部关闭；会话跨设备同步） ====== */}
      {/* r34：新增标签搜索 + 多选批量关闭（用户诉求：标签页太多可搜索/批量操作） */}
      <div className="flex items-center gap-1 border-b pb-1.5 overflow-x-auto scrollbar-none">
        <div className="flex items-center gap-0.5 min-w-0">
          {(tabSearchOpen ? tabs.filter((t) => {
            const q = tabSearch.trim().toLowerCase()
            if (!q) return true
            return (tabTitle(t) || "").toLowerCase().includes(q) || (t.path || "").toLowerCase().includes(q) || domainLabel(t.domain as Domain).toLowerCase().includes(q)
          }) : tabs).map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => tabSelIds.size > 0 ? toggleTabSel(t.id) : switchTab(t.id)
              }
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") switchTab(t.id) }}
              className={`group flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${
                t.id === activeTabId ? "bg-primary/10 border-primary/30 text-primary font-medium" : "bg-muted/40 border-border text-muted-foreground hover:bg-muted"
              } ${tabSelIds.has(t.id) ? "ring-1 ring-teal-400" : ""}`}
              title={`${domainLabel(t.domain as Domain)}${t.path ? ` / ${t.path}` : ""}`}
            >
              {tabSelIds.size > 0 && (
                <Checkbox checked={tabSelIds.has(t.id)} onCheckedChange={() => toggleTabSel(t.id)} className="h-3 w-3" />
              )}
              {t.domain === "ROOT_FS" ? <Server className="h-3 w-3 shrink-0" /> : t.domain === "STORAGE" ? <HardDrive className="h-3 w-3 shrink-0" /> : <Home className="h-3 w-3 shrink-0" />}
              <span className="max-w-28 truncate">{tabTitle(t)}</span>
              {tabs.length > 1 && tabSelIds.size === 0 && (
                <button
                  type="button"
                  aria-label="关闭标签"
                  className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background"
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id) }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => openNewTab(domain, "")} title="新建标签页（当前域根目录）"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Plus className="h-3.5 w-3.5" />
        </button>
        {/* r34：标签搜索切换 */}
        <button type="button" onClick={() => { setTabSearchOpen((v) => !v); if (tabSearchOpen) setTabSearch("") }}
          title={tabSearchOpen ? "退出标签搜索" : "搜索标签页"}
          className={`shrink-0 rounded-md p-1 ${tabSearchOpen ? "text-teal-600 bg-teal-50" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <Search className="h-3.5 w-3.5" />
        </button>
        {tabSearchOpen && (
          <input
            value={tabSearch}
            onChange={(e) => setTabSearch(e.target.value)}
            placeholder="搜索标签…"
            className="shrink-0 w-28 h-7 rounded-md border bg-background px-2 text-xs"
          />
        )}
        {/* r34：多选批量关闭 */}
        <button type="button" onClick={() => { setTabSelIds(tabSelIds.size > 0 ? new Set() : new Set()) }}
          title={tabSelIds.size > 0 ? "退出多选" : "多选标签"}
          className={`shrink-0 rounded-md p-1 ${tabSelIds.size > 0 ? "text-teal-600 bg-teal-50" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
        {tabSelIds.size > 0 && (
          <>
            <button
              type="button"
              onClick={() => closeTabBatch([...tabSelIds])}
              className="shrink-0 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-600 hover:bg-red-100"
            >
              批量关闭（{tabSelIds.size}）
            </button>
            <button
              type="button"
              onClick={() => setTabSelIds(new Set(tabs.map((t) => t.id)))}
              className="shrink-0 rounded-md border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
            >
              全选
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={toggleFavoriteCurrent}
            title={favorites.some((f) => f.domain === domain && f.path === curPath) ? "已收藏（点击移除）" : "收藏当前目录（跨设备同步）"}
            className={`rounded-md p-1 ${favorites.some((f) => f.domain === domain && f.path === curPath) ? "text-amber-500" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
          >
            <Star className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="标签页操作">
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={closeOtherTabs}>关闭其他标签页</DropdownMenuItem>
              <DropdownMenuItem onClick={closeAllTabs}>全部关闭</DropdownMenuItem>
              <DropdownMenuItem onClick={toggleFavoriteCurrent}>{favorites.some((f) => f.domain === domain && f.path === curPath) ? "取消收藏当前目录" : "收藏当前目录"}</DropdownMenuItem>
              <DropdownMenuItem disabled title="标签与收藏自动跨设备同步（登录即恢复）">已开启跨端同步</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ====== 收藏夹快捷条（r34：>8 条自动折叠 + 展开可搜索收藏） ====== */}
      {favorites.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground shrink-0">收藏夹</span>
            {(() => {
              // 折叠：超过 8 条默认只显示前 8（用户诉求：收藏夹太多自动折叠）
              const shown = favExpanded ? favorites : favorites.slice(0, 8)
              return shown.map((f) => (
                <span key={f.id} className="group inline-flex max-w-44 items-center gap-1 rounded-full border border-amber-200/60 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                  <button type="button" onClick={() => gotoFavorite(f)} className="flex min-w-0 items-center gap-1" title={`${domainLabel(f.domain)}${f.path ? ` / ${f.path}` : ""}`}>
                    <Star className="h-3 w-3 shrink-0" />
                    <span className="truncate">{f.title || domainLabel(f.domain)}</span>
                  </button>
                  <button type="button" aria-label="移除收藏" className="shrink-0 rounded-full p-0.5 hover:bg-amber-100" onClick={() => removeFavorite(f.id)}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))
            })()}
            {favorites.length > 8 && (
              <button
                type="button"
                onClick={() => setFavExpanded((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-300/60 px-2 py-0.5 text-[10px] text-amber-600 hover:bg-amber-50"
              >
                {favExpanded ? <><ChevronUp className="h-3 w-3" />收起</> : <>+{favorites.length - 8} 收藏 <ChevronDown className="h-3 w-3" /></>}
              </button>
            )}
            {/* 收藏夹搜索（展开态可用；用户诉求：点击收藏夹可搜索） */}
            <button
              type="button"
              onClick={() => { setFavExpanded(true); setFavSearchOpen((v) => !v) }}
              className="inline-flex items-center gap-1 rounded-full border border-amber-200/60 px-2 py-0.5 text-[10px] text-amber-600 hover:bg-amber-50"
              title="搜索收藏"
            >
              <Search className="h-3 w-3" />搜索
            </button>
          </div>
          {favSearchOpen && (
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={favSearch}
                onChange={(e) => setFavSearch(e.target.value)}
                placeholder="搜索收藏（名称/路径）…"
                className="pl-8 h-8 text-xs"
                autoFocus
              />
              {favSearch && (
                <div className="mt-1 flex flex-wrap gap-1.5 rounded-md border bg-card p-1.5 max-h-28 overflow-y-auto">
                  {favorites
                    .filter((f) => !favSearch.trim() || (f.title || "").toLowerCase().includes(favSearch.toLowerCase()) || (f.path || "").toLowerCase().includes(favSearch.toLowerCase()))
                    .slice(0, 20)
                    .map((f) => (
                      <button key={f.id} type="button" onClick={() => { gotoFavorite(f); setFavSearchOpen(false) }} className="inline-flex max-w-52 items-center gap-1 rounded-full border border-amber-200/60 bg-amber-50/60 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-100">
                        <Star className="h-3 w-3 shrink-0" />
                        <span className="truncate">{f.title || domainLabel(f.domain)}</span>
                        <span className="text-[10px] text-amber-500/70 truncate hidden sm:inline">{f.path}</span>
                      </button>
                    ))}
                  {favorites.filter((f) => !favSearch.trim() || (f.title || "").toLowerCase().includes(favSearch.toLowerCase()) || (f.path || "").toLowerCase().includes(favSearch.toLowerCase())).length === 0 && (
                    <p className="p-2 text-xs text-muted-foreground">无匹配收藏</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
          {/* r34：批量下载（多选打包 zip —— 用户诉求：批量操作里支持批量下载） */}
          <Button variant="outline" size="sm" className="gap-1" onClick={() => {
            const names = JSON.stringify([...selected])
            const url = `/api/files/raw?domain=${encodeURIComponent(domain)}&path=${encodeURIComponent(curPath)}&mode=batch-zip&names=${encodeURIComponent(names)}`
            const a = document.createElement("a")
            a.href = url
            a.download = ""
            a.click()
            toast.success(`正在打包下载 ${selected.size} 项（zip）`)
          }}>
            <Download className="h-3.5 w-3.5" />批量下载
          </Button>
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
          {/* r34：table-fixed + 名称列 max-w-0 —— 超长文件名强制截断，操作栏永不被挤出屏幕（用户报障：文件名溢出致操作栏消失） */}
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-muted/95 backdrop-blur z-10">
              <tr className="border-b">
                <th className="w-10 p-2"><Checkbox checked={allChecked} onCheckedChange={toggleAll} /></th>
                <th className="text-left p-2 font-medium w-auto">名称</th>
                <th className="text-left p-2 font-medium w-20 hidden sm:table-cell">大小</th>
                <th className="text-left p-2 font-medium w-32 hidden md:table-cell">修改时间</th>
                <th className="text-left p-2 font-medium w-20 hidden lg:table-cell">类型</th>
                <th className="p-2 font-medium w-[210px] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const path = joinPath(curPath, e.name)
                const isSel = selected.has(e.name)
                const isFocus = focusHit && focusFileName === e.name
                return (
                  <tr key={e.name} ref={isFocus ? focusRowRef : undefined} className={`border-b last:border-0 hover:bg-muted/40 ${isSel ? "bg-primary/5" : ""} ${isFocus ? "ring-2 ring-teal-400 ring-inset" : ""}`}>
                    <td className="p-2"><Checkbox checked={isSel} onCheckedChange={() => toggleOne(e.name)} /></td>
                    <td className="p-2 w-0 max-w-0 truncate">
                      <button className="flex items-center gap-2 text-left min-w-0 w-full group" onClick={() => { if (e.isDir) go(path); else openPreview(e) }}>
                        {KIND_ICON[e.kind] || <File className="h-4 w-4 shrink-0" />}
                        <span className="truncate font-medium group-hover:underline" title={path}>{e.name}</span>
                        {isFocus && <span className="ml-1 shrink-0 rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:text-teal-300">定位</span>}
                      </button>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground hidden sm:table-cell">{e.isDir ? "-" : fmtBytes(e.size)}</td>
                    <td className="p-2 text-xs text-muted-foreground hidden md:table-cell">{fmtTime(e.mtime)}</td>
                    <td className="p-2 text-xs text-muted-foreground hidden lg:table-cell">{e.isDir ? "目录" : e.kind}</td>
                    <td className="p-2 w-[210px]">
                      <div className="flex items-center justify-end gap-0.5 flex-wrap">
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
                        {e.isDir && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="在新标签页打开" onClick={() => openNewTab(domain, joinPath(curPath, e.name))}>
                            <FolderInput className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {e.kind === "archive" && canWrite && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="解压" onClick={() => { setExtractTarget(e); setExtractPassword("") }}><PackageOpen className="h-3.5 w-3.5" /></Button>
                        )}
                        {(domain === "HOME" || domain === "STORAGE") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={e.isDir ? "分享文件夹（预览页浏览/打包）" : "分享"} onClick={() => { void openShareDialog(e) }}><Share2 className="h-3.5 w-3.5" /></Button>
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

      {/* r34：上传进度条（进度可视 + 取消操作） */}
      {uploads.length > 0 && (
        <div className="rounded-lg border bg-card p-3 space-y-2" data-testid="upload-progress-panel">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" />上传任务（{uploads.filter((u) => u.status === "uploading").length} 个进行中）</p>
          </div>
          {uploads.map((u) => {
            const pct = u.size > 0 ? Math.min(100, Math.round((u.sent / u.size) * 100)) : 0
            return (
              <div key={u.name} className="flex items-center gap-2">
                <span className="text-xs truncate flex-1 min-w-0" title={u.name}>{u.name}</span>
                <span className={cn("text-[10px] tabular-nums shrink-0",
                  u.status === "done" ? "text-emerald-600" : u.status === "error" ? "text-red-600" : u.status === "cancelled" ? "text-muted-foreground" : "text-muted-foreground")}>
                  {u.status === "done" ? "完成" : u.status === "error" ? u.msg || "失败" : u.status === "cancelled" ? "已取消" : `${pct}% · ${fmtBytes(u.sent)}/${fmtBytes(u.size)}`}
                </span>
                {u.status === "uploading" && (
                  <button type="button" onClick={() => cancelUpload(u.name)} className="text-[10px] text-red-500 underline shrink-0">取消</button>
                )}
                <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
                  <div className={cn("h-full transition-all", u.status === "done" ? "bg-emerald-500" : u.status === "error" ? "bg-red-500" : u.status === "cancelled" ? "bg-muted-foreground/30" : "bg-teal-500")} style={{ width: `${u.status === "done" ? 100 : pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ====== 超级编辑器弹窗（r35：行号+工具栏+可视化+查找替换） ====== */}
      {editor && (
        <Dialog open onOpenChange={(v) => { if (!v) { if (!editor.dirty || confirm("有未保存修改，确定关闭？")) setEditor(null) } }}>
          <DialogContent className="max-w-6xl h-[88vh] flex flex-col p-0 gap-0 overflow-hidden [&>button]:absolute [&>button]:right-4 [&>button]:top-4 [&>button]:z-20">
            <SuperEditor
              name={editor.name}
              content={editor.content}
              truncated={editor.truncated}
              readOnly={!canWrite}
              onSave={async (content) => {
                const res = await writeFileAction({ domain, path: editor.path, content })
                if (res.code === 0) {
                  toast.success(`已保存（${fmtBytes(res.data?.size || 0)}）`)
                  setEditor({ ...editor, content, dirty: false })
                  void reload()
                } else toast.error(res.msg || "保存失败")
              }}
              onClose={() => { if (!editor.dirty || confirm("有未保存修改，确定关闭？")) setEditor(null) }}
            />
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
                <img src={rawUrl(preview, "preview")} alt={preview.name} className="max-h-[64vh] max-w-full object-contain" />
              )}
              {preview.kind === "video" && <video src={rawUrl(preview, "preview")} controls className="max-h-[64vh] w-full" />}
              {preview.kind === "audio" && <audio src={rawUrl(preview, "preview")} controls className="w-full" />}
              {preview.kind === "pdf" && <iframe src={rawUrl(preview, "preview")} className="w-full h-[64vh] rounded" title={preview.name} />}
            </div>
            <DialogFooter>
              <span className="text-xs text-muted-foreground mr-auto">{fmtBytes(preview.size)}</span>
              {preview.kind === "image" && canWrite && domain !== "RECORDING" && domain !== "SCREENSHOT" && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setCropTarget(preview); setPreview(null) }} title="在线裁剪并保存为新文件">
                  <Crop className="h-3.5 w-3.5" />在线裁剪
                </Button>
              )}
              <a href={rawUrl(preview, "download")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 text-sm hover:bg-primary/90"><Download className="h-3.5 w-3.5" />下载</a>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 图片在线裁剪弹窗（r35） ====== */}
      {cropTarget && (
        <ImageCropperDialog
          open
          onOpenChange={(v) => { if (!v) setCropTarget(null) }}
          imageUrl={rawUrl(cropTarget, "preview")}
          fileName={cropTarget.name}
          domain={domain}
          dir={curPath}
          onDone={() => { setCropTarget(null); void reload() }}
        />
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

      {/* ====== 分享弹窗（r31：用户+组双多选可搜索 / 自定义到期时刻） ====== */}
      {shareState.open && shareState.target && (
        <Dialog open onOpenChange={(v) => { if (!v) setShareState({ ...shareState, open: false, created: undefined }) }}>
          <DialogContent className="max-w-lg max-h-[86vh] overflow-y-auto">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><Share2 className="h-4 w-4" />分享「{shareState.target.name}」</DialogTitle></DialogHeader>
            {shareState.created ? (
              <div className="space-y-3">
                <div className="p-3 rounded border bg-muted/50 break-all font-mono text-xs">{location.origin}{shareState.created.url}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  有效期：{shareState.created.expiresAt ? new Date(shareState.created.expiresAt).toLocaleString("zh-CN") : "永久"}
                </div>
                <div className="text-xs text-muted-foreground leading-relaxed">
                  接收人打开链接即可预览（文件夹分享支持在线浏览/多选打包下载；视频拖动进度条）。{""}
                  {shareState.target.isDir ? "本次为文件夹分享。" : ""}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => {
                    void navigator.clipboard.writeText(`${location.origin}${shareState.created!.url}`)
                    toast.success("链接已复制")
                  }}>复制完整链接</Button>
                  <Button size="sm" variant="secondary" onClick={() => window.open(shareState.created!.url, "_blank")}>打开预览页</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[90px_1fr] items-center gap-2 text-sm">
                  <span>访问权限</span>
                  <select value={shareState.accessMode} onChange={(e) => setShareState({ ...shareState, accessMode: e.target.value as "LOGIN" | "PUBLIC" | "USERS" })} className="h-8 rounded border bg-background px-2 text-sm">
                    <option value="LOGIN">需登录</option>
                    <option value="PUBLIC">免登录（公开）</option>
                    <option value="USERS">指定用户/用户组</option>
                  </select>
                  <span>有效期</span>
                  <div className="space-y-1.5">
                    <select value={String(shareState.expiresDays)} onChange={(e) => setShareState({ ...shareState, expiresDays: Number(e.target.value), customExpiry: "" })} className="h-8 w-full rounded border bg-background px-2 text-sm">
                      <option value="0">永久有效</option>
                      <option value="1">1 天</option>
                      <option value="7">7 天</option>
                      <option value="30">30 天</option>
                      <option value="90">90 天</option>
                      <option value="365">365 天</option>
                      <option value="-1">自定义时刻…</option>
                    </select>
                    {(shareState.expiresDays === -1 || shareState.customExpiry) && (
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="datetime-local"
                          value={shareState.customExpiry}
                          onChange={(e) => setShareState({ ...shareState, customExpiry: e.target.value })}
                          className="h-8 text-xs"
                          min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                        />
                        {shareState.customExpiry && (
                          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setShareState({ ...shareState, customExpiry: "", expiresDays: 7 })} title="改回预设">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  <span>下载上限</span>
                  <Input type="number" min={0} value={shareState.maxDownloads} onChange={(e) => setShareState({ ...shareState, maxDownloads: Number(e.target.value) })} placeholder="0=不限次" className="h-8" />
                  <span>下载限速</span>
                  <Input type="number" min={0} value={shareState.downloadKBps} onChange={(e) => setShareState({ ...shareState, downloadKBps: Number(e.target.value) })} placeholder="0=不限速（KB/s）" className="h-8" />
                  <span>备注</span>
                  <Input value={shareState.note} onChange={(e) => setShareState({ ...shareState, note: e.target.value })} placeholder="可选（接收人可见）" className="h-8" />
                </div>
                {/* r31：USERS 模式双多选（用户 + 用户组，均可搜索） */}
                {shareState.accessMode === "USERS" && (
                  <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">授权名单：用户与用户组可混合多选（搜索定位 · 组员全部可访问）</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-14 shrink-0 text-xs font-medium">用户</span>
                      <MultiSelectPopover
                        options={shareTargets.users.map((u) => ({ id: u.id, label: u.displayName ? `${u.displayName}（${u.username}）` : u.username }))}
                        selected={shareState.allowedUserIds}
                        onChange={(next) => setShareState({ ...shareState, allowedUserIds: next })}
                        placeholder={"选择用户（" + shareTargets.users.length + "）"}
                        searchPlaceholder="搜索用户名/昵称…"
                        width={280}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-14 shrink-0 text-xs font-medium">用户组</span>
                      <MultiSelectPopover
                        options={shareTargets.groups.map((g) => ({ id: g.id, label: g.name, sub: `${g.memberCount} 人` }))}
                        selected={shareState.allowedGroupIds}
                        onChange={(next) => setShareState({ ...shareState, allowedGroupIds: next })}
                        placeholder={"选择用户组（" + shareTargets.groups.length + "）"}
                        searchPlaceholder="搜索组名…"
                        width={280}
                      />
                    </div>
                    {(shareState.allowedUserIds.length > 0 || shareState.allowedGroupIds.length > 0) && (
                      <p className="text-[11px] text-teal-600">已授权 {shareState.allowedUserIds.length} 位用户 + {shareState.allowedGroupIds.length} 个用户组</p>
                    )}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              {!shareState.created && <Button size="sm" onClick={() => void createShare()}>创建链接</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ====== 我的分享列表（r31：复制预览页链接 + 打开 + 延期） ====== */}
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
                    <td className="p-2 truncate max-w-0" title={l.fileName}>
                      {l.isDir && <Folder className="mr-1 inline h-3 w-3 text-amber-500" />}
                      {l.fileName}
                    </td>
                    <td className="p-2">{l.accessMode === "PUBLIC" ? "免登录" : l.accessMode === "USERS" ? "指定名单" : "需登录"}</td>
                    <td className="p-2">{l.revokedAt ? "已撤销" : l.expiresAt ? new Date(l.expiresAt).toLocaleString("zh-CN") : "永久"}</td>
                    <td className="p-2">{l.viewCount}/{l.downloadCount}</td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => {
                          void navigator.clipboard.writeText(`${location.origin}/share/${l.token}`)
                          toast.success("预览页链接已复制")
                        }}>复制</Button>
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => window.open(`/share/${l.token}`, "_blank")}>
                          <Eye className="h-3 w-3 mr-0.5" />打开
                        </Button>
                        {!l.revokedAt && (
                          <Button variant="ghost" size="sm" className="h-6 text-xs text-teal-600" onClick={() => { setExtendTarget(l); setExtendValue("") }} title="自定义新到期时间（可永久）">
                            延期
                          </Button>
                        )}
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

      {/* ====== r31：分享延期弹窗 ====== */}
      {extendTarget && (
        <Dialog open onOpenChange={(v) => { if (!v) setExtendTarget(null) }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><Clock className="h-4 w-4" />延期「{extendTarget.fileName}」</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                当前：{extendTarget.expiresAt ? new Date(extendTarget.expiresAt).toLocaleString("zh-CN") : "永久有效"}
              </p>
              <Input
                type="datetime-local"
                value={extendValue}
                onChange={(e) => setExtendValue(e.target.value)}
                min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              />
              <Button size="sm" variant="outline" className="w-full" onClick={async () => {
                const res = await extendShareLinkAction({ token: extendTarget.token, expiresAt: null })
                if (res.code === 0) { toast.success("已改为永久有效"); setExtendTarget(null); void loadShareLinks() }
                else toast.error(res.msg)
              }}>设为永久有效</Button>
            </div>
            <DialogFooter>
              <Button size="sm" disabled={!extendValue} onClick={async () => {
                const t = new Date(extendValue).getTime()
                if (!Number.isFinite(t) || t <= Date.now() + 60_000) { toast.error("新到期时间必须晚于当前时间至少 1 分钟"); return }
                const res = await extendShareLinkAction({ token: extendTarget.token, expiresAt: new Date(t).toISOString() })
                if (res.code === 0) { toast.success(`已延期至 ${new Date(t).toLocaleString("zh-CN")}`); setExtendTarget(null); void loadShareLinks() }
                else toast.error(res.msg)
              }}>确认延期</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
