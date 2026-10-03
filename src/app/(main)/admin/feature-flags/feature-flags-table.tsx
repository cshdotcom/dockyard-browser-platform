"use client"

// 功能开关表（r27-f）：分组卡片 + 行级 Switch（乐观更新 + 失败回滚）
// 写入复用 setConfigAction（SUPER_ADMIN；版本快照 + 审计 + 内存缓存刷新全链路）

import { useState, useTransition } from "react"
import { setConfigAction } from "@/server/actions/config"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { CheckCircle2, XCircle, RotateCcw, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export interface FlagRow {
  key: string
  name: string
  description: string
  effect: "immediate" | "next-session" | "next-build"
  default: boolean
  current: boolean
}

export interface FlagCategory {
  category: string
  flags: FlagRow[]
}

export function FeatureFlagsTable({ byCategory, canWrite, effectLabel }: { byCategory: FlagCategory[]; canWrite: boolean; effectLabel: Record<string, string> }) {
  const [values, setValues] = useState<Record<string, boolean>>(() => Object.fromEntries(byCategory.flatMap((c) => c.flags.map((f) => [f.key, f.current]))))
  const [pending, startTransition] = useTransition()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const toggle = (flag: FlagRow) => {
    if (!canWrite) {
      toast.error("仅超级管理员可修改功能开关")
      return
    }
    const before = values[flag.key]
    const next = !before
    setValues((v) => ({ ...v, [flag.key]: next }))
    setBusyKey(flag.key)
    startTransition(async () => {
      try {
        const res = await setConfigAction({ items: [{ key: flag.key, value: next }] })
        if (res.code !== 0) throw new Error(res.msg || "保存失败")
        toast.success(`${flag.name} 已${next ? "开启" : "关闭"}（${effectLabel[flag.effect]}）`)
      } catch (e) {
        setValues((v) => ({ ...v, [flag.key]: before }))
        toast.error(e instanceof Error ? e.message : "保存失败")
      } finally {
        setBusyKey(null)
      }
    })
  }

  const resetDefault = (flag: FlagRow) => {
    if (!canWrite) return
    setValues((v) => ({ ...v, [flag.key]: flag.default }))
    setBusyKey(flag.key)
    startTransition(async () => {
      try {
        const res = await setConfigAction({ items: [{ key: flag.key, value: flag.default }] })
        if (res.code !== 0) throw new Error(res.msg || "保存失败")
        toast.success(`${flag.name} 已恢复默认（${flag.default ? "开" : "关"}）`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败")
      } finally {
        setBusyKey(null)
      }
    })
  }

  return (
    <div className="space-y-5">
      {byCategory.map((cat) => (
        <div key={cat.category} className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{cat.category}</h2>
            <span className="text-xs text-muted-foreground">
              {cat.flags.filter((f) => values[f.key]).length}/{cat.flags.length} 开启
            </span>
          </div>
          <div className="divide-y">
            {cat.flags.map((flag) => {
              const on = values[flag.key]
              const isDefault = on === flag.default
              const busy = busyKey === flag.key && pending
              return (
                <div key={flag.key} className="px-4 py-3 flex items-center gap-4 hover:bg-muted/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{flag.name}</span>
                      {on ? (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-300 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950/40 gap-1">
                          <CheckCircle2 className="h-3 w-3" />已启用
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground gap-1">
                          <XCircle className="h-3 w-3" />已停用
                        </Badge>
                      )}
                      {!isDefault && (
                        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950/40">
                          非默认
                        </Badge>
                      )}
                      <Badge variant="secondary" className="font-normal">{effectLabel[flag.effect]}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{flag.description}</p>
                    <code className="text-[10px] text-muted-foreground/70">{flag.key}</code>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canWrite && !isDefault && (
                      <button
                        onClick={() => resetDefault(flag)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                        title="恢复默认值"
                      >
                        <RotateCcw className="h-3 w-3" />默认
                      </button>
                    )}
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch checked={on} onCheckedChange={() => toggle(flag)} disabled={!canWrite} aria-label={flag.name} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {!canWrite && (
        <div className={cn("rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm text-muted-foreground")}>
          当前为管理员查看模式：仅超级管理员可切换功能开关（全部变更均有版本快照与审计留痕）。
        </div>
      )}
    </div>
  )
}
