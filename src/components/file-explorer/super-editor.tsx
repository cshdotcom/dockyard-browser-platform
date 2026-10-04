"use client"

// ============================================================
// r35 超级文件编辑器（用户点名功能）
// 用户诉求：文件编辑器增强 —— 格式 + 裁剪 + HTML 可视化 + txt/md 超级工具栏
//
// 自包含零新依赖的企业级编辑器：
//   · 行号槽 + 等宽编辑区（同步滚动）+ 状态栏（行:列/选中/总行/大小）
//   · 查找替换（正则/大小写/全部替换/计数高亮）+ 跳转行 + Ctrl+S 保存
//   · 超级工具栏（左右滑动不溢出）：大小写/Trim/去空行/去重/排序/反转/时间戳/
//     JSON 格式化与压缩/复制全部；按扩展名自适应启用
//   · MD 可视化（编辑+实时预览双栏）· HTML 可视化（沙箱 iframe）· SVG 可视化（内联渲染）
//   · Tab 两空格缩进 · 自动记忆只读/截断态
// ============================================================
import * as React from "react"
import { toast } from "sonner"
import {
  Save, Search, Replace, X, CaseUpper, CaseLower, Type, Eraser, ListOrdered,
  ArrowDownUp, Clock, Braces, Minimize2, Copy, Eye, Code2, WrapText, Hash, Image as ImageIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { renderMarkdown } from "@/lib/markdown"
import { cn } from "@/lib/utils"

export interface SuperEditorProps {
  name: string
  content: string
  truncated: boolean
  readOnly?: boolean
  onSave: (content: string) => Promise<void>
  onClose: () => void
}

const lineCount = (s: string) => s.split("\n").length
const extOf = (n: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(n)
  return m ? m[1].toLowerCase() : ""
}

export function SuperEditor({ name, content, truncated, readOnly, onSave, onClose }: SuperEditorProps) {
  const [text, setText] = React.useState(content)
  const [dirty, setDirty] = React.useState(false)
  const [cursor, setCursor] = React.useState({ line: 1, col: 1, sel: 0 })
  const [showFind, setShowFind] = React.useState(false)
  const [find, setFind] = React.useState("")
  const [replaceWith, setReplaceWith] = React.useState("")
  const [findOpts, setFindOpts] = React.useState({ regex: false, caseSensitive: false })
  const [viewMode, setViewMode] = React.useState<"edit" | "split" | "preview">("edit")
  const [saving, setSaving] = React.useState(false)
  const [jumpLine, setJumpLine] = React.useState("")

  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const gutterRef = React.useRef<HTMLDivElement>(null)
  const ext = extOf(name)
  const isMd = ext === "md" || ext === "markdown"
  const isHtml = ext === "html" || ext === "htm"
  const isSvg = ext === "svg"
  const isJson = ext === "json" || ext === "jsonl" || ext === "geojson" || ext === "har"
  const visualizable = isMd || isHtml || isSvg

  React.useEffect(() => {
    // 默认进入适合的可视化模式
    if (visualizable) setViewMode("split")
     
  }, [])

  const lines = React.useMemo(() => text.split("\n"), [text])

  const updateCursor = () => {
    const ta = taRef.current
    if (!ta) return
    const upto = text.slice(0, ta.selectionStart)
    const ln = upto.split("\n")
    setCursor({ line: ln.length, col: ln[ln.length - 1].length + 1, sel: ta.selectionEnd - ta.selectionStart })
  }

  const applyTransform = (fn: (s: string) => string, label: string) => {
    if (readOnly) return
    const next = fn(text)
    if (next === text) { toast.info("内容无变化"); return }
    setText(next)
    setDirty(true)
    toast.success(label)
  }

  // ---- 键盘：Tab 缩进 / Ctrl+S 保存 / Ctrl+F 查找 ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !readOnly) {
      e.preventDefault()
      const ta = taRef.current!
      const s = ta.selectionStart, en = ta.selectionEnd
      const next = text.slice(0, s) + "  " + text.slice(en)
      setText(next)
      setDirty(true)
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2 })
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault()
      void doSave()
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault()
      setShowFind(true)
    }
  }

  const doSave = async () => {
    if (readOnly || !dirty || truncated) return
    setSaving(true)
    try {
      await onSave(text)
      setDirty(false)
    } finally { setSaving(false) }
  }

  // ---- 查找替换 ----
  const matchRe = React.useMemo(() => {
    if (!find) return null
    try {
      const body = findOpts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      return new RegExp(body, findOpts.caseSensitive ? "g" : "gi")
    } catch { return null }
  }, [find, findOpts])

  const matchCount = React.useMemo(() => {
    if (!matchRe || !find) return 0
    return (text.match(matchRe) || []).length
  }, [text, matchRe, find])

  const findNext = (back = false) => {
    const ta = taRef.current
    if (!ta || !matchRe || !find) return
    matchRe.lastIndex = 0
    const matches: Array<{ s: number; e: number }> = []
    let m: RegExpExecArray | null
    while ((m = matchRe.exec(text)) !== null) {
      matches.push({ s: m.index, e: m.index + m[0].length })
      if (m.index === matchRe.lastIndex) matchRe.lastIndex++
    }
    if (matches.length === 0) { toast.info("未找到匹配"); return }
    const pos = ta.selectionEnd
    let target = back ? [...matches].reverse().find((x) => x.e < pos) : matches.find((x) => x.s > pos)
    if (!target) target = back ? matches[matches.length - 1] : matches[0]
    ta.focus()
    ta.setSelectionRange(target.s, target.e)
    // 滚动到目标行
    const lineNo = text.slice(0, target.s).split("\n").length - 1
    const lineH = 21
    ta.scrollTop = Math.max(0, lineNo * lineH - ta.clientHeight / 2)
    updateCursor()
  }

  const replaceOne = () => {
    const ta = taRef.current
    if (!ta || !matchRe || !find || readOnly) return
    matchRe.lastIndex = ta.selectionStart
    const m = matchRe.exec(text)
    if (!m) { findNext(); return }
    const next = text.slice(0, m.index) + replaceWith + text.slice(m.index + m[0].length)
    setText(next)
    setDirty(true)
    requestAnimationFrame(() => ta.setSelectionRange(m.index + replaceWith.length, m.index + replaceWith.length))
  }

  const replaceAll = () => {
    if (!matchRe || !find || readOnly) return
    const count = matchCount
    if (count === 0) { toast.info("未找到匹配"); return }
    const next = text.replace(matchRe, replaceWith)
    setText(next)
    setDirty(true)
    toast.success(`已替换 ${count} 处`)
  }

  // ---- 跳转行 ----
  const jumpToLine = () => {
    const n = parseInt(jumpLine, 10)
    const ta = taRef.current
    if (!Number.isFinite(n) || n < 1 || n > lines.length || !ta) { toast.error(`行号需在 1-${lines.length} 之间`); return }
    let pos = 0
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1
    ta.focus()
    ta.setSelectionRange(pos, pos)
    ta.scrollTop = Math.max(0, (n - 1) * 21 - ta.clientHeight / 2)
    updateCursor()
  }

  // ---- 工具栏动作集合（按格式自适应） ----
  const tools: Array<{ icon: React.ReactNode; label: string; hint?: string; onClick: () => void; hidden?: boolean }> = [
    { icon: <Clock className="h-3.5 w-3.5" />, label: "时间戳", hint: "插入当前时间戳", onClick: () => { const ta = taRef.current; const s = ta?.selectionStart ?? text.length; const stamp = new Date().toISOString().replace("T", " ").slice(0, 19); setText(text.slice(0, s) + stamp + text.slice(ta?.selectionEnd ?? s)); setDirty(true) } },
    { icon: <CaseUpper className="h-3.5 w-3.5" />, label: "AA", hint: "选中转大写（无选中则全文）", onClick: () => applyTransform((s) => (taRef.current?.selectionStart ?? 0) < (taRef.current?.selectionEnd ?? 0) ? s.slice(0, taRef.current!.selectionStart) + s.slice(taRef.current!.selectionStart, taRef.current!.selectionEnd).toUpperCase() + s.slice(taRef.current!.selectionEnd) : s.toUpperCase(), "已转大写") },
    { icon: <CaseLower className="h-3.5 w-3.5" />, label: "aa", hint: "选中转小写", onClick: () => applyTransform((s) => (taRef.current?.selectionStart ?? 0) < (taRef.current?.selectionEnd ?? 0) ? s.slice(0, taRef.current!.selectionStart) + s.slice(taRef.current!.selectionStart, taRef.current!.selectionEnd).toLowerCase() + s.slice(taRef.current!.selectionEnd) : s.toLowerCase(), "已转小写") },
    { icon: <Type className="h-3.5 w-3.5" />, label: "Aa", hint: "每行首字母大写", onClick: () => applyTransform((s) => s.split("\n").map((l) => l.replace(/^(\s*)(\w)/, (_, p, c) => p + c.toUpperCase())).join("\n"), "首字母已大写") },
    { icon: <Eraser className="h-3.5 w-3.5" />, label: "Trim", hint: "去除每行行尾空白", onClick: () => applyTransform((s) => s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n"), "已去除行尾空白") },
    { icon: <Eraser className="h-3.5 w-3.5" />, label: "去空行", hint: "压缩连续空行为一行", onClick: () => applyTransform((s) => s.replace(/\n{3,}/g, "\n\n"), "已压缩空行") },
    { icon: <ListOrdered className="h-3.5 w-3.5" />, label: "排序", hint: "按字典序排序全部行", onClick: () => applyTransform((s) => s.split("\n").sort((a, b) => a.localeCompare(b)).join("\n"), "已排序") },
    { icon: <ListOrdered className="h-3.5 w-3.5" />, label: "去重", hint: "删除重复行（保留首次出现）", onClick: () => applyTransform((s) => Array.from(new Set(s.split("\n"))).join("\n"), "已去重") },
    { icon: <ArrowDownUp className="h-3.5 w-3.5" />, label: "反转", hint: "反转行顺序", onClick: () => applyTransform((s) => s.split("\n").reverse().join("\n"), "已反转") },
    { icon: <Braces className="h-3.5 w-3.5" />, label: "格式化", hint: "JSON 美化缩进", onClick: () => applyTransform((s) => JSON.stringify(JSON.parse(s), null, 2), "JSON 已格式化"), hidden: !isJson },
    { icon: <Minimize2 className="h-3.5 w-3.5" />, label: "压缩", hint: "JSON 压缩单行", onClick: () => applyTransform((s) => JSON.stringify(JSON.parse(s)), "JSON 已压缩"), hidden: !isJson },
    { icon: <Copy className="h-3.5 w-3.5" />, label: "复制", hint: "复制全部内容", onClick: () => { void navigator.clipboard.writeText(text).then(() => toast.success("已复制全部内容")).catch(() => toast.error("复制失败（浏览器限制）")) } },
  ]

  const preview = React.useMemo(() => {
    if (isMd) return <div className="markdown-preview h-full overflow-auto p-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    if (isHtml) return <iframe title="html-preview" srcDoc={text} sandbox="allow-same-origin allow-popups" className="h-full w-full bg-white" />
    if (isSvg) return (
      <div className="flex h-full items-center justify-center bg-[repeating-conic-gradient(#f0f0f0_0%_25%,#fff_0%_50%)] bg-[length:16px_16px] p-4 dark:bg-[repeating-conic-gradient(#1c1c1c_0%_25%,#111_0%_50%)]">
        <div className="max-h-full max-w-full bg-white p-2 shadow" dangerouslySetInnerHTML={{ __html: text.replace(/<\?xml[^>]*\?>/, "") }} />
      </div>
    )
    return null
  }, [text, isMd, isHtml, isSvg, viewMode])

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border">
      {/* 标题栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="max-w-[260px] truncate font-medium text-sm">{name}</span>
        <Badge variant="outline" className="font-mono text-[10px] uppercase">{ext || "text"}</Badge>
        {dirty && <Badge className="bg-amber-500 text-[10px]">未保存</Badge>}
        {truncated && <Badge variant="destructive" className="text-[10px]">文件超过编辑上限已截断（只读）</Badge>}
        {readOnly && <Badge variant="secondary" className="text-[10px]">只读</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          {visualizable && (
            <div className="flex items-center rounded-md border p-0.5">
              <button type="button" onClick={() => setViewMode("edit")} className={cn("rounded px-2 py-0.5 text-xs", viewMode === "edit" && "bg-primary text-primary-foreground")} title="仅编辑"><Code2 className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setViewMode("split")} className={cn("rounded px-2 py-0.5 text-xs", viewMode === "split" && "bg-primary text-primary-foreground")} title="编辑 + 实时预览"><WrapText className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setViewMode("preview")} className={cn("rounded px-2 py-0.5 text-xs", viewMode === "preview" && "bg-primary text-primary-foreground")} title="仅可视化预览"><Eye className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setShowFind((v) => !v)} title="查找替换 (Ctrl+F)">
            <Search className="h-3.5 w-3.5" />查找
          </Button>
          <Button size="sm" className="h-7 gap-1" onClick={() => void doSave()} disabled={!dirty || readOnly || truncated || saving}>
            <Save className={cn("h-3.5 w-3.5", saving && "animate-pulse")} />保存
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* 查找替换面板 */}
      {showFind && (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-3 py-1.5 text-xs">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="查找内容" className="h-7 w-44 rounded border pl-7 pr-2 font-mono" onKeyDown={(e) => { if (e.key === "Enter") findNext(e.shiftKey) }} />
          </div>
          <div className="relative">
            <Replace className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)} placeholder="替换为" className="h-7 w-44 rounded border pl-7 pr-2 font-mono" />
          </div>
          <Button size="sm" variant="outline" className="h-7" onClick={() => findNext(false)}>下一个</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => findNext(true)}>上一个</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={replaceOne} disabled={readOnly}>替换</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={replaceAll} disabled={readOnly}>全部替换</Button>
          <label className="flex items-center gap-1"><input type="checkbox" checked={findOpts.regex} onChange={(e) => setFindOpts((o) => ({ ...o, regex: e.target.checked }))} />正则</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={findOpts.caseSensitive} onChange={(e) => setFindOpts((o) => ({ ...o, caseSensitive: e.target.checked }))} />区分大小写</label>
          {find && <span className="text-muted-foreground">{matchCount} 处匹配</span>}
        </div>
      )}

      {/* 超级工具栏（左右滑动，永不溢出） */}
      <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/20 px-2 py-1.5 [scrollbar-width:thin]">
        {tools.filter((t) => !t.hidden).map((t, i) => (
          <button key={i} type="button" onClick={t.onClick} title={t.hint || t.label} disabled={readOnly}
            className="flex shrink-0 items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
            {t.icon}{t.label && <span className="hidden sm:inline">{t.label}</span>}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          <Hash className="h-3 w-3 text-muted-foreground" />
          <input value={jumpLine} onChange={(e) => setJumpLine(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") jumpToLine() }} placeholder="行号" className="h-7 w-16 rounded border px-2 text-[11px] font-mono" />
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={jumpToLine}>跳转</Button>
        </div>
      </div>

      {/* 主体：编辑区 / 双栏 / 纯预览 */}
      <div className="flex min-h-0 flex-1">
        {viewMode !== "preview" && (
          <div className={cn("flex min-h-0", viewMode === "split" ? "w-1/2 border-r" : "w-full")}>
            <div ref={gutterRef} className="w-12 shrink-0 select-none overflow-hidden border-r bg-muted/30 py-2 text-right font-mono text-[11px] leading-[21px] text-muted-foreground">
              {lines.slice(Math.floor((taRef.current?.scrollTop ?? 0) / 21), Math.floor((taRef.current?.scrollTop ?? 0) / 21) + 500).map((_, i) => {
                const no = Math.floor((taRef.current?.scrollTop ?? 0) / 21) + i + 1
                return <div key={no} className={cn("pr-2", no === cursor.line && "bg-primary/10 text-primary font-semibold")}>{no}</div>
              })}
            </div>
            <textarea
              ref={taRef}
              value={text}
              readOnly={readOnly || truncated}
              spellCheck={false}
              onChange={(e) => { setText(e.target.value); setDirty(true) }}
              onKeyDown={onKeyDown}
              onKeyUp={updateCursor}
              onClick={updateCursor}
              onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop }}
              className="min-h-0 flex-1 resize-none bg-background p-2 font-mono text-[12px] leading-[21px] outline-none"
              style={{ tabSize: 2 }}
            />
          </div>
        )}
        {viewMode !== "edit" && (
          <div className={cn("min-h-0", viewMode === "split" ? "w-1/2" : "w-full")}>
            {preview}
          </div>
        )}
      </div>

      {/* 状态栏 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
        <span>行 {cursor.line}/{lines.length}</span>
        <span>列 {cursor.col}</span>
        {cursor.sel > 0 && <span className="text-primary">选中 {cursor.sel} 字符</span>}
        <span>{new Blob([text]).size.toLocaleString()} 字节</span>
        <span className="ml-auto flex items-center gap-1"><ImageIcon className="h-3 w-3" />UTF-8 · LF · {ext.toUpperCase() || "TXT"}</span>
      </div>
    </div>
  )
}
