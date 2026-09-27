"use client"

// UA 池交互表格：CRUD / 启停 / 导入导出 JSON / 使用次数统计

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Plus, MoreHorizontal, Pencil, Trash2, FileDown, FileUp, MonitorSmartphone, Smartphone } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { saveUaAction, deleteUaAction, toggleUaAction, importUaAction, exportUaAction } from "@/server/actions/rules"

export interface UaRow {
  id: string
  ua: string
  label: string | null
  category: string
  enabled: boolean
  usageCount: number
  createdAt: string
}

interface Props {
  rows: UaRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function UaTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<UaRow | null>(null)

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

  // ---- 编辑弹窗 ----
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<UaRow | null>(null)
  const [form, setForm] = React.useState({ ua: "", label: "", category: "DESKTOP", enabled: true })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ ua: "", label: "", category: "DESKTOP", enabled: true })
    setFormOpen(true)
  }
  const openEdit = (row: UaRow) => {
    setEditing(row)
    setForm({ ua: row.ua, label: row.label || "", category: row.category, enabled: row.enabled })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (form.ua.trim().length < 10) return toast.error("UA 字符串过短（至少 10 字符）")
    setFormBusy(true)
    try {
      const res = await saveUaAction({
        id: editing?.id,
        ua: form.ua.trim(),
        label: form.label.trim() || null,
        category: form.category,
        enabled: form.enabled,
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

  // ---- 导入导出 ----
  const [importOpen, setImportOpen] = React.useState(false)
  const [importText, setImportText] = React.useState("")
  const [importBusy, setImportBusy] = React.useState(false)

  const doExport = async () => {
    setBusy("export")
    try {
      const res = await exportUaAction()
      if (res.code === 0 && res.data) {
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `ua-pool-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
        toast.success("已导出 UA 池 JSON")
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导出失败")
    } finally {
      setBusy("")
    }
  }

  const doImport = async () => {
    if (!importText.trim()) return toast.error("请粘贴 JSON 内容")
    setImportBusy(true)
    try {
      const res = await importUaAction({ text: importText })
      if (res.code === 0 && res.data) {
        const d = res.data as { imported: number; skipped: number; errors: string[] }
        toast.success(`导入完成：新增 ${d.imported} 条，跳过重复 ${d.skipped} 条${d.errors.length ? `，失败 ${d.errors.length} 条` : ""}`)
        if (d.errors.length > 0) toast.warning(`首条错误：${d.errors[0]}`)
        setImportOpen(false)
        setImportText("")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setImportBusy(false)
    }
  }

  const columns = [
    {
      key: "ua",
      title: "UA 字符串",
      sortable: true,
      render: (row: UaRow) => (
        <div className="min-w-0 max-w-md">
          <p className="font-medium text-xs">{row.label || "(未命名)"}</p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">{row.ua}</p>
        </div>
      ),
    },
    {
      key: "category",
      title: "类别",
      sortable: true,
      render: (row: UaRow) => (
        <Badge variant={row.category === "MOBILE" ? "secondary" : "default"} className={row.category === "DESKTOP" ? "bg-teal-600 hover:bg-teal-600" : ""}>
          {row.category === "MOBILE" ? <Smartphone className="h-3 w-3 mr-1" /> : <MonitorSmartphone className="h-3 w-3 mr-1" />}
          {row.category}
        </Badge>
      ),
    },
    { key: "usageCount", title: "使用次数", sortable: true, render: (row: UaRow) => <span className="tabular-nums">{row.usageCount}</span> },
    {
      key: "enabled",
      title: "启用",
      render: (row: UaRow) => (
        <Badge variant={row.enabled ? "default" : "outline"} className={row.enabled ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
          {row.enabled ? "启用" : "停用"}
        </Badge>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: UaRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">UA 池为模板与会话提供指纹伪装；停用记录不再参与调度</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={doExport}>
            <FileDown className="h-4 w-4 mr-1" /> 导出 JSON
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <FileUp className="h-4 w-4 mr-1" /> 导入 JSON
          </Button>
          <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" /> 新建 UA
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
          { key: "category", placeholder: "类别", options: [{ label: "DESKTOP", value: "DESKTOP" }, { label: "MOBILE", value: "MOBILE" }] },
          { key: "enabled", placeholder: "状态", options: [{ label: "启用", value: "true" }, { label: "停用", value: "false" }] },
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
              <DropdownMenuItem onClick={() => callAction(`toggle-${row.id}`, () => toggleUaAction({ id: row.id }))}>
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

      {/* 新建/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 UA" : "新建 UA"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <Label>标签名称</Label>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="如 Chrome 126 Win" />
            </div>
            <div className="space-y-1.5">
              <Label>UA 字符串</Label>
              <Textarea rows={4} value={form.ua} onChange={(e) => setForm({ ...form, ua: e.target.value })} className="font-mono text-xs" placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>类别</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DESKTOP">DESKTOP（桌面）</SelectItem>
                    <SelectItem value="MOBILE">MOBILE（移动）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>状态</Label>
                <Select value={form.enabled ? "true" : "false"} onValueChange={(v) => setForm({ ...form, enabled: v === "true" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">启用</SelectItem>
                    <SelectItem value="false">停用</SelectItem>
                  </SelectContent>
                </Select>
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

      {/* 导入弹窗 */}
      <Dialog open={importOpen} onOpenChange={(v) => !importBusy && setImportOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入 UA 池 JSON</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Textarea
              rows={10}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="font-mono text-xs"
              placeholder={'[\n  { "ua": "Mozilla/5.0 ...", "label": "Chrome 126", "category": "DESKTOP", "enabled": true }\n]'}
            />
            <p className="text-xs text-muted-foreground">支持数组或 {"{ items: [...] }"} 结构；相同 UA 自动跳过；单次上限 200 条</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={doImport} disabled={importBusy}>
              {importBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="物理删除 UA"
        description={`UA「${deleting?.label || deleting?.ua?.slice(0, 30)}」将被物理删除（不可恢复，含审计）。如需临时停用请使用“逻辑停用”。`}
        destructive
        confirmText="物理删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteUaAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
