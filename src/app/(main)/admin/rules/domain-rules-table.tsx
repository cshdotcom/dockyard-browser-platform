"use client"

// 域名规则交互表格：CRUD / 启停 / 物理删除

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { saveDomainRuleAction, deleteDomainRuleAction, toggleDomainRuleAction } from "@/server/actions/rules"

export interface DomainRuleRow {
  id: string
  pattern: string
  type: string
  enabled: boolean
  note: string | null
  scopeType: string // GLOBAL | GROUP | USER
  scopeLabel: string // 人读作用域标签
  scopeTargetId: string | null // GROUP/USER 目标ID（编辑回填）
  createdByUsername: string
  createdAt: string
}

interface Props {
  rows: DomainRuleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  groupOptions: { id: string; name: string }[]
  userOptions: { id: string; name: string }[]
  workspaceOptions: { id: string; name: string }[]
}

export function DomainRulesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<DomainRuleRow | null>(null)

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

  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<DomainRuleRow | null>(null)
  const [form, setForm] = React.useState({ pattern: "", type: "BLACK", enabled: true, note: "", scopeType: "GLOBAL", groupId: "", userId: "", workspaceId: "", priority: 0 })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ pattern: "", type: "BLACK", enabled: true, note: "", scopeType: "GLOBAL", groupId: "", userId: "", workspaceId: "", priority: 0 })
    setFormOpen(true)
  }
  const openEdit = (row: DomainRuleRow) => {
    setEditing(row)
    setForm({
      pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note || "",
      scopeType: row.scopeType, groupId: row.scopeType === "GROUP" ? row.scopeTargetId || "" : "", userId: row.scopeType === "USER" ? row.scopeTargetId || "" : "", workspaceId: row.scopeType === "SANDBOX" ? row.scopeTargetId || "" : "", priority: 0,
    })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.pattern.trim()) return toast.error("请填写域名模式")
    if (form.scopeType === "GROUP" && !form.groupId) return toast.error("组级规则请选择用户组")
    if (form.scopeType === "USER" && !form.userId) return toast.error("用户级规则请选择用户")
    if (form.scopeType === "SANDBOX" && !form.workspaceId) return toast.error("沙箱级规则请选择目标沙箱")
    setFormBusy(true)
    try {
      const res = await saveDomainRuleAction({
        id: editing?.id,
        pattern: form.pattern.trim(),
        type: form.type,
        enabled: form.enabled,
        note: form.note.trim() || null,
        scopeType: form.scopeType,
        groupId: form.scopeType === "GROUP" ? form.groupId : null,
        userId: form.scopeType === "USER" ? form.userId : null,
        workspaceId: form.scopeType === "SANDBOX" ? form.workspaceId : null,
        priority: Number(form.priority) || 0,
      })
      if (res.code === 0) {
        toast.success(editing ? "已更新" : "已创建")
        setFormOpen(false)
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
      key: "pattern",
      title: "域名模式",
      sortable: true,
      render: (row: DomainRuleRow) => (
        <div className="min-w-0">
          <p className="font-mono text-xs break-all">{row.pattern}</p>
          {row.note && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{row.note}</p>}
        </div>
      ),
    },
    {
      key: "type",
      title: "类型",
      render: (row: DomainRuleRow) => (
        <Badge className={row.type === "BLACK" ? "bg-red-600 hover:bg-red-600" : "bg-emerald-600 hover:bg-emerald-600"}>{row.type}</Badge>
      ),
    },
    {
      key: "scopeType",
      title: "作用域",
      render: (row: DomainRuleRow) => (
        <Badge
          variant="outline"
          className={
            row.scopeType === "USER"
              ? "border-violet-400/50 text-violet-500"
              : row.scopeType === "GROUP"
                ? "border-amber-400/50 text-amber-500"
                : row.scopeType === "SANDBOX"
                  ? "border-teal-400/50 text-teal-500"
                  : "border-slate-400/50 text-slate-400"
          }
        >
          {row.scopeLabel}
        </Badge>
      ),
    },
    {
      key: "enabled",
      title: "启用",
      render: (row: DomainRuleRow) => (
        <Badge variant={row.enabled ? "default" : "outline"} className={row.enabled ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
          {row.enabled ? "生效" : "停用"}
        </Badge>
      ),
    },
    { key: "createdByUsername", title: "创建人", render: (row: DomainRuleRow) => <span className="text-xs">{row.createdByUsername}</span> },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: DomainRuleRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">黑名单域名在工作区内被阻断；白名单模式启用后仅名单域名可访问</p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建域名规则
        </Button>
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
          { key: "type", placeholder: "类型", options: [{ label: "BLACK", value: "BLACK" }, { label: "WHITE", value: "WHITE" }] },
          { key: "scopeType", placeholder: "作用域", options: [{ label: "全局", value: "GLOBAL" }, { label: "用户组", value: "GROUP" }, { label: "用户", value: "USER" }, { label: "单沙箱", value: "SANDBOX" }] },
          { key: "enabled", placeholder: "状态", options: [{ label: "生效", value: "true" }, { label: "停用", value: "false" }] },
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(row)}>
                <Pencil className="h-4 w-4 mr-2" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => callAction(`toggle-${row.id}`, () => toggleDomainRuleAction({ id: row.id }))}>
                {row.enabled ? "逻辑停用" : "启用"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                <Trash2 className="h-4 w-4 mr-2" /> 物理删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
      />

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑域名规则" : "新建域名规则"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <Label>域名模式</Label>
              <Input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="*.example.com 或 example.com" className="font-mono" />
              <p className="text-[10px] text-muted-foreground">支持通配符：*.example.com 匹配全部子域名</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BLACK">BLACK（黑名单）</SelectItem>
                    <SelectItem value="WHITE">WHITE（白名单）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">启用</p>
                  <p className="text-xs text-muted-foreground">停用即逻辑下线</p>
                </div>
                <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>作用域</Label>
                <Select value={form.scopeType} onValueChange={(v) => setForm({ ...form, scopeType: v, groupId: "", userId: "", workspaceId: "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GLOBAL">全局（全部会话生效）</SelectItem>
                    <SelectItem value="GROUP">用户组（仅组成员）</SelectItem>
                    <SelectItem value="USER">指定用户</SelectItem>
                    <SelectItem value="SANDBOX">单沙箱（仅该沙箱）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.scopeType === "GROUP" ? (
                <div className="space-y-1.5">
                  <Label>目标用户组</Label>
                  <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择用户组" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.groupOptions.map((g) => (
                        <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : form.scopeType === "USER" ? (
                <div className="space-y-1.5">
                  <Label>目标用户</Label>
                  <Select value={form.userId} onValueChange={(v) => setForm({ ...form, userId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.userOptions.map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : form.scopeType === "SANDBOX" ? (
                <div className="space-y-1.5">
                  <Label>目标沙箱</Label>
                  <Select value={form.workspaceId} onValueChange={(v) => setForm({ ...form, workspaceId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择 NoVNC 沙箱" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.workspaceOptions.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">仅作用于该沙箱（四层最高优先）</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>优先级（可选）</Label>
                  <Input type="number" min={0} max={9999} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} placeholder="0" />
                  <p className="text-[10px] text-muted-foreground">数字越大越先应用</p>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>备注（可选）</Label>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="规则说明" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={submitForm} disabled={formBusy}>
              {formBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} {editing ? "保存修改" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="物理删除域名规则"
        description={`规则「${deleting?.pattern}」将被物理删除（含审计）。如需临时停用请使用启用开关。`}
        destructive
        confirmText="物理删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteDomainRuleAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
