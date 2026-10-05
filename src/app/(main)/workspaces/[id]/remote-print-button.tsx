"use client"

// r40：打印对话框（双模式）
//   Tab「远程打印机」：沙箱页面 → 选择远程客户端物理打印机（虚拟打印机池）
//     · 打印机列表（在线客户端上报；含位置/能力/双面彩色标识）
//     · 交付模式：silent=客户端直打（全自动）| dialog=客户端弹出打印界面（人工确认）
//     · 份数/双面/横纵向 + 任务状态实时跟踪（PENDING→SENT→DELIVERED→PRINTED）
//   Tab「本地打印」（r37 原链路）：PDF 流直达操作者浏览器 → 系统打印对话框
// 权限：printing.poolEnabled + blockRemotePrintPool（远程池）/ feature.remotePrint + blockRemotePrint（本地）

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Printer, Wifi, WifiOff, RefreshCw, FileText, CheckCircle2, XCircle, Clock, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

interface PoolPrinter {
  id: string
  name: string
  description: string
  location: string
  capabilities: Record<string, unknown>
  client: { name: string; hostname: string; version: string }
}

interface MyPrintJob {
  id: string
  jobNo: string
  workspaceName: string
  printerName: string
  clientName: string
  fileName: string
  fileBytes: number
  status: string
  deliverMode: string
  copies: number
  sourceUrl: string
  error: string | null
  createdAt: string
  finishedAt: string | null
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "排队中", cls: "bg-muted text-muted-foreground" },
  SENT: { label: "已派发", cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  DELIVERED: { label: "已投递客户端", cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  PRINTING: { label: "打印中", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  PRINTED: { label: "已完成", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  FAILED: { label: "失败", cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
  CANCELED: { label: "已取消", cls: "bg-zinc-500/15 text-zinc-500" },
  TIMED_OUT: { label: "超时收口", cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
}

export function RemotePrintButton({ workspaceId, disabled }: { workspaceId: string; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={disabled} title="打印沙箱当前页面（本地打印机 / 远程客户端打印机池）">
        <Printer className="mr-1 h-4 w-4" />
        打印当前页面
      </Button>
      {open && (
        <PrintDialog
          workspaceId={workspaceId}
          onClose={() => setOpen(false)}
          onDone={() => router.refresh()}
        />
      )}
    </>
  )
}

function PrintDialog({ workspaceId, onClose, onDone }: { workspaceId: string; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = React.useState<"pool" | "local">("pool")

  return (
    <Dialog open onOpenChange={(v) => { if (!v) { onClose() } }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Printer className="h-4 w-4" /> 打印当前沙箱页面</DialogTitle>
          <DialogDescription>
            渲染在沙箱内完成（CDP printToPDF 页面完整保真），可选择发送到远程客户端的物理打印机（虚拟打印机池）或本地打印机。
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "pool" | "local")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="pool"><Send className="mr-1 h-3.5 w-3.5" />远程打印机池</TabsTrigger>
            <TabsTrigger value="local"><FileText className="mr-1 h-3.5 w-3.5" />本地打印</TabsTrigger>
          </TabsList>
          <TabsContent value="pool" className="pt-3">
            <PoolPrintForm workspaceId={workspaceId} onDone={onDone} />
          </TabsContent>
          <TabsContent value="local" className="pt-3">
            <LocalPrintForm workspaceId={workspaceId} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- 远程打印机池表单 ----------------
function PoolPrintForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [printers, setPrinters] = React.useState<PoolPrinter[] | null>(null)
  const [poolDisabled, setPoolDisabled] = React.useState<string | null>(null)
  const [printerId, setPrinterId] = React.useState("")
  const [deliverMode, setDeliverMode] = React.useState<"dialog" | "silent">("dialog")
  const [copies, setCopies] = React.useState(1)
  const [duplex, setDuplex] = React.useState("default")
  const [landscape, setLandscape] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [jobs, setJobs] = React.useState<MyPrintJob[]>([])
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const loadPrinters = React.useCallback(async () => {
    setPrinters(null)
    try {
      const res = await fetch("/api/print/printers")
      const j = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { printers?: PoolPrinter[] } } | null
      if (res.status === 403) { setPoolDisabled(j?.msg || "打印机池不可用"); setPrinters([]); return }
      if (j?.code === 0) {
        setPrinters(j.data?.printers || [])
        setPrinterId((prev) => (prev && j.data?.printers?.some((p) => p.id === prev) ? prev : j.data?.printers?.[0]?.id || ""))
      } else setPrinters([])
    } catch { setPrinters([]) }
  }, [])

  const loadJobs = React.useCallback(async () => {
    try {
      const res = await fetch("/api/print/jobs?limit=6")
      const j = (await res.json().catch(() => null)) as { code?: number; data?: { jobs?: MyPrintJob[] } } | null
      if (j?.code === 0) setJobs(j.data?.jobs || [])
    } catch { /* 轮询容错 */ }
  }, [])

  React.useEffect(() => { void loadPrinters(); void loadJobs() }, [loadPrinters, loadJobs])

  // 任务状态轮询（有活跃任务时 8s；对话框关闭由父级卸载自动停）
  React.useEffect(() => {
    const active = jobs.some((j) => ["PENDING", "SENT", "DELIVERED", "PRINTING"].includes(j.status))
    if (!active) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } return }
    if (!pollRef.current) pollRef.current = setInterval(() => { void loadJobs() }, 8000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [jobs, loadJobs])

  const submit = async () => {
    if (!printerId) { toast.error("请选择目标打印机"); return }
    setBusy(true)
    try {
      const res = await fetch("/api/print/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, printerId, deliverMode, copies, duplex, landscape }),
      })
      const j = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { jobNo?: string; printerName?: string } } | null
      if (!res.ok || j?.code !== 0) throw new Error(j?.msg || `创建失败（HTTP ${res.status}）`)
      toast.success(`打印任务 ${j.data?.jobNo} 已创建 —— 即将送达「${j.data?.printerName}」所在客户端`)
      await loadJobs()
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建打印任务失败")
    } finally { setBusy(false) }
  }

  const cancelJob = async (id: string) => {
    try {
      const res = await fetch(`/api/print/jobs/${id}/cancel`, { method: "POST" })
      const j = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
      if (!res.ok || j?.code !== 0) throw new Error(j?.msg || "取消失败")
      toast.success("打印任务已取消")
      await loadJobs()
    } catch (e) { toast.error(e instanceof Error ? e.message : "取消失败") }
  }

  if (poolDisabled) {
    return <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{poolDisabled}。可切换到「本地打印」或联系管理员。</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm">目标远程打印机</Label>
        <Button size="sm" variant="ghost" onClick={() => void loadPrinters()}><RefreshCw className="h-3.5 w-3.5" /></Button>
      </div>
      {printers === null ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在获取在线打印机池…</div>
      ) : printers.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          当前无在线打印机。需要在连接物理打印机的客户端机器部署 Dockyard Worker（打印代理），并确保其已注册本平台。部署方式见部署文档「打印机池代理」。
        </div>
      ) : (
        <>
          <Select value={printerId} onValueChange={setPrinterId}>
            <SelectTrigger><SelectValue placeholder="选择打印机" /></SelectTrigger>
            <SelectContent>
              {printers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">@{p.client.hostname || p.client.name}{p.location ? ` · ${p.location}` : ""}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {printerId && (() => {
            const p = printers.find((x) => x.id === printerId)
            if (!p) return null
            return (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="outline" className="font-normal"><Wifi className="mr-1 h-3 w-3" />{p.client.name}</Badge>
                {p.capabilities?.duplex === true && <Badge variant="secondary">双面</Badge>}
                {p.capabilities?.color === true && <Badge variant="secondary">彩色</Badge>}
                {typeof p.capabilities?.paper === "string" && <Badge variant="secondary">{String(p.capabilities.paper)}</Badge>}
                {p.description && <span className="truncate">{p.description}</span>}
              </div>
            )
          })()}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">交付方式</Label>
              <Select value={deliverMode} onValueChange={(v) => setDeliverMode(v as "dialog" | "silent")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dialog">弹出打印界面（客户端确认）</SelectItem>
                  <SelectItem value="silent">直接打印（全自动）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">份数</Label>
              <Input type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">双面</Label>
              <Select value={duplex} onValueChange={setDuplex}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">打印机默认</SelectItem>
                  <SelectItem value="simplex">单面</SelectItem>
                  <SelectItem value="duplex">双面</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">纸张方向</Label>
              <Select value={landscape ? "landscape" : "portrait"} onValueChange={(v) => setLandscape(v === "landscape")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">纵向</SelectItem>
                  <SelectItem value="landscape">横向</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button className="w-full" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
            发送到远程打印机{deliverMode === "silent" ? "（直接打印）" : "（弹出打印界面）"}
          </Button>
        </>
      )}

      {jobs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> 我的最近打印任务
          </div>
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                {j.status === "PRINTED" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  : j.status === "FAILED" || j.status === "TIMED_OUT" || j.status === "CANCELED" ? <XCircle className="h-3.5 w-3.5 text-red-500" />
                  : <Clock className="h-3.5 w-3.5 text-amber-500 animate-pulse" />}
                <span className="font-mono">{j.jobNo}</span>
                <span className="truncate flex-1 text-muted-foreground" title={`${j.printerName}${j.clientName ? ` @ ${j.clientName}` : ""}`}>
                  {j.printerName}{j.clientName ? ` @ ${j.clientName}` : ""}
                </span>
                <Badge className={`text-[10px] ${STATUS_META[j.status]?.cls || ""}`} variant="secondary">{STATUS_META[j.status]?.label || j.status}</Badge>
                {["PENDING", "SENT"].includes(j.status) && (
                  <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => void cancelJob(j.id)}>取消</Button>
                )}
              </div>
            ))}
          </div>
          {jobs.some((j) => ["PENDING", "SENT", "DELIVERED", "PRINTING"].includes(j.status)) && (
            <p className="text-[10px] text-muted-foreground">活跃任务每 8 秒自动刷新状态；客户端离线时任务将在交付超时后自动收口。</p>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------- 本地打印表单（r37 原链路） ----------------
function LocalPrintForm({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = React.useState(false)

  const print = async () => {
    setBusy(true)
    try {
      const res = await fetch("/api/vnc-proxy/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { msg?: string } | null
        throw new Error(j?.msg || `打印失败（HTTP ${res.status}）`)
      }
      const blob = await res.blob()
      if (blob.size < 100) throw new Error("打印渲染结果为空（页面可能无可打印内容）")
      const url = URL.createObjectURL(blob)
      const iframe = document.createElement("iframe")
      iframe.style.position = "fixed"
      iframe.style.width = "0"
      iframe.style.height = "0"
      iframe.style.border = "none"
      iframe.src = url
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus()
          iframe.contentWindow?.print()
          toast.success("已唤起本地打印对话框（在对话框中选择打印机）")
        } catch {
          window.open(url, "_blank")
        }
        setTimeout(() => { URL.revokeObjectURL(url); iframe.remove() }, 120_000)
      }
      document.body.appendChild(iframe)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "打印失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        PDF 流直达你的浏览器并唤起系统打印对话框——在对话框中选择本机或网络打印机即可。服务端与沙箱零中间文件落盘。
      </p>
      <Button className="w-full" onClick={() => void print()} disabled={busy}>
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
        渲染并发送到我的本地打印机
      </Button>
    </div>
  )
}
