"use client"

// r23-b：定时任务列表（DataTable 统一底座）
// - 分页 / 搜索（名称/编码/描述）/ 筛选（启停/内置自定义/最近结果）/ 排序
// - 行操作：启停 Switch / 立即执行 / 编辑（自定义任务 CRUD 弹窗）/ 删除（仅自定义）/ 查看日志
// - 批量操作：批量启用/停用 / 批量立即执行（失败明细弹窗）/ 批量删除（仅自定义任务生效）
// - ?focus=<code>：滚动定位并 ring 高亮该任务行

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { describeCron } from "@/lib/cron-next"
import { ConfirmDialog } from "@/components/shared/confirm"
import { DataTable } from "@/components/shared/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  batchExecuteTasksAction,
  batchToggleTasksAction,
  deleteCustomTaskAction,
  executeTaskNowAction,
  toggleTaskAction,
} from "@/server/actions/tasks"
import { CustomTaskDialog } from "./custom-task-dialog"

export interface TaskRow {
  id: string // = code
  code: string
  name: string
  isCustom: boolean
  taskType: string | null
  paramsJson: string | null // r24-a：参数化执行体内容（shell/chain/webhook）
  description: string | null
  createdByUsername: string | null
  cronExpr: string
  enabled: boolean
  timeoutSec: number
  dependsOn: string | null
  consecutiveFails: number
  lastExecuteAt: string | null
  lastResult: string | null
  avgDurationMs: number
  nextRunAt: string | null
}

interface TasksTableProps {
  rows: TaskRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  focus?: string
}

export function TasksTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, focus }: TasksTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // ---- 行级状态 ----
  const [busy, setBusy] = React.useState("") // `${code}:${action}`
  const [executeCode, setExecuteCode] = React.useState<string | null>(null)
  const [editTask, setEditTask] = React.useState<TaskRow | null>(null)
  const [deleteTask, setDeleteTask] = React.useState<TaskRow | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)

  // ---- 批量状态 ----
  const [sel, setSel] = React.useState<string[]>([])
  const [batchBusy, setBatchBusy] = React.useState("")
  const [batchExecConfirm, setBatchExecConfirm] = React.useState(false)
  const [batchDeleteConfirm, setBatchDeleteConfirm] = React.useState(false)
  const [batchFailures, setBatchFailures] = React.useState<{ ok: number; fail: number; results: { code: string; ok: boolean; message: string }[] } | null>(null)

  // focus 定位只滚动一次
  const scrolledFor = React.useRef<string | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    // 交互后撤销 focus 高亮（行可能已不在当前页/筛选结果内）
    params.delete("focus")
    router.push(`${pathname}?${params.toString()}`)
  }

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(name)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
        return true
      }
      toast.error(res.msg)
      return false
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
      return false
    } finally {
      setBusy("")
    }
  }

  // ---- 单个立即执行 ----
  const runExecute = async (code: string) => {
    setBusy(`${code}:execute`)
    try {
      const res = await executeTaskNowAction({ code })
      if (res.data) {
        if (res.data.ok) toast.success(`已触发执行 ${code}：${res.data.cronMsg}`)
        else toast.error(`执行 ${code} 失败：${res.data.cronMsg}`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "触发失败")
    } finally {
      setBusy("")
      setExecuteCode(null)
    }
  }

  // ---- 批量启停 ----
  const runBatchToggle = async (enabled: boolean) => {
    setBatchBusy(enabled ? "enable" : "disable")
    try {
      const res = await batchToggleTasksAction({ codes: sel, enabled })
      if (res.code === 0 && res.data) {
        const applied = enabled ? res.data.enabled : res.data.disabled
        toast.success(
          `已批量${enabled ? "启用" : "停用"} ${applied} 个任务${res.data.skipped > 0 ? `（跳过 ${res.data.skipped} 个：不存在或状态一致）` : ""}`
        )
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBatchBusy("")
    }
  }

  // ---- 批量执行 ----
  const runBatchExecute = async () => {
    setBatchBusy("execute")
    try {
      const res = await batchExecuteTasksAction({ codes: sel })
      if (res.code === 0 && res.data) {
        if (res.data.fail > 0) setBatchFailures(res.data)
        else toast.success(`批量执行完成：${res.data.ok} 个任务全部触发成功，结果请稍后在执行日志查看`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量执行失败")
    } finally {
      setBatchBusy("")
    }
  }

  // ---- 批量删除（仅自定义任务；内置跳过） ----
  const customSel = React.useMemo(() => sel.filter((id) => rows.find((r) => r.code === id && r.isCustom) || id.startsWith("custom:")), [sel, rows])
  const builtinSelCount = sel.length - customSel.length

  const runBatchDelete = async () => {
    setBatchBusy("delete")
    let ok = 0
    let fail = 0
    const errors: string[] = []
    try {
      for (const code of customSel) {
        try {
          const res = await deleteCustomTaskAction({ code })
          if (res.code === 0) ok++
          else {
            fail++
            errors.push(`${code}：${res.msg}`)
          }
        } catch (e) {
          fail++
          errors.push(`${code}：${e instanceof Error ? e.message : "删除失败"}`)
        }
      }
      toast.success(`批量删除完成：成功 ${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ""}${builtinSelCount > 0 ? `（内置任务 ${builtinSelCount} 个不可删除已跳过）` : ""}`)
      if (fail > 0) {
        toast.error(`删除失败明细：${errors.slice(0, 3).join("；")}${errors.length > 3 ? "…" : ""}`)
      }
      setSel((prev) => prev.filter((id) => !customSel.includes(id)))
      router.refresh()
    } finally {
      setBatchBusy("")
    }
  }

  const columns = [
    {
      key: "name",
      title: "任务",
      sortable: true,
      render: (t: TaskRow) => {
        const isFocus = !!focus && t.code === focus
        return (
          <div
            ref={
              isFocus
                ? (el) => {
                    if (el && scrolledFor.current !== t.code) {
                      scrolledFor.current = t.code
                      requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: "smooth" }))
                    }
                  }
                : undefined
            }
            className={cn(
              "space-y-0.5 rounded-md -mx-1 px-2 py-1 transition-shadow",
              isFocus && "ring-2 ring-teal-500 bg-teal-500/5"
            )}
          >
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium">{t.name}</p>
              <Badge
                variant={t.isCustom ? "default" : "outline"}
                className={cn("text-[10px] px-1.5", t.isCustom && "bg-teal-600 hover:bg-teal-600")}
              >
                {t.isCustom ? "自定义" : "内置"}
              </Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{t.code}</p>
            {(t.description || t.createdByUsername) && (
              <p className="text-xs text-muted-foreground block max-w-56 truncate" title={t.description || `创建人：${t.createdByUsername}`}>
                {t.description ? t.description : `创建人：${t.createdByUsername}`}
              </p>
            )}
          </div>
        )
      },
    },
    {
      key: "taskType",
      title: "任务类型",
      render: (t: TaskRow) =>
        t.isCustom && t.taskType ? (
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{t.taskType}</span>
        ) : (
          <span className="text-xs text-muted-foreground" title="内置任务：执行体即任务本身">—</span>
        ),
    },
    {
      key: "cronExpr",
      title: "cron 表达式",
      render: (t: TaskRow) => (
        <div className="space-y-0.5">
          <span className="font-mono text-sm">{t.cronExpr}</span>
          <p className="text-xs text-muted-foreground">{describeCron(t.cronExpr)}</p>
        </div>
      ),
    },
    {
      key: "enabled",
      title: "启用",
      render: (t: TaskRow) => (
        <div className="flex items-center gap-2">
          <Switch
            checked={t.enabled}
            disabled={busy === `${t.code}:toggle`}
            onCheckedChange={(b) => callAction(`${t.code}:toggle`, () => toggleTaskAction({ code: t.code, enabled: b }))}
            aria-label={`${t.enabled ? "停用" : "启用"}任务 ${t.code}`}
          />
          {busy === `${t.code}:toggle` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </div>
      ),
    },
    {
      key: "nextRunAt",
      title: "下次运行",
      sortable: true,
      render: (t: TaskRow) =>
        t.enabled ? (
          <span className="text-xs tabular-nums">{t.nextRunAt || "-"}</span>
        ) : (
          <span className="text-xs text-muted-foreground" title="任务已停用，不调度">已停用</span>
        ),
    },
    {
      key: "lastExecuteAt",
      title: "最近执行",
      sortable: true,
      render: (t: TaskRow) => (
        <div className="space-y-0.5">
          <p className="text-xs tabular-nums">{t.lastExecuteAt || "-"}</p>
          <span className="text-xs text-muted-foreground block max-w-56 truncate" title={t.lastResult || ""}>
            {t.lastResult || "-"}
          </span>
        </div>
      ),
    },
    {
      key: "consecutiveFails",
      title: "连续失败",
      render: (t: TaskRow) =>
        t.consecutiveFails > 0 ? (
          <Badge variant="destructive">{t.consecutiveFails} 次</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">0</span>
        ),
    },
    {
      key: "avgDurationMs",
      title: "平均耗时",
      sortable: true,
      render: (t: TaskRow) => (
        <span className="tabular-nums text-xs">{t.avgDurationMs > 0 ? `${(t.avgDurationMs / 1000).toFixed(2)}s` : "-"}</span>
      ),
    },
    {
      key: "timeoutSec",
      title: "超时(秒)",
      render: (t: TaskRow) => <span className="tabular-nums text-xs">{t.timeoutSec}</span>,
    },
  ]

  const rowActions = (t: TaskRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`任务 ${t.code} 操作`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setExecuteCode(t.code)} disabled={busy.startsWith(`${t.code}:`)}>
          <Play className="mr-2 h-4 w-4" />
          立即执行一次
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setEditTask(t)} disabled={busy.startsWith(`${t.code}:`)}>
          <Pencil className="mr-2 h-4 w-4" />
          编辑{t.isCustom ? "（cron/类型/名称…）" : "（cron/超时/启停）"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const params = new URLSearchParams()
            params.set("tab", "logs")
            params.set("taskCode", t.code)
            router.push(`${pathname}?${params.toString()}`)
          }}
        >
          <ScrollText className="mr-2 h-4 w-4" />
          查看执行日志
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600 focus:text-red-600"
          disabled={!t.isCustom}
          onClick={() => (t.isCustom ? setDeleteTask(t) : toast.error("内置任务不可删除（只能停用）"))}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          删除任务{!t.isCustom ? "（内置不可删）" : ""}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const batchToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">已选 {sel.length}</Badge>
      <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runBatchToggle(true)} title="批量启用所选任务">
        批量启用
      </Button>
      <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runBatchToggle(false)} title="批量停用所选任务">
        批量停用
      </Button>
      <Button size="sm" variant="outline" disabled={!!batchBusy || sel.length > 20} onClick={() => setBatchExecConfirm(true)} title={`逐个触发执行（单批最多 20 个${sel.length > 20 ? "，当前超出" : ""}）`}>
        <Play className="mr-1 h-3.5 w-3.5" />
        批量执行
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-red-600 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
        disabled={!!batchBusy}
        onClick={() => {
          if (customSel.length === 0) {
            toast.error("所选任务均为内置任务（内置任务不可删除，只能停用）")
            return
          }
          setBatchDeleteConfirm(true)
        }}
        title="删除所选中的自定义任务（内置任务自动跳过）"
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        批量删除
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setSel([])} disabled={!!batchBusy}>
        清空选择
      </Button>
    </div>
  )

  return (
    <div className="space-y-3">
      {/* 工具栏：创建自定义任务入口 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          创建自定义任务
        </Button>
        <p className="text-xs text-muted-foreground">
          自定义任务复用内置任务引擎注册的任务类型，按自己的 cron 周期调度；创建后与内置任务统一管理（启停 / 执行 / 日志）
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        filters={[
          {
            key: "taskEnabled",
            placeholder: "启停状态",
            options: [
              { label: "已启用", value: "enabled" },
              { label: "已停用", value: "disabled" },
            ],
          },
          {
            key: "taskKind",
            placeholder: "任务来源",
            options: [
              { label: "内置任务", value: "builtin" },
              { label: "自定义任务", value: "custom" },
            ],
          },
          {
            key: "taskStatus",
            placeholder: "最近结果",
            options: [
              { label: "最近成功", value: "success" },
              { label: "最近失败", value: "failed" },
            ],
          },
        ]}
        selectedIds={sel}
        onSelectedChange={setSel}
        rowActions={rowActions}
        batchToolbar={batchToolbar}
        emptyText="暂无定时任务（可调整筛选或创建自定义任务）"
      />

      <p className="text-xs text-muted-foreground">
        手动执行将调用内部 cron 接口（携带 x-cron-secret 鉴权），执行结果会写入下方执行日志页签；任务串行执行，正在运行的任务会排队；批量执行单批最多 20 个。
      </p>

      {/* ---- 创建自定义任务 ---- */}
      <CustomTaskDialog open={createOpen} onOpenChange={setCreateOpen} mode="create" />

      {/* ---- 编辑（自定义任务全字段 / 内置任务 cron+超时+启停） ---- */}
      <CustomTaskDialog open={!!editTask} onOpenChange={(v) => !v && setEditTask(null)} mode="edit" task={editTask} />

      {/* ---- 单个立即执行确认 ---- */}
      {executeCode && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setExecuteCode(null)}
          title="手动执行任务"
          description={`确认立即执行 ${executeCode} 一次？触发方式将记录为 MANUAL，全程审计留痕。`}
          confirmText="立即执行"
          loading={busy === `${executeCode}:execute`}
          onConfirm={() => runExecute(executeCode)}
        />
      )}

      {/* ---- 删除自定义任务确认 ---- */}
      {deleteTask && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setDeleteTask(null)}
          title="删除自定义任务"
          destructive
          description={`将删除自定义任务「${deleteTask.name}」（${deleteTask.code}，类型 ${deleteTask.taskType}）及其全部历史执行日志。该操作不可恢复。`}
          confirmText="确认删除"
          loading={busy === `${deleteTask.code}:delete`}
          onConfirm={async () => {
            const ok = await callAction(`${deleteTask.code}:delete`, () => deleteCustomTaskAction({ code: deleteTask.code }))
            if (ok) setSel((prev) => prev.filter((id) => id !== deleteTask.code))
          }}
        />
      )}

      {/* ---- 批量执行确认 ---- */}
      {batchExecConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setBatchExecConfirm(false)}
          title="批量立即执行"
          description={`确认对所选 ${sel.length} 个任务逐个触发立即执行？触发方式均记录为 MANUAL；任务串行执行，可能需要等待排队。`}
          confirmText="批量执行"
          loading={batchBusy === "execute"}
          onConfirm={runBatchExecute}
        />
      )}

      {/* ---- 批量删除确认（仅自定义任务） ---- */}
      {batchDeleteConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setBatchDeleteConfirm(false)}
          title="批量删除自定义任务"
          destructive
          requirePhrase="DELETE"
          description={`将删除所选 ${customSel.length} 个自定义任务及其全部历史执行日志（不可恢复）：${customSel.join("、")}${builtinSelCount > 0 ? `\n\n所选中另有 ${builtinSelCount} 个内置任务不可删除，将自动跳过。` : ""}`}
          confirmText="批量删除"
          loading={batchBusy === "delete"}
          onConfirm={runBatchDelete}
        />
      )}

      {/* ---- 批量执行失败明细 ---- */}
      <Dialog open={!!batchFailures} onOpenChange={(v) => !v && setBatchFailures(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="h-4 w-4 text-amber-600" />
              批量执行结果
            </DialogTitle>
            <DialogDescription>
              成功 {batchFailures?.ok ?? 0} 个 / 失败 {batchFailures?.fail ?? 0} 个，失败明细如下：
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border max-h-64 overflow-y-auto">
            <ul className="divide-y text-xs">
              {(batchFailures?.results || []).map((r) => (
                <li key={r.code} className="flex items-start gap-2 p-2">
                  <Badge variant={r.ok ? "default" : "destructive"} className="mt-0.5 text-[10px]">
                    {r.ok ? "OK" : "FAIL"}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-mono">{r.code}</p>
                    {!r.ok && <p className="text-muted-foreground break-all">{r.message}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchFailures(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
