"use client"

// 高危操作二次确认弹窗：支持输入确认文字的强确认模式
// 全站高危操作（物理删除/恢复数据库/批量作废）统一使用

import * as React from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  requirePhrase?: string // 强确认：需要手动输入的文字
  destructive?: boolean
  loading?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "确认执行",
  cancelText = "取消",
  requirePhrase,
  destructive,
  loading,
  onConfirm,
}: ConfirmDialogProps) {
  const [phrase, setPhrase] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const ok = !requirePhrase || phrase === requirePhrase

  React.useEffect(() => {
    if (open) setPhrase("")
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle className="h-5 w-5 text-red-500" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription className="text-left whitespace-pre-line">{description}</DialogDescription>}
        </DialogHeader>
        {requirePhrase && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              请输入 <span className="font-mono font-semibold text-foreground">{requirePhrase}</span> 以确认操作：
            </p>
            <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={requirePhrase} autoComplete="off" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onOpenChange(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            {(busy || loading) && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 数字输入组件：强制支持 0.001 最小步进；前端初校验 + 显示精度
import { cn } from "@/lib/utils"

interface PrecisionInputProps {
  value: number | string
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  className?: string
  placeholder?: string
  disabled?: boolean
}

export function PrecisionInput({ value, onChange, min = 0, max = 1e9, step = 0.001, suffix, className, placeholder, disabled }: PrecisionInputProps) {
  const [text, setText] = React.useState(String(value ?? ""))
  React.useEffect(() => {
    setText(String(value ?? ""))
  }, [value])

  const commit = (raw: string) => {
    const n = Number(raw)
    if (Number.isFinite(n)) {
      const clamped = Math.min(Math.max(Math.round(n * 1000) / 1000, min), max)
      onChange(clamped)
      setText(String(clamped))
    } else {
      setText(String(value ?? ""))
    }
  }

  return (
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value)
        }}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
          suffix && "pr-12",
          className
        )}
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  )
}

// 统计数字卡片
export function StatCard({
  title,
  value,
  sub,
  icon,
  tone = "default",
}: {
  title: string
  value: React.ReactNode
  sub?: string
  icon?: React.ReactNode
  tone?: "default" | "success" | "warning" | "danger" | "muted"
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-red-600",
    muted: "text-muted-foreground",
  }[tone]
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{title}</p>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums", toneClass)}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}
