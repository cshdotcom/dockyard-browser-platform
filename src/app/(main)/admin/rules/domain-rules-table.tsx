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
  const [form, setForm] = React.useState({ pattern: "", type: "BLACK", enabled: true, note: "" })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ pattern: "", type: "BLACK", enabled: true, note: "" })
    setFormOpen(true)
  }
  const openEdit = (row: DomainRuleRow) => {
    setEditing(row)
    setForm({ pattern: row.pattern, type: row.type, enabled: row.enabled, note: row.note || "" })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.pattern.trim()) return toast.error("请填写域名模式")
    setFormBusy(true)
    try {
      const res = await saveDomainRuleAction({
        id: editing?.id,
        pattern: form.pattern.trim(),
        type: form.type,
        enabled: form.enabled,
        note: form.note.trim() || null,
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
