"use client"

// r23-b：自定义任务创建 / 编辑弹窗
// - 创建：createCustomTaskAction（名称/任务类型/cron/超时/描述/启停）
// - 编辑：自定义任务 → updateCustomTaskAction（全字段）；内置任务 → 只改 cron/超时/启停（taskType/name 禁用置灰）
// - cron 表达式实时预览：防抖 500ms 调 previewCronAction（describe + 未来3次运行时间；非法显示红色错误）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CalendarClock, Loader2 } from "lucide-react"
import { PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
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
  const [types, setTypes] = React.useState<{ code: string; description: string }[]>([])
  const [typesLoading, setTypesLoading] = React.useState(false)
  const [preview, setPreview] = React.useState<CronPreview | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  // 类型下拉选项：注册表清单 + 回显兜底（taskType 不在清单时补一项，防编辑回显丢失）
  const typeOptions = React.useMemo(() => {
    if (!typeEditable) return []
    if (taskType && !types.some((t) => t.code === taskType)) {
      return [...types, { code: taskType, description: "当前任务类型" }]
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
          // 编辑回显：taskType 不在清单（注册表变化）时保留原值展示
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

  // cron 预览：防抖 500ms 调 previewCronAction（非法表达式红色报错）；打开弹窗时对回显值也立即预览
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

    setSubmitting(true)
    try {
      if (!isEdit) {
        // ---- 创建 ----
        const res = await createCustomTaskAction({
          name: name.trim(),
          taskType,
          cronExpr: cronExpr.trim(),
          timeoutSec,
          description: description.trim() || undefined,
          enabled,
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
        // ---- 编辑 ----
        if (task.isCustom) {
          const res = await updateCustomTaskAction({
            code: task.code,
            name: name.trim(),
            taskType,
            cronExpr: cronExpr.trim(),
            timeoutSec,
            description: description.trim() || null,
            enabled,
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
          // 内置任务：只能改 cron / 超时（启停变化单独走 toggleTaskAction）
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
      <DialogContent className="max-w-lg">
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
              "基于内置任务引擎注册的任务类型，按自定义 cron 周期调度执行"
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
              placeholder="如：QA 每十分钟过期文件清理"
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
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {typeEditable && (
              <p className="text-xs text-muted-foreground">
                执行体 = 内置任务引擎注册的任务类型（任务注册表键）；调度周期由下方 cron 表达式决定
              </p>
            )}
          </div>

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
                          <li key={d} className="tabular-nums">
                            · {fmtLocal(d)}
                          </li>
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
              <PrecisionInput value={timeoutSec} onChange={setTimeoutSec} min={5} max={86400} step={1} suffix="秒" />
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
