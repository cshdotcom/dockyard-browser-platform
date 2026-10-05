"use client"

// ============================================================
// r40：打印机池管理中心（管理员）
//   ① 统计卡（总任务/进行中/完成/失败/超时/取消）
//   ② 打印机池（客户端上报的物理打印机；禁用/启用/删除/位置标注）
//   ③ 任务队列（全用户实时状态；重派[失败/超时]/强制取消/清文件）
//   ④ PRINT_POOL 审计流（创建/投递/打印/失败/策略拒绝/管理操作全事件）
// ============================================================

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Printer, Wifi, WifiOff, Ban, Loader2, RotateCcw, Trash2, MapPin, CheckCircle2, XCircle, Clock } from "lucide-react"
import { printAdminMonitorAction, printAdminPrinterOpAction, printAdminJobOpAction, type PrintAdminMonitorData } from "@/server/actions/print-admin"

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "排队中", cls: "bg-muted text-muted-foreground" },
  SENT: { label: "已派发", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  DELIVERED: { label: "已投递", cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  PRINTING: { label: "打印中", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  PRINTED: { label: "已完成", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  FAILED: { label: "失败", cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
  CANCELED: { label: "已取消", cls: "bg-zinc-500/15 text-zinc-500" },
  TIMED_OUT: { label: "超时收口", cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
}

export default function AdminPrintingPage() {
  const [data, setData] = useState<PrintAdminMonitorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [locationInput, setLocationInput] = useState<Record<string, string>>({})
  const [jobFilter, setJobFilter] = useState<string>("ALL")

  const refresh = useCallback(async () => {
    try {
      const res = await printAdminMonitorAction({})
      if (res.code === 0) setData(res.data as PrintAdminMonitorData)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(t)
  }, [refresh])

  const printerOp = async (id: string, op: "disable" | "enable" | "delete" | "setLocation") => {
    setBusyId(id)
    try {
      const res = await printAdminPrinterOpAction({ id, op, ...(op === "setLocation" ? { location: locationInput[id] || "" } : {}) })
      if (res.code === 0) { toast.success("操作成功"); void refresh() }
      else toast.error(res.msg)
    } finally { setBusyId(null) }
  }

  const jobOp = async (id: string, op: "retry" | "cancel" | "cleanFile") => {
    setBusyId(id)
    try {
      const res = await printAdminJobOpAction({ id, op })
      if (res.code === 0) { toast.success(res.msg); void refresh() }
      else toast.error(res.msg)
    } finally { setBusyId(null) }
  }

  const printers = data?.printers ?? []
  const jobs = (data?.recentJobs ?? []).filter((j) => jobFilter === "ALL" || j.status === jobFilter)

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Printer className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">打印机池监控</h1>
          <p className="text-sm text-muted-foreground">虚拟打印机：沙箱页面 → 远程客户端物理打印机 · 全链路状态与管控</p>
        </div>
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 md:grid-cols-6">
        {[
          { v: data?.stats.totalJobs ?? 0, l: "总任务", c: "" },
          { v: data?.stats.inFlight ?? 0, l: "进行中", c: "text-blue-600" },
          { v: data?.stats.printed ?? 0, l: "已打印", c: "text-emerald-600" },
          { v: data?.stats.failed ?? 0, l: "失败", c: "text-red-600" },
          { v: data?.stats.timedOut ?? 0, l: "超时收口", c: "text-orange-600" },
          { v: data?.stats.canceled ?? 0, l: "已取消", c: "text-zinc-500" },
        ].map((s) => (
          <Card key={s.l}><CardContent className="pt-5">
            <div className={`text-2xl font-bold ${s.c}`}>{s.v}</div>
            <p className="text-xs text-muted-foreground mt-1">{s.l}</p>
          </CardContent></Card>
        ))}
      </div>

      {/* 配置提示 */}
      {data && (
        <Card><CardContent className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>池开关：<Badge variant={data.config.poolEnabled ? "default" : "destructive"}>{data.config.poolEnabled ? "开启" : "停用"}</Badge></span>
          <span>派发超时 {data.config.dispatchTimeoutSec}s</span>
          <span>交付超时 {data.config.deliverTimeoutSec}s</span>
          <span>文件保留 {data.config.fileTtlHours}h</span>
          <span>权限锁 <code>blockRemotePrintPool</code>（用户/组）· 企业策略 <code>PrintingEnabled</code> / URL 级黑白名单</span>
        </CardContent></Card>
      )}

      {/* 打印机池 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Wifi className="h-4 w-4" />打印机池（{printers.length}）</CardTitle>
          <CardDescription>客户端上报的物理打印机（60s 全量同步；未上报自动离线；禁用后不出现在用户选择列表）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {printers.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              暂无打印机。在连接打印机的客户端机器部署 Dockyard Worker（打印代理）即可自动上报 —— 部署凭证见「工作节点」页。
            </p>
          )}
          {printers.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <div className="flex-1 min-w-56">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {p.status === "ONLINE" ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : p.status === "DISABLED" ? <Ban className="h-3.5 w-3.5 text-zinc-400" /> : <WifiOff className="h-3.5 w-3.5 text-zinc-400" />}
                  <span className="font-medium">{p.name}</span>
                  <code className="text-xs text-muted-foreground">{p.printerKey}</code>
                  <Badge variant={p.status === "ONLINE" ? "default" : "secondary"}>{p.status === "ONLINE" ? "在线" : p.status === "DISABLED" ? "已禁用" : "离线"}</Badge>
                  <Badge variant="outline">{p.nodeName}{p.nodeStatus !== "ONLINE" ? `（节点${p.nodeStatus}）` : ""}</Badge>
                  <span className="text-xs text-muted-foreground">{p.clientName}</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(p.lastSeenAt).toLocaleString()}</span>
                  <Badge variant="secondary">{p.jobCount} 任务</Badge>
                </div>
                {p.description && <p className="text-xs text-muted-foreground mt-1">{p.description}</p>}
                {p.location && <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><MapPin className="h-3 w-3" />{p.location}</p>}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="位置标注（如 3F 打印区）"
                  className="w-40 h-8 text-xs"
                  value={locationInput[p.id] ?? p.location}
                  onChange={(e) => setLocationInput({ ...locationInput, [p.id]: e.target.value })}
                />
                <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => printerOp(p.id, "setLocation")}>
                  {busyId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}标注
                </Button>
                {p.status === "DISABLED" ? (
                  <Button size="sm" variant="default" disabled={busyId === p.id} onClick={() => printerOp(p.id, "enable")}>
                    <CheckCircle2 className="h-4 w-4" />启用
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => printerOp(p.id, "disable")}>
                    <Ban className="h-4 w-4" />禁用
                  </Button>
                )}
                <Button size="sm" variant="destructive" disabled={busyId === p.id} onClick={() => printerOp(p.id, "delete")}>
                  <Trash2 className="h-4 w-4" />删除
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 任务队列 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">任务队列（最近 50）</CardTitle>
          <CardDescription>全用户打印任务实时状态（15s 自动刷新）</CardDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {["ALL", "PENDING", "SENT", "DELIVERED", "PRINTING", "PRINTED", "FAILED", "TIMED_OUT", "CANCELED"].map((s) => (
              <Button key={s} size="sm" variant={jobFilter === s ? "default" : "outline"} className="h-6 px-2 text-xs" onClick={() => setJobFilter(s)}>
                {s === "ALL" ? "全部" : STATUS_META[s]?.label || s}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {jobs.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无任务</p>}
          {jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
              <span className="font-mono w-28 shrink-0">{j.jobNo}</span>
              <span className="font-medium w-24 shrink-0 truncate" title={j.username}>{j.username}</span>
              <span className="flex-1 min-w-40 truncate text-muted-foreground" title={`${j.printerName} @ ${j.nodeName} · 源：${j.sourceUrl}`}>
                {j.printerName} @ {j.nodeName} · {j.deliverMode === "silent" ? "直打" : "打印界面"} ×{j.copies} · {(j.fileBytes / 1024).toFixed(0)}KB
              </span>
              <span className="text-muted-foreground w-36 shrink-0">{new Date(j.createdAt).toLocaleString()}</span>
              <Badge className={`shrink-0 ${STATUS_META[j.status]?.cls || ""}`} variant="secondary">{STATUS_META[j.status]?.label || j.status}</Badge>
              <div className="flex items-center gap-1 shrink-0">
                {["TIMED_OUT", "FAILED"].includes(j.status) && (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busyId === j.id} onClick={() => jobOp(j.id, "retry")}>
                    {busyId === j.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}重派
                  </Button>
                )}
                {["PENDING", "SENT", "DELIVERED", "PRINTING"].includes(j.status) && (
                  <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" disabled={busyId === j.id} onClick={() => jobOp(j.id, "cancel")}>
                    <XCircle className="h-3 w-3" />强制取消
                  </Button>
                )}
                {["PRINTED", "FAILED", "CANCELED", "TIMED_OUT"].includes(j.status) && j.fileBytes > 0 && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busyId === j.id} onClick={() => jobOp(j.id, "cleanFile")}>
                    <Trash2 className="h-3 w-3" />清文件
                  </Button>
                )}
              </div>
              {j.error && <p className="w-full text-red-500 truncate" title={j.error}>{j.error}</p>}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 审计流 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">打印审计流</CardTitle>
          <CardDescription>PRINT_POOL 全事件：创建 / 策略拒绝 / 已投递 / 打印 / 失败 / 超时 / 重派 / 强制取消 / 打印机管理</CardDescription>
        </CardHeader>
        <CardContent>
          {(data?.recentAudit ?? []).length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无审计事件</p>}
          <div className="space-y-1.5 max-h-72 overflow-auto">
            {(data?.recentAudit ?? []).map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-xs rounded border px-2 py-1.5">
                <span className="text-muted-foreground w-36 shrink-0">{new Date(a.at).toLocaleString()}</span>
                <Badge variant={a.severity === "WARN" || a.severity === "DANGER" ? "destructive" : "outline"} className="shrink-0">{a.op}</Badge>
                <span className="font-medium shrink-0">{a.operator}</span>
                <span className="truncate text-muted-foreground">{a.target}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" />加载中…
        </div>
      )}
    </div>
  )
}
