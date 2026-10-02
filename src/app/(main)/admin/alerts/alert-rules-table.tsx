"use client"

// 告警规则 CRUD：名称 / 条件JSON文本域 / 级别 / 静默窗口分钟 / webhook开关 / 启用开关

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { upsertAlertRuleAction, deleteAlertRuleAction, toggleAlertRuleAction } from "@/server/actions/alerts"
import { batchToggleAlertRulesAction, batchDeleteAlertRulesAction } from "@/server/actions/batch"

export interface AlertRuleRow {
  id: string
  name: string
  conditionsJson: string
  level: string
  silenceWindowMin: number
  webhookEnabled: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

const LEVEL_OPTIONS = [
  { label: "INFO 信息", value: "INFO" },
  { label: "WARN 警告", value: "WARN" },
  { label: "CRITICAL 严重", value: "CRITICAL" },
]

const DEFAULT_CONDITIONS = `[
  { "field": "loginFailureCount", "op": ">=", "value": 10 }
]`

interface AlertRulesTableProps {
  rows: AlertRuleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function AlertRulesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters }: AlertRulesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [sel, setSel] = React.useState<string[]>([])
  const [batchBusy, setBatchBusy] = React.useState("")
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)

  const runBatch = async (label: string, fn: () => Promise<{ code: number; msg: string; data?: { affected: number } | null }>, okText: string) => {
    setBatchBusy(label)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(okText.replace("{n}", String(res.data?.affected ?? 0)))
        setSel([])
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBatchBusy("")
    }
  }
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AlertRuleRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<AlertRowSafe | null>(null)

  // 表单状态
  const [fName, setFName] = React.useState("")
  const [fConditions, setFConditions] = React.useState(DEFAULT_CONDITIONS)
  const [fLevel, setFLevel] = React.useState("WARN")
  const [fSilence, setFSilence] = React.useState(30)
  const [fWebhook, setFWebhook] = React.useState(true)
  const [fEnabled, setFEnabled] = React.useState(true)

  type AlertRowSafe = AlertRuleRow

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const openCreate = () => {
    setEditing(null)
    setFName("")
    setFConditions(DEFAULT_CONDITIONS)
    setFLevel("WARN")
    setFSilence(30)
    setFWebhook(true)
    setFEnabled(true)
    setFormOpen(true)
  }

  const openEdit = (row: AlertRuleRow) => {
    setEditing(row)
    setFName(row.name)
    setFConditions(row.conditionsJson)
    setFLevel(row.level)
    setFSilence(row.silenceWindowMin)
    setFWebhook(row.webhookEnabled)
    setFEnabled(row.enabled)
    setFormOpen(true)
  }

  const submit = async () => {
    if (!fName.trim()) {
      toast.error("规则名称必填")
      return
    }
    try {
      JSON.parse(fConditions)
    } catch {
      toast.error("条件 JSON 无法解析，请检查格式")
      return
    }
    setBusy("form")
    try {
      const res = await upsertAlertRuleAction({
        id: editing?.id,
        name: fName.trim(),
        conditionsJson: fConditions,
        level: fLevel,
        silenceWindowMin: Math.round(fSilence),
        webhookEnabled: fWebhook,
        enabled: fEnabled,
      })
      if (res.code === 0) {
        toast.success(editing ? "告警规则已更新" : "告警规则已创建")
        setFormOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy("")
    }
  }

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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">告警规则：满足条件即触发对应级别的告警（支持静默窗口与 webhook 联动）</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          新建规则
        </Button>
      </div>

      <DataTable
        selectedIds={sel}
        onSelectedChange={setSel}
        batchToolbar={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runBatch("on", () => batchToggleAlertRulesAction({ ids: sel, enabled: true }), "已批量启用 {n} 条规则")}>
              批量启用
            </Button>
            <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runBatch("off", () => batchToggleAlertRulesAction({ ids: sel, enabled: false }), "已批量停用 {n} 条规则")}>
              批量停用
            </Button>
            <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900" disabled={!!batchBusy} onClick={() => setBatchDeleteOpen(true)}>
              {batchBusy === "delete" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
              批量删除
            </Button>
          </div>
        }
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        filters={[
          { key: "level", placeholder: "级别", options: LEVEL_OPTIONS },
          {
            key: "enabled",
            placeholder: "启用状态",
            options: [
              { label: "已启用", value: "true" },
              { label: "已停用", value: "false" },
            ],
          },
        ]}
        emptyText="暂无告警规则"
        columns={[
          { key: "name", title: "规则名称", render: (r) => <span className="text-sm font-medium">{r.name}</span> },
          {
            key: "level",
            title: "级别",
            render: (r) => (
              <Badge
                className={
                  r.level === "CRITICAL"
                    ? "bg-red-600 hover:bg-red-600 text-white"
                    : r.level === "WARN"
                      ? "bg-amber-500 hover:bg-amber-500 text-white"
                      : "bg-sky-600 hover:bg-sky-600 text-white"
                }
              >
                {r.level}
              </Badge>
            ),
          },
          {
            key: "conditionsJson",
            title: "触发条件（JSON）",
            render: (r) => (
              <span className="font-mono text-[10px] text-muted-foreground block max-w-72 truncate" title={r.conditionsJson}>
                {r.conditionsJson}
              </span>
            ),
          },
          { key: "silenceWindowMin", title: "静默窗口", render: (r) => <span className="tabular-nums text-sm">{r.silenceWindowMin} 分钟</span> },
          {
            key: "webhookEnabled",
            title: "Webhook",
            render: (r) =>
              r.webhookEnabled ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-[10px]">已联动</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">未联动</Badge>
              ),
          },
          {
            key: "enabled",
            title: "启用",
            render: (r) => (
              <Switch
                checked={r.enabled}
                disabled={busy === `toggle:${r.id}`}
                onCheckedChange={(b) => callAction(`toggle:${r.id}`, () => toggleAlertRuleAction({ id: r.id, enabled: b }))}
                aria-label={`启用 ${r.name}`}
              />
            ),
          },
          { key: "updatedAt", title: "更新时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.updatedAt}</span> },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={`编辑 ${r.name}`}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={() => setDeleteTarget(r)}
              disabled={busy === `delete:${r.id}`}
              aria-label={`删除 ${r.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      />

      {/* 新建/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !v && setFormOpen(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑告警规则" : "新建告警规则"}</DialogTitle>
            <DialogDescription>条件 JSON 支持对象（含 logic: AND/OR）或条件数组（field / op / value）</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>规则名称</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="如：登录失败激增" maxLength={64} />
            </div>
            <div className="space-y-1.5">
              <Label>触发条件（JSON 文本）</Label>
              <Textarea value={fConditions} onChange={(e) => setFConditions(e.target.value)} rows={5} className="font-mono text-xs" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>告警级别</Label>
                <Select value={fLevel} onValueChange={setFLevel}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEVEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>静默窗口（分钟）</Label>
                <PrecisionInput value={fSilence} onChange={setFSilence} min={0} max={10080} step={1} suffix="分" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Webhook 联动</p>
                <p className="text-xs text-muted-foreground">触发时同时投递全局 / 规则 webhook</p>
              </div>
              <Switch checked={fWebhook} onCheckedChange={setFWebhook} aria-label="webhook 联动" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用规则</p>
                <p className="text-xs text-muted-foreground">关闭后规则不再参与告警评估</p>
              </div>
              <Switch checked={fEnabled} onCheckedChange={setFEnabled} aria-label="启用规则" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={busy === "form"}>
              {busy === "form" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? "保存修改" : "创建规则"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（物理删除 + 快照审计） */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除告警规则"
        destructive
        requirePhrase="DELETE"
        description={`确认删除规则「${deleteTarget?.name}」？\nAlertRule 为物理删除（无软删字段），删除前会将完整规则快照写入审计日志。`}
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (deleteTarget) await callAction("delete", () => deleteAlertRuleAction({ id: deleteTarget.id }))
          setDeleteTarget(null)
        }}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && setBatchDeleteOpen(v)}
        title={`批量删除 ${sel.length} 条告警规则`}
        description={`将物理删除选中的 ${sel.length} 条规则：\n· 删除前完整规则快照写入审计日志\n· 关联的历史告警记录保留不受影响`}
        requirePhrase="DELETE"
        destructive
        loading={batchBusy === "delete"}
        confirmText="确认批量删除"
        onConfirm={() => runBatch("delete", () => batchDeleteAlertRulesAction({ ids: sel }), "已批量删除 {n} 条规则")}
      />
    </div>
  )
}
