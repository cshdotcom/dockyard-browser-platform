"use client"

// 黑白名单交互表格：新建 / 删除 / 手动解封 / 一键清理过期

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, Trash2, LockOpen, Sparkles } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MoreHorizontal } from "lucide-react"
import { Info } from "lucide-react"
import { createRiskRuleAction, deleteRiskRuleAction, unbanRiskRuleAction, purgeExpiredRiskRulesAction } from "@/server/actions/risk"

export interface RiskRuleRow {
  id: string
  type: string
  value: string
  note: string | null
  mode: string
  expiresAt: string | null
  expired: boolean
  createdByUsername: string
  createdAt: string
}

interface Props {
  rows: RiskRuleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

const TYPE_META: Record<string, { label: string; cls: string }> = {
  IP_BLACK: { label: "IP 黑名单", cls: "bg-red-600 text-white" },
  IP_WHITE: { label: "IP 白名单", cls: "bg-emerald-600 text-white" },
  UA_BLACK: { label: "UA 黑名单", cls: "bg-purple-600 text-white" },
  DEVICE_BLACK: { label: "设备黑名单", cls: "bg-slate-700 text-white" },
}

export function RiskListTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<RiskRuleRow | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
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
      return res
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy("")
    }
  }

  // ---- 表单 ----
  const [formOpen, setFormOpen] = React.useState(false)
  const [form, setForm] = React.useState({ type: "IP_BLACK", value: "", note: "", mode: "PERMANENT", expiresAt: "" })
  const [formBusy, setFormBusy] = React.useState(false)

  const submitForm = async () => {
    if (!form.value.trim()) return toast.error("请填写规则值")
    if (form.mode === "TEMP" && !form.expiresAt) return toast.error("临时规则必须选择过期时间")
    setFormBusy(true)
    try {
      const res = await createRiskRuleAction({
        type: form.type,
        value: form.value.trim(),
        note: form.note.trim() || null,
        mode: form.mode,
        expiresAt: form.mode === "TEMP" && form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      })
      if (res.code === 0) {
        toast.success("规则已创建")
        setFormOpen(false)
        setForm({ type: "IP_BLACK", value: "", note: "", mode: "PERMANENT", expiresAt: "" })
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setFormBusy(false)
    }
  }

  const columns = [
    {
      key: "type",
      title: "类型",
      render: (row: RiskRuleRow) => {
        const m = TYPE_META[row.type] || { label: row.type, cls: "bg-secondary text-secondary-foreground" }
        return <Badge className={`${m.cls} text-xs`}>{m.label}</Badge>
      },
    },
    {
      key: "value",
      title: "值",
      sortable: true,
      render: (row: RiskRuleRow) => (
        <div className="min-w-0">
          <p className="font-mono text-xs break-all">{row.value}</p>
          {row.note && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{row.note}</p>}
        </div>
      ),
    },
    {
      key: "mode",
      title: "模式",
      render: (row: RiskRuleRow) => (
        <div className="text-xs">
          <Badge variant={row.mode === "TEMP" ? "default" : "outline"} className={row.mode === "TEMP" ? "bg-amber-600 hover:bg-amber-600" : ""}>
            {row.mode === "TEMP" ? "临时" : "永久"}
          </Badge>
          {row.expired && <p className="text-red-600 mt-1">已过期</p>}
        </div>
      ),
    },
    {
      key: "expiresAt",
      title: "过期时间",
      sortable: true,
      render: (row: RiskRuleRow) => <span className="text-xs tabular-nums">{row.expiresAt || "-"}</span>,
    },
    { key: "createdByUsername", title: "创建人", render: (row: RiskRuleRow) => <span className="text-xs">{row.createdByUsername}</span> },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: RiskRuleRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p><span className="font-medium text-foreground">白名单开启后，仅白名单 IP 可访问 API / MCP / VNC 通道</span>（不在名单内的 IP 将被拒绝）。</p>
          <p>黑名单支持 CIDR 段（如 <code className="font-mono text-xs">203.0.113.0/24</code>）与通配符（如 <code className="font-mono text-xs">203.0.*</code>）；临时规则到期后自动解封，也可手动清理。</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">封禁操作全程审计；临时规则到期自动失效</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => callAction("purgeExpired", purgeExpiredRiskRulesAction)}>
            {busy === "purgeExpired" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            清理全部已过期
          </Button>
          <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> 新建规则
          </Button>
        </div>
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
        filters={[
          {
            key: "type", placeholder: "类型",
            options: Object.entries(TYPE_META).map(([v, m]) => ({ label: m.label, value: v })),
          },
          { key: "mode", placeholder: "模式", options: [{ label: "临时", value: "TEMP" }, { label: "永久", value: "PERMANENT" }] },
          { key: "expired", placeholder: "过期状态", options: [{ label: "已过期", value: "true" }, { label: "生效中", value: "false" }] },
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {row.mode === "TEMP" && (
                <DropdownMenuItem onClick={() => callAction(`unban-${row.id}`, () => unbanRiskRuleAction({ id: row.id }))}>
                  <LockOpen className="h-4 w-4 mr-2" /> 手动解封（需已过期）
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                <Trash2 className="h-4 w-4 mr-2" /> 删除规则
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
      />

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建黑白名单规则</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_META).map(([v, m]) => (
                      <SelectItem key={v} value={v}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>模式</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v, expiresAt: v === "TEMP" ? form.expiresAt : "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERMANENT">永久</SelectItem>
                    <SelectItem value="TEMP">临时（到期自动解封）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>值</Label>
              <Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.type.startsWith("IP") ? "203.0.113.10 或 203.0.113.0/24" : "关键字 / 设备指纹"} />
            </div>
            {form.mode === "TEMP" && (
              <div className="space-y-1.5">
                <Label>过期时间</Label>
                <Input type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
                <p className="text-[10px] text-muted-foreground">到期后规则自动失效（解封）</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>备注（可选）</Label>
              <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="封禁原因 / 工单号" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={submitForm} disabled={formBusy}>
              {formBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 创建规则
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="删除规则"
        description={`规则「${deleting?.value}」将被物理删除（含审计记录），立即解除封禁效果。`}
        destructive
        confirmText="删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteRiskRuleAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
