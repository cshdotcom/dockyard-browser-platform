"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Server, Plus, Loader2, Play, Square, Trash2, Copy, FlaskConical, FileJson, HardDrive, RefreshCw, History, Upload, Boxes, Activity } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { DataTable, StatusBadge, type Column } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput, StatCard } from "@/components/shared/confirm"
import {
  createSingboxAction, updateSingboxConfigAction, stopSingboxAction, startSingboxAction,
  destroySingboxAction, testSingboxConnectivityAction, getInstanceRuntimeAction,
  rollbackSingboxConfigAction, batchSingboxAction, copySingboxAction, exportSingboxConfigAction, importSingboxAction,
} from "@/server/actions/singbox"
import { cn } from "@/lib/utils"

export interface SingboxRow {
  id: string; name: string; remark: string; tags: string[]; status: string
  cpuLimit: number; memLimitMb: number; maxSessions: number; currentSessions: number
  hostNodeId: string | null; socksAddr: string | null; configVersion: number; autoRestart: boolean
  trafficLimitMb: number; bytesUpMb: number; bytesDownMb: number; peakTrafficMb: number
  overLimitAction: string; containerId: string | null; lastError: string | null
  ownerUserId: string | null; createdByUserId: string | null; createdAt: string
}

interface HostRow { id: string; name: string; status: string; cpuAvailable: number; memAvailableMb: number }

interface Props {
  instances: SingboxRow[]
  total: number; page: number; pageSize: number
  keyword?: string; sortField?: string; sortOrder?: "asc" | "desc"
  hosts: HostRow[]
  runningCount: number; abnormalCount: number; proxyCount: number
}

export function SingboxManager(props: Props) {
  const router = useRouter()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [detail, setDetail] = React.useState<SingboxRow | null>(null)
  const [confirmDestroy, setConfirmDestroy] = React.useState<SingboxRow | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [batchResult, setBatchResult] = React.useState<{ ok: number; fail: number; failures: { name: string; reason: string }[] } | null>(null)

  const query = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams()
    const current: Record<string, string | undefined> = {
      page: String(props.page), pageSize: String(props.pageSize), keyword: props.keyword,
      sortField: props.sortField, sortOrder: props.sortOrder,
    }
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) params.set(k, v)
    router.push(`/admin/singbox?${params.toString()}`)
  }

  const stop = async (row: SingboxRow) => {
    setBusyId(row.id)
    try {
      const res = await stopSingboxAction({ id: row.id })
      if (res.code === 0) { toast.success("实例已停止，关联代理节点已置故障"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const start = async (row: SingboxRow) => {
    setBusyId(row.id)
    try {
      const res = await startSingboxAction({ id: row.id })
      if (res.code === 0) { toast.success("实例已启动"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const destroy = async (row: SingboxRow) => {
    setBusyId(row.id)
    try {
      const res = await destroySingboxAction({ id: row.id, toRecycle: true })
      if (res.code === 0) { toast.success("实例已销毁并移入回收站"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const copy = async (row: SingboxRow) => {
    const name = window.prompt("新实例名称", `${row.name}-copy`)
    if (!name) return
    setBusyId(row.id)
    try {
      const res = await copySingboxAction({ id: row.id, newName: name })
      if (res.code === 0) { toast.success("实例复制完成"); router.refresh() } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }
  const test = async (row: SingboxRow) => {
    setBusyId(row.id)
    try {
      const res = await testSingboxConnectivityAction({ id: row.id })
      if (res.code === 0 && res.data) {
        toast[res.data.ok ? "success" : "error"](
          `${res.data.ok ? "连通正常" : "连通失败"} · 延迟 ${res.data.latencyMs}ms${res.data.exitIp ? ` · 出口IP ${res.data.exitIp}` : ""} · UDP ${res.data.udpOk ? "正常" : "异常"} · DNS泄漏 ${res.data.dnsLeak ? "检测到" : "无"}`,
          { duration: 8000 }
        )
      } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }

  const columns: Column<SingboxRow>[] = [
    {
      key: "name", title: "实例", sortable: true,
      render: (r) => (
        <div>
          <button className="text-sm font-medium text-teal-700 dark:text-teal-300 hover:underline" onClick={() => setDetail(r)}>
            {r.name}
          </button>
          {r.remark && <p className="text-[10px] text-muted-foreground truncate max-w-40">{r.remark}</p>}
          {r.tags.length > 0 && <div className="text-[10px] text-muted-foreground">{r.tags.map((t) => `#${t}`).join(" ")}</div>}
        </div>
      ),
    },
    { key: "status", title: "状态", sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "resources", title: "资源限制", sortable: true,
      render: (r) => (
        <div className="text-xs tabular-nums">
          <p>{r.cpuLimit} 核 CPU</p>
          <p className="text-muted-foreground">{r.memLimitMb} MB 内存</p>
        </div>
      ),
    },
    {
      key: "sessions", title: "会话占用", sortable: true,
      render: (r) => <span className="text-xs tabular-nums">{r.currentSessions}{r.maxSessions > 0 ? ` / ${r.maxSessions}` : ""}</span>,
    },
    {
      key: "socks", title: "Socks出口",
      render: (r) => <code className="text-[10px] font-mono text-muted-foreground">{r.socksAddr ?? "-"}</code>,
    },
    {
      key: "traffic", title: "流量 MB",
      render: (r) => (
        <div className="text-xs tabular-nums">
          <p>↑{r.bytesUpMb} ↓{r.bytesDownMb}</p>
          <p className="text-muted-foreground">峰值 {r.peakTrafficMb}{r.trafficLimitMb > 0 ? ` / 限${r.trafficLimitMb}` : ""}</p>
        </div>
      ),
    },
    {
      key: "configVersion", title: "配置版本", sortable: true,
      render: (r) => <Badge variant="outline">v{r.configVersion}</Badge>,
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (r) => <span className="text-xs text-muted-foreground">{r.createdAt}</span> },
  ]

  const rowActions = (r: SingboxRow) => (
    <div className="flex items-center justify-end gap-0.5">
      <Button variant="ghost" size="icon" title="连通性测试" disabled={busyId === r.id} onClick={() => test(r)}>
        <FlaskConical className="h-4 w-4 text-teal-600" />
      </Button>
      {r.status === "RUNNING" ? (
        <Button variant="ghost" size="icon" title="停止" disabled={busyId === r.id} onClick={() => stop(r)}>
          <Square className="h-4 w-4 text-amber-600" />
        </Button>
      ) : (
        <Button variant="ghost" size="icon" title="启动" disabled={busyId === r.id} onClick={() => start(r)}>
          <Play className="h-4 w-4 text-emerald-600" />
        </Button>
      )}
      <Button variant="ghost" size="icon" title="复制实例" disabled={busyId === r.id} onClick={() => copy(r)}>
        <Copy className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" title="销毁" onClick={() => setConfirmDestroy(r)}>
        <Trash2 className="h-4 w-4 text-red-500" />
      </Button>
    </div>
  )

  const runBatch = async (op: "stop" | "start" | "destroy" | "test") => {
    if (selectedIds.length === 0) return
    setBusyId("batch")
    try {
      const res = await batchSingboxAction({ ids: selectedIds, op })
      if (res.code === 0 && res.data) {
        setBatchResult({ ok: res.data.ok, fail: res.data.fail, failures: res.data.failures })
        toast.success(`批量${op === "test" ? "测试" : op}完成：成功 ${res.data.ok}`)
        router.refresh()
      } else toast.error(res.msg)
    } finally { setBusyId(null) }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <StatCard title="运行中实例" value={props.runningCount} icon={<Server className="h-4 w-4" />} tone="success" />
        <StatCard title="异常/停止" value={props.abnormalCount} icon={<Activity className="h-4 w-4" />} tone={props.abnormalCount > 0 ? "danger" : "default"} />
        <StatCard title="代理池节点" value={props.proxyCount} sub="internal_singbox 类型" icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="实例总数" value={props.total} icon={<HardDrive className="h-4 w-4" />} />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 新建实例
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4 mr-1" /> 导入配置JSON
        </Button>
        {selectedIds.length > 0 && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-xs text-muted-foreground">已选 {selectedIds.length}</span>
            <Button size="sm" variant="outline" disabled={busyId === "batch"} onClick={() => runBatch("test")}>批量测试</Button>
            <Button size="sm" variant="outline" disabled={busyId === "batch"} onClick={() => runBatch("start")}>批量启动</Button>
            <Button size="sm" variant="outline" disabled={busyId === "batch"} onClick={() => runBatch("stop")}>批量停止</Button>
            <Button size="sm" variant="destructive" disabled={busyId === "batch"} onClick={() => runBatch("destroy")}>批量销毁</Button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={props.instances}
        total={props.total}
        page={props.page}
        pageSize={props.pageSize}
        keyword={props.keyword}
        sortField={props.sortField}
        sortOrder={props.sortOrder}
        onQueryChange={query}
        rowActions={rowActions}
        selectedIds={selectedIds}
        onSelectedChange={setSelectedIds}
        emptyText="暂无实例，点击「新建实例」创建第一个 SingBox 代理容器"
      />

      {/* 批量结果弹窗 */}
      <Dialog open={!!batchResult} onOpenChange={(v) => !v && setBatchResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>批量操作结果</DialogTitle></DialogHeader>
          <p className="text-sm">成功 {batchResult?.ok} 项 · 失败 {batchResult?.fail} 项</p>
          {batchResult && batchResult.failures.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-md border divide-y text-xs">
              {batchResult.failures.map((f, i) => (
                <div key={i} className="p-2">
                  <span className="font-medium">{f.name}</span>：{f.reason}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CreateInstanceDialog open={createOpen} onOpenChange={setCreateOpen} hosts={props.hosts} onDone={() => router.refresh()} />
      <InstanceDetailDialog instance={detail} onClose={() => setDetail(null)} onDone={() => router.refresh()} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={() => router.refresh()} />

      <ConfirmDialog
        open={!!confirmDestroy}
        onOpenChange={(v) => !v && setConfirmDestroy(null)}
        title="销毁 SingBox 实例"
        description={`「${confirmDestroy?.name}」的容器将被删除、数据库软删除入回收站、关联代理节点自动禁用。存在活跃浏览器会话时将拒绝执行。`}
        destructive
        requirePhrase="DESTROY"
        confirmText="确认销毁"
        onConfirm={async () => { if (confirmDestroy) await destroy(confirmDestroy) }}
      />
    </div>
  )
}

// ================= 新建/编辑实例可视化表单 =================
export function InstanceForm({
  hosts, initial, onSubmit, onCancel, busy, submitLabel,
}: {
  hosts: HostRow[]
  initial?: Partial<{ name: string; remark: string; hostNodeId: string; cpuLimit: number; memLimitMb: number; maxSessions: number; inboundPort: number; autoRestart: boolean; trafficLimitMb: number; overLimitAction: string; tags: string }>
  onSubmit: (form: Record<string, unknown>) => void
  onCancel: () => void
  busy: boolean
  submitLabel: string
}) {
  const [form, setForm] = React.useState({
    name: "", remark: "", tags: "", hostNodeId: hosts[0]?.id || "",
    cpuLimit: 1, memLimitMb: 512, maxSessions: 0, inboundPort: 1080,
    autoRestart: true, trafficLimitMb: 0, overLimitAction: "ALERT",
    defaultOutbound: "direct",
    ...initial,
  })
  const [outbounds, setOutbounds] = React.useState([
    { type: "socks", tag: "upstream-1", server: "", serverPort: 1080, uuid: "", userId: "", password: "", security: "", flow: "" },
  ])
  const [routeRules, setRouteRules] = React.useState<{ priority: number; outboundTag: string; domain: string; ipCidr: string }[]>([])
  const [dns, setDns] = React.useState([{ tag: "local", address: "local", detour: "" }])

  const addOutbound = () => setOutbounds([...outbounds, { type: "socks", tag: `upstream-${outbounds.length + 1}`, server: "", serverPort: 1080, uuid: "", userId: "", password: "", security: "", flow: "" }])
  const addRule = () => setRouteRules([...routeRules, { priority: routeRules.length + 1, outboundTag: "direct", domain: "", ipCidr: "" }])

  const submit = () => {
    onSubmit({
      ...form,
      inboundPort: form.inboundPort,
      maxSessions: form.maxSessions,
      cpuLimit: form.cpuLimit,
      memLimitMb: form.memLimitMb,
      trafficLimitMb: form.trafficLimitMb,
      tags: form.tags,
      autoRestart: form.autoRestart,
      defaultOutbound: form.defaultOutbound,
      outbounds: outbounds.map((o) => ({
        type: o.type, tag: o.tag, server: o.server || undefined, serverPort: Number(o.serverPort) || undefined,
        uuid: o.uuid || undefined, userId: o.userId || undefined, password: o.password || undefined,
        security: o.security || undefined, flow: o.flow || undefined,
      })),
      routeRules: routeRules.filter((r) => r.domain || r.ipCidr).map((r) => ({
        priority: r.priority, outboundTag: r.outboundTag,
        domain: r.domain ? r.domain.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        ipCidr: r.ipCidr ? r.ipCidr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      })),
      dns: { servers: dns.filter((d) => d.tag && d.address).map((d) => ({ tag: d.tag, address: d.address, detour: d.detour || undefined })) },
    })
  }

  return (
    <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
      <Tabs defaultValue="basic">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="basic">基础</TabsTrigger>
          <TabsTrigger value="outbound">出站</TabsTrigger>
          <TabsTrigger value="route">路由</TabsTrigger>
          <TabsTrigger value="dns">DNS</TabsTrigger>
          <TabsTrigger value="advanced">高级</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>实例名称 *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 sb-hk-01" /></div>
            <div className="space-y-1.5">
              <Label>宿主机 *</Label>
              <Select value={form.hostNodeId} onValueChange={(v) => setForm({ ...form, hostNodeId: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {hosts.map((h) => (
                    <SelectItem key={h.id} value={h.id} disabled={h.status !== "ONLINE"}>
                      {h.name}（{h.cpuAvailable}核 / {Math.round(h.memAvailableMb / 1024)}GB 可用）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5"><Label>备注</Label><Input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>CPU 限制（核）</Label>
              <PrecisionInput value={form.cpuLimit} onChange={(v) => setForm({ ...form, cpuLimit: v })} min={0.001} max={64} step={0.001} suffix="核" />
            </div>
            <div className="space-y-1.5">
              <Label>内存限制（MB）</Label>
              <PrecisionInput value={form.memLimitMb} onChange={(v) => setForm({ ...form, memLimitMb: v })} min={16} max={65536} step={0.001} suffix="MB" />
            </div>
            <div className="space-y-1.5">
              <Label>入站 Socks 端口</Label>
              <PrecisionInput value={form.inboundPort} onChange={(v) => setForm({ ...form, inboundPort: Math.round(v) })} min={1024} max={65535} suffix="端口" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>单实例最大会话数（0不限）</Label>
              <PrecisionInput value={form.maxSessions} onChange={(v) => setForm({ ...form, maxSessions: Math.round(v) })} min={0} max={10000} />
            </div>
            <div className="space-y-1.5"><Label>标签（逗号分隔）</Label><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="hk,住宅" /></div>
          </div>
        </TabsContent>

        <TabsContent value="outbound" className="space-y-3 pt-3">
          {outbounds.map((o, i) => (
            <Card key={i}>
              <CardContent className="p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Select value={o.type} onValueChange={(v) => setOutbounds(outbounds.map((x, j) => j === i ? { ...x, type: v } : x))}>
                    <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["vless", "vmess", "trojan", "socks", "http"].map((t) => <SelectItem key={t} value={t}>{t.toUpperCase()}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input value={o.tag} onChange={(e) => setOutbounds(outbounds.map((x, j) => j === i ? { ...x, tag: e.target.value } : x))} placeholder="tag（路由引用名）" className="w-36" />
                  <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setOutbounds(outbounds.filter((_, j) => j !== i))} disabled={outbounds.length <= 1}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Input value={o.server} onChange={(e) => setOutbounds(outbounds.map((x, j) => j === i ? { ...x, server: e.target.value } : x))} placeholder="服务器地址" />
                  <PrecisionInput value={o.serverPort} onChange={(v) => setOutbounds(outbounds.map((x, j) => j === i ? { ...x, serverPort: Math.round(v) } : x))} min={1} max={65535} suffix="端口" />
                  <Input value={o.password} onChange={(e) => setOutbounds(outbounds.map((x, j) => j === i ? { ...x, password: e.target.value } : x))} placeholder="密码/UUID" />
                </div>
              </CardContent>
            </Card>
          ))}
          <Button variant="outline" size="sm" onClick={addOutbound}><Plus className="h-3.5 w-3.5 mr-1" /> 添加出站</Button>
          <div className="space-y-1.5">
            <Label>默认出站（route.final）</Label>
            <Input value={form.defaultOutbound} onChange={(e) => setForm({ ...form, defaultOutbound: e.target.value })} placeholder="direct" />
          </div>
        </TabsContent>

        <TabsContent value="route" className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">路由规则按优先级升序匹配（拖动数字调整）；域名支持通配符（*.example.com）</p>
          {routeRules.map((r, i) => (
            <Card key={i}>
              <CardContent className="p-3 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">优先级</Label>
                    <PrecisionInput value={r.priority} onChange={(v) => setRouteRules(routeRules.map((x, j) => j === i ? { ...x, priority: Math.round(v) } : x))} min={1} max={9999} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">出站</Label>
                    <Input value={r.outboundTag} onChange={(e) => setRouteRules(routeRules.map((x, j) => j === i ? { ...x, outboundTag: e.target.value } : x))} placeholder="direct" />
                  </div>
                  <div className="flex items-end">
                    <Button variant="ghost" size="icon" onClick={() => setRouteRules(routeRules.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input value={r.domain} onChange={(e) => setRouteRules(routeRules.map((x, j) => j === i ? { ...x, domain: e.target.value } : x))} placeholder="域名列表（逗号分隔，如 *.google.com）" />
                  <Input value={r.ipCidr} onChange={(e) => setRouteRules(routeRules.map((x, j) => j === i ? { ...x, ipCidr: e.target.value } : x))} placeholder="IP CIDR（逗号分隔，如 1.1.1.0/24）" />
                </div>
              </CardContent>
            </Card>
          ))}
          <Button variant="outline" size="sm" onClick={addRule}><Plus className="h-3.5 w-3.5 mr-1" /> 添加路由规则</Button>
        </TabsContent>

        <TabsContent value="dns" className="space-y-3 pt-3">
          {dns.map((d, i) => (
            <div key={i} className="grid grid-cols-3 gap-2">
              <Input value={d.tag} onChange={(e) => setDns(dns.map((x, j) => j === i ? { ...x, tag: e.target.value } : x))} placeholder="tag" />
              <Input value={d.address} onChange={(e) => setDns(dns.map((x, j) => j === i ? { ...x, address: e.target.value } : x))} placeholder="地址（如 8.8.8.8）" />
              <div className="flex gap-1">
                <Input value={d.detour} onChange={(e) => setDns(dns.map((x, j) => j === i ? { ...x, detour: e.target.value } : x))} placeholder="detour（出站tag）" />
                <Button variant="ghost" size="icon" onClick={() => setDns(dns.filter((_, j) => j !== i))} disabled={dns.length <= 1}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setDns([...dns, { tag: "", address: "", detour: "" }])}>
            <Plus className="h-3.5 w-3.5 mr-1" /> 添加DNS服务器
          </Button>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-3 pt-3">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">OOM 自动重启</p>
              <p className="text-xs text-muted-foreground">容器异常退出/OOM时自动重启（重启失败触发告警）</p>
            </div>
            <Switch checked={form.autoRestart} onCheckedChange={(v) => setForm({ ...form, autoRestart: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>流量上限（MB，0不限）</Label>
              <PrecisionInput value={form.trafficLimitMb} onChange={(v) => setForm({ ...form, trafficLimitMb: v })} min={0} max={1e9} suffix="MB" />
            </div>
            <div className="space-y-1.5">
              <Label>超限动作</Label>
              <Select value={form.overLimitAction} onValueChange={(v) => setForm({ ...form, overLimitAction: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALERT">仅告警</SelectItem>
                  <SelectItem value="THROTTLE">流量限速</SelectItem>
                  <SelectItem value="BLOCK_NEW">禁止分配新会话</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>取消</Button>
        <Button onClick={submit} disabled={busy || !form.name.trim() || !form.hostNodeId}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} {submitLabel}
        </Button>
      </div>
    </div>
  )
}

function CreateInstanceDialog({ open, onOpenChange, hosts, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; hosts: HostRow[]; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const submit = async (form: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await createSingboxAction(form)
      if (res.code === 0) {
        toast.success(`实例创建成功 · Socks出口 ${res.data?.socksAddr}${res.data?.simulated ? "（模拟容器模式）" : ""}`)
        onOpenChange(false)
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Server className="h-5 w-5" /> 新建 Sing-Box 实例</DialogTitle>
          <DialogDescription>
            配置JSON由后端内存组装后注入容器环境变量（不落盘）；创建完成自动同步代理池节点
          </DialogDescription>
        </DialogHeader>
        <InstanceForm hosts={hosts} onSubmit={submit} onCancel={() => onOpenChange(false)} busy={busy} submitLabel="创建实例" />
      </DialogContent>
    </Dialog>
  )
}

// ================= 实例详情弹窗 =================
function InstanceDetailDialog({ instance, onClose, onDone }: { instance: SingboxRow | null; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = React.useState("runtime")
  const [runtime, setRuntime] = React.useState<Awaited<ReturnType<typeof getInstanceRuntimeAction>>["data"] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!instance) return
    setBusy(true)
    try {
      const res = await getInstanceRuntimeAction({ id: instance.id })
      if (res.code === 0) setRuntime(res.data ?? null)
    } finally { setBusy(false) }
  }, [instance])

  React.useEffect(() => {
    if (instance) { setTab("runtime"); void load() }
  }, [instance, load])

  const rollback = async (version: number) => {
    if (!instance) return
    const res = await rollbackSingboxConfigAction({ instanceId: instance.id, version })
    if (res.code === 0) { toast.success(`已回滚至 v${version}`); void load(); onDone() } else toast.error(res.msg)
  }

  const exportConfig = async () => {
    if (!instance) return
    const res = await exportSingboxConfigAction({ id: instance.id })
    if (res.code === 0 && res.data) {
      const blob = new Blob([JSON.stringify(res.data.config, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url; a.download = `singbox-${instance.name}.json`; a.click()
      URL.revokeObjectURL(url)
    }
  }

  return (
    <Dialog open={!!instance} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        {instance && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Server className="h-5 w-5" /> {instance.name}
                <StatusBadge status={instance.status} />
                <Badge variant="outline">v{instance.configVersion}</Badge>
              </DialogTitle>
              <DialogDescription>
                {instance.remark || "无备注"} · Socks出口 <code className="font-mono">{instance.socksAddr ?? "-"}</code>
                {instance.lastError && <span className="text-red-500"> · 异常：{instance.lastError}</span>}
              </DialogDescription>
            </DialogHeader>

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="grid grid-cols-4 w-full">
                <TabsTrigger value="runtime">运行状态</TabsTrigger>
                <TabsTrigger value="config">配置预览</TabsTrigger>
                <TabsTrigger value="logs">运行日志</TabsTrigger>
                <TabsTrigger value="versions">版本历史</TabsTrigger>
              </TabsList>

              <TabsContent value="runtime" className="space-y-3 pt-3">
                <div className="grid grid-cols-4 gap-3">
                  <StatCard title="CPU" value={`${runtime?.stats.cpuPct ?? 0}%`} sub={`限制 ${instance.cpuLimit}核`} />
                  <StatCard title="内存" value={`${runtime?.stats.memMb ?? 0}MB`} sub={`限制 ${instance.memLimitMb}MB`} />
                  <StatCard title="下行流量" value={`${runtime?.stats.netRxMb ?? 0}MB`} />
                  <StatCard title="会话" value={instance.currentSessions} sub={instance.maxSessions > 0 ? `上限 ${instance.maxSessions}` : "不限"} />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
                    <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy && "animate-spin")} /> 刷新实时状态
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>编辑配置（热更新）</Button>
                  <Button size="sm" variant="outline" onClick={exportConfig}><FileJson className="h-3.5 w-3.5 mr-1" /> 导出配置</Button>
                  {runtime?.containerInfo && (
                    <span className="text-xs text-muted-foreground">容器 {runtime.containerInfo.name} · {runtime.containerInfo.state}</span>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="config" className="pt-3">
                <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/50 p-3 text-[11px] font-mono">
                  {runtime?.configJson ? JSON.stringify(JSON.parse(runtime.configJson), null, 2) : "加载中..."}
                </pre>
                <p className="text-[11px] text-muted-foreground mt-1">只读展示后端内存组装的完整运行配置（容器环境变量注入，不落盘）</p>
              </TabsContent>

              <TabsContent value="logs" className="pt-3">
                <div className="max-h-80 overflow-auto rounded-lg border bg-slate-950 p-3 text-[11px] font-mono text-slate-300">
                  {(runtime?.logs ?? []).length === 0 ? "暂无日志" : runtime?.logs?.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              </TabsContent>

              <TabsContent value="versions" className="pt-3 space-y-2">
                {(runtime?.versions ?? []).map((v) => (
                  <div key={v.version} className="flex items-center justify-between rounded-md border p-2.5 text-sm">
                    <div>
                      <Badge variant="outline">v{v.version}</Badge>
                      <span className="ml-2 text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString("zh-CN")}</span>
                    </div>
                    <Button size="sm" variant="outline" disabled={v.version === instance.configVersion} onClick={() => rollback(v.version)}>
                      <History className="h-3.5 w-3.5 mr-1" /> 回滚到此版本
                    </Button>
                  </div>
                ))}
              </TabsContent>
            </Tabs>

            <HotReloadDialog instance={instance} open={editOpen} onOpenChange={setEditOpen} onDone={() => { void load(); onDone() }} hosts={[]} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// 热更新弹窗（复用表单）
function HotReloadDialog({ instance, open, onOpenChange, onDone, hosts }: { instance: SingboxRow; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void; hosts: HostRow[] }) {
  const [busy, setBusy] = React.useState(false)
  const [confirm, setConfirm] = React.useState<Record<string, unknown> | null>(null)

  const doReload = async () => {
    if (!confirm) return
    setBusy(true)
    try {
      const res = await updateSingboxConfigAction({ instanceId: instance.id, ...confirm })
      if (res.code === 0) {
        if (res.data?.rolledBack) toast.error("热更新失败：实例异常，已自动回滚上一版配置并触发告警")
        else toast.success(`配置热更新成功（v${res.data?.version}）`)
        onOpenChange(false)
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>热更新配置 · {instance.name}</DialogTitle>
          <DialogDescription>
            保存后向容器发送 SIGHUP 触发重载；重载异常将自动回滚上一版配置并告警
          </DialogDescription>
        </DialogHeader>
        <InstanceForm
          hosts={hosts}
          initial={{ name: instance.name, remark: instance.remark, hostNodeId: instance.hostNodeId ?? "", cpuLimit: instance.cpuLimit, memLimitMb: instance.memLimitMb, maxSessions: instance.maxSessions, autoRestart: instance.autoRestart, trafficLimitMb: instance.trafficLimitMb, overLimitAction: instance.overLimitAction }}
          onSubmit={(form) => { setConfirm(form); onOpenChange(false) }}
          onCancel={() => onOpenChange(false)}
          busy={busy}
          submitLabel="保存并热重载"
        />
        <ConfirmDialog
          open={!!confirm}
          onOpenChange={(v) => { if (!v) setConfirm(null) }}
          title="确认热更新配置"
          description="将向运行中的 sing-box 容器发送重载信号。若重载后实例异常，系统自动回滚至上一版本。"
          confirmText="执行热更新"
          onConfirm={doReload}
        />
      </DialogContent>
    </Dialog>
  )
}

// 导入弹窗
function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [json, setJson] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await importSingboxAction({ json })
      if (res.code === 0) { toast.success("导入成功，实例已创建"); onOpenChange(false); setJson(""); onDone() }
      else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>导入实例配置 JSON</DialogTitle>
          <DialogDescription>格式：{"{ name, remark, cpuLimit, memLimitMb, configJson: { sing-box完整配置 } }"}，导入后复用创建流程生成实例</DialogDescription>
        </DialogHeader>
        <textarea
          className="w-full min-h-48 rounded-md border bg-background p-2 font-mono text-xs"
          placeholder='粘贴导出的配置JSON...'
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || json.length < 5}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 导入并创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
