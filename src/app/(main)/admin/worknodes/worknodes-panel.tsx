"use client"

// r29：Worker 节点管理面板 —— 列表/资源监控/创建（一次性凭证）/驱逐
// 10s 自动刷新心跳与资源指标

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Plus, RefreshCw, Server, ShieldBan, Copy, Check, Activity, Cpu, HardDrive, Boxes } from "lucide-react"
import { toast } from "sonner"

interface WorkNodeRow {
  id: string; nodeUuid: string; name: string; region: string; note: string | null
  status: string; enabled: boolean; liveStatus: string
  cpuUsage: number | null; memUsage: number | null; diskUsage: number | null; diskFreeMb: number | null
  sandboxCount: number; sandboxRunning: number; version: string | null; hostname: string | null
  lastHeartbeatAt: string | null; heartbeatAgeSec: number | null
  maxSandboxes: number; storageUsedMb: number
  evictedAt: string | null; evictReason: string | null; createdAt: string
}

interface CreatedCredential {
  nodeUuid: string
  apiKey: string
  deploy: Record<string, string>
}

function pct(v: number | null | undefined): string {
  return v == null ? "-" : `${Math.round(v)}%`
}
function barTone(v: number | null | undefined): string {
  if (v == null) return "bg-muted"
  if (v >= 90) return "bg-red-500"
  if (v >= 70) return "bg-amber-500"
  return "bg-emerald-500"
}

export function WorkNodesPanel({ initialNodes, canManage }: { initialNodes: WorkNodeRow[]; canManage: boolean }) {
  const [nodes, setNodes] = useState<WorkNodeRow[]>(initialNodes)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState("")
  const [region, setRegion] = useState("default")
  const [note, setNote] = useState("")
  const [maxSb, setMaxSb] = useState(20)
  const [creating, setCreating] = useState(false)
  const [credential, setCredential] = useState<CreatedCredential | null>(null)
  const [copied, setCopied] = useState(false)
  const [evictTarget, setEvictTarget] = useState<WorkNodeRow | null>(null)
  const [evictReason, setEvictReason] = useState("")

  // 10s 轮询刷新
  useEffect(() => {
    const t = setInterval(() => {
      void refresh()
    }, 10_000)
    return () => clearInterval(t)
  }, [])

  const refresh = async () => {
    const res = await fetch("/api/master/worknode/list").then((r) => r.json()).catch(() => null)
    if (res?.code === 0 && res.data?.nodes) setNodes(res.data.nodes as WorkNodeRow[])
  }

  const create = async () => {
    setCreating(true)
    try {
      const res = await fetch("/api/master/worknode/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, region, note: note || undefined, maxSandboxes: maxSb }),
      }).then((r) => r.json())
      if (res.code === 0 && res.data) {
        setCredential({ nodeUuid: res.data.nodeUuid, apiKey: res.data.apiKey, deploy: res.data.deploy })
        toast.success("节点已创建（凭证仅本次展示）")
        void refresh()
      } else toast.error(res.msg || "创建失败")
    } finally {
      setCreating(false)
    }
  }

  const evict = async () => {
    if (!evictTarget) return
    if (evictReason.trim().length < 4) { toast.error("驱逐原因至少 4 字符（审计留痕）"); return }
    const res = await fetch("/api/master/worknode/evict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: evictTarget.id, reason: evictReason }),
    }).then((r) => r.json())
    if (res.code === 0) {
      toast.success("节点已驱逐：对应 Worker 将在下次心跳时永久退出")
      setEvictTarget(null); setEvictReason("")
      void refresh()
    } else toast.error(res.msg || "驱逐失败")
  }

  const copyDeploy = () => {
    if (!credential) return
    const env = Object.entries(credential.deploy).map(([k, v]) => `${k}=${v}`).join("\n")
    void navigator.clipboard.writeText(env)
    setCopied(true)
    toast.success("部署环境变量已复制")
    setTimeout(() => setCopied(false), 2000)
  }

  const online = nodes.filter((n) => n.liveStatus === "ONLINE").length

  return (
    <div className="space-y-4">
      {/* 统计卡 */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1"><Server className="h-3 w-3" />节点总数</div>
          <div className="text-xl font-semibold mt-1">{nodes.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1"><Activity className="h-3 w-3" />在线</div>
          <div className="text-xl font-semibold mt-1 text-emerald-600">{online}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1"><Boxes className="h-3 w-3" />沙箱总数</div>
          <div className="text-xl font-semibold mt-1">{nodes.reduce((s, n) => s + n.sandboxRunning, 0)}</div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" />平均负载</div>
          <div className="text-xl font-semibold mt-1">
            {online > 0 ? pct(nodes.filter((n) => n.liveStatus === "ONLINE").reduce((s, n) => s + (n.cpuUsage || 0), 0) / online) : "-"}
          </div>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        {canManage && (
          <Button size="sm" className="gap-1.5" onClick={() => { setCreateOpen(true); setCredential(null); setName(""); setRegion("default"); setNote("") }}>
            <Plus className="h-3.5 w-3.5" />注册 Worker 节点
          </Button>
        )}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" />刷新（10s 自动）
        </Button>
      </div>

      {/* 节点列表 */}
      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="border-b">
              <th className="text-left p-2 font-medium">节点</th>
              <th className="text-left p-2 font-medium w-24">状态</th>
              <th className="text-left p-2 font-medium w-40">资源（CPU/MEM/DISK）</th>
              <th className="text-left p-2 font-medium w-24 hidden sm:table-cell">沙箱</th>
              <th className="text-left p-2 font-medium w-40 hidden md:table-cell">心跳</th>
              <th className="text-right p-2 font-medium w-24">操作</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="p-2">
                  <div className="font-medium">{n.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{n.nodeUuid} · {n.region}{n.hostname ? ` · ${n.hostname}` : ""}</div>
                </td>
                <td className="p-2">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    n.liveStatus === "ONLINE" ? "bg-emerald-500/15 text-emerald-600"
                    : n.liveStatus === "PENDING" ? "bg-sky-500/15 text-sky-600"
                    : n.liveStatus === "EVICTED" ? "bg-red-500/15 text-red-600"
                    : "bg-slate-500/15 text-slate-500"}`}>
                    {{ ONLINE: "在线", PENDING: "待接入", OFFLINE: "离线", EVICTED: "已驱逐" }[n.liveStatus] || n.liveStatus}
                  </span>
                </td>
                <td className="p-2">
                  <div className="flex items-center gap-1.5 text-xs tabular-nums">
                    <div className="w-10">{pct(n.cpuUsage)}</div>
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden"><div className={`h-full ${barTone(n.cpuUsage)}`} style={{ width: `${n.cpuUsage ?? 0}%` }} /></div>
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs tabular-nums mt-1">
                    <div className="w-10">{pct(n.memUsage)}</div>
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden"><div className={`h-full ${barTone(n.memUsage)}`} style={{ width: `${n.memUsage ?? 0}%` }} /></div>
                    <div className="w-10">{pct(n.diskUsage)}</div>
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden"><div className={`h-full ${barTone(n.diskUsage)}`} style={{ width: `${n.diskUsage ?? 0}%` }} /></div>
                  </div>
                </td>
                <td className="p-2 text-xs tabular-nums hidden sm:table-cell">{n.sandboxRunning}/{n.maxSandboxes}</td>
                <td className="p-2 text-xs text-muted-foreground hidden md:table-cell">
                  {n.lastHeartbeatAt ? `${n.heartbeatAgeSec}s 前 · v${n.version || "?"}` : "从未心跳"}
                  {n.evictedAt && <div className="text-red-500 text-[10px]">驱逐：{n.evictReason}</div>}
                </td>
                <td className="p-2 text-right">
                  {canManage && n.liveStatus !== "EVICTED" && (
                    <Button variant="ghost" size="sm" className="text-red-600 h-7" onClick={() => { setEvictTarget(n); setEvictReason("") }}>
                      <ShieldBan className="h-3.5 w-3.5 mr-1" />驱逐
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {nodes.length === 0 && (
              <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">
                暂无 Worker 节点——点击「注册 Worker 节点」生成部署凭证（MASTER_API_URL / WORKER_NODE_UUID / WORKER_API_KEY）
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 创建弹窗（两阶段：表单 → 一次性凭证） */}
      {createOpen && (
        <Dialog open onOpenChange={(v) => { if (!v) setCreateOpen(false) }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>注册 Worker 节点</DialogTitle>
              <DialogDescription>创建后生成唯一凭证（API_KEY 仅展示一次，不可回溯）</DialogDescription>
            </DialogHeader>
            {credential ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
                  ⚠️ Worker 部署三环境变量（关闭后无法找回 API_KEY；遗失只能驱逐重建）
                </div>
                <div className="rounded-lg border bg-muted/40 p-3 font-mono text-xs space-y-1 break-all">
                  {Object.entries(credential.deploy).map(([k, v]) => (
                    <div key={k}><span className="text-muted-foreground">{k}=</span>{v}</div>
                  ))}
                </div>
                <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={copyDeploy}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "已复制" : "复制全部环境变量"}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-[70px_1fr] items-center gap-2 text-sm">
                  <span>名称</span><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="worker-bj-01" />
                  <span>区域</span><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="default / beijing / shanghai" />
                  <span>沙箱上限</span><Input type="number" value={maxSb} onChange={(e) => setMaxSb(Number(e.target.value) || 20)} />
                  <span>备注</span><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
                </div>
                <div className="text-xs text-muted-foreground">
                  Worker 启动命令：<code className="bg-muted px-1 rounded">bun run mini-services/worker</code>（容器镜像内已内置）
                </div>
              </div>
            )}
            <DialogFooter>
              {!credential && <Button size="sm" disabled={creating || name.length < 2} onClick={() => void create()}>创建并生成凭证</Button>}
              {credential && <Button size="sm" onClick={() => setCreateOpen(false)}>我已保存凭证，关闭</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 驱逐弹窗 */}
      {evictTarget && (
        <Dialog open onOpenChange={(v) => { if (!v) setEvictTarget(null) }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-red-600">驱逐节点「{evictTarget.name}」</DialogTitle>
              <DialogDescription>
                驱逐后对应 Worker 永久失效（心跳 403 → 自动退出），无法再接入集群；密钥泄露场景使用
              </DialogDescription>
            </DialogHeader>
            <Input value={evictReason} onChange={(e) => setEvictReason(e.target.value)} placeholder="驱逐原因（至少 4 字符，审计留痕）" autoFocus />
            <DialogFooter>
              <Button variant="destructive" size="sm" onClick={() => void evict()}>确认驱逐</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
