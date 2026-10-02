"use client"

// r24-a：自定义任务「执行内容完全放开」可视化构建器
// - 参数化执行体（paramKind）：
//     shell   —— 脚本编辑器 + 环境变量 KV 编辑 + cwd 白名单提示
//     chain   —— 可视化步骤编排（添加/上移/下移/删除，每步类型+标签+失败策略），流程预览
//     webhook —— 方法/URL/请求头 KV/请求体/期望状态码 表单
// - 非参数化类型保持原行为（仅选类型）
// - cron 实时预览（previewCronAction）；编辑回显 paramsJson
// - 安全提示（Shell 危险命令黑名单 / SSRF 内网限制）随表单展示

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowDown, ArrowUp, CalendarClock, ChevronRight, Globe, Loader2, Plus, Terminal, Trash2, Workflow } from "lucide-react"
import { PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  createCustomTaskAction,
  listCustomTaskTypesAction,
  previewCronAction,
  toggleTaskAction,
  updateCustomTaskAction,
  updateTaskAction,
} from "@/server/actions/tasks"
import type { TaskRow } from "./tasks-table"

interface CronPreview {
  ok: boolean
  error: string | null
  describe: string
  nextRuns: string[]
}

interface CustomTaskDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: "create" | "edit"
  task?: TaskRow | null
  onDone?: () => void
}

const pad = (n: number) => String(n).padStart(2, "0")

// ISO 字符串 → 本地时区可读时间（客户端工具，不引服务端 fmtDate）
function fmtLocal(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ============================================================
// 参数模型（与 custom-exec.ts zod schema 对齐的客户端形态）
// ============================================================

interface ShellParams {
  script: string
  cwd: string
  env: [string, string][]
  shell: "sh" | "bash"
}

interface ChainStep {
  key: string // 行内稳定 key
  taskType: string
  label: string
  continueOnError: boolean
}

interface ChainParams {
  steps: ChainStep[]
  failFast: boolean
}

interface WebhookParams {
  url: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
  headers: [string, string][]
  body: string
  expectedStatus: number | null
  timeoutSec: number
}

type ParamKind = "shell" | "chain" | "webhook" | null

interface TaskTypeOption {
  code: string
  description: string
  paramKind: ParamKind
}

const uid = () => Math.random().toString(36).slice(2, 10)

function parseStoredParams(kind: ParamKind, paramsJson: string | null): ShellParams | ChainParams | WebhookParams | null {
  if (!kind || !paramsJson) return null
  try {
    const raw = JSON.parse(paramsJson) as Record<string, unknown>
    if (kind === "shell") {
      const env = (raw.env && typeof raw.env === "object" ? Object.entries(raw.env as Record<string, string>) : []) as [string, string][]
      return { script: String(raw.script || ""), cwd: String(raw.cwd || ""), env, shell: raw.shell === "bash" ? "bash" : "sh" } satisfies ShellParams
    }
    if (kind === "chain") {
      const steps = Array.isArray(raw.steps)
        ? (raw.steps as Record<string, unknown>[]).map((s) => ({
            key: uid(),
            taskType: String(s.taskType || ""),
            label: String(s.label || ""),
            continueOnError: !!s.continueOnError,
          }))
        : []
      return { steps, failFast: raw.failFast !== false } satisfies ChainParams
    }
    const headers = (raw.headers && typeof raw.headers === "object" ? Object.entries(raw.headers as Record<string, string>) : []) as [string, string][]
    return {
      url: String(raw.url || ""),
      method: (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(String(raw.method)) ? raw.method : "GET") as WebhookParams["method"],
      headers,
      body: String(raw.body || ""),
      expectedStatus: typeof raw.expectedStatus === "number" ? raw.expectedStatus : null,
      timeoutSec: typeof raw.timeoutSec === "number" ? raw.timeoutSec : 30,
    } satisfies WebhookParams
  } catch {
    return null
  }
}

// KV 编辑器（环境变量 / 请求头共用）
function KvEditor({ rows, onChange, keyPlaceholder, valPlaceholder, keyLabel }: {
  rows: [string, string][]
  onChange: (rows: [string, string][]) => void
  keyPlaceholder: string
  valPlaceholder: string
  keyLabel: string
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={r[0]}
            onChange={(e) => { const next = [...rows]; next[i] = [e.target.value, r[1]]; onChange(next) }}
            placeholder={keyPlaceholder}
            className="font-mono text-xs flex-1"
            aria-label={`${keyLabel}名 ${i + 1}`}
            maxLength={64}
          />
          <Input
            value={r[1]}
            onChange={(e) => { const next = [...rows]; next[i] = [r[0], e.target.value]; onChange(next) }}
            placeholder={valPlaceholder}
            className="font-mono text-xs flex-1"
            aria-label={`${keyLabel}值 ${i + 1}`}
            maxLength={2048}
          />
          <Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="删除该行">
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...rows, ["", ""]])}>
        <Plus className="h-3.5 w-3.5 mr-1" /> 添加一行
      </Button>
    </div>
  )
}

export function CustomTaskDialog({ open, onOpenChange, mode, task, onDone }: CustomTaskDialogProps) {
  const router = useRouter()
  const isEdit = mode === "edit"
  const isBuiltin = isEdit && !!task && !task.isCustom // 内置任务：taskType/name 禁用
  const typeEditable = !isBuiltin

  const [name, setName] = React.useState("")
  const [taskType, setTaskType] = React.useState("")
  const [cronExpr, setCronExpr] = React.useState("*/10 * * * *")
  const [timeoutSec, setTimeoutSec] = React.useState(300)
  const [description, setDescription] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [types, setTypes] = React.useState<TaskTypeOption[]>([])
  const [typesLoading, setTypesLoading] = React.useState(false)
  const [preview, setPreview] = React.useState<CronPreview | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  // ---- 参数化执行体表单状态 ----
  const [shellParams, setShellParams] = React.useState<ShellParams>({ script: "", cwd: "", env: [], shell: "sh" })
  const [chainParams, setChainParams] = React.useState<ChainParams>({ steps: [], failFast: true })
  const [webhookParams, setWebhookParams] = React.useState<WebhookParams>({ url: "", method: "GET", headers: [], body: "", expectedStatus: null, timeoutSec: 30 })

  const paramKind: ParamKind = React.useMemo(() => {
    const found = types.find((t) => t.code === taskType)
    return found?.paramKind ?? null
  }, [types, taskType])

  // 类型下拉选项：注册表清单 + 回显兜底
  const typeOptions = React.useMemo(() => {
    if (!typeEditable) return [] as TaskTypeOption[]
    if (taskType && !types.some((t) => t.code === taskType)) {
      return [...types, { code: taskType, description: "当前任务类型", paramKind: null }]
    }
    return types
  }, [types, taskType, typeEditable])

  // 打开时回显 / 重置表单 + 加载任务类型清单
  React.useEffect(() => {
    if (!open) return
    if (isEdit && task) {
      setName(task.name)
      setTaskType(task.taskType || "")
      setCronExpr(task.cronExpr)
      setTimeoutSec(task.timeoutSec)
      setDescription(task.description || "")
      setEnabled(task.enabled)
    } else {
      setName("")
      setTaskType("")
      setCronExpr("*/10 * * * *")
      setTimeoutSec(300)
      setDescription("")
      setEnabled(true)
    }
    setPreview(null)
  }, [open, isEdit, task])

  // 回显参数化执行体内容（types 加载后才能识别 paramKind）
  React.useEffect(() => {
    if (!open || !isEdit || !task) return
    if (!types.length) return
    const kind = types.find((t) => t.code === (task.taskType || ""))?.paramKind ?? null
    if (!kind) return
    const parsed = parseStoredParams(kind, task.paramsJson)
    if (kind === "shell" && parsed) setShellParams(parsed as ShellParams)
    if (kind === "chain" && parsed) setChainParams(parsed as ChainParams)
    if (kind === "webhook" && parsed) setWebhookParams(parsed as WebhookParams)
  }, [open, isEdit, task, types])

  // 任务类型清单（创建 / 自定义任务编辑时需要；内置任务编辑不需要）
  React.useEffect(() => {
    if (!open || !typeEditable) return
    let alive = true
    setTypesLoading(true)
    listCustomTaskTypesAction()
      .then((res) => {
        if (!alive) return
        if (res.code === 0 && res.data) {
          setTypes(res.data.items)
        } else {
          toast.error(res.msg || "任务类型清单加载失败")
        }
      })
      .catch((e) => {
        if (alive) toast.error(e instanceof Error ? e.message : "任务类型清单加载失败")
      })
      .finally(() => {
        if (alive) setTypesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, typeEditable])

  // cron 预览：防抖 500ms
  React.useEffect(() => {
    if (!open) return
    const expr = (cronExpr || "").trim()
    if (!expr) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await previewCronAction({ cronExpr: expr })
        if (res.code === 0 && res.data) {
          setPreview({ ok: res.data.ok, error: res.data.error, describe: res.data.describe, nextRuns: res.data.nextRuns })
        } else {
          setPreview({ ok: false, error: res.msg || "表达式非法", describe: "", nextRuns: [] })
        }
      } catch (e) {
        setPreview({ ok: false, error: e instanceof Error ? e.message : "预览失败", describe: "", nextRuns: [] })
      } finally {
        setPreviewLoading(false)
      }
    }, 500)
    return () => {
      clearTimeout(timer)
      setPreviewLoading(false)
    }
  }, [cronExpr, open])

  // ---- 参数收集（提交时按 paramKind 打包） ----
  const buildParams = (): Record<string, unknown> | undefined => {
    if (!paramKind) return undefined
    if (paramKind === "shell") {
      const env: Record<string, string> = {}
      for (const [k, v] of shellParams.env) {
        if (k.trim()) env[k.trim()] = v
      }
      return { script: shellParams.script, cwd: shellParams.cwd || undefined, env, shell: shellParams.shell }
    }
    if (paramKind === "chain") {
      return {
        steps: chainParams.steps
          .filter((s) => s.taskType)
          .map((s) => ({ taskType: s.taskType, label: s.label || undefined, continueOnError: s.continueOnError })),
        failFast: chainParams.failFast,
      }
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of webhookParams.headers) {
      if (k.trim()) headers[k.trim()] = v
    }
    return {
      url: webhookParams.url.trim(),
      method: webhookParams.method,
      headers,
      body: webhookParams.body || undefined,
      expectedStatus: webhookParams.expectedStatus ?? undefined,
      timeoutSec: webhookParams.timeoutSec,
    }
  }

  // ---- 前端参数校验（服务端 zod 为权威，这里做即时反馈） ----
  const validateParams = (): string | null => {
    if (!paramKind) return null
    if (paramKind === "shell") {
      if (!shellParams.script.trim()) return "脚本内容不能为空"
      if (shellParams.script.length > 16384) return "脚本最长 16384 字符"
      if (/rm\s+[^#\n]*\s\/(\s|$)/.test(shellParams.script)) return "脚本疑似包含 rm 根路径操作（服务端黑名单将拒绝）"
      for (const [k] of shellParams.env) {
        if (k && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return `环境变量名非法：${k}`
      }
      return null
    }
    if (paramKind === "chain") {
      const valid = chainParams.steps.filter((s) => s.taskType)
      if (valid.length === 0) return "任务链至少需要 1 个有效步骤"
      if (valid.length > 10) return "任务链最多 10 个步骤"
      if (valid.some((s) => s.taskType === "custom_chain")) return "任务链内不允许再嵌套任务链"
      return null
    }
    if (!webhookParams.url.trim()) return "Webhook URL 不能为空"
    try {
      const u = new URL(webhookParams.url.trim())
      if (u.protocol !== "http:" && u.protocol !== "https:") return "Webhook 仅支持 http/https"
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(u.hostname)) return "目标为内网/保留地址（默认拦截；需超管配置放行）"
    } catch {
      return "Webhook URL 格式非法"
    }
    if (webhookParams.timeoutSec < 3 || webhookParams.timeoutSec > 120) return "Webhook 超时必须在 3-120 秒"
    return null
  }

  const submit = async () => {
    // ---- 前端初校验 ----
    if (typeEditable) {
      if (name.trim().length < 2 || name.trim().length > 64) {
        toast.error("任务名称长度必须在 2 - 64 个字符之间")
        return
      }
      if (!taskType) {
        toast.error("请选择任务类型")
        return
      }
    }
    if (!preview || !preview.ok || previewLoading) {
      toast.error(previewLoading ? "cron 表达式正在校验，请稍候" : "cron 表达式非法，请修正后再提交")
      return
    }
    if (timeoutSec < 5 || timeoutSec > 86400) {
      toast.error("超时时间必须在 5 - 86400 秒之间")
      return
    }
    if (description.length > 300) {
      toast.error("描述最长 300 个字符")
      return
    }
    const paramErr = validateParams()
    if (paramErr) {
      toast.error(paramErr)
      return
    }

    setSubmitting(true)
    try {
      const params = buildParams()
      if (!isEdit) {
        const res = await createCustomTaskAction({
          name: name.trim(),
          taskType,
          cronExpr: cronExpr.trim(),
          timeoutSec,
          description: description.trim() || undefined,
          enabled,
          ...(params ? { params } : {}),
        })
        if (res.code === 0 && res.data) {
          toast.success(
            `自定义任务已创建：下次运行 ${res.data.nextRunAt ? fmtLocal(res.data.nextRunAt) : "（暂无）"}（${res.data.describe}）`
          )
          onOpenChange(false)
          router.refresh()
          onDone?.()
        } else {
          toast.error(res.msg)
        }
      } else if (task) {
        if (task.isCustom) {
          const res = await updateCustomTaskAction({
            code: task.code,
            name: name.trim(),
            taskType,
            cronExpr: cronExpr.trim(),
            timeoutSec,
            description: description.trim() || null,
            enabled,
            ...(paramKind && params ? { params } : {}),
          })
          if (res.code === 0 && res.data) {
            toast.success(`任务已更新：下次运行 ${res.data.nextRunAt ? fmtLocal(res.data.nextRunAt) : "（暂无）"}`)
            onOpenChange(false)
            router.refresh()
            onDone?.()
          } else {
            toast.error(res.msg)
          }
        } else {
          // 内置任务：只能改 cron / 超时
          const res = await updateTaskAction({ code: task.code, cronExpr: cronExpr.trim(), timeoutSec })
          if (res.code !== 0) {
            toast.error(res.msg)
            return
          }
          if (enabled !== task.enabled) {
            const t = await toggleTaskAction({ code: task.code, enabled })
            if (t.code !== 0) {
              toast.error(`cron 已更新，但启停切换失败：${t.msg}`)
              router.refresh()
              onOpenChange(false)
              return
            }
          }
          toast.success("任务调度参数已更新")
          onOpenChange(false)
          router.refresh()
          onDone?.()
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className={paramKind ? "max-w-3xl max-h-[90vh] overflow-y-auto" : "max-w-lg"}>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? (isBuiltin ? "编辑内置任务调度参数" : "编辑自定义任务") : "创建自定义任务"}
          </DialogTitle>
          <DialogDescription>
            {isEdit && task ? (
              <>
                <span className="font-mono font-medium text-foreground">{task.code}</span>
                （{task.name}）
                {isBuiltin ? " · 内置任务仅可修改 cron / 超时 / 启停" : ""}
              </>
            ) : (
              "任务类型 + cron 周期 + 自定义执行内容（Shell 脚本 / 任务链 / Webhook）"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ct-name">任务名称（2-64 字符）</Label>
            <Input
              id="ct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：夜间数据归档脚本"
              disabled={!typeEditable}
              maxLength={64}
            />
            {typeEditable && <p className="text-xs text-muted-foreground">平台内唯一；用于列表展示与审计追溯</p>}
          </div>

          <div className="space-y-1.5">
            <Label>任务类型</Label>
            <Select value={taskType} onValueChange={setTaskType} disabled={!typeEditable}>
              <SelectTrigger aria-label="任务类型">
                <SelectValue placeholder={isBuiltin ? "内置任务 · 执行体=任务本身" : typesLoading ? "加载中…" : "选择任务类型"} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {typeOptions.map((t) => (
                  <SelectItem key={t.code} value={t.code}>
                    <span className="font-mono text-xs">{t.code}</span>
                    <span className="ml-1 text-xs text-muted-foreground">（{t.description}）</span>
                    {t.paramKind && (
                      <span className="ml-1">
                        <Badge variant="secondary" className="text-[10px] px-1 py-0">可自定义内容</Badge>
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* ============ 参数化执行体编辑器（r24-a）============ */}
          {typeEditable && paramKind === "shell" && (
            <div className="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/40 dark:bg-teal-950/20 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-teal-600" />
                <span className="text-sm font-medium">Shell 脚本执行内容</span>
                <Badge variant="outline" className="text-[10px]">危险命令黑名单拦截</Badge>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-script">脚本内容（sh 执行；最长 16384 字符）</Label>
                <Textarea
                  id="ct-script"
                  value={shellParams.script}
                  onChange={(e) => setShellParams({ ...shellParams, script: e.target.value })}
                  placeholder={"# 示例：导出近7天任务日志统计\ncd /app && echo \"磁盘占用：\" && du -sh storage | awk '{print $1}'"}
                  className="font-mono text-xs min-h-40"
                  maxLength={16384}
                />
                <p className="text-xs text-muted-foreground">
                  禁止：rm 根路径 / mkfs / dd 写裸设备 / 关机重启 / fork 炸弹 / curl|sh 等（保存与执行双重校验）；输出全文落执行日志
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>解释器</Label>
                  <Select value={shellParams.shell} onValueChange={(v) => setShellParams({ ...shellParams, shell: v as "sh" | "bash" })}>
                    <SelectTrigger aria-label="解释器"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sh">/bin/sh（POSIX，默认）</SelectItem>
                      <SelectItem value="bash">/bin/bash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ct-cwd">工作目录（可选，白名单内）</Label>
                  <Input
                    id="ct-cwd"
                    value={shellParams.cwd}
                    onChange={(e) => setShellParams({ ...shellParams, cwd: e.target.value })}
                    placeholder="留空 = 平台运行目录"
                    className="font-mono text-xs"
                    maxLength={256}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>自定义环境变量（注入脚本进程）</Label>
                <KvEditor
                  rows={shellParams.env}
                  onChange={(env) => setShellParams({ ...shellParams, env })}
                  keyPlaceholder="如 BATCH_SIZE"
                  valPlaceholder="值（最长 2048 字符）"
                  keyLabel="环境变量"
                />
              </div>
            </div>
          )}

          {typeEditable && paramKind === "chain" && (
            <div className="rounded-lg border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Workflow className="h-4 w-4 text-violet-600" />
                <span className="text-sm font-medium">任务链可视化编排</span>
                <Badge variant="outline" className="text-[10px]">最多 10 步 · 顺序执行</Badge>
              </div>

              {/* 流程预览 */}
              {chainParams.steps.filter((s) => s.taskType).length > 0 && (
                <div className="flex items-center flex-wrap gap-1 rounded-md border bg-background p-2">
                  {chainParams.steps.filter((s) => s.taskType).map((s, i) => (
                    <React.Fragment key={s.key}>
                      {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="rounded bg-violet-100 dark:bg-violet-950/60 px-1.5 py-0.5 text-[11px] font-mono">
                        {i + 1}. {s.label || s.taskType}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              )}

              <ScrollArea className="max-h-64 rounded-md border bg-background">
                <div className="divide-y">
                  {chainParams.steps.map((s, i) => {
                    const stepTypeMeta = types.find((t) => t.code === s.taskType)
                    return (
                      <div key={s.key} className="flex items-start gap-2 p-2">
                        <div className="flex flex-col gap-0.5 pt-1">
                          <Button
                            variant="ghost" size="sm" className="h-5 w-5 p-0"
                            disabled={i === 0}
                            onClick={() => {
                              const next = [...chainParams.steps]
                              ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                              setChainParams({ ...chainParams, steps: next })
                            }}
                            aria-label="上移该步骤"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost" size="sm" className="h-5 w-5 p-0"
                            disabled={i === chainParams.steps.length - 1}
                            onClick={() => {
                              const next = [...chainParams.steps]
                              ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
                              setChainParams({ ...chainParams, steps: next })
                            }}
                            aria-label="下移该步骤"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                        </div>
                        <span className="mt-1.5 w-5 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <Select value={s.taskType} onValueChange={(v) => {
                              const next = [...chainParams.steps]
                              next[i] = { ...s, taskType: v }
                              setChainParams({ ...chainParams, steps: next })
                            }}>
                              <SelectTrigger className="h-8 text-xs font-mono" aria-label={`步骤 ${i + 1} 类型`}>
                                <SelectValue placeholder="选择步骤任务类型" />
                              </SelectTrigger>
                              <SelectContent className="max-h-72">
                                {types.filter((t) => t.code !== "custom_chain").map((t) => (
                                  <SelectItem key={t.code} value={t.code} className="text-xs">
                                    <span className="font-mono">{t.code}</span>
                                    <span className="ml-1 text-muted-foreground">（{(t.description || "").split("·")[0]}）</span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {stepTypeMeta?.paramKind && <Badge variant="secondary" className="text-[10px] shrink-0">可带参数</Badge>}
                          </div>
                          <div className="flex items-center gap-3">
                            <Input
                              value={s.label}
                              onChange={(e) => {
                                const next = [...chainParams.steps]
                                next[i] = { ...s, label: e.target.value }
                                setChainParams({ ...chainParams, steps: next })
                              }}
                              placeholder="步骤备注（可选，如：先清理日志）"
                              className="h-7 text-xs flex-1"
                              maxLength={64}
                            />
                            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer shrink-0">
                              <Switch
                                checked={s.continueOnError}
                                onCheckedChange={(v) => {
                                  const next = [...chainParams.steps]
                                  next[i] = { ...s, continueOnError: v }
                                  setChainParams({ ...chainParams, steps: next })
                                }}
                                aria-label={`步骤 ${i + 1} 失败继续`}
                              />
                              失败继续
                            </label>
                          </div>
                        </div>
                        <Button
                          variant="ghost" size="sm" className="mt-1 h-6 w-6 p-0"
                          onClick={() => setChainParams({ ...chainParams, steps: chainParams.steps.filter((_, j) => j !== i) })}
                          aria-label="删除该步骤"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
              <div className="flex items-center justify-between">
                <Button
                  variant="outline" size="sm"
                  disabled={chainParams.steps.length >= 10}
                  onClick={() => setChainParams({ ...chainParams, steps: [...chainParams.steps, { key: uid(), taskType: "", label: "", continueOnError: false }] })}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> 添加步骤（{chainParams.steps.length}/10）
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <Switch checked={chainParams.failFast} onCheckedChange={(v) => setChainParams({ ...chainParams, failFast: v })} aria-label="任一步骤失败即中止" />
                  任一步骤失败即中止（关闭后按「失败继续」逐步执行）
                </label>
              </div>
            </div>
          )}

          {typeEditable && paramKind === "webhook" && (
            <div className="rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50/40 dark:bg-sky-950/20 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-sky-600" />
                <span className="text-sm font-medium">Webhook 调用内容</span>
                <Badge variant="outline" className="text-[10px]">SSRF 内网防护</Badge>
              </div>
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <div className="space-y-1.5">
                  <Label>方法</Label>
                  <Select value={webhookParams.method} onValueChange={(v) => setWebhookParams({ ...webhookParams, method: v as WebhookParams["method"] })}>
                    <SelectTrigger aria-label="HTTP 方法"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ct-url">目标 URL</Label>
                  <Input
                    id="ct-url"
                    value={webhookParams.url}
                    onChange={(e) => setWebhookParams({ ...webhookParams, url: e.target.value })}
                    placeholder="https://example.com/api/hook"
                    className="font-mono text-xs"
                    maxLength={2048}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>请求头（可选）</Label>
                <KvEditor
                  rows={webhookParams.headers}
                  onChange={(headers) => setWebhookParams({ ...webhookParams, headers })}
                  keyPlaceholder="如 Authorization"
                  valPlaceholder="如 Bearer xxx"
                  keyLabel="请求头"
                />
              </div>
              {webhookParams.method !== "GET" && webhookParams.method !== "HEAD" && (
                <div className="space-y-1.5">
                  <Label htmlFor="ct-body">请求体（可选，默认 Content-Type: application/json）</Label>
                  <Textarea
                    id="ct-body"
                    value={webhookParams.body}
                    onChange={(e) => setWebhookParams({ ...webhookParams, body: e.target.value })}
                    placeholder='{"event": "nightly_report"}'
                    className="font-mono text-xs min-h-20"
                    maxLength={32768}
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>期望状态码（空=2xx 均算成功）</Label>
                  <PrecisionInput
                    value={webhookParams.expectedStatus ?? 0}
                    onChange={(v) => setWebhookParams({ ...webhookParams, expectedStatus: v > 0 ? Math.round(v) : null })}
                    min={0}
                    max={599}
                    step={1}
                    suffix="（0=不限）"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>请求超时（秒）</Label>
                  <PrecisionInput
                    value={webhookParams.timeoutSec}
                    onChange={(v) => setWebhookParams({ ...webhookParams, timeoutSec: Math.round(v) })}
                    min={3}
                    max={120}
                    step={1}
                    suffix="秒"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                默认拦截内网/回环/私网目标（防 SSRF）；如需调用内网服务请由超级管理员在配置中心开启 tasks.webhookAllowPrivate
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ct-cron">cron 表达式（5字段：分 时 日 月 周）</Label>
            <Input
              id="ct-cron"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/10 * * * *"
              className="font-mono"
              maxLength={64}
            />
            <div className="min-h-12">
              {previewLoading && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> 正在校验表达式…
                </p>
              )}
              {!previewLoading && preview && !preview.ok && (
                <p className="rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 px-2 py-1.5 text-xs text-red-600 dark:text-red-400">
                  表达式非法：{preview.error || "格式错误"}
                </p>
              )}
              {!previewLoading && preview && preview.ok && (
                <div className="rounded-md border bg-muted/50 p-2.5 space-y-1">
                  <p className="flex items-center gap-1.5 text-xs">
                    <CalendarClock className="h-3.5 w-3.5 text-teal-600" />
                    <span className="font-medium text-foreground">{preview.describe}</span>
                  </p>
                  {preview.nextRuns.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      未来 {preview.nextRuns.length} 次运行：
                      <ul className="mt-0.5 space-y-0.5">
                        {preview.nextRuns.map((d) => (
                          <li key={d} className="tabular-nums">· {fmtLocal(d)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {!previewLoading && !preview && (
                <p className="text-xs text-muted-foreground">示例：*/5 * * * *（每5分钟）· 0 3 * * *（每天3点）· 0 */2 * * *（每2小时）</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>超时时间（超时自动终止并记 TIMEOUT）</Label>
              <PrecisionInput value={timeoutSec} onChange={(v) => setTimeoutSec(Math.round(v))} min={5} max={86400} step={1} suffix="秒" />
            </div>
            <div className="space-y-1.5">
              <Label>创建后立即启用</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用任务" />
                <span className="text-xs text-muted-foreground">{enabled ? "启用（按 cron 到期触发）" : "停用（仅保存不调度）"}</span>
              </div>
            </div>
          </div>

          {typeEditable && (
            <div className="space-y-1.5">
              <Label htmlFor="ct-desc">描述（可选，最长 300 字符）</Label>
              <Textarea
                id="ct-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="任务用途 / 责任人 / 注意事项"
                rows={2}
                maxLength={300}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || previewLoading}>
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {isEdit ? "保存修改" : "创建任务"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
