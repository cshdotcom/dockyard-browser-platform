"use client"

// ============================================================
// 云盘文件预览弹窗（r28a 用户云盘 /files）
//   · text / md / csv / json / 代码 → 在线只读 + 「编辑」入口
//   · image / svg → 内嵌渲染（走 /api/files/download?id=&inline=1 流）
//   · video / audio → 原生播放器（Range 分片由下载路由透传）
//   · pdf → iframe 内嵌
//   · office / 二进制 → 下载提示
//   · 预览内可下载（仅自己文件 —— /files 全部为本人的安全视图）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Download, Loader2, Pencil, FileArchive, FileText } from "lucide-react"
import { previewKindOf, isTextEditable } from "@/lib/preview-kind"
import { USER_CATEGORY_LABEL, type UserFileRow } from "./types"

const TEXT_PREVIEW_LIMIT = 512 * 1024 // 512KB 只读预览上限

interface PreviewDialogProps {
  row: UserFileRow | null
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 点击「编辑」 → 打开在线文本编辑器 */
  onEdit: (row: UserFileRow) => void
}

export function PreviewDialog({ row, open, onOpenChange, onEdit }: PreviewDialogProps) {
  const [textContent, setTextContent] = React.useState<string | null>(null)
  const [textLoading, setTextLoading] = React.useState(false)

  const kind = row ? previewKindOf(row.mime, row.fileName) : "none"
  const inlineUrl = row ? `/api/files/download?id=${encodeURIComponent(row.id)}&inline=1` : ""
  const downloadUrl = row ? `/api/files/download?id=${encodeURIComponent(row.id)}` : ""

  // 文本族内容加载
  React.useEffect(() => {
    if (!open || !row || (kind !== "text" && kind !== "svg")) {
      setTextContent(null)
      return
    }
    let cancelled = false
    setTextLoading(true)
    fetch(inlineUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const text = await r.text()
        if (!cancelled) setTextContent(text.slice(0, TEXT_PREVIEW_LIMIT))
      })
      .catch(() => {
        if (!cancelled) {
          setTextContent(null)
          toast.error("预览内容加载失败")
        }
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, row, kind, inlineUrl])

  if (!row) return null

  const editable = isTextEditable(row.mime, row.fileName) && row.size <= 1024 * 1024
  const isText = kind === "text" || kind === "svg"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 min-w-0 pr-6">
            <span className="truncate">{row.fileName}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{USER_CATEGORY_LABEL[row.category] || row.category}</Badge>
            <span className="text-xs font-mono text-muted-foreground">{row.mime || "未知类型"}</span>
            <span className="text-xs tabular-nums">{fmtSize(row.size)}</span>
            {row.expired && <Badge variant="destructive">已过期</Badge>}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
          {kind === "image" && <img src={inlineUrl} alt={row.fileName} className="max-w-full mx-auto" />}
          {kind === "svg" && (
            <object data={inlineUrl} type="image/svg+xml" className="w-full min-h-[300px]">
              <img src={inlineUrl} alt={row.fileName} className="max-w-full mx-auto" />
            </object>
          )}
          {kind === "video" && <video controls src={inlineUrl} className="w-full max-h-[60vh] bg-black" />}
          {kind === "audio" && <audio controls src={inlineUrl} className="w-full my-10" />}
          {kind === "pdf" && <iframe src={inlineUrl} className="w-full h-[60vh]" title={row.fileName} />}
          {isText && (
            <div className="p-3">
              {textLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> 加载预览…
                </div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-[55vh] overflow-auto bg-card rounded p-3 border">
                  {textContent ?? "（空文件或内容加载失败）"}
                </pre>
              )}
            </div>
          )}
          {kind === "office-hint" && (
            <div className="py-12 text-center space-y-2">
              <FileArchive className="h-9 w-9 text-orange-500 mx-auto" />
              <p className="text-sm font-medium">Office 文档不支持在线预览</p>
              <p className="text-xs text-muted-foreground">可下载后用本地办公软件打开</p>
            </div>
          )}
          {kind === "none" && (
            <div className="py-12 text-center space-y-2">
              <FileText className="h-9 w-9 text-muted-foreground/40 mx-auto" />
              <p className="text-sm font-medium">此格式不支持在线预览</p>
              <p className="text-xs text-muted-foreground">请下载后使用对应软件查看</p>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row justify-between sm:justify-between gap-2">
          <span className="text-xs text-muted-foreground truncate font-mono" title={row.storageKey}>
            {row.storageKey}
          </span>
          <div className="flex items-center gap-2">
            {editable && (
              <Button variant="secondary" size="sm" onClick={() => onEdit(row)}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> 编辑
              </Button>
            )}
            <Button size="sm" asChild>
              <a href={downloadUrl} download={row.fileName}>
                <Download className="mr-1 h-3.5 w-3.5" /> 下载
              </a>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function fmtSize(n: number): string {
  if (!n) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Math.round(v * 1000) / 1000} ${units[i]}`
}
