"use client"

// 宿主机交互表格：CRUD / 采集资源（水位探测） / 超阈值行红高亮

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pencil, Plus, Gauge, Trash2, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react"
import { StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { createHostNodeAction, updateHostNodeAction, deleteHostNodeAction, probeHostNodeAction } from "@/server/actions/network"

export interface HostNodeRow {
  id: string
  name: string
  dockerApiUrl: string
  labels: string[]
  cpuCores: number
  memTotalMb: number
  cpuUsedPct: number
  memUsedMb: number
  diskUsedPct: number
  reservedCpu: number
  reservedMemMb: number
  grayGroup: string
  status: string
  enabled: boolean
  createdAt: string
}

interface Props {
  rows: HostNodeRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

export function HostNodesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<HostNodeRow | null>(null)

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
  const [editing, setEditing] = React.useState<HostNodeRow | null>(null)
  const [form, setForm] = React.useState({
    name: "", dockerApiUrl: "", labels: "", cpuCores: 8, memTotalMb: 16384, reservedCpu: 0, reservedMemMb: 0, grayGroup: "PROD", enabled: true,
  })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ name: "", dockerApiUrl: "http://", labels: "", cpuCores: 8, memTotalMb: 16384, reservedCpu: 0, reservedMemMb: 0, grayGroup: "PROD", enabled: true })
    setFormOpen(true)
  }
  const openEdit = (row: HostNodeRow) => {
    setEditing(row)
    setForm({
      name: row.name, dockerApiUrl: row.dockerApiUrl, labels: row.labels.join(", "),
      cpuCores: row.cpuCores, memTotalMb: row.memTotalMb, reservedCpu: row.reservedCpu, reservedMemMb: row.reservedMemMb,
      grayGroup: row.grayGroup, enabled: row.enabled,
    })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.name.trim()) return toast.error("请填写名称")
    if (!form.dockerApiUrl.trim()) return toast.error("请填写 Docker API 地址")
    if (form.memTotalMb <= 0) return toast.error("内存必须大于 0")
    if (form.reservedCpu > form.cpuCores) return toast.error("预留 CPU 不能超过总核数")
    if (form.reservedMemMb > form.memTotalMb) return toast.error("预留内存不能超过总内存")
    setFormBusy(true)
    try {
      const payload = {
        id: editing?.id,
        name: form.name.trim(),
        dockerApiUrl: form.dockerApiUrl.trim(),
        labels: form.labels.split(/[,，\s]+/).filter(Boolean),
        cpuCores: form.cpuCores,
        memTotalMb: form.memTotalMb,
        reservedCpu: form.reservedCpu,
        reservedMemMb: form.reservedMemMb,
        grayGroup: form.grayGroup,
        enabled: form.enabled,
      }
      const res = editing ? await updateHostNodeAction(payload) : await createHostNodeAction(payload)
      if (res.code === 0) {
        toast.success(editing ? "宿主机已更新" : "宿主机已创建")
        setFormOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setFormBusy(false)
    }
  }

  const collect = (row: HostNodeRow) => {
    callAction(`probe-${row.id}`, async () => {
      const res = await probeHostNodeAction({ id: row.id })
      if (res.code === 0 && res.data) {
        const d = res.data as { simulated: boolean; cpuCores: number; memTotalMb: number; cpuUsedPct: number; memUsedMb: number; diskUsedPct: number; alert?: string }
        toast.success(
          `采集完成${d.simulated ? "（模拟水位）" : ""}：CPU ${d.cpuCores} 核 / ${d.cpuUsedPct.toFixed(1)}%，内存 ${fmtMem(d.memUsedMb)}/${fmtMem(d.memTotalMb)}，磁盘 ${d.diskUsedPct.toFixed(1)}%${d.alert ? ` ⚠ ${d.alert}` : ""}`
        )
        router.refresh()
        return { code: 0, msg: "ok" }
      }
      return res
    })
  }

  const overWater = (row: HostNodeRow) => row.cpuUsedPct > 80 || row.diskUsedPct > 85

  const columns = [
    {
      key: "name",
      title: "名称",
      sortable: true,
      render: (row: HostNodeRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{row.dockerApiUrl}</p>
        </div>
      ),
    },
    {
      key: "labels",
      title: "标签",
      render: (row: HostNodeRow) =>
        row.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.labels.slice(0, 3).map((l) => (
              <Badge key={l} variant="outline" className="text-[10px] px-1.5">{l}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    { key: "cpuCores", title: "CPU 核数", sortable: true, render: (row: HostNodeRow) => <span className="tabular-nums">{row.cpuCores}</span> },
    { key: "memTotalMb", title: "内存", render: (row: HostNodeRow) => <span className="text-xs tabular-nums">{fmtMem(row.memTotalMb)}</span> },
    {
      key: "cpuUsedPct",
      title: "CPU 使用率",
      sortable: true,
      render: (row: HostNodeRow) => (
        <div className="min-w-28">
          <p className="text-xs tabular-nums mb-1">{row.cpuUsedPct.toFixed(1)}%</p>
          <Progress value={row.cpuUsedPct} className="h-1.5" />
        </div>
      ),
    },
    {
      key: "memUsedMb",
      title: "内存使用",
      render: (row: HostNodeRow) => (
        <div className="min-w-28">
          <p className="text-xs tabular-nums mb-1">
            {fmtMem(row.memUsedMb)} / {fmtMem(row.memTotalMb)}
          </p>
          <Progress value={row.memTotalMb > 0 ? (row.memUsedMb / row.memTotalMb) * 100 : 0} className="h-1.5" />
        </div>
      ),
    },
    {
      key: "diskUsedPct",
      title: "磁盘使用",
      sortable: true,
      render: (row: HostNodeRow) => (
        <div className="min-w-28">
          <p className={`text-xs tabular-nums mb-1 ${row.diskUsedPct > 85 ? "text-red-600 font-medium" : ""}`}>{row.diskUsedPct.toFixed(1)}%</p>
          <Progress value={row.diskUsedPct} className="h-1.5" />
        </div>
      ),
    },
    {
      key: "reservedCpu",
      title: "预留资源",
      render: (row: HostNodeRow) => (
        <span className="text-xs tabular-nums">
          {row.reservedCpu} 核 / {fmtMem(row.reservedMemMb)}
        </span>
      ),
    },
    {
      key: "grayGroup",
      title: "灰度组",
      render: (row: HostNodeRow) => (
        <Badge variant={row.grayGroup === "PROD" ? "default" : "secondary"} className={row.grayGroup === "PROD" ? "bg-teal-600 hover:bg-teal-600" : ""}>
          {row.grayGroup}
        </Badge>
      ),
    },
    { key: "status", title: "状态", render: (row: HostNodeRow) => <StatusBadge status={row.status} /> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Docker 宿主机池：SingBox 实例按预留资源调度部署；CPU&gt;80% 或磁盘&gt;85% 行将红色高亮并触发告警</p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建宿主机
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="宿主机列表">
            <thead>
              <tr className="border-b bg-muted/50">
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2.5 text-left font-medium text-xs text-muted-foreground whitespace-nowrap">
                    {c.sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() =>
                          pushQuery(
                            sortField === c.key
                              ? { sortOrder: sortOrder === "asc" ? "desc" : "asc" }
                              : { sortField: c.key, sortOrder: "asc" }
                          )
                        }
                      >
                        {typeof c.title === "string" ? c.title : c.key}
                        {sortField === c.key ? (
                          sortOrder === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </button>
                    ) : (
                      <span>{typeof c.title === "string" ? c.title : c.key}</span>
                    )}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right font-medium text-xs text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="h-24 text-center text-muted-foreground">暂无宿主机</td>
                </tr>
              )}
              {rows.map((row) => (
                <TableRow key={row.id} className={cn("hover:bg-muted/30", overWater(row) && "bg-red-50 dark:bg-red-950/20")}>
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2.5 align-middle">
                      {c.render ? c.render(row) : ((row as unknown as Record<string, React.ReactNode>)[c.key]) ?? "-"}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy === `probe-${row.id}`}>
                          {busy === `probe-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => openEdit(row)}>
                          <Pencil className="h-4 w-4 mr-2" /> 编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => collect(row)}>
                          <Gauge className="h-4 w-4 mr-2" /> 采集资源
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                          <Trash2 className="h-4 w-4 mr-2" /> 删除（回收站）
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </TableRow>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const input = (e.currentTarget.elements.namedItem("kw") as HTMLInputElement)
              pushQuery({ page: "1", keyword: input.value })
            }}
          >
            <Input name="kw" defaultValue={keyword || ""} placeholder="搜索名称 / Docker API" className="w-56" />
            <Button type="submit" variant="secondary" size="sm">搜索</Button>
          </form>
          <Select value={undefined} onValueChange={(v) => pushQuery({ page: "1", grayGroup: v === "__all__" ? undefined : v })}>
            <SelectTrigger className="w-32 h-9"><SelectValue placeholder="灰度组" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部</SelectItem>
              <SelectItem value="PROD">PROD</SelectItem>
              <SelectItem value="TEST">TEST</SelectItem>
            </SelectContent>
          </Select>
          <Select value={undefined} onValueChange={(v) => pushQuery({ page: "1", status: v === "__all__" ? undefined : v })}>
            <SelectTrigger className="w-32 h-9"><SelectValue placeholder="状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部</SelectItem>
              <SelectItem value="ONLINE">ONLINE</SelectItem>
              <SelectItem value="OFFLINE">OFFLINE</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              共 <span className="font-medium text-foreground">{total}</span> 条 · 第 {page}/{Math.max(1, Math.ceil(total / pageSize))} 页
            </span>
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => pushQuery({ page: String(page - 1) })}>
              上一页
            </Button>
            <Button variant="outline" size="sm" disabled={page >= Math.ceil(total / pageSize)} onClick={() => pushQuery({ page: String(page + 1) })}>
              下一页
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑宿主机" : "新建宿主机"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 docker-host-01" />
              </div>
              <div className="space-y-1.5">
                <Label>灰度组</Label>
                <Select value={form.grayGroup} onValueChange={(v) => setForm({ ...form, grayGroup: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROD">PROD（生产）</SelectItem>
                    <SelectItem value="TEST">TEST（灰度）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Docker API 地址</Label>
              <Input value={form.dockerApiUrl} onChange={(e) => setForm({ ...form, dockerApiUrl: e.target.value })} placeholder="http://docker-proxy:2375" />
            </div>
            <div className="space-y-1.5">
              <Label>标签（逗号分隔）</Label>
              <Textarea rows={2} value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="机房A, 40G带宽" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>CPU 核数</Label>
                <PrecisionInput value={form.cpuCores} onChange={(v) => setForm({ ...form, cpuCores: v })} min={0.001} max={1024} suffix="核" />
              </div>
              <div className="space-y-1.5">
                <Label>总内存</Label>
                <PrecisionInput value={form.memTotalMb} onChange={(v) => setForm({ ...form, memTotalMb: v })} min={1} max={8388608} suffix="MB" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>预留 CPU</Label>
                <PrecisionInput value={form.reservedCpu} onChange={(v) => setForm({ ...form, reservedCpu: v })} min={0} max={1024} suffix="核" />
              </div>
              <div className="space-y-1.5">
                <Label>预留内存</Label>
                <PrecisionInput value={form.reservedMemMb} onChange={(v) => setForm({ ...form, reservedMemMb: v })} min={0} max={8388608} suffix="MB" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用宿主机</p>
                <p className="text-xs text-muted-foreground">停用后不再部署新实例</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={submitForm} disabled={formBusy}>
              {formBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {editing ? "保存修改" : "创建宿主机"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="删除宿主机"
        description={`宿主机「${deleting?.name}」将软删除并移入回收站；若仍有运行中 SingBox 实例将被阻止。`}
        destructive
        confirmText="移入回收站"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteHostNodeAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
