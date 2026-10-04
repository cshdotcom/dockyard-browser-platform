"use client"

// ============================================================
// r28 文件公开分享页 /s/<token>（免登录 · 修复「分享链接 404」）
// · 访客密钥门（NEED_KEY 时渲染密钥输入，错误统一提示不区分细节）
// · 文件夹/多文件分享：完整清单 + 逐文件预览
// · 预览：text / image / svg / video（Range 流）/ audio / pdf / office 提示
// · VIEW 型仅预览；DOWNLOAD 型提供下载按钮
// ============================================================

import * as React from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import {
  Loader2, Lock, FileText, FileImage, FileVideo, FileAudio, FileArchive, File,
  Download, Eye, Clock, ShieldCheck, FolderOpen, AlertTriangle, ChevronLeft, Hash,
} from "lucide-react"

interface ShareFile {
  id: string
  fileName: string
  size: number
  mime: string | null
  category: string
  previewKind: "text" | "image" | "svg" | "video" | "audio" | "pdf" | "office-hint" | "none"
  createdAt: string
}
interface ShareView {
  name: string
  permission: "VIEW" | "DOWNLOAD"
  needsKey: boolean
  expireAt: string | null
  fileCount: number
  totalBytes: number
  files: ShareFile[]
  createdAt: string
  viewCount: number
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function kindIcon(k: ShareFile["previewKind"] | string, mime: string | null) {
  if (k === "text") return <FileText className="h-4 w-4 text-sky-600" />
  if (k === "image" || k === "svg") return <FileImage className="h-4 w-4 text-violet-600" />
  if (k === "video") return <FileVideo className="h-4 w-4 text-rose-600" />
  if (k === "audio") return <FileAudio className="h-4 w-4 text-amber-600" />
  if (mime?.includes("zip") || mime?.includes("tar") || mime?.includes("compressed")) return <FileArchive className="h-4 w-4 text-orange-600" />
  return <File className="h-4 w-4 text-slate-500" />
}

export default function PublicSharePage() {
  const params = useParams<{ token: string }>()
  const token = params.token
  const [loading, setLoading] = React.useState(true)
  const [needKey, setNeedKey] = React.useState(false)
  const [keyInput, setKeyInput] = React.useState("")
  const [view, setView] = React.useState<ShareView | null>(null)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState<ShareFile | null>(null)
  const [textContent, setTextContent] = React.useState<string | null>(null)
  const [textLoading, setTextLoading] = React.useState(false)
  const [kw, setKw] = React.useState("")

  const load = React.useCallback(async (visitorKey?: string) => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`/api/share/resolve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorKey }),
      })
      const json = await res.json()
      if (json.code === 0 && json.data) {
        setView(json.data as ShareView)
        setNeedKey(false)
        const first = (json.data as ShareView).files[0]
        if (first && (json.data as ShareView).fileCount === 1) setSelected(first)
      } else if (json.code === 40302 || /密钥/.test(json.msg || "")) {
        setNeedKey(true)
      } else {
        setError(json.msg || "分享不存在或已失效")
      }
    } catch {
      setError("网络错误，请稍后重试")
    } finally {
      setLoading(false)
    }
  }, [token])

  React.useEffect(() => { load() }, [load])

  // 文本预览内容加载（选中 text 类型时）
  React.useEffect(() => {
    if (!selected || (selected.previewKind !== "text" && selected.previewKind !== "svg")) {
      setTextContent(null)
      return
    }
    if (!view) return
    let cancelled = false
    setTextLoading(true)
    fetch(`/api/share/download/${token}?file=${selected.id}&key=${encodeURIComponent(keyInput)}&inline=1`)
      .then(async (r) => {
        const text = await r.text()
        if (!cancelled) setTextContent(text.slice(0, 512 * 1024)) // 512KB 预览上限
      })
      .catch(() => { if (!cancelled) setTextContent("（预览加载失败）") })
      .finally(() => { if (!cancelled) setTextLoading(false) })
    return () => { cancelled = true }
  }, [selected, token, view, keyInput])

  const dlUrl = (f: ShareFile, inline = false) =>
    `/api/share/download/${token}?file=${f.id}&key=${encodeURIComponent(keyInput)}${inline ? "&inline=1" : ""}`

  const canDownload = view?.permission === "DOWNLOAD"

  const filtered = React.useMemo(() => {
    if (!view) return []
    if (!kw.trim()) return view.files
    return view.files.filter((f) => f.fileName.toLowerCase().includes(kw.trim().toLowerCase()))
  }, [view, kw])

  // ---- 密钥门 ----
  if (loading && !view && !needKey) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> 正在打开分享…</div>
      </div>
    )
  }

  if (needKey) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border bg-white dark:bg-slate-900 p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
            <Lock className="h-5 w-5 text-amber-600" />
            <h1 className="text-lg font-semibold">此分享受密钥保护</h1>
          </div>
          <p className="text-sm text-muted-foreground">请输入分享者提供的访问密钥继续。密钥错误不会区分提示细节（防探测）。</p>
          <form
            onSubmit={(e) => { e.preventDefault(); load(keyInput) }}
            className="space-y-3"
          >
            <input
              type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
              placeholder="输入访问密钥" autoFocus
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <button type="submit" className="w-full rounded-md bg-teal-600 hover:bg-teal-700 text-white py-2 text-sm font-medium">
              解锁查看
            </button>
          </form>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </div>
    )
  }

  if (error && !view) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl border bg-white dark:bg-slate-900 p-6 text-center space-y-3">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto" />
          <h1 className="text-lg font-semibold">无法打开此分享</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="text-xs text-muted-foreground">链接可能已过期、被撤销或达到访问次数上限。请联系分享者重新获取。</p>
        </div>
      </div>
    )
  }

  if (!view) return null

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* 顶栏 */}
      <div className="border-b bg-white dark:bg-slate-900 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          {selected && view.files.length > 1 ? (
            <button onClick={() => { setSelected(null); setTextContent(null) }} className="flex items-center gap-1 text-sm text-slate-500 hover:text-teal-600">
              <ChevronLeft className="h-4 w-4" /> 返回清单
            </button>
          ) : (
            <FolderOpen className="h-5 w-5 text-teal-600" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold truncate">{selected ? selected.fileName : view.name}</h1>
            <p className="text-[11px] text-muted-foreground">
              {view.fileCount} 个文件 · {fmtSize(view.totalBytes)} · {view.fileCount > 1 ? "多文件分享" : "单文件分享"}
              {canDownload ? " · 可下载" : " · 仅预览"}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
            {needKey ? "密钥保护" : "公开链接"}
            <Hash className="h-3 w-3 ml-1" />{view.viewCount}
          </span>
          {view.expireAt && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
              <Clock className="h-3.5 w-3.5" />
              {new Date(view.expireAt).toLocaleString("zh-CN")} 过期
            </span>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4">
        {!selected ? (
          /* ---- 文件清单（文件夹/多文件） ---- */
          <div className="space-y-3">
            {view.fileCount > 5 && (
              <input
                value={kw} onChange={(e) => setKw(e.target.value)}
                placeholder="搜索文件名…"
                className="w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm"
              />
            )}
            <div className="rounded-lg border bg-white dark:bg-slate-900 divide-y">
              {filtered.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="shrink-0">{kindIcon(f.previewKind, f.mime)}</span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(f)}>
                    <p className="text-sm truncate font-medium hover:text-teal-600">{f.fileName}</p>
                    <p className="text-[11px] text-muted-foreground">{fmtSize(f.size)} · {new Date(f.createdAt).toLocaleDateString("zh-CN")}</p>
                  </button>
                  {(f.previewKind !== "none" && f.previewKind !== "office-hint") && (
                    <button onClick={() => setSelected(f)} className="shrink-0 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-teal-600">
                      <Eye className="h-3.5 w-3.5" /> 预览
                    </button>
                  )}
                  {canDownload && (
                    <a href={dlUrl(f)} className="shrink-0 inline-flex items-center gap-1 text-xs text-teal-600 hover:underline">
                      <Download className="h-3.5 w-3.5" /> 下载
                    </a>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的文件</div>
              )}
            </div>
          </div>
        ) : (
          /* ---- 单文件预览 ---- */
          <div className="rounded-lg border bg-white dark:bg-slate-900 overflow-hidden">
            {selected.previewKind === "image" && (
              <img src={dlUrl(selected, true)} alt={selected.fileName} className="max-w-full mx-auto" />
            )}
            {selected.previewKind === "svg" && (
              <object data={dlUrl(selected, true)} type="image/svg+xml" className="w-full min-h-[300px]">
                <img src={dlUrl(selected, true)} alt={selected.fileName} className="max-w-full mx-auto" />
              </object>
            )}
            {selected.previewKind === "video" && (
              <video controls src={dlUrl(selected, true)} className="w-full max-h-[70vh] bg-black" />
            )}
            {selected.previewKind === "audio" && (
              <audio controls src={dlUrl(selected, true)} className="w-full my-8" />
            )}
            {selected.previewKind === "pdf" && (
              <iframe src={dlUrl(selected, true)} className="w-full h-[75vh]" title={selected.fileName} />
            )}
            {(selected.previewKind === "text" || selected.previewKind === "svg") && (
              <div className="p-4">
                {textLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                    <Loader2 className="h-4 w-4 animate-spin" /> 加载预览…
                  </div>
                ) : (
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-[70vh] overflow-auto bg-slate-50 dark:bg-slate-950 rounded p-3 border">
                    {textContent}
                  </pre>
                )}
              </div>
            )}
            {selected.previewKind === "office-hint" && (
              <div className="p-8 text-center space-y-2">
                <FileArchive className="h-8 w-8 text-orange-500 mx-auto" />
                <p className="text-sm font-medium">Office 文档不支持在线预览</p>
                <p className="text-xs text-muted-foreground">可下载后用本地办公软件打开</p>
              </div>
            )}
            {selected.previewKind === "none" && (
              <div className="p-8 text-center space-y-2">
                <File className="h-8 w-8 text-slate-400 mx-auto" />
                <p className="text-sm font-medium">{selected.fileName}</p>
                <p className="text-xs text-muted-foreground">此格式不支持在线预览</p>
              </div>
            )}
            <div className="border-t px-4 py-3 flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs text-muted-foreground">{fmtSize(selected.size)} · {selected.mime || "未知类型"}</span>
              {canDownload && (
                <a href={dlUrl(selected)} className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 text-xs font-medium">
                  <Download className="h-3.5 w-3.5" /> 下载文件
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
