"use client"

// 代理节点交互表格：CRUD / 健康探测 / 批量启停 / internal_singbox 引导提示

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pencil, Plus, Activity, Trash2, ArrowUpCircle, ArrowDownCircle, Boxes } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import {
  createProxyNodeAction, updateProxyNodeAction, deleteProxyNodeAction, probeProxyNodeAction, batchProxyStatusAction,
} from "@/server/actions/network"

export interface ProxyNodeRow {
  id: string
  name: string
  type: string
  protocol: string
  host: string | null
  port: number | null
  username: string | null
  status: string
  latencyMs: number
  labels: string[]
  weight: number
  currentSessions: number
  maxSessions: number
  scheduleStrategy: string
  healthFailCount: number
  singboxInstanceId: string | null
  singboxName: string | null
  singboxStatus: string | null
  createdAt: string
}

interface Props {
  rows: ProxyNodeRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

const STRATEGY_LABEL: Record<string, string> = {
  WEIGHT: "加权",
  ROUND_ROBIN: "轮询",
  LEAST_LOAD: "最小负载",
  AFFINITY: "会话亲和",
}

export function ProxyNodesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [sel, setSel] = React.useState<string[]>([])
  React.useEffect(() => setSel([]), [rows])
  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<ProxyNodeRow | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string; data?: unknown }>) => {
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

  // ---- 表单弹窗 ----
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ProxyNodeRow | null>(null)
  const [form, setForm] = React.useState({
    name: "", protocol: "socks5", host: "", port: 1080, username: "", password: "",
    labels: "", weight: 1, maxSessions: 0, scheduleStrategy: "LEAST_LOAD",
  })
  const [formBusy, setFormBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setForm({ name: "", protocol: "socks5", host: "", port: 1080, username: "", password: "", labels: "", weight: 1, maxSessions: 0, scheduleStrategy: "LEAST_LOAD" })
    setFormOpen(true)
  }
  const openEdit = (row: ProxyNodeRow) => {
    if (row.type !== "external") {
      toast.info("internal_singbox 类型节点由 SingBox 实例统一编排，请前往 SingBox 实例管理页签进行配置变更")
      return
    }
    setEditing(row)
    setForm({
      name: row.name,
      protocol: row.protocol,
      host: row.host || "",
      port: row.port || 1080,
      username: row.username || "",
      password: "",
      labels: row.labels.join(", "),
      weight: row.weight,
      maxSessions: row.maxSessions,
      scheduleStrategy: row.scheduleStrategy,
    })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.name.trim()) return toast.error("请填写名称")
    if (!form.host.trim()) return toast.error("请填写地址")
    if (!form.port || form.port < 1 || form.port > 65535) return toast.error("端口范围 1-65535")
    setFormBusy(true)
    try {
      const payload = {
        id: editing?.id,
        name: form.name.trim(),
        protocol: form.protocol,
        host: form.host.trim(),
        port: form.port,
        username: form.username.trim() || null,
        password: form.password || null,
        labels: form.labels.split(/[,，\s]+/).filter(Boolean),
        weight: form.weight,
        maxSessions: Math.round(form.maxSessions),
        scheduleStrategy: form.scheduleStrategy,
      }
      const res = editing ? await updateProxyNodeAction(payload) : await createProxyNodeAction(payload)
      if (res.code === 0) {
        toast.success(editing ? "节点已更新" : "节点已创建")
        setFormOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setFormBusy(false)
    }
  }

  const probe = (row: ProxyNodeRow) => {
    callAction(`probe-${row.id}`, async () => {
      const res = await probeProxyNodeAction({ id: row.id })
      if (res.code === 0 && res.data) {
        const d = res.data as { ok: boolean; latencyMs: number; status: string; exitIp?: string; detail?: string }
        if (d.ok) {
          toast.success(`探测成功：${d.latencyMs.toFixed(3)} ms（出口 IP ${d.exitIp || "-"}）→ ${d.status}`)
        } else {
          toast.error(`探测失败：${d.detail || "连接失败"} → 状态 ${d.status}`)
        }
        router.refresh()
        return { code: 0, msg: "ok" }
      }
      return res
    })
  }

  const batchStatus = (enable: boolean) => {
    callAction("batch", () => batchProxyStatusAction({ ids: sel, enable })).then((res) => {
      if (res && res.code === 0 && res.data) {
        const d = res.data as { successCount: number; failCount: number }
        toast.success(`批量${enable ? "启用" : "停用"}完成：成功 ${d.successCount} / 失败 ${d.failCount}`)
        setSel([])
      }
    })
  }

  const columns = [
    {
      key: "name",
      title: "名称",
      sortable: true,
      render: (row: ProxyNodeRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          {row.type === "internal_singbox" && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Boxes className="h-3 w-3" />
              {row.singboxName || "未关联实例"}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "type",
      title: "类型",
      render: (row: ProxyNodeRow) =>
        row.type === "internal_singbox" ? (
          <Badge className="bg-purple-600 hover:bg-purple-600">internal_singbox</Badge>
        ) : (
          <Badge variant="secondary">external</Badge>
        ),
    },
    {
      key: "protocol",
      title: "协议",
      render: (row: ProxyNodeRow) => <span className="uppercase text-xs font-mono">{row.protocol}</span>,
    },
    {
      key: "host",
      title: "地址",
      render: (row: ProxyNodeRow) => (
        <span className="text-xs font-mono">
          {row.type === "internal_singbox" ? "由实例提供" : `${row.host || "-"}:${row.port || "-"}`}
        </span>
      ),
    },
    { key: "status", title: "状态", render: (row: ProxyNodeRow) => <StatusBadge status={row.status} /> },
    {
      key: "latencyMs",
      title: "延迟",
      sortable: true,
      render: (row: ProxyNodeRow) => (
        <span className="text-xs tabular-nums">
          {row.latencyMs > 0 ? `${row.latencyMs.toFixed(3)} ms` : "-"}
          {row.healthFailCount > 0 && <span className="ml-1 text-red-500">×{row.healthFailCount}</span>}
        </span>
      ),
    },
    {
      key: "labels",
      title: "标签",
      render: (row: ProxyNodeRow) =>
        row.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.labels.slice(0, 3).map((l) => (
              <Badge key={l} variant="outline" className="text-[10px] px-1.5">{l}</Badge>
            ))}
            {row.labels.length > 3 && <span className="text-xs text-muted-foreground">+{row.labels.length - 3}</span>}
          </div>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    { key: "weight", title: "权重", sortable: true, render: (row: ProxyNodeRow) => <span className="tabular-nums">{row.weight}</span> },
    {
      key: "currentSessions",
      title: "会话",
      sortable: true,
      render: (row: ProxyNodeRow) => (
        <div className="min-w-24">
          <p className="text-xs tabular-nums">
            {row.currentSessions} / {row.maxSessions === 0 ? "∞" : row.maxSessions}
          </p>
          {row.maxSessions > 0 && (
            <Progress value={(row.currentSessions / row.maxSessions) * 100} className="h-1 mt-1" />
          )}
        </div>
      ),
    },
    {
      key: "scheduleStrategy",
      title: "调度策略",
      render: (row: ProxyNodeRow) => (
        <Badge variant="outline" className="text-xs">{STRATEGY_LABEL[row.scheduleStrategy] || row.scheduleStrategy}</Badge>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: ProxyNodeRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">出口代理池：external 节点在此维护；internal_singbox 节点由 SingBox 实例编排自动注册</p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建代理节点
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
          { key: "type", placeholder: "类型", options: [{ label: "external", value: "external" }, { label: "internal_singbox", value: "internal_singbox" }] },
          { key: "status", placeholder: "状态", options: [{ label: "HEALTHY", value: "HEALTHY" }, { label: "DEGRADED", value: "DEGRADED" }, { label: "FAILED", value: "FAILED" }, { label: "DISABLED", value: "DISABLED" }] },
          { key: "strategy", placeholder: "调度策略", options: Object.entries(STRATEGY_LABEL).map(([v, l]) => ({ label: l, value: v })) },
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy === `probe-${row.id}`}>
                {busy === `probe-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => openEdit(row)}>
                <Pencil className="h-4 w-4 mr-2" />
                {row.type === "external" ? "编辑" : "编辑（受限）"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => probe(row)}>
                <Activity className="h-4 w-4 mr-2" /> 健康探测
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                <Trash2 className="h-4 w-4 mr-2" /> 删除（回收站）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
        selectedIds={sel}
        onSelectedChange={setSel}
        batchToolbar={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">已选 {sel.length} 项</span>
            <Button size="sm" variant="outline" disabled={busy === "batch"} onClick={() => batchStatus(true)}>
              {busy === "batch" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ArrowUpCircle className="h-4 w-4 mr-1" />}
              批量启用
            </Button>
            <Button size="sm" variant="outline" disabled={busy === "batch"} onClick={() => batchStatus(false)}>
              <ArrowDownCircle className="h-4 w-4 mr-1" /> 批量停用
            </Button>
          </div>
        }
      />

      {/* 新建/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑代理节点" : "新建代理节点（external）"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>名称</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 hk-exit-01" />
              </div>
              <div className="space-y-1.5">
                <Label>协议</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>地址 Host</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="proxy.example.com" />
              </div>
              <div className="space-y-1.5">
                <Label>端口 Port</Label>
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} min={1} max={65535} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>用户名（可选）</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label>密码（可选）</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editing ? "留空保持不变" : ""} autoComplete="new-password" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>标签（逗号分隔）</Label>
              <Textarea rows={2} value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="香港, 低延迟, 专线" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>权重</Label>
                <PrecisionInput value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} min={0.001} max={100000} suffix="" />
              </div>
              <div className="space-y-1.5">
                <Label>最大会话</Label>
                <PrecisionInput value={form.maxSessions} onChange={(v) => setForm({ ...form, maxSessions: v })} min={0} max={100000} suffix="个" />
                <p className="text-[10px] text-muted-foreground">0 = 不限</p>
              </div>
              <div className="space-y-1.5">
                <Label>调度策略</Label>
                <Select value={form.scheduleStrategy} onValueChange={(v) => setForm({ ...form, scheduleStrategy: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(STRATEGY_LABEL).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={submitForm} disabled={formBusy}>
              {formBusy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {editing ? "保存修改" : "创建节点"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="删除代理节点"
        description={`节点「${deleting?.name}」将软删除并移入回收站（保留恢复窗口），期间不可被调度。`}
        destructive
        confirmText="移入回收站"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteProxyNodeAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
