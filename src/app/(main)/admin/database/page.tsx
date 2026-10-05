"use client"

// ============================================================
// r38：数据库管理页（二次初始化 / 迁移 / 回滚 —— 管理员登录态）
//
// 页面结构：
//   ① 状态总览卡（运行库 / env 通道 / 探测健康度）
//   ② mismatch 横幅（env 类型变更检测 → 「即将进入二次初始化模式」）
//   ③ 迁移面板（目标配置表单 + 测试连接 + 启动迁移 + 实时进度 + 完成/失败态）
//   ④ 回滚卡（迁移血缘 + 回滚窗口 + 一键回滚）
//   ⑤ 三 Provider 支持说明（SQLite / PostgreSQL / MySQL 全兼容矩阵）
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Database, Server, ShieldAlert, CheckCircle2, XCircle, Loader2, RotateCcw, ArrowRightLeft, Plug, Info } from "lucide-react"

interface DbStatus {
  active: { provider: string; urlMasked: string; source: string; connectable: boolean; version: string; latencyMs: number; userCount: number; probeError: string | null }
  env: { provider: string; urlMasked: string; configured: boolean }
  mismatch: { detected: boolean; envProvider: string; activeProvider: string; envUrlMasked: string; activeUrlMasked: string; note: string }
  migration: {
    phase: string; running: boolean; error: string | null
    progress: { table: string; tablesDone: number; tablesTotal: number; rowsCopied: number; rowsTotal: number; backupFiles: number }
    startedAt: string; updatedAt: string; switchedAt: string | null
    target: { provider: string; urlMasked: string } | null
    logTail: string[]; backupDir: string
  } | null
  rollback: { available: boolean; prevProvider: string | null; prevUrlMasked: string; rollbackUntil: string | null; migratedAt: string | null; warning: string }
  switchedNow: boolean
}

export default function AdminDatabasePage() {
  const router = useRouter()
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [toast, setToast] = useState("")

  // 表单（目标库）
  const [formProvider, setFormProvider] = useState<string>("mysql")
  const [formUrl, setFormUrl] = useState("")
  const [retentionDays, setRetentionDays] = useState(7)

  // 动作态
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; version: string; latencyMs: number; hasSchema: boolean; hasData: boolean; userCount: number; error?: string } | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchStatus = useCallback(async (quiet = false) => {
    try {
      const res = await fetch("/api/admin/database", { cache: "no-store" })
      const body = await res.json()
      if (body.code === 0) {
        setStatus(body.data as DbStatus)
        setError("")
        // 迁移完成热切换后提示刷新
        if ((body.data as DbStatus).switchedNow) {
          setToast("数据库已热切换到新库 ✓（页面数据即将刷新）")
          setTimeout(() => router.refresh(), 1200)
        }
      } else {
        setError(body.msg || "状态查询失败")
      }
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setLoading(false)
    }
  }, [router])

  // 初始加载 + 迁移期间轮询（2s）
  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])
  useEffect(() => {
    if (status?.migration?.running) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void fetchStatus(true), 2000)
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [status?.migration?.running, fetchStatus])

  // mismatch 时预选 env 目标类型
  useEffect(() => {
    if (status?.mismatch?.detected && status.env.configured && status.env.provider !== "sqlite") {
      setFormProvider(status.env.provider)
    }
  }, [status?.mismatch?.detected, status?.env?.configured, status?.env?.provider])

  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/admin/database", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return res.json()
  }

  const onTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const body = await post({ action: "test", provider: formProvider, url: formUrl })
      if (body.code === 0) setTestResult(body.data.probe)
      else setTestResult({ ok: false, version: "", latencyMs: 0, hasSchema: false, hasData: false, userCount: 0, error: body.msg })
    } catch (e) {
      setTestResult({ ok: false, version: "", latencyMs: 0, hasSchema: false, hasData: false, userCount: 0, error: e instanceof Error ? e.message : "网络错误" })
    } finally {
      setTesting(false)
    }
  }

  const onMigrate = async () => {
    if (!confirm(`即将进入二次初始化模式：将当前 ${status?.active.provider} 数据库全量迁移到 ${formUrl.slice(0, 40)}…\n\n流程：备份源库 → 目标建结构 → 逐表复制 → 计数校验 → 热切换。\n源库全程只读零修改（迁移失败零损失，随时可回滚）。\n迁移期间写操作临时暂停（通常数十秒内完成）。\n\n确认开始？`)) return
    setMigrating(true)
    setError("")
    try {
      const body = await post({ action: "migrate", provider: formProvider, url: formUrl, retentionDays })
      if (body.code === 0) {
        setToast(body.msg)
        void fetchStatus(true) // 立即进入轮询
      } else {
        setError(body.msg)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setMigrating(false)
    }
  }

  const onRollback = async () => {
    if (!confirm(`确认回滚到迁移前数据库（${status?.rollback.prevProvider}）？\n\n${status?.rollback.warning}\n\n回滚后请刷新页面。`)) return
    setRollingBack(true)
    try {
      const body = await post({ action: "rollback" })
      if (body.code === 0) {
        setToast(body.msg)
        setTimeout(() => router.refresh(), 800)
        void fetchStatus(true)
      } else setError(body.msg)
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误")
    } finally {
      setRollingBack(false)
    }
  }

  const mig = status?.migration
  const migRunning = !!mig?.running
  const migDone = mig?.phase === "done"
  const migError = mig?.phase === "error"
  const progressPct = mig && mig.progress.tablesTotal > 0 ? Math.round((mig.progress.tablesDone / mig.progress.tablesTotal) * 100) : mig?.phase === "backup" ? 5 : 0

  const phaseLabel = (p: string) =>
    p === "queued" ? "排队" : p === "backup" ? "备份源库" : p === "schema" ? "建目标结构" : p === "clear" ? "清空目标" :
    p === "copy" ? "复制数据" : p === "verify" ? "计数校验" : p === "finalize" ? "落配置" : p === "done" ? "完成 ✓" : "失败 ✗"

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Database className="h-6 w-6 text-teal-600" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">数据库管理</h1>
          <p className="text-sm text-muted-foreground">三库引擎（SQLite / PostgreSQL / MySQL）· 二次初始化 · 迁移与回滚</p>
        </div>
      </div>

      {toast && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 p-3 text-sm text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{toast}</span>
          <button onClick={() => setToast("")} className="text-xs underline">关闭</button>
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ① 状态总览 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Server className="h-4 w-4" />运行状态</CardTitle>
          <CardDescription>当前运行库与 env 配置通道对照（运行库优先级：图形界面配置 &gt; env &gt; 默认 SQLite）</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">当前运行库</span>
              <Badge variant={status?.active.connectable ? "default" : "destructive"} className="font-mono">
                {status?.active.provider ?? "-"}
              </Badge>
            </div>
            <p className="font-mono text-xs break-all">{status?.active.urlMasked}</p>
            <p className="text-xs text-muted-foreground">
              {status?.active.connectable ? `连接正常 · ${status.active.version || "—"} · ${status.active.latencyMs}ms · 用户 ${status.active.userCount}` : `连接异常：${status?.active.probeError ?? "探测失败"}`}
            </p>
            <p className="text-xs text-muted-foreground">配置来源：{status?.active.source === "db-active" ? "图形界面配置" : status?.active.source === "env" ? "环境变量" : "默认"}</p>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">env 配置通道</span>
              <Badge variant={status?.env.configured ? "secondary" : "outline"} className="font-mono">{status?.env.provider ?? "-"}</Badge>
            </div>
            <p className="font-mono text-xs break-all">{status?.env.urlMasked || "（未配置，使用默认 SQLite）"}</p>
            <p className="text-xs text-muted-foreground">env 改动只在新库初始化或经二次初始化迁移后生效（运行库绝不自动切到空库）</p>
          </div>
        </CardContent>
      </Card>

      {/* ② mismatch 横幅：二次初始化入口 */}
      {status?.mismatch.detected && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-4 space-y-2">
          <div className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
            <ShieldAlert className="h-5 w-5" />
            检测到数据库配置变更 —— 即将进入二次初始化模式
          </div>
          <p className="text-sm text-amber-700 dark:text-amber-300">{status.mismatch.note}</p>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            env 指向：{status.mismatch.envProvider} {status.mismatch.envUrlMasked && `（${status.mismatch.envUrlMasked}）`} · 运行库：{status.mismatch.activeProvider}（{status.mismatch.activeUrlMasked}）
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400">在下方「数据库迁移」面板填入目标连接串并启动迁移；数据将自动搬运并校验，完成后热切换。</p>
        </div>
      )}

      {/* ③ 迁移面板 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><ArrowRightLeft className="h-4 w-4" />数据库迁移（二次初始化）</CardTitle>
          <CardDescription>备份源库 → 目标建结构 → 逐表复制 → 计数校验 → 热切换；源库全程只读零修改，可随时回滚</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[160px_1fr]">
            <div className="space-y-1.5">
              <Label>目标类型</Label>
              <Select value={formProvider} onValueChange={setFormProvider} disabled={migRunning}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
                  <SelectItem value="postgres">PostgreSQL</SelectItem>
                  <SelectItem value="sqlite">SQLite（文件库）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>目标连接串</Label>
              <Input
                placeholder={formProvider === "sqlite" ? "file:/app/db/custom.db" : formProvider === "mysql" ? "mysql://user:pass@host:3306/dockyard" : "postgresql://user:pass@host:5432/dockyard"}
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                disabled={migRunning}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onTest} disabled={testing || migRunning || !formUrl}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}测试连接
            </Button>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>回滚窗口</span>
              <Input type="number" min={1} max={90} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value) || 7)} className="w-16 h-7" disabled={migRunning} />
              <span>天</span>
            </div>
            <Button size="sm" onClick={onMigrate} disabled={migRunning || !formUrl || !testResult?.ok} className="ml-auto">
              {migRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
              {migRunning ? "迁移进行中…" : "开始迁移（全量搬运 + 校验）"}
            </Button>
          </div>

          {testResult && (
            <div className={`rounded-md border p-3 text-xs ${testResult.ok ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 text-red-700 dark:text-red-300"}`}>
              {testResult.ok ? (
                <span>
                  连接成功 ✓ {testResult.version} · {testResult.latencyMs}ms · 目标库{testResult.hasSchema ? `已有结构（用户 ${testResult.userCount}）` : "为空（迁移时自动建结构）"}
                </span>
              ) : (
                <span>连接失败：{testResult.error}</span>
              )}
            </div>
          )}

          {/* 迁移进度 / 结果 */}
          {mig && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={migDone ? "default" : migError ? "destructive" : migRunning ? "secondary" : "outline"}>
                  {phaseLabel(mig.phase)}
                </Badge>
                {mig.target && <span className="text-xs text-muted-foreground">目标：{mig.target.provider}（{mig.target.urlMasked}）</span>}
                {mig.switchedAt && <span className="text-xs text-emerald-600">已热切换 {new Date(mig.switchedAt).toLocaleString()}</span>}
              </div>
              {(migRunning || migDone) && (
                <>
                  <Progress value={progressPct} className="h-2" />
                  <p className="text-xs text-muted-foreground">
                    表 {mig.progress.tablesDone}/{mig.progress.tablesTotal} · 行 {mig.progress.rowsCopied}/{mig.progress.rowsTotal}
                    {mig.progress.table && ` · 当前：${mig.progress.table}`}
                  </p>
                </>
              )}
              {migError && (
                <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300">
                  <p className="font-medium">迁移失败（源库零损失、运行库未切换 —— 修复后可重试）</p>
                  <p className="mt-1 break-all">{mig.error}</p>
                </div>
              )}
              {mig.logTail.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">迁移日志（尾 8 条）</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{mig.logTail.join("\n")}</pre>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ④ 回滚 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><RotateCcw className="h-4 w-4" />迁移回滚</CardTitle>
          <CardDescription>{status?.rollback.warning}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
            <div>迁移前库：<span className="font-mono">{status?.rollback.prevProvider ?? "—"}</span></div>
            <div>迁移前地址：<span className="font-mono break-all">{status?.rollback.prevUrlMasked || "—"}</span></div>
            <div>窗口截止：{status?.rollback.rollbackUntil ? new Date(status.rollback.rollbackUntil).toLocaleString() : "—"}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onRollback} disabled={!status?.rollback.available || rollingBack || migRunning}>
            {rollingBack ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            一键回滚到迁移前数据库
          </Button>
          {!status?.rollback.available && <p className="text-xs text-muted-foreground">（无迁移血缘或窗口已过期 —— 无可回滚目标）</p>}
        </CardContent>
      </Card>

      {/* ⑤ 兼容矩阵说明 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Info className="h-4 w-4" />三引擎支持说明</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-xs text-muted-foreground md:grid-cols-3">
          <div className="space-y-1 rounded-lg border p-3">
            <p className="font-medium text-foreground">SQLite（默认）</p>
            <p>零依赖文件库 · WAL 并发 · 适合单机与中小规模部署</p>
          </div>
          <div className="space-y-1 rounded-lg border p-3">
            <p className="font-medium text-foreground">PostgreSQL</p>
            <p>env 或 GUI 配置 · 自动建结构播种 · 审计不可篡改触发器 · 企业首选</p>
          </div>
          <div className="space-y-1 rounded-lg border p-3">
            <p className="font-medium text-foreground">MySQL / MariaDB</p>
            <p>r38 新增 · 全类型映射（Text/MediumText 长内容无损）· 与 PG 同级自动初始化/迁移支持</p>
          </div>
        </CardContent>
      </Card>

      {loading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />加载状态中…
        </div>
      )}
    </div>
  )
}
