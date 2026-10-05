"use client"

// ============================================================
// r38：安装向导 · 第一步 —— 数据库绑定（首启 GUI 配置通道）
//
// 展示条件（由 /api/setup/database GET 决定）：
//   · needsDbBinding=true（生效库连不上：env 错误配置/库宕机）→ 强制绑定
//   · needsDbBinding=false → 默认收起（高级绑定可展开 —— env 未显式配置时）
//       env 已配置且可连接 → 显示「env 已就绪」卡（跳过绑定直接创建管理员）
//
// 提交（POST /api/setup/database）：
//   校验 → 探测 →（空库自动 push+seed，SEED_SKIP_ADMIN 防默认密码）→
//   写 db-active.json（initSource=setup）→ 热切换 → 进入第二步（管理员创建）
// ============================================================

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Database, Plug, Loader2, CheckCircle2, XCircle, ChevronDown, Server } from "lucide-react"

interface WizardDbState {
  needsDbBinding: boolean
  active: { provider: string; urlMasked: string; source: string; connectable: boolean; hasSchema: boolean; hasData: boolean; userCount: number; version: string; latencyMs: number; probeError: string | null }
  env: { provider: string; urlMasked: string; configured: boolean }
  dbActive: { provider: string; urlMasked: string; initSource: string } | null
  hasAdmin: boolean
  setupTokenHint: string
}

export function DatabaseBindingStep({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<WizardDbState | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [provider, setProvider] = useState("sqlite")
  const [url, setUrl] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [okMsg, setOkMsg] = useState("")

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/database", { cache: "no-store" })
      const body = await res.json()
      if (body.code === 0) {
        const d = body.data as WizardDbState
        setState(d)
        setExpanded(d.needsDbBinding)
        // env 已配置 → 预填 env 值（用户要求「根据 env 里填的类型自动选择」）
        if (d.env.configured) {
          setProvider(d.env.provider === "sqlite" ? "sqlite" : d.env.provider)
        }
        setError("")
      } else setError(body.msg || "状态查询失败")
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchState()
  }, [fetchState])

  const onSubmit = async () => {
    setSubmitting(true)
    setError("")
    try {
      const res = await fetch("/api/setup/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, url }),
      })
      const body = await res.json()
      if (body.code === 0) {
        setOkMsg(`${body.msg}（${body.data.provider}）${body.data.initializedSchema ? " · 已自动初始化结构与种子数据" : ""}`)
        setTimeout(onDone, 600)
      } else {
        setError(body.msg + (body.data?.log ? `\n${String(body.data.log).slice(-300)}` : ""))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />正在检查数据库环境…
        </CardContent>
      </Card>
    )
  }

  const mustBind = state?.needsDbBinding

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />第一步 · 数据库绑定
        </CardTitle>
        <CardDescription>
          {mustBind
            ? "当前数据库无法连接 —— 请绑定可用数据库后继续初始化"
            : state?.env.configured
              ? "env 已配置数据库且连接正常 —— 可直接进入下一步（或改绑其它库）"
              : "默认使用内置 SQLite（零依赖）—— 高级用户可绑定 PostgreSQL / MySQL"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 当前状态摘要 */}
        <div className="grid gap-2 text-xs">
          <div className="flex items-center justify-between rounded-lg border p-2.5">
            <span className="flex items-center gap-1.5 text-muted-foreground"><Server className="h-3.5 w-3.5" />当前生效库</span>
            <span className="flex items-center gap-2">
              <Badge variant={state?.active.connectable ? "default" : "destructive"} className="font-mono">{state?.active.provider ?? "-"}</Badge>
              {state?.active.connectable ? (
                <span className="text-emerald-600">{state.active.hasData ? `数据就绪 · ${state.active.userCount} 用户` : "空库（将自动初始化）"}</span>
              ) : (
                <span className="text-red-600">连接失败{state?.active.probeError ? `：${state.active.probeError.slice(0, 60)}` : ""}</span>
              )}
            </span>
          </div>
          {state?.env.configured && (
            <div className="flex items-center justify-between rounded-lg border p-2.5">
              <span className="text-muted-foreground">env 配置</span>
              <span className="font-mono">{state.env.provider} · {state.env.urlMasked}</span>
            </div>
          )}
        </div>

        {/* env 就绪 → 跳过按钮 */}
        {!mustBind && !expanded && (
          <div className="flex items-center justify-between">
            <Button onClick={onDone} variant="default" size="sm">
              数据库已就绪，进入下一步 <CheckCircle2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
              <ChevronDown className="h-4 w-4" />高级：绑定其它数据库
            </Button>
          </div>
        )}

        {/* 绑定表单 */}
        {(mustBind || expanded) && (
          <div className="space-y-3 rounded-lg border border-teal-200 dark:border-teal-800 p-3">
            <div className="grid gap-3 md:grid-cols-[150px_1fr]">
              <div className="space-y-1.5">
                <Label>数据库类型</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sqlite">SQLite（文件库）</SelectItem>
                    <SelectItem value="postgres">PostgreSQL</SelectItem>
                    <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{provider === "sqlite" ? "数据库文件路径" : "连接串"}</Label>
                <Input
                  placeholder={
                    provider === "sqlite" ? "/app/db/custom.db"
                      : provider === "mysql" ? "mysql://user:password@host:3306/dockyard"
                        : "postgresql://user:password@host:5432/dockyard"
                  }
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  {provider === "sqlite"
                    ? "绝对路径（目录不存在会自动创建；已有数据将直接沿用）"
                    : "空库将自动建结构 + 播种；已有 Dockyard 数据的库将直接沿用（不覆盖）"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={onSubmit} disabled={submitting || !url}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                {submitting ? "绑定并初始化中…" : "绑定数据库（自动初始化）"}
              </Button>
              {!mustBind && (
                <Button size="sm" variant="ghost" onClick={onDone} disabled={submitting}>
                  跳过（沿用当前库）
                </Button>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300">
            <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="whitespace-pre-wrap break-all">{error}</span>
          </div>
        )}
        {okMsg && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 p-3 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />{okMsg}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
