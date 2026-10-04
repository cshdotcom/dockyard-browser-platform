"use client"

// 浏览器节点交互表格：CRUD / 探测 / 灰度分组切换 / 启停

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, MoreHorizontal, Pencil, Plus, Activity, Trash2, ArrowRightLeft } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
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
import {
  createBrowserNodeAction, updateBrowserNodeAction, deleteBrowserNodeAction, probeBrowserNodeAction, setBrowserNodeGrayGroupAction,
} from "@/server/actions/network"
import { isPrivateAddress } from "@/lib/env"

export interface BrowserNodeRow {
  id: string
  name: string
  baseUrl: string
  publicUrl?: string | null
  labels: string[]
  weight: number
  status: string
  grayGroup: string
  activeSessions: number
  loadScore: number
  probeFailCount: number
  enabled: boolean
  createdAt: string
}

interface Props {
  rows: BrowserNodeRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function BrowserNodesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, sortField, sortOrder, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [sel, setSel] = React.useState<string[]>([])
  React.useEffect(() => setSel([]), [rows])
  const [busy, setBusy] = React.useState("")
  const [deleting, setDeleting] = React.useState<BrowserNodeRow | null>(null)

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
  const [editing, setEditing] = React.useState<BrowserNodeRow | null>(null)
  const [form, setForm] = React.useState({ name: "", baseUrl: "", publicUrl: "", labels: "", weight: 1, grayGroup: "PROD", enabled: true })
  const [formBusy, setFormBusy] = React.useState(false)
  // r28：环境推荐公网地址（NODE_PUBLIC_URL > PUBLIC_BASE_URL）；空 = 未配置域名
  const [envPublicHint] = React.useState(() => {
    try {
      // 页面服务端注入（data-public-hint）—— env 不能进客户端包
      const el = document.getElementById("__nodePublicHint")
      return el?.textContent || ""
    } catch { return "" }
  })

  const openCreate = () => {
    setEditing(null)
    setForm({ name: "", baseUrl: "http://", publicUrl: envPublicHint, labels: "", weight: 1, grayGroup: "PROD", enabled: true })
    setFormOpen(true)
  }
  const openEdit = (row: BrowserNodeRow) => {
    setEditing(row)
    setForm({ name: row.name, baseUrl: row.baseUrl, publicUrl: row.publicUrl || "", labels: row.labels.join(", "), weight: row.weight, grayGroup: row.grayGroup, enabled: row.enabled })
    setFormOpen(true)
  }

  const submitForm = async () => {
    if (!form.name.trim()) return toast.error("请填写名称")
    if (!form.baseUrl.trim()) return toast.error("请填写 baseUrl")
    setFormBusy(true)
    try {
      const payload = {
        id: editing?.id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        publicUrl: form.publicUrl.trim(),
        labels: form.labels.split(/[,，\s]+/).filter(Boolean),
        weight: form.weight,
        grayGroup: form.grayGroup,
        enabled: form.enabled,
      }
      const res = editing ? await updateBrowserNodeAction(payload) : await createBrowserNodeAction(payload)
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

  const probe = (row: BrowserNodeRow) => {
    callAction(`probe-${row.id}`, async () => {
      const res = await probeBrowserNodeAction({ id: row.id })
      if (res.code === 0 && res.data) {
        const d = res.data as { ok: boolean; status: string; loadScore: number; activeSessions: number; probeFailCount: number }
        if (d.ok) {
          toast.success(`探测成功：${d.activeSessions} 个活跃会话，负载 ${(d.loadScore * 100).toFixed(1)}%`)
        } else {
          toast.error(`探测失败：连续 ${d.probeFailCount} 次失败，状态 ${d.status}${d.status === "ISOLATED" ? "（已隔离）" : ""}`)
        }
        router.refresh()
        return { code: 0, msg: "ok" }
      }
      return res
    })
  }

  const switchGray = (row: BrowserNodeRow) => {
    const target = row.grayGroup === "PROD" ? "TEST" : "PROD"
    callAction(`gray-${row.id}`, () => setBrowserNodeGrayGroupAction({ id: row.id, grayGroup: target }))
  }

  const columns = [
    {
      key: "name",
      title: "名称",
      sortable: true,
      render: (row: BrowserNodeRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">{row.publicUrl || row.baseUrl}</p>
          {/* r28：公网地址优先展示；未配公网且 baseUrl 为私网时标注 */}
          {!row.publicUrl && isPrivateAddress(row.baseUrl) && (
            <Badge variant="outline" className="text-[9px] px-1 mt-0.5 text-amber-600 border-amber-300">内网地址</Badge>
          )}
        </div>
      ),
    },
    {
      key: "labels",
      title: "标签",
      render: (row: BrowserNodeRow) =>
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
    { key: "weight", title: "权重", sortable: true, render: (row: BrowserNodeRow) => <span className="tabular-nums">{row.weight}</span> },
    { key: "status", title: "状态", render: (row: BrowserNodeRow) => <StatusBadge status={row.status} /> },
    {
      key: "grayGroup",
      title: "灰度组",
      render: (row: BrowserNodeRow) => (
        <Badge variant={row.grayGroup === "PROD" ? "default" : "secondary"} className={row.grayGroup === "PROD" ? "bg-teal-600 hover:bg-teal-600" : ""}>
          {row.grayGroup}
        </Badge>
      ),
    },
    { key: "activeSessions", title: "活跃会话", sortable: true, render: (row: BrowserNodeRow) => <span className="tabular-nums">{row.activeSessions}</span> },
    {
      key: "loadScore",
      title: "负载分数",
      sortable: true,
      render: (row: BrowserNodeRow) => (
        <div className="min-w-28">
          <p className="text-xs tabular-nums mb-1">{(row.loadScore * 100).toFixed(1)}%</p>
          <Progress value={row.loadScore * 100} className="h-1.5" />
        </div>
      ),
    },
    {
      key: "probeFailCount",
      title: "连续失败",
      sortable: true,
      render: (row: BrowserNodeRow) => (
        <span className={`tabular-nums ${row.probeFailCount > 0 ? "text-red-600 font-medium" : ""}`}>{row.probeFailCount}</span>
      ),
    },
    {
      key: "enabled",
      title: "启用",
      render: (row: BrowserNodeRow) => (
        <Badge variant={row.enabled ? "default" : "outline"} className={row.enabled ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
          {row.enabled ? "启用" : "停用"}
        </Badge>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: BrowserNodeRow) => <span className="text-xs text-muted-foreground">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">自研浏览器执行集群：负载分数用于最小负载调度，灰度组支持 PROD/TEST 平滑发布</p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> 新建浏览器节点
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
          { key: "status", placeholder: "状态", options: [{ label: "ONLINE", value: "ONLINE" }, { label: "OFFLINE", value: "OFFLINE" }, { label: "ISOLATED", value: "ISOLATED" }] },
          { key: "grayGroup", placeholder: "灰度组", options: [{ label: "PROD", value: "PROD" }, { label: "TEST", value: "TEST" }] },
        ]}
        rowActions={(row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy === `probe-${row.id}`}>
                {busy === `probe-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => openEdit(row)}>
                <Pencil className="h-4 w-4 mr-2" /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => probe(row)}>
                <Activity className="h-4 w-4 mr-2" /> 探测
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => switchGray(row)}>
                <ArrowRightLeft className="h-4 w-4 mr-2" /> 切至 {row.grayGroup === "PROD" ? "TEST" : "PROD"} 组
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600" onClick={() => setDeleting(row)}>
                <Trash2 className="h-4 w-4 mr-2" /> 删除（回收站）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        onQueryChange={pushQuery}
      />

      <Dialog open={formOpen} onOpenChange={(v) => !formBusy && setFormOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑浏览器节点" : "新建浏览器节点"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 browser-node-hk-01" />
            </div>
            <div className="space-y-1.5">
              <Label>baseUrl（拨号地址）</Label>
              <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://browser-node:3000" />
              {/* r28：私网地址提示 —— 平台可拨号但外部不可直连（用户反馈“显示 localhost 困惑”） */}
              {isPrivateAddress(form.baseUrl) && (
                <p className="text-[11px] text-amber-600 flex items-start gap-1">
                  ⚠ 内网/环回地址：平台拨号可用，外部工具无法直连；对外展示请填写下方「公网地址」
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>公网地址（展示用，可选）</Label>
              <Input value={form.publicUrl} onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://browser.example.com" />
              <p className="text-[11px] text-muted-foreground">
                连接信息/对外展示优先使用该地址{envPublicHint ? `（已从环境变量推荐 ${envPublicHint}）` : "（未配置 NODE_PUBLIC_URL / PUBLIC_BASE_URL 环境变量，可手动填写）"}；
                实际拨号始终走 baseUrl
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>标签（逗号分隔）</Label>
              <Textarea rows={2} value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="A机房, 高配" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>权重</Label>
                <PrecisionInput value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} min={0.001} max={100000} />
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
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用节点</p>
                <p className="text-xs text-muted-foreground">停用后不再调度新会话</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
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

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !busy && setDeleting(v ? deleting : null)}
        title="删除浏览器节点"
        description={`节点「${deleting?.name}」将软删除并移入回收站；运行中工作区会先被检查。`}
        destructive
        confirmText="移入回收站"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (!deleting) return
          await callAction("delete", () => deleteBrowserNodeAction({ id: deleting.id }))
        }}
      />
    </div>
  )
}
