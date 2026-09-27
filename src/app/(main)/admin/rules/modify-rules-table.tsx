"use client"

// 请求篡改规则交互表格：REQ_HEADER / RESP_HEADER / REDIRECT CRUD + 模板绑定 + 软删除

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
import { saveModifyRuleAction, deleteModifyRuleAction, toggleModifyRuleAction } from "@/server/actions/rules"

export interface ModifyRuleRow {
  id: string
  name: string
  type: string
  matchPattern: string
  headerKey: string | null
  headerValue: string | null
  redirectUrl: string | null
  enabled: boolean
  templateBinding: string | null
  templateName: string | null
  createdAt: string
}

interface Props {
  rows: ModifyRuleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  templateOptions: { id: string; name: string }[]
}

const TYPE_LABEL: Record<string, string> = {
  REQ_HEADER: "请求头",
  RESP_HEADER: "响应头",
  REDIRECT: "重定向",
}

export function ModifyRulesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters, templateOptions } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<ModifyRuleRow | null>(null)

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
  const [editing, setEditing] = React.useState<ModifyRuleRow | null>(null)
  const [form, setForm] = React.useState({
    name: "", type: "REQ_HEADER", matchPattern: "", headerKey: "", headerValue: "", redirectUrl: "", enabled: true, templateBinding: "__none__",
  })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ name: "", type: "REQ_HEADER", matchPattern: "", headerKey: "", headerValue: "", redirectUrl: "", enabled: true, templateBinding: "__none__" })
    setFormOpen(true)
  }
  const openEdit = (row: ModifyRuleRow) => {
    setEditing(row)
    setForm({
      name: row.name,
      type: row.type,
      matchPattern: row.matchPattern,
      headerKey: row.headerKey || "",
      headerValue: row.headerValue || "",
      redirectUrl: row.redirectUrl || "",
      enabled: row.enabled,
      templateBinding: row.templateBinding || "__none__",
    })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.name.trim()) return toast.error("请填写规则名称")
    if (!form.matchPattern.trim()) return toast.error("请填写匹配模式")
    if (form.type === "REDIRECT" && !form.redirectUrl.trim()) return toast.error("重定向类型必须填写重定向 URL")
    if (form.type !== "REDIRECT" && !form.headerKey.trim()) return toast.error("请求/响应头类型必须填写头名称")
    if (form.type !== "REDIRECT" && !form.headerValue) return toast.error("请求/响应头类型必须填写头值")
    setFormBusy(true)
    try {
      const res = await saveModifyRuleAction({
        id: editing?.id,
        name: form.name.trim(),
        type: form.type,
        matchPattern: form.matchPattern.trim(),
        headerKey: form.type === "REDIRECT" ? null : form.headerKey.trim(),
        headerValue: form.type === "REDIRECT" ? null : form.headerValue,
        redirectUrl: form.type === "REDIRECT" ? form.redirectUrl.trim() : null,
        enabled: form.enabled,
        templateBinding: form.templateBinding === "__none__" ? null : form.templateBinding,
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
      key: "name",
      title: "规则名",
      sortable: true,
      render: (row: ModifyRuleRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{row.matchPattern}</p>
        </div>
      ),
    },
    {
      key: "type",
      title: "类型",
      sortable: true,
      render: (row: ModifyRuleRow) => (
        <Badge variant={row.type === "REDIRECT" ? "default" : "secondary"} className={row.type === "REDIRECT" ? "bg-purple-600 hover:bg-purple-600" : ""}>
          {TYPE_LABEL[row.type] || row.type}
        </Badge>
      ),
    },
    {
      key: "detail",
      title: "规则内容",
      render: (row: ModifyRuleRow) => (
        <div className="min-w-0 max-w-56 text-xs">
          {row.type === "REDIRECT" ? (
            <p className="font-mono truncate">→ {row.redirectUrl || "-"}</p>
          ) : (
            <p className="font-mono truncate">
              <span className="text-teal-600">{row.headerKey}</span>: {row.headerValue}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "templateBinding",
      title: "绑定模板",
      render: (row: ModifyRuleRow) =>
        row.templateBinding ? (
          <Badge variant="outline" className="text-xs">{row.templateName || "已删除模板"}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">全局</span>
        ),
    },
    {
      key: "enabled",
      title: "启用",
      render: (row: ModifyRuleRow) => (
        <Badge variant={row.enabled ? "default" : "outline"} className={row.enabled ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
          {row.enabled ? "生效" : "停用"}
        </Badge>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: ModifyRuleRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">请求/响应头注入与重定向规则；可绑定模板仅对该模板会话生效，否则全局生效</p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建篡改规则
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
          {
            key: "type", placeholder: "类型",
            options: [
              { label: "请求头", value: "REQ_HEADER" },
              { label: "响应头", value: "RESP_HEADER" },
              { label: "重定向", value: "REDIRECT" },
            ],
          },
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
              <DropdownMenuItem onClick={() => callAction(`toggle-${row.id}`, () => toggleModifyRuleAction({ id: row.id }))}>
                {row.enabled ? "停用" : "启用"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                <Trash2 className="h-4 w-4 mr-2" /> 删除（软删除）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
      />

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑篡改规则" : "新建篡改规则"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>规则名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 注入 X-Trace-Id" />
              </div>
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="REQ_HEADER">REQ_HEADER（请求头）</SelectItem>
                    <SelectItem value="RESP_HEADER">RESP_HEADER（响应头）</SelectItem>
                    <SelectItem value="REDIRECT">REDIRECT（重定向）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>匹配模式</Label>
              <Input value={form.matchPattern} onChange={(e) => setForm({ ...form, matchPattern: e.target.value })} placeholder="*://api.example.com/*" className="font-mono" />
            </div>
            {form.type === "REDIRECT" ? (
              <div className="space-y-1.5">
                <Label>重定向 URL</Label>
                <Input value={form.redirectUrl} onChange={(e) => setForm({ ...form, redirectUrl: e.target.value })} placeholder="https://mirror.example.com" className="font-mono" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>头名称</Label>
                  <Input value={form.headerKey} onChange={(e) => setForm({ ...form, headerKey: e.target.value })} placeholder="X-Custom-Header" className="font-mono" />
                </div>
                <div className="space-y-1.5">
                  <Label>头值</Label>
                  <Input value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="value" className="font-mono" />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>绑定模板（可选）</Label>
                <Select value={form.templateBinding} onValueChange={(v) => setForm({ ...form, templateBinding: v })}>
                  <SelectTrigger><SelectValue placeholder="全局生效" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不绑定（全局）</SelectItem>
                    {templateOptions.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
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
        title="删除篡改规则（软删除）"
        description={`规则「${deleting?.name}」将软删除并停用（不进回收站，含审计记录）。`}
        destructive
        confirmText="删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteModifyRuleAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
