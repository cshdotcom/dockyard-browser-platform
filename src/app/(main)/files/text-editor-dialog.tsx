"use client"

// ============================================================
// 文本在线编辑器（r28a 用户云盘）
//   · 行号 gutter（与编辑区滚动同步）
//   · 撤销 / 重做栈（快照式，500ms 合并连续输入）
//   · 行级 diff 提示（修改前后对比：新增/删除计数 + 样例行）
//   · Ctrl+S / Cmd+S 快捷键保存
//   · 保存走 saveFileTextAction（归属/类型/1MB/路径穿越五重服务端校验）
// ============================================================

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Redo2, Save, Undo2 } from "lucide-react"
import { saveFileTextAction } from "@/server/actions/files-user"
import type { UserFileRow } from "./types"

const MAX_EDIT_BYTES = 1024 * 1024

interface TextEditorDialogProps {
  row: UserFileRow | null
  open: boolean
  onOpenChange: (v: boolean) => void
}

interface DiffSummary {
  added: number
  removed: number
  addedSamples: string[]
  removedSamples: string[]
}

export function TextEditorDialog({ row, open, onOpenChange }: TextEditorDialogProps) {
  const router = useRouter()
  const [content, setContent] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [diff, setDiff] = React.useState<DiffSummary | null>(null)

  // 撤销/重做栈
  const pastRef = React.useRef<string[]>([])
  const futureRef = React.useRef<string[]>([])
  const lastPushRef = React.useRef(0)
  const gutterRef = React.useRef<HTMLDivElement>(null)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  // 打开时加载当前内容
  React.useEffect(() => {
    if (!open || !row) return
    let cancelled = false
    setLoading(true)
    pastRef.current = []
    futureRef.current = []
    setDiff(null)
    fetch(`/api/files/download?id=${encodeURIComponent(row.id)}&inline=1`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return await r.text()
      })
      .then((text) => {
        if (cancelled) return
        setContent(text)
        setOriginal(text)
      })
      .catch(() => {
        if (!cancelled) toast.error("文件内容加载失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, row])

  // 行级 diff（多重集合计数 + 样例行）
  React.useEffect(() => {
    if (content === original) {
      setDiff(null)
      return
    }
    const countOf = (lines: string[]) => {
      const map = new Map<string, number>()
      for (const l of lines) map.set(l, (map.get(l) || 0) + 1)
      return map
    }
    const a = original.split("\n")
    const b = content.split("\n")
    const ca = countOf(a)
    const cb = countOf(b)
    let added = 0
    let removed = 0
    const addedSamples: string[] = []
    const removedSamples: string[] = []
    for (const [line, n] of cb) {
      const delta = n - (ca.get(line) || 0)
      if (delta > 0) {
        added += delta
        if (addedSamples.length < 6) addedSamples.push(line.slice(0, 120))
      }
    }
    for (const [line, n] of ca) {
      const delta = n - (cb.get(line) || 0)
      if (delta > 0) {
        removed += delta
        if (removedSamples.length < 6) removedSamples.push(line.slice(0, 120))
      }
    }
    setDiff({ added, removed, addedSamples, removedSamples })
  }, [content, original])

  const byteLen = React.useMemo(() => new TextEncoder().encode(content).length, [content])
  const lines = React.useMemo(() => content.split("\n").length, [content])

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0

  const applyContent = (value: string, resetHistory: boolean) => {
    if (resetHistory) {
      pastRef.current = []
      futureRef.current = []
    }
    setContent(value)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    const now = Date.now()
    // 快照式撤销栈：500ms 内的连续输入合并为一个快照
    if (now - lastPushRef.current > 500 || pastRef.current.length === 0) {
      pastRef.current = [...pastRef.current.slice(-99), content]
      futureRef.current = []
    }
    lastPushRef.current = now
    setContent(value)
    // 强制重渲染以刷新撤销/重做可用态
    setTick((t) => t + 1)
  }

  const undo = () => {
    const past = pastRef.current
    if (past.length === 0) return
    const prev = past[past.length - 1]
    pastRef.current = past.slice(0, -1)
    futureRef.current = [content, ...futureRef.current.slice(0, 99)]
    setContent(prev)
    setTick((t) => t + 1)
  }

  const redo = () => {
    const future = futureRef.current
    if (future.length === 0) return
    const next = future[0]
    futureRef.current = future.slice(1)
    pastRef.current = [...pastRef.current.slice(-99), content]
    setContent(next)
    setTick((t) => t + 1)
  }

  // 重渲染 tick（撤销栈为 ref，需手动触发刷新按钮可用态）
  const [, setTick] = React.useState(0)

  const save = React.useCallback(async () => {
    if (!row || saving) return
    if (byteLen > MAX_EDIT_BYTES) {
      toast.error(`内容 ${fmtBytes(byteLen)} 超出 1MB 在线编辑上限`)
      return
    }
    setSaving(true)
    try {
      const res = await saveFileTextAction({ fileId: row.id, content })
      if (res.code === 0 && res.data) {
        setOriginal(content)
        setDiff(null)
        pastRef.current = []
        futureRef.current = []
        toast.success(`已保存 · ${fmtBytes(res.data.size)} · 校验和已更新`)
        router.refresh()
      } else {
        toast.error(res.msg || "保存失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }, [row, saving, byteLen, content, router])

  // Ctrl+S / Cmd+S
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault()
      void save()
    }
  }

  if (!row) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 min-w-0 pr-6">
            <span className="truncate">{row.fileName}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">在线编辑</Badge>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>纯文本在线编辑 · Ctrl+S 保存</span>
            <span className="text-xs tabular-nums">{lines} 行</span>
            <span className={`text-xs tabular-nums ${byteLen > MAX_EDIT_BYTES ? "text-red-600 font-medium" : ""}`}>
              {fmtBytes(byteLen)} / 上限 1 MB
            </span>
          </DialogDescription>
        </DialogHeader>

        {diff && (
          <div className="shrink-0 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 p-2.5 text-xs space-y-1.5">
            <p className="text-muted-foreground">
              检测到未保存修改：
              <span className="text-emerald-600 font-medium"> +{diff.added} 行新增</span> ·
              <span className="text-red-600 font-medium"> -{diff.removed} 行删除</span>
            </p>
            {(diff.addedSamples.length > 0 || diff.removedSamples.length > 0) && (
              <div className="max-h-24 overflow-y-auto font-mono text-[10px] space-y-0.5">
                {diff.addedSamples.map((l, i) => (
                  <p key={`a-${i}`} className="text-emerald-600 truncate">+ {l}</p>
                ))}
                {diff.removedSamples.map((l, i) => (
                  <p key={`r-${i}`} className="text-red-600 truncate">- {l}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 flex rounded-md border overflow-hidden bg-card">
          {/* 行号 gutter（与编辑区滚动同步） */}
          <div
            ref={gutterRef}
            className="shrink-0 w-12 overflow-hidden border-r bg-muted/50 select-none py-2 text-right"
            aria-hidden="true"
          >
            {Array.from({ length: Math.min(lines, 5000) }, (_, i) => (
              <div key={i} className="px-2 text-[11px] leading-5 font-mono text-muted-foreground tabular-nums">
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            ref={taRef}
            value={content}
            onChange={handleChange}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (gutterRef.current) gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop
            }}
            spellCheck={false}
            disabled={loading}
            placeholder={loading ? "正在加载文件内容…" : ""}
            className="flex-1 min-h-[300px] max-h-[55vh] resize-none bg-transparent p-2 text-[12px] leading-5 font-mono outline-none focus:ring-1 focus:ring-ring"
            aria-label={`编辑 ${row.fileName}`}
          />
        </div>

        <DialogFooter className="shrink-0 flex-row justify-between sm:justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={undo} disabled={!canUndo || loading || saving} title="撤销（Ctrl+Z）">
              <Undo2 className="h-3.5 w-3.5" /> 撤销
            </Button>
            <Button variant="outline" size="sm" onClick={redo} disabled={!canRedo || loading || saving} title="重做（Ctrl+Shift+Z）">
              <Redo2 className="h-3.5 w-3.5" /> 重做
            </Button>
            <span className="text-[11px] text-muted-foreground ml-1 hidden sm:inline">
              撤销栈 {pastRef.current.length} 步
            </span>
          </div>
          <div className="flex items-center gap-2">
            {content !== original && <span className="text-xs text-amber-600">有未保存修改</span>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => applyContent(original, true)}
              disabled={content === original || loading || saving}
            >
              还原
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={loading || saving || byteLen > MAX_EDIT_BYTES}>
              {(loading || saving) && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              <Save className="mr-1 h-3.5 w-3.5" /> 保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function fmtBytes(n: number): string {
  if (!n) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Math.round(v * 1000) / 1000} ${units[i]}`
}
