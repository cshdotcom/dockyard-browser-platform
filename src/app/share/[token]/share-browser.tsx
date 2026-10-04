"use client"

// ============================================================
// r31：分享落地页客户端面板
//   文件 → 在线预览（图片/视频[Range 拖动]/音频/PDF/文本/MD 渲染）+ 下载
//   文件夹 → 面包屑导航 + 搜索 + 多选 + 单文件预览/下载 + 所选/整夹 zip
//   移动端完整适配（单列布局、大触控目标）
// ============================================================

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import {
  Folder, FileText, Image as ImageIcon, Video, Music, Archive, Binary, Download, Search, X,
  ChevronRight, Package, Eye, Clock, HardDrive, Share2, Loader2, FileBox,
} from "lucide-react"

interface ShareMeta {
  fileName: string
  isDir: boolean
  sizeBytes: number
  accessMode: string
  expiresAt: string | null
  maxViews: number | null
  maxDownloads: number | null
  viewCount: number
  downloadCount: number
  note: string | null
  ownerName: string
  createdAt: string
  targetUsers: number
  targetGroups: number
}

interface Entry {
  name: string
  rel: string
  isDir: boolean
  size: number
  mtime: string
  kind: string
}

const KIND_ICON: Record<string, React.ReactNode> = {
  dir: <Folder className="h-4 w-4 text-amber-500" />,
  text: <FileText className="h-4 w-4 text-sky-500" />,
  image: <ImageIcon className="h-4 w-4 text-emerald-500" />,
  video: <Video className="h-4 w-4 text-purple-500" />,
  audio: <Music className="h-4 w-4 text-pink-500" />,
  pdf: <FileText className="h-4 w-4 text-red-500" />,
  archive: <Archive className="h-4 w-4 text-orange-500" />,
  binary: <Binary className="h-4 w-4 text-slate-400" />,
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const ACCESS_LABEL: Record<string, string> = { PUBLIC: "公开（免登录）", LOGIN: "登录可见", USERS: "指定名单" }

function apiUrl(token: string, qs: Record<string, string>): string {
  const us = new URLSearchParams(qs)
  return `/api/files/share/${token}?${us.toString()}`
}

// ---- 轻量 Markdown 渲染（与文件管理器同语义的精简版）----
function renderMarkdown(src: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return esc(src)
    .replace(/```([\s\S]*?)```/g, (_m, c) => `<pre class="bg-muted rounded p-3 overflow-x-auto text-xs"><code>${c}</code></pre>`)
    .replace(/^### (.*)$/gm, '<div class="text-base font-semibold mt-2">$1</div>')
    .replace(/^## (.*)$/gm, '<div class="text-lg font-semibold mt-2">$1</div>')
    .replace(/^# (.*)$/gm, '<div class="text-xl font-semibold mt-2">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, '<code class="bg-muted px-1 rounded text-xs">$1</code>')
    .replace(/^[-*] (.*)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^&gt; (.*)$/gm, '<blockquote class="border-l-2 border-primary/40 pl-3 text-muted-foreground my-1">$1</blockquote>')
    .replace(/\n/g, "<br/>")
}

export function ShareBrowserPanel({ token, share }: { token: string; share: ShareMeta }) {
  // ---- 文件夹浏览状态 ----
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [rel, setRel] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [kw, setKw] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [zipping, setZipping] = React.useState(false)

  // ---- 单文件预览状态（文件夹内文件弹窗预览）----
  const [preview, setPreview] = React.useState<Entry | null>(null)
  const [previewText, setPreviewText] = React.useState<string | null>(null)
  const [textLoading, setTextLoading] = React.useState(false)

  const fileUrl = (mode: "preview" | "download", sub?: string) =>
    apiUrl(token, { ...(sub ? { path: sub } : {}), mode })

  React.useEffect(() => {
    if (!share.isDir) return
    const load = async (r: string) => {
      setLoading(true)
      try {
        const res = await fetch(apiUrl(token, { op: "list", ...(r ? { path: r } : {}) }), { cache: "no-store" })
        const json = await res.json()
        if (json.code === 0 && json.data) {
          setEntries(json.data.entries as Entry[])
          setSelected(new Set())
        } else {
          toast.error(json.msg || "目录读取失败")
        }
      } catch {
        toast.error("目录读取失败（网络异常）")
      } finally {
        setLoading(false)
      }
    }
    void load(rel)
  }, [share.isDir, token, rel])

  // 文本类预览（单文件：分享根为文件时）
  React.useEffect(() => {
    if (share.isDir) return
    const kind = kindOfName(share.fileName)
    if (kind !== "text") return
    setTextLoading(true)
    fetch(fileUrl("preview"), { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("读取失败"))))
      .then((t) => setPreviewText(t.slice(0, 512 * 1024)))
      .catch(() => setPreviewText(null))
      .finally(() => setTextLoading(false))
  }, [share.isDir, share.fileName, token])  

  // 弹窗文本预览
  React.useEffect(() => {
    if (!preview || kindOfName(preview.name) !== "text") { setPreviewText(null); return }
    setTextLoading(true)
    fetch(fileUrl("preview", preview.rel), { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("读取失败"))))
      .then((t) => setPreviewText(t.slice(0, 512 * 1024)))
      .catch(() => setPreviewText(null))
      .finally(() => setTextLoading(false))
  }, [preview])  

  const filtered = React.useMemo(() => {
    if (!kw.trim()) return entries
    const q = kw.trim().toLowerCase()
    return entries.filter((e) => e.name.toLowerCase().includes(q))
  }, [entries, kw])

  const toggleSel = (relPath: string) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(relPath)) n.delete(relPath)
      else n.add(relPath)
      return n
    })
  }

  const downloadZip = async (sub: string, names?: string[]) => {
    setZipping(true)
    try {
      const url = apiUrl(token, { op: "zip", ...(sub ? { path: sub } : {}), ...(names && names.length > 0 ? { names: names.join(",") } : {}) })
      const a = document.createElement("a")
      a.href = url
      a.download = `${share.fileName}.zip`
      a.click()
      toast.success(names && names.length > 0 ? `正在打包 ${names.length} 个文件…` : "正在打包整个文件夹…")
    } finally {
      setTimeout(() => setZipping(false), 800)
    }
  }

  const crumbs = rel ? rel.split("/").filter(Boolean) : []

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950">
      <div className="mx-auto max-w-4xl p-4 sm:p-6 space-y-4">
        {/* ===== 头部卡片 ===== */}
        <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
          <div className="bg-gradient-to-r from-teal-500/10 to-emerald-500/10 px-5 py-4 border-b">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white">
                <Share2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-base sm:text-lg font-semibold truncate flex items-center gap-2">
                  {share.isDir ? <Folder className="h-4 w-4 text-amber-500 shrink-0" /> : null}
                  {share.fileName}
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  来自 {share.ownerName} 的分享 · {share.isDir ? "文件夹（支持浏览与打包下载）" : "单个文件"}
                </p>
              </div>
              <Badge variant={share.accessMode === "PUBLIC" ? "default" : "secondary"} className="shrink-0">
                {ACCESS_LABEL[share.accessMode] || share.accessMode}
              </Badge>
            </div>
          </div>

          {/* 元信息行 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><HardDrive className="h-3.5 w-3.5" />{fmtBytes(share.sizeBytes)}</span>
            <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{share.viewCount} 次查看{share.maxViews ? ` / ${share.maxViews}` : ""}</span>
            <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{share.downloadCount} 次下载{share.maxDownloads ? ` / ${share.maxDownloads}` : ""}</span>
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{share.expiresAt ? `至 ${new Date(share.expiresAt).toLocaleString("zh-CN")} 有效` : "永久有效"}</span>
            {share.accessMode === "USERS" && (share.targetUsers > 0 || share.targetGroups > 0) && (
              <span className="inline-flex items-center gap-1">
                <FileBox className="h-3.5 w-3.5" />
                授权 {share.targetUsers > 0 ? `${share.targetUsers} 位用户` : ""}
                {share.targetUsers > 0 && share.targetGroups > 0 ? " + " : ""}
                {share.targetGroups > 0 ? `${share.targetGroups} 个用户组` : ""}
              </span>
            )}
          </div>
          {share.note && (
            <div className="px-5 pb-3">
              <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">发起人备注：{share.note}</div>
            </div>
          )}

          {/* ===== 文件模式：预览 + 下载 ===== */}
          {!share.isDir && (
            <div className="px-5 pb-5 space-y-3">
              <FilePreviewArea name={share.fileName} kind={kindOfName(share.fileName)} url={fileUrl("preview")} text={previewText} textLoading={textLoading} />
              <div className="flex items-center gap-2">
                <Button onClick={() => window.open(fileUrl("download"), "_blank")} className="gap-1.5 bg-gradient-to-r from-teal-500 to-emerald-600 text-white hover:opacity-90">
                  <Download className="h-4 w-4" />下载文件（{fmtBytes(share.sizeBytes)}）
                </Button>
                <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => toast.success("链接已复制")).catch(() => toast.error("复制失败")) }}>
                  复制分享链接
                </Button>
              </div>
            </div>
          )}

          {/* ===== 文件夹模式：浏览/搜索/多选/打包 ===== */}
          {share.isDir && (
            <div className="px-3 sm:px-5 pb-5 space-y-3">
              {/* 工具条 */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[160px]">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <input
                    value={kw}
                    onChange={(e) => setKw(e.target.value)}
                    placeholder="在当前目录搜索文件名…"
                    className="h-9 w-full rounded-lg border bg-background pl-8 pr-8 text-sm focus:outline-none focus:ring-1 focus:ring-teal-400"
                  />
                  {kw && (
                    <button type="button" onClick={() => setKw("")} className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button size="sm" variant="outline" disabled={zipping} onClick={() => void downloadZip(rel)} className="gap-1.5">
                  <Package className="h-3.5 w-3.5" />{rel ? "打包当前目录" : "打包整个文件夹"}
                </Button>
                {selected.size > 0 && (
                  <Button size="sm" disabled={zipping} onClick={() => void downloadZip(rel, [...selected])} className="gap-1.5 bg-teal-600 hover:bg-teal-500 text-white">
                    <Download className="h-3.5 w-3.5" />下载所选（{selected.size}）
                  </Button>
                )}
              </div>

              {/* 面包屑 */}
              {crumbs.length > 0 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
                  <button type="button" onClick={() => setRel("")} className="hover:text-foreground font-medium text-foreground">{share.fileName}</button>
                  {crumbs.map((c, i) => (
                    <React.Fragment key={i}>
                      <ChevronRight className="h-3 w-3" />
                      <button type="button" onClick={() => setRel(crumbs.slice(0, i + 1).join("/"))} className={cn("hover:text-foreground", i === crumbs.length - 1 && "text-foreground font-medium")}>{c}</button>
                    </React.Fragment>
                  ))}
                </div>
              )}

              {/* 文件列表 */}
              <div className="rounded-xl border overflow-hidden">
                {loading ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 读取目录…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">{kw ? "无匹配文件" : "空目录"}</div>
                ) : (
                  <div className="max-h-[56vh] overflow-y-auto divide-y">
                    {filtered.map((e) => (
                      <div key={e.rel} className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40">
                        <Checkbox
                          checked={selected.has(e.rel)}
                          onCheckedChange={() => toggleSel(e.rel)}
                          disabled={e.isDir}
                          aria-label={`选择 ${e.name}`}
                        />
                        <span className="shrink-0">{KIND_ICON[e.kind] || KIND_ICON.binary}</span>
                        {e.isDir ? (
                          <button type="button" onClick={() => { setRel(e.rel); setKw("") }} className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-sm font-medium hover:text-teal-600">{e.name}</span>
                          </button>
                        ) : (
                          <button type="button" onClick={() => setPreview(e)} className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-sm font-medium hover:text-teal-600">{e.name}</span>
                            <span className="block text-[10px] text-muted-foreground">{fmtBytes(e.size)} · {new Date(e.mtime).toLocaleString("zh-CN")}</span>
                          </button>
                        )}
                        {!e.isDir && (
                          <div className="flex items-center gap-1 shrink-0">
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="预览" onClick={() => setPreview(e)}>
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="下载" onClick={() => window.open(fileUrl("download", e.rel), "_blank")}>
                              <Download className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                支持多选文件（勾选后「下载所选」打包 zip）；子目录可进入后单独打包；视频/音频支持进度条拖动（Range 流）。所有访问均审计留痕。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 单文件预览弹窗（文件夹内） ===== */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreview(null)}>
          <div className="w-full max-w-3xl max-h-[86vh] overflow-auto rounded-2xl border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b px-4 py-3">
              {KIND_ICON[kindOfName(preview.name)]}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{preview.name}</span>
              <Button variant="outline" size="sm" onClick={() => window.open(fileUrl("download", preview.rel), "_blank")} className="gap-1">
                <Download className="h-3.5 w-3.5" />下载
              </Button>
              <button type="button" onClick={() => setPreview(null)} className="rounded-md p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-4">
              <FilePreviewArea name={preview.name} kind={kindOfName(preview.name)} url={fileUrl("preview", preview.rel)} text={previewText} textLoading={textLoading} compact />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- 预览区（按类型渲染）----
function FilePreviewArea({ name, kind, url, text, textLoading, compact }: {
  name: string
  kind: string
  url: string
  text: string | null
  textLoading: boolean
  compact?: boolean
}) {
  const box = compact ? "rounded-xl" : "rounded-xl border"
  if (kind === "image") {
    return <img src={url} alt={name} className={cn("max-h-[56vh] w-full object-contain bg-slate-100 dark:bg-slate-900", box)} />
  }
  if (kind === "video") {
    return <video src={url} controls preload="metadata" className={cn("w-full max-h-[56vh] bg-black", box)} controlsList="nodownload" />
  }
  if (kind === "audio") {
    return (
      <div className={cn("bg-slate-50 dark:bg-slate-900 p-6 flex flex-col items-center gap-3", box)}>
        <Music className="h-10 w-10 text-teal-500" />
        <audio src={url} controls preload="metadata" className="w-full max-w-md" />
      </div>
    )
  }
  if (kind === "pdf") {
    return <iframe src={url} title={name} className={cn("h-[56vh] w-full bg-slate-200 dark:bg-slate-900", box)} />
  }
  if (kind === "text") {
    const isMd = /\.md$/i.test(name)
    return (
      <div className={cn("bg-slate-50 dark:bg-slate-900 p-4 overflow-auto max-h-[56vh] text-sm", box)}>
        {textLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 读取内容…</div>
        ) : text == null ? (
          <div className="text-muted-foreground">内容读取失败或为空</div>
        ) : isMd ? (
          <div className="prose-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre>
        )}
      </div>
    )
  }
  return (
    <div className={cn("bg-slate-50 dark:bg-slate-900 p-8 flex flex-col items-center gap-2 text-muted-foreground", box)}>
      <Archive className="h-10 w-10" />
      <p className="text-sm">该文件类型（{kind}）不支持在线预览，请下载后查看</p>
    </div>
  )
}

function kindOfName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || ""
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) return "image"
  if (["mp4", "webm", "mkv", "mov"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio"
  if (ext === "pdf") return "pdf"
  if (["txt", "md", "log", "csv", "json", "xml", "html", "htm", "css", "js", "ts", "py", "sh", "yml", "yaml", "ini", "conf"].includes(ext)) return "text"
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive"
  return "binary"
}
