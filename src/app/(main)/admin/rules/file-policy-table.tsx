"use client"

// ============================================================
// 文件访问限制策略管理（四层定向：全局 / 用户组 / 用户 / 单沙箱）
// 维度：下载 / 上传（文件拾取器）/ file:// 本地访问
// 执行层：Chromium 托管策略（DownloadRestrictions / AllowFileSelectionDialogs / URLBlocklist）
// ============================================================

import React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Plus, Pencil, Trash2, MoreHorizontal, FileDown, FileUp, FileSearch, ShieldCheck, Loader2 } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { saveFilePolicyAction, deleteFilePolicyAction } from "@/server/actions/rules"
import { cn } from "@/lib/utils"

export interface FilePolicyRow {
  id: string
  scopeType: string
  scopeId: string
  scopeLabel: string
  allowDownload: boolean
  allowUpload: boolean
  allowFileScheme: boolean
  note: string | null
  updatedAt: string
}

interface Props {
  rows: FilePolicyRow[]
  groupOptions: { id: string; name: string }[]
  userOptions: { id: string; name: string }[]
  workspaceOptions: { id: string; name: string }[]
}

const SOURCE_STYLE: Record<string, string> = {
  GLOBAL: "border-slate-400/50 text-slate-400",
  GROUP: "border-amber-400/50 text-amber-500",
  USER: "border-violet-400/50 text-violet-500",
  SANDBOX: "border-teal-400/50 text-teal-500",
}

export function FilePolicyTable(props: Props) {
  const router = useRouter()
  const [busy, setBusy] = React.useState("")
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<FilePolicyRow | null>(null)
  const [formBusy, setFormBusy] = React.useState(false)
  const [form, setForm] = React.useState({
    scopeType: "GLOBAL", scopeId: "",
    allowDownload: true, allowUpload: true, allowFileScheme: false,
    note: "",
  })

  const openCreate = () => {
    setEditing(null)
    setForm({ scopeType: "GLOBAL", scopeId: "", allowDownload: true, allowUpload: true, allowFileScheme: false, note: "" })
    setFormOpen(true)
  }
  const openEdit = (row: FilePolicyRow) => {
    setEditing(row)
    setForm({
      scopeType: row.scopeType, scopeId: row.scopeId,
      allowDownload: row.allowDownload, allowUpload: row.allowUpload, allowFileScheme: row.allowFileScheme,
      note: row.note || "",
    })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (form.scopeType !== "GLOBAL" && !form.scopeId) return toast.error("请选择策略目标")
    setFormBusy(true)
    try {
      const res = await saveFilePolicyAction({
        scopeType: form.scopeType,
        scopeId: form.scopeType === "GLOBAL" ? "" : form.scopeId,
        allowDownload: form.allowDownload,
        allowUpload: form.allowUpload,
        allowFileScheme: form.allowFileScheme,
        note: form.note.trim() || null,
      })
      if (res.code === 0) {
        const eff = (res.data as { effective?: { allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean; source: string } } | undefined)?.effective
        toast.success(editing ? "文件策略已更新" : "文件策略已保存", {
          description: eff ? `生效链：下载${eff.allowDownload ? "允许" : "禁止"} · 上传${eff.allowUpload ? "允许" : "禁止"} · file://${eff.allowFileScheme ? "允许" : "禁止"}（来源 ${eff.source}）` : undefined,
        })
        setFormOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setFormBusy(false)
    }
  }

  const doDelete = async (row: FilePolicyRow) => {
    if (!confirm(`确认删除「${row.scopeLabel}」的文件限制条目？删除后该作用域回退继承上层策略。`)) return
    setBusy(`del-${row.id}`)
    try {
      const res = await deleteFilePolicyAction({ id: row.id })
      if (res.code === 0) {
        toast.success("已删除，该作用域回退继承上层")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy("")
    }
  }

  const columns = [
    {
      key: "scopeType",
      title: "作用域",
      render: (row: FilePolicyRow) => (
        <Badge variant="outline" className={SOURCE_STYLE[row.scopeType] || SOURCE_STYLE.GLOBAL}>{row.scopeLabel}</Badge>
      ),
    },
    {
      key: "allowDownload",
      title: "文件下载",
      render: (row: FilePolicyRow) => (
        <span className={cn("inline-flex items-center gap-1 text-xs", row.allowDownload ? "text-emerald-600" : "text-red-600")}>
          <FileDown className="h-3.5 w-3.5" />{row.allowDownload ? "允许" : "禁止"}
        </span>
      ),
    },
    {
      key: "allowUpload",
      title: "文件上传",
      render: (row: FilePolicyRow) => (
        <span className={cn("inline-flex items-center gap-1 text-xs", row.allowUpload ? "text-emerald-600" : "text-red-600")}>
          <FileUp className="h-3.5 w-3.5" />{row.allowUpload ? "允许" : "禁止"}
        </span>
      ),
    },
    {
      key: "allowFileScheme",
      title: "file:// 访问",
      render: (row: FilePolicyRow) => (
        <span className={cn("inline-flex items-center gap-1 text-xs", row.allowFileScheme ? "text-emerald-600" : "text-red-600")}>
          <FileSearch className="h-3.5 w-3.5" />{row.allowFileScheme ? "允许" : "禁止"}
        </span>
      ),
    },
    { key: "note", title: "备注", render: (row: FilePolicyRow) => <span className="text-xs text-muted-foreground">{row.note || "-"}</span> },
    { key: "updatedAt", title: "更新时间", render: (row: FilePolicyRow) => <span className="text-xs text-muted-foreground">{row.updatedAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          四层定向（单沙箱 &gt; 用户 &gt; 用户组 &gt; 全局）；同一目标仅一条配置，未配置层自动继承
        </p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建文件限制条目
        </Button>
      </div>

      <div className="rounded-lg border">
        <div className="overflow-x-auto [touch-action:pan-x]">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">{c.title}</th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {props.rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    暂无文件限制条目 —— 全部作用域按系统默认（下载允许 / 上传允许 / file:// 禁止）
                  </td>
                </tr>
              ) : (
                props.rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 py-2.5 align-middle whitespace-nowrap">{c.render(row)}</td>
                    ))}
                    <td className="px-2 py-2 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy === `del-${row.id}`}>
                            {busy === `del-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openEdit(row)}>
                            <Pencil className="h-4 w-4 mr-2" /> 编辑
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-red-600" onClick={() => doDelete(row)}>
                            <Trash2 className="h-4 w-4 mr-2" /> 删除（回退继承）
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑文件限制条目" : "新建文件限制条目"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>作用域</Label>
                <Select value={form.scopeType} onValueChange={(v) => setForm({ ...form, scopeType: v, scopeId: "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GLOBAL">全局默认（全部会话）</SelectItem>
                    <SelectItem value="GROUP">用户组（仅组成员）</SelectItem>
                    <SelectItem value="USER">指定用户</SelectItem>
                    <SelectItem value="SANDBOX">单沙箱（仅该沙箱）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>目标{form.scopeType === "GLOBAL" ? "（全局无需选择）" : ""}</Label>
                {form.scopeType === "GROUP" ? (
                  <Select value={form.scopeId} onValueChange={(v) => setForm({ ...form, scopeId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择用户组" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.groupOptions.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : form.scopeType === "USER" ? (
                  <Select value={form.scopeId} onValueChange={(v) => setForm({ ...form, scopeId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.userOptions.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : form.scopeType === "SANDBOX" ? (
                  <Select value={form.scopeId} onValueChange={(v) => setForm({ ...form, scopeId: v })}>
                    <SelectTrigger><SelectValue placeholder="选择 NoVNC 沙箱" /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {props.workspaceOptions.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value="（全局默认）" disabled />
                )}
              </div>
            </div>

            <div className="rounded-md border divide-y">
              <div className="flex items-center justify-between p-3">
                <div className="min-w-0 pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5"><FileDown className="h-4 w-4 text-muted-foreground" />允许文件下载</p>
                  <p className="text-xs text-muted-foreground mt-0.5">关闭后 Chromium DownloadRestrictions=2 全禁下载</p>
                </div>
                <Switch checked={form.allowDownload} onCheckedChange={(v) => setForm({ ...form, allowDownload: v })} />
              </div>
              <div className="flex items-center justify-between p-3">
                <div className="min-w-0 pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5"><FileUp className="h-4 w-4 text-muted-foreground" />允许文件上传</p>
                  <p className="text-xs text-muted-foreground mt-0.5">关闭后文件拾取器封禁（AllowFileSelectionDialogs=false）</p>
                </div>
                <Switch checked={form.allowUpload} onCheckedChange={(v) => setForm({ ...form, allowUpload: v })} />
              </div>
              <div className="flex items-center justify-between p-3">
                <div className="min-w-0 pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5"><FileSearch className="h-4 w-4 text-muted-foreground" />允许 file:// 本地访问</p>
                  <p className="text-xs text-muted-foreground mt-0.5">默认禁止（沙箱内本地文件不可被浏览）</p>
                </div>
                <Switch checked={form.allowFileScheme} onCheckedChange={(v) => setForm({ ...form, allowFileScheme: v })} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>备注（可选）</Label>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="如：外访账号统一禁上传" />
            </div>

            <div className="rounded-md bg-muted/50 p-3 flex gap-2.5">
              <ShieldCheck className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                层级覆盖语义：单沙箱 &gt; 用户 &gt; 用户组（沿继承链）&gt; 全局条目 &gt; 系统默认。
                对运行中沙箱变更后，可在工作区列表「策略刷新」或策略下发中心对该沙箱下发并即时生效（浏览器进程 1 秒内自动重启）。
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={submitForm} disabled={formBusy}>
              {formBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {editing ? "保存修改" : "创建条目"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
