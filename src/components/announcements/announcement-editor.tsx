"use client"

// ============================================================
// 公告轻量 Markdown 编辑器（自研，无重型编辑器依赖）
//   · 工具栏：加粗/斜体/删除线 · H2/H3 · 列表/有序/任务 · 引用 ·
//     行内代码/代码块 · 链接/图片 · 表格 · 分割线 · 撤销重做
//   · 「插入 HTML」：粘贴任意 HTML 片段直接插入（渲染侧 rehype-raw + sanitize）
//   · 编辑 / 预览 双页签（实时 MD 渲染，与用户端完全一致）
//   · 选区感知：工具栏对选中文本包裹语法；无选区插入占位骨架
//   · 字数统计（上限 5000）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import {
  Bold, Code, Code2, Eye, Heading2, Heading3, Image as ImageIcon, Italic, Link2,
  List, ListOrdered, ListTodo, Minus, PencilLine, Quote, Redo2, Strikethrough, Table, Undo2, Braces,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { AnnouncementContent } from "./announcement-content"

export const ANNOUNCEMENT_CONTENT_MAX = 5000

interface EditorAction {
  icon: React.ReactNode
  title: string
  // 返回插入/包裹后的片段与选区
  transform: (selected: string) => { text: string; selectStart: number; selectEnd: number }
}

const WRAP = (before: string, after: string, placeholder: string): EditorAction["transform"] => (sel) => {
  const inner = sel || placeholder
  const text = `${before}${inner}${after}`
  const selectStart = before.length
  const selectEnd = before.length + inner.length
  return { text, selectStart, selectEnd }
}

const LINE_PREFIX = (prefix: string): EditorAction["transform"] => (sel) => {
  const inner = sel || "列表项"
  const lines = inner.split("\n").map((l) => (l.trim() ? `${prefix}${l}` : `${prefix}列表项`))
  const text = lines.join("\n")
  return { text, selectStart: 0, selectEnd: text.length }
}

const ACTIONS: EditorAction[] = [
  { icon: <Bold className="h-4 w-4" />, title: "加粗 **text**", transform: WRAP("**", "**", "加粗文字") },
  { icon: <Italic className="h-4 w-4" />, title: "斜体 *text*", transform: WRAP("*", "*", "斜体文字") },
  { icon: <Strikethrough className="h-4 w-4" />, title: "删除线 ~~text~~", transform: WRAP("~~", "~~", "删除文字") },
  { icon: <Heading2 className="h-4 w-4" />, title: "二级标题", transform: (sel) => ({ text: `## ${sel || "标题"}`, selectStart: 3, selectEnd: 3 + (sel || "标题").length }) },
  { icon: <Heading3 className="h-4 w-4" />, title: "三级标题", transform: (sel) => ({ text: `### ${sel || "小节标题"}`, selectStart: 4, selectEnd: 4 + (sel || "小节标题").length }) },
  { icon: <List className="h-4 w-4" />, title: "无序列表", transform: LINE_PREFIX("- ") },
  { icon: <ListOrdered className="h-4 w-4" />, title: "有序列表", transform: LINE_PREFIX("1. ") },
  { icon: <ListTodo className="h-4 w-4" />, title: "任务清单", transform: LINE_PREFIX("- [ ] ") },
  { icon: <Quote className="h-4 w-4" />, title: "引用块", transform: LINE_PREFIX("> ") },
  { icon: <Code className="h-4 w-4" />, title: "行内代码 `code`", transform: WRAP("`", "`", "code") },
  { icon: <Code2 className="h-4 w-4" />, title: "代码块", transform: (sel) => ({ text: `\`\`\`\n${sel || "// 代码内容"}\n\`\`\``, selectStart: 4, selectEnd: 4 + (sel || "// 代码内容").length }) },
  { icon: <Link2 className="h-4 w-4" />, title: "链接", transform: (sel) => ({ text: `[${sel || "链接文字"}](https://)`, selectStart: 0, selectEnd: 0 }) },
  { icon: <ImageIcon className="h-4 w-4" />, title: "图片", transform: (sel) => ({ text: `![${sel || "图片描述"}](https://)`, selectStart: 0, selectEnd: 0 }) },
  {
    icon: <Table className="h-4 w-4" />,
    title: "表格",
    transform: () => ({
      text: "\n| 列A | 列B | 列C |\n| --- | --- | --- |\n| 值1 | 值2 | 值3 |\n| 值4 | 值5 | 值6 |\n",
      selectStart: 0, selectEnd: 0,
    }),
  },
  { icon: <Minus className="h-4 w-4" />, title: "分割线", transform: () => ({ text: "\n---\n", selectStart: 0, selectEnd: 0 }) },
]

export function AnnouncementEditor({
  value,
  onChange,
  rows = 9,
  placeholder = "支持 Markdown 语法与直接粘贴 HTML；可用上方工具栏快速排版",
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  const taRef = React.useRef<HTMLTextAreaElement | null>(null)
  const undoStack = React.useRef<string[]>([])
  const redoStack = React.useRef<string[]>([])
  const [undoCount, setUndoCount] = React.useState(0)
  const [redoCount, setRedoCount] = React.useState(0)
  const [mode, setMode] = React.useState<"edit" | "preview">("edit")
  const [htmlDialogOpen, setHtmlDialogOpen] = React.useState(false)
  const [htmlDraft, setHtmlDraft] = React.useState("")

  const pushUndo = (prev: string) => {
    undoStack.current.push(prev)
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
    setUndoCount(undoStack.current.length)
    setRedoCount(0)
  }

  const undo = () => {
    const prev = undoStack.current.pop()
    if (prev === undefined) return
    redoStack.current.push(value)
    onChange(prev)
    setUndoCount(undoStack.current.length)
    setRedoCount(redoStack.current.length)
  }
  const redo = () => {
    const next = redoStack.current.pop()
    if (next === undefined) return
    undoStack.current.push(value)
    onChange(next)
    setUndoCount(undoStack.current.length)
    setRedoCount(redoStack.current.length)
  }

  // 选区感知插入（块级语法自动补换行）
  const applyAction = (a: EditorAction) => {
    const ta = taRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = value.slice(start, end)
    const { text, selectStart, selectEnd } = a.transform(selected)
    const isBlock = text.startsWith("\n") || text.startsWith("##") || text.startsWith("- ") || text.startsWith("> ") || text.startsWith("```") || text.startsWith("1. ")
    const before = value.slice(0, start)
    const needsLeadingNewline = isBlock && before.length > 0 && !before.endsWith("\n")
    const insert = (needsLeadingNewline ? "\n" : "") + text
    pushUndo(value)
    const next = before + insert + value.slice(end)
    onChange(next)
    // 恢复选区
    requestAnimationFrame(() => {
      ta.focus()
      const base = start + (needsLeadingNewline ? 1 : 0)
      ta.setSelectionRange(base + selectStart, base + selectEnd)
    })
  }

  const insertHtml = () => {
    const snippet = htmlDraft.trim()
    if (!snippet) {
      toast.error("请粘贴 HTML 片段")
      return
    }
    const ta = taRef.current
    const at = ta ? ta.selectionStart : value.length
    const before = value.slice(0, at)
    const needsNewline = before.length > 0 && !before.endsWith("\n")
    pushUndo(value)
    const next = before + (needsNewline ? "\n" : "") + snippet + "\n" + value.slice(at)
    onChange(next)
    setHtmlDialogOpen(false)
    setHtmlDraft("")
    toast.success("HTML 片段已插入（预览页签可实时查看渲染效果）")
  }

  const overLimit = value.length > ANNOUNCEMENT_CONTENT_MAX

  return (
    <div className="rounded-md border focus-within:ring-1 focus-within:ring-ring">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1">
        {ACTIONS.map((a, i) => (
          <button
            key={i}
            type="button"
            title={a.title}
            aria-label={a.title}
            className="rounded p-1.5 hover:bg-muted active:scale-95 text-muted-foreground hover:text-foreground transition"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyAction(a)}
          >
            {a.icon}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          title="插入 HTML 片段（直接粘贴，正常渲染）"
          aria-label="插入 HTML"
          className="rounded p-1.5 hover:bg-muted active:scale-95 text-violet-600 dark:text-violet-400 transition"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setHtmlDialogOpen(true)}
        >
          <Braces className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          title="撤销"
          aria-label="撤销"
          className="rounded p-1.5 hover:bg-muted text-muted-foreground transition disabled:opacity-40"
          onMouseDown={(e) => e.preventDefault()}
          onClick={undo}
          disabled={undoCount === 0}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="重做"
          aria-label="重做"
          className="rounded p-1.5 hover:bg-muted text-muted-foreground transition disabled:opacity-40"
          onMouseDown={(e) => e.preventDefault()}
          onClick={redo}
          disabled={redoCount === 0}
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <span className={cn("ml-auto text-xs tabular-nums", overLimit ? "text-red-600 font-medium" : "text-muted-foreground")}>
          {value.length} / {ANNOUNCEMENT_CONTENT_MAX}
        </span>
      </div>

      {/* 编辑 / 预览 */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as "edit" | "preview")}>
        <div className="flex items-center justify-between border-b px-2 py-1">
          <TabsList className="h-7">
            <TabsTrigger value="edit" className="text-xs gap-1 px-2.5"><PencilLine className="h-3 w-3" />编辑</TabsTrigger>
            <TabsTrigger value="preview" className="text-xs gap-1 px-2.5"><Eye className="h-3 w-3" />预览</TabsTrigger>
          </TabsList>
          <p className="text-[11px] text-muted-foreground">Markdown + HTML 双支持</p>
        </div>
        <TabsContent value="edit" className="m-0">
          <Textarea
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo() }
              if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo() }
              if ((e.ctrlKey || e.metaKey) && e.key === "b") { e.preventDefault(); applyAction(ACTIONS[0]) }
              if ((e.ctrlKey || e.metaKey) && e.key === "i") { e.preventDefault(); applyAction(ACTIONS[1]) }
            }}
            rows={rows}
            placeholder={placeholder}
            maxLength={ANNOUNCEMENT_CONTENT_MAX * 2}
            className="rounded-none border-0 focus-visible:ring-0 font-mono text-[13px] leading-relaxed"
          />
        </TabsContent>
        <TabsContent value="preview" className="m-0">
          <div className="min-h-[calc(var(--ed-h,180px))] max-h-96 overflow-y-auto px-4 py-2">
            {value.trim() ? (
              <AnnouncementContent content={value} />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">暂无内容，切换到编辑页签开始撰写</p>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* HTML 插入弹窗 */}
      <Dialog open={htmlDialogOpen} onOpenChange={setHtmlDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>插入 HTML 片段</DialogTitle>
            <DialogDescription>
              粘贴任意 HTML（div/span/table/img/video 等）；渲染前经白名单消毒（script/iframe/事件属性自动剥离）
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={htmlDraft}
            onChange={(e) => setHtmlDraft(e.target.value)}
            rows={7}
            placeholder={'<div style="text-align:center">\n  <h3 style="color:#0d9488">重要通知</h3>\n  <p>支持 <strong>富文本</strong>、<span style="color:#dc2626">彩色文字</span> 与表格</p>\n</div>'}
            className="font-mono text-[13px]"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setHtmlDialogOpen(false)}>取消</Button>
            <Button onClick={insertHtml}>插入到光标处</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
