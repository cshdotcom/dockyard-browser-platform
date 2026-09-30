"use client"

// ============================================================
// 统一筛选搜索栏（全站审计/数据页复用）
// 能力：关键词全文检索 + 搜索类型筛选（下拉多级）+ 时间范围快捷预设（今日/近7天/近30天/自定义起止）
// 交互：URL 查询参数驱动（回车/选择即提交并回到第 1 页）；移动端自适应换行
// 复用方：审计日志 / 安全事件 / CRX 扩展审计 / 插件库 / 安装状态 等所有列表页
// ============================================================

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search, X, CalendarDays, Filter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export interface FilterOption {
  label: string
  value: string
}

export interface FilterSelectDef {
  key: string // URL 参数名
  label: string
  options: FilterOption[]
  placeholder?: string
  allowCustom?: boolean // 允许输入自定义值（模糊匹配型筛选）
}

export interface UnifiedFilterBarProps {
  keyword?: string
  filters: Record<string, string>
  /** 搜索类型筛选：一个或多个下拉维度（如 审计数据类型 / 级别 / 状态） */
  selectDefs: FilterSelectDef[]
  /** 时间范围：默认开启；键名可配置（默认 from/to） */
  showTimeRange?: boolean
  fromKey?: string
  toKey?: string
  /** 附加说明/占位 */
  keywordPlaceholder?: string
  /** 时间预设键（切换预设时写入 fromKey/toKey） */
  className?: string
}

// 时间快捷预设：计算 [from, to]（YYYY-MM-DD）
function presetRange(preset: string): { from: string; to: string } | null {
  const now = new Date()
  const fmt = (d: Date) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }
  if (preset === "today") return { from: fmt(now), to: fmt(now) }
  if (preset === "7d") {
    const d = new Date(now.getTime() - 6 * 86400_000)
    return { from: fmt(d), to: fmt(now) }
  }
  if (preset === "30d") {
    const d = new Date(now.getTime() - 29 * 86400_000)
    return { from: fmt(d), to: fmt(now) }
  }
  if (preset === "90d") {
    const d = new Date(now.getTime() - 89 * 86400_000)
    return { from: fmt(d), to: fmt(now) }
  }
  return null
}

// 由当前 from/to 反推命中的预设键（用于高亮）
function activePreset(from?: string, to?: string): string | null {
  if (!from || !to) return null
  const today = presetRange("today")
  if (today && today.from === from && today.to === to) return "today"
  const d7 = presetRange("7d")
  if (d7 && d7.from === from && d7.to === to) return "7d"
  const d30 = presetRange("30d")
  if (d30 && d30.from === from && d30.to === to) return "30d"
  const d90 = presetRange("90d")
  if (d90 && d90.from === from && d90.to === to) return "90d"
  return null
}

export function UnifiedFilterBar({
  keyword,
  filters,
  selectDefs = [],
  showTimeRange = true,
  fromKey = "from",
  toKey = "to",
  keywordPlaceholder = "全文关键词检索…（回车提交）",
  className,
}: UnifiedFilterBarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [kw, setKw] = React.useState(keyword || "")

  React.useEffect(() => {
    setKw(keyword || "")
  }, [keyword, searchParams.toString()])

  const pushQuery = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") sp.delete(k)
      else sp.set(k, v)
    }
    sp.set("page", "1")
    router.push(`${pathname}?${sp.toString()}`)
  }

  const applyPreset = (preset: string) => {
    const range = presetRange(preset)
    if (range) pushQuery({ [fromKey]: range.from, [toKey]: range.to })
  }

  const from = filters[fromKey] || ""
  const to = filters[toKey] || ""
  const hitPreset = activePreset(from, to)
  const hasAnyFilter = Object.keys(filters).some((k) => k !== "tab") || keyword

  const presetMeta: { key: string; label: string }[] = [
    { key: "today", label: "今日" },
    { key: "7d", label: "近7天" },
    { key: "30d", label: "近30天" },
    { key: "90d", label: "近90天" },
  ]

  return (
    <div className={cn("rounded-lg border bg-card p-3 space-y-3", className)}>
      {/* 第一行：关键词 + 类型筛选下拉 */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-52 flex-1 items-center gap-2 rounded-md border px-2 md:max-w-sm">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") pushQuery({ keyword: kw || undefined }) }}
            placeholder={keywordPlaceholder}
            className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {kw && (
            <button type="button" aria-label="清空关键词" onClick={() => { setKw(""); pushQuery({ keyword: undefined }) }}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {selectDefs.map((def) => (
          <div key={def.key} className="space-y-0">
            <Label className="sr-only">{def.label}</Label>
            <select
              value={filters[def.key] || ""}
              onChange={(e) => pushQuery({ [def.key]: e.target.value || undefined })}
              className="h-8 rounded-md border bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring max-w-44"
              aria-label={def.label}
            >
              <option value="">{def.label}：全部</option>
              {def.options.map((o) => (
                <option key={o.value} value={o.value}>{def.label}：{o.label}</option>
              ))}
            </select>
          </div>
        ))}
        <Button size="sm" className="h-8" onClick={() => pushQuery({ keyword: kw || undefined })}>
          <Search className="mr-1 h-3.5 w-3.5" /> 搜索
        </Button>
        {hasAnyFilter && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => {
            const sp = new URLSearchParams(searchParams.toString())
            for (const k of Array.from(sp.keys())) {
              if (k === "tab" || k === "page" || k === "pageSize" || k === "sortField" || k === "sortOrder") continue
              sp.delete(k)
            }
            router.push(`${pathname}?${sp.toString()}`)
          }}>
            <X className="mr-1 h-3.5 w-3.5" /> 清除筛选
          </Button>
        )}
      </div>

      {/* 第二行：时间范围快捷预设 + 自定义起止 */}
      {showTimeRange && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" /> 时间范围
          </span>
          <div className="flex flex-wrap gap-1">
            {presetMeta.map((p) => (
              <button key={p.key} type="button" onClick={() => applyPreset(p.key)}
                className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  hitPreset === p.key ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent")}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Input type="date" className="h-7 w-[130px] text-xs" value={from}
              onChange={(e) => pushQuery({ [fromKey]: e.target.value || undefined })} aria-label="起始日期" />
            <span className="text-xs text-muted-foreground">至</span>
            <Input type="date" className="h-7 w-[130px] text-xs" value={to}
              onChange={(e) => pushQuery({ [toKey]: e.target.value || undefined })} aria-label="截止日期" />
          </div>
          {hitPreset && <Badge variant="secondary" className="text-[10px]">{presetMeta.find((p) => p.key === hitPreset)?.label} · {from} ~ {to}</Badge>}
        </div>
      )}

      {/* 筛选命中摘要（移动端友好） */}
      {hasAnyFilter && (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">当前筛选：</span>
          {keyword && <Badge variant="outline" className="text-[10px] gap-1">关键词：{keyword.slice(0, 24)}{keyword.length > 24 ? "…" : ""}</Badge>}
          {selectDefs.map((def) => filters[def.key] ? (
            <Badge key={def.key} variant="outline" className="text-[10px]">{def.label}：{def.options.find((o) => o.value === filters[def.key])?.label || filters[def.key]}</Badge>
          ) : null)}
          {from && <Badge variant="outline" className="text-[10px]">{from} ~ {to || "今"}</Badge>}
        </div>
      )}
    </div>
  )
}
