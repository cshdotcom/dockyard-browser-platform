"use client"

// ============================================================
// r31：通用可搜索多选筛选器（Popover 形态）
//   场景：我的记录多选沙箱 / DFS 多选节点 / 分享多选用户与组 等
//   交互：搜索（名称/副标题匹配）→ 勾选 → 已选 chips 徽章（可移除）→ 全选/清空
//   与 r30 公告双多选面板同款交互语义，抽成通用组件复用
// ============================================================

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Check, ChevronsUpDown, Search, X } from "lucide-react"

export interface MultiOption {
  id: string
  label: string
  sub?: string
  dot?: string // 状态点颜色（如运行中=emerald）
}

export function MultiSelectPopover({
  options,
  selected,
  onChange,
  placeholder,
  searchPlaceholder,
  triggerClassName,
  maxChips = 2,
  disabled,
  width = 300,
}: {
  options: MultiOption[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder: string
  searchPlaceholder?: string
  triggerClassName?: string
  maxChips?: number
  disabled?: boolean
  width?: number
}) {
  const [open, setOpen] = React.useState(false)
  const [kw, setKw] = React.useState("")

  const labelById = React.useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options])
  const filtered = React.useMemo(() => {
    if (!kw.trim()) return options
    const q = kw.trim().toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.sub || "").toLowerCase().includes(q))
  }, [options, kw])

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const summary = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? (labelById.get(selected[0]) || selected[0])
      : `已选 ${selected.length} 项`

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}
            className={cn("h-8 gap-1.5 font-normal", selected.length > 0 && "border-teal-400 text-teal-700", triggerClassName)}>
            <ChevronsUpDown className="h-3.5 w-3.5" />
            <span className="max-w-40 truncate">{summary}</span>
            {selected.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                aria-label="清空筛选"
                className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
                onClick={(e) => { e.stopPropagation(); onChange([]) }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onChange([]) } }}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0" align="start" style={{ width }}>
          <div className="flex items-center gap-2 border-b p-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder={searchPlaceholder || "搜索…"}
                className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-sm focus:outline-none focus:ring-1 focus:ring-teal-400"
              />
            </div>
            {kw && (
              <button type="button" onClick={() => setKw("")} className="rounded p-1 text-muted-foreground hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">无匹配项</div>
            )}
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  selected.includes(o.id) && "bg-teal-50/60")}
              >
                <Checkbox checked={selected.includes(o.id)} onCheckedChange={() => toggle(o.id)} className="pointer-events-none" />
                {o.dot && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", o.dot)} />}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.sub && <span className="shrink-0 text-[10px] text-muted-foreground">{o.sub}</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t p-2 text-xs">
            <button type="button" className="text-teal-600 hover:underline disabled:opacity-40"
              disabled={selected.length === options.length} onClick={() => onChange(options.map((o) => o.id))}>
              全选
            </button>
            <span className="text-muted-foreground">{selected.length}/{options.length}</span>
            <button type="button" className="text-muted-foreground hover:underline disabled:opacity-40"
              disabled={selected.length === 0} onClick={() => onChange([])}>
              清空
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* 已选 chips（超出 maxChips 折叠计数） */}
      {selected.slice(0, maxChips).map((id) => (
        <Badge key={id} variant="outline" className="max-w-36 gap-1 border-teal-200 bg-teal-50 text-teal-700">
          <span className="truncate">{labelById.get(id) || id}</span>
          <button type="button" onClick={() => onChange(selected.filter((x) => x !== id))} aria-label="移除" className="shrink-0">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {selected.length > maxChips && (
        <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-700">
          +{selected.length - maxChips}
        </Badge>
      )}
    </div>
  )
}
