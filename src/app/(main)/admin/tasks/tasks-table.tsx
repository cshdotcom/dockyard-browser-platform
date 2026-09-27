"use client"

// 定时任务列表交互：启停开关 / 手动执行一次（走内部 cron 接口）/ 编辑 cron 与超时弹窗

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pencil, Play, ScrollText } from "lucide-react"
import { PrecisionInput } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { toggleTaskAction, executeTaskNowAction, updateTaskAction } from "@/server/actions/tasks"

export interface TaskRow {
  id: string // = code
  code: string
  name: string
  cronExpr: string
  enabled: boolean
  timeoutSec: number
  dependsOn: string | null
  consecutiveFails: number
  lastExecuteAt: string | null
  lastResult: string | null
  avgDurationMs: number
}

const CRON_FIELD_RE = /^(\S+\s+){4}\S+$/

export function TasksTable({ rows }: { rows: TaskRow[] }) {
  const router = useRouter()

  const [busy, setBusy] = React.useState<string>("") // code:action
  const [executeCode, setExecuteCode] = React.useState<string | null>(null)
  const [editTask, setEditTask] = React.useState<TaskRow | null>(null)
  const [editCron, setEditCron] = React.useState("")
  const [editTimeout, setEditTimeout] = React.useState(300)
  const [resultDialog, setResultDialog] = React.useState<{ code: string; cronCode: number; cronMsg: string } | null>(null)

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(name)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  const runExecute = async (code: string) => {
    setBusy(`${code}:execute`)
    try {
      const res = await executeTaskNowAction({ code })
      if (res.data) {
        // 展示 cron 接口原始 { code, msg } 响应
        setResultDialog({ code, cronCode: res.data.cronCode, cronMsg: res.data.cronMsg })
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

  const submitEdit = async () => {
    if (!editTask) return
    if (!CRON_FIELD_RE.test(editCron.trim())) {
      toast.error("cron 表达式必须为5字段格式：分 时 日 月 周（空格分隔），如 */5 * * * *")
      return
    }
    if (editTimeout < 5 || editTimeout > 86400) {
      toast.error("超时时间必须在 5 - 86400 秒之间")
      return
    }
    setBusy(`${editTask.code}:edit`)
    try {
      const res = await updateTaskAction({ code: editTask.code, cronExpr: editCron.trim(), timeoutSec: editTimeout })
      if (res.code === 0) {
        toast.success("任务已更新")
        setEditTask(null)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失败")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>cron 表达式</TableHead>
              <TableHead className="w-20">启用</TableHead>
              <TableHead className="w-24">超时(秒)</TableHead>
              <TableHead className="w-32">依赖任务</TableHead>
              <TableHead className="w-24">连续失败</TableHead>
              <TableHead className="w-40">上次执行</TableHead>
              <TableHead className="w-24">平均耗时</TableHead>
              <TableHead>上次结果</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">暂无定时任务</TableCell>
              </TableRow>
            )}
            {rows.map((t) => (
              <TableRow key={t.code}>
                <TableCell>
                  <div className="space-y-0.5">
                    <p className="font-mono text-sm font-medium">{t.code}</p>
                    <p className="text-xs text-muted-foreground">{t.name}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-mono text-sm">{t.cronExpr}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={t.enabled}
                      disabled={busy === `${t.code}:toggle`}
                      onCheckedChange={(b) => callAction(`${t.code}:toggle`, () => toggleTaskAction({ code: t.code, enabled: b }))}
                      aria-label={`启用 ${t.code}`}
                    />
                    {busy === `${t.code}:toggle` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">{t.timeoutSec}</TableCell>
                <TableCell>
                  {t.dependsOn ? (
                    <Badge variant="outline" className="font-mono text-[10px]">{t.dependsOn}</Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {t.consecutiveFails > 0 ? (
                    <Badge variant="destructive">{t.consecutiveFails} 次</Badge>
                  ) : (
                    <Badge variant="secondary">0</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums">{t.lastExecuteAt || "-"}</TableCell>
                <TableCell className="tabular-nums text-xs">
                  {t.avgDurationMs > 0 ? `${(t.avgDurationMs / 1000).toFixed(2)}s` : "-"}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground block max-w-64 truncate" title={t.lastResult || ""}>
                    {t.lastResult || "-"}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label="任务操作">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setExecuteCode(t.code)} disabled={busy.startsWith(`${t.code}:`)}>
                        <Play className="mr-2 h-4 w-4" />
                        手动执行一次
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setEditTask(t)
                          setEditCron(t.cronExpr)
                          setEditTimeout(t.timeoutSec)
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑 cron / 超时
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        手动执行将调用内部 cron 接口（携带 x-cron-secret 鉴权），执行结果会写入下方执行日志页签；任务串行执行，正在运行的任务会排队。
      </p>

      {/* 手动执行确认 */}
      {executeCode && (
        <Dialog open onOpenChange={(v) => !v && !busy && setExecuteCode(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Play className="h-4 w-4 text-teal-600" />
                手动执行任务
              </DialogTitle>
              <DialogDescription>
                确认立即执行 <span className="font-mono font-medium text-foreground">{executeCode}</span> 一次？触发方式将记录为 MANUAL，全程审计留痕。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setExecuteCode(null)} disabled={busy === `${executeCode}:execute`}>
                取消
              </Button>
              <Button onClick={() => runExecute(executeCode)} disabled={busy === `${executeCode}:execute`}>
                {busy === `${executeCode}:execute` && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                立即执行
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* cron / 超时编辑 */}
      <Dialog open={!!editTask} onOpenChange={(v) => !v && setEditTask(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑任务调度参数</DialogTitle>
            <DialogDescription>
              {editTask && (
                <>
                  <span className="font-mono font-medium text-foreground">{editTask.code}</span>（{editTask.name}）
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>cron 表达式（5字段：分 时 日 月 周）</Label>
              <Input
                value={editCron}
                onChange={(e) => setEditCron(e.target.value)}
                placeholder="*/5 * * * *"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">示例：*/5 * * * *（每5分钟）· 0 3 * * *（每天3点）· 0 */2 * * *（每2小时）</p>
            </div>
            <div className="space-y-1.5">
              <Label>超时时间（秒，超时自动终止并记 TIMEOUT）</Label>
              <PrecisionInput value={editTimeout} onChange={setEditTimeout} min={5} max={86400} step={1} suffix="秒" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTask(null)}>取消</Button>
            <Button onClick={submitEdit} disabled={!!editTask && busy === `${editTask.code}:edit`}>
              {!!editTask && busy === `${editTask.code}:edit` && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* cron 接口响应展示 */}
      <Dialog open={!!resultDialog} onOpenChange={(v) => !v && setResultDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4" />
              cron 接口响应
            </DialogTitle>
            <DialogDescription>
              任务 <span className="font-mono text-foreground">{resultDialog?.code}</span> 触发完成，接口原始返回如下：
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 font-mono text-xs space-y-1">
            <p><span className="text-muted-foreground">code:</span> {resultDialog?.cronCode}</p>
            <p><span className="text-muted-foreground">msg:</span> {resultDialog?.cronMsg}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResultDialog(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

