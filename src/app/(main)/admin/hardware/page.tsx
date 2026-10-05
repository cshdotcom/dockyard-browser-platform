"use client"

// ============================================================
// r38：硬件透传监控中心（管理员）
//   ① 待审批队列（批准[可设有效期]/拒绝）
//   ② 活跃授权表（撤销 + 到期倒计时）
//   ③ 17 项权限分布统计（组维度 + 危险标记）
//   ④ 硬件操作审计流（HARDWARE_* 事件）
// 静默/申请双模式说明：静默=策略链直接放行（无提示监控，仅超管 silent 开关）；
// 申请=本页审批流（GRANTED 即 resolveHardwarePolicy 生效）。
// ============================================================

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Cpu, CheckCircle2, XCircle, ShieldAlert, Loader2, Ban, Clock } from "lucide-react"
import { hardwareMonitorAction, listHardwareRequestsAdminAction, decideHardwareRequestAction } from "@/server/actions/hardware-requests"

interface MonitorData {
  perms: Array<{ permId: string; permLabel: string; group: string; activeGrants: number; danger: boolean }>
  activeGrants: Array<{
    id: string; username: string; displayName: string | null; workspaceId: string | null
    workspaceName: string | null; permId: string; permLabel: string
    expiresAt: string | null; decidedByName: string | null; grantedAt: string
  }>
  recentAudit: Array<{ at: string; operator: string; op: string; target: string; severity: string }>
  pendingCount: number
}

interface PendingItem {
  id: string; userId: string; username: string; displayName: string | null
  workspaceId: string | null; workspaceName: string | null
  permId: string; permLabel: string; reason: string | null; createdAt: string
}

export default function AdminHardwarePage() {
  const [monitor, setMonitor] = useState<MonitorData | null>(null)
  const [pending, setPending] = useState<PendingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expireInput, setExpireInput] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      const [m, list] = await Promise.all([hardwareMonitorAction(), listHardwareRequestsAdminAction({ take: 50 })])
      if (m.code === 0) setMonitor(m.data as MonitorData)
      if (list.code === 0) setPending((list.data as { pending: PendingItem[] }).pending)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const decide = async (id: string, decision: "GRANTED" | "DENIED" | "REVOKED") => {
    const hours = parseInt(expireInput[id] || "", 10)
    setBusyId(id)
    try {
      const res = await decideHardwareRequestAction({
        id,
        decision,
        ...(decision === "GRANTED" && hours > 0 ? { expireHours: hours } : {}),
      })
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        void refresh()
      } else {
        toast.error(res.msg || "操作失败")
      }
    } finally {
      setBusyId(null)
    }
  }

  const fmtExpire = (iso: string | null) => {
    if (!iso) return "永久"
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return "已过期"
    if (ms < 3600_000) return `${Math.ceil(ms / 60000)} 分钟`
    if (ms < 86400_000) return `${Math.ceil(ms / 3600000)} 小时`
    return `${Math.ceil(ms / 86400000)} 天`
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Cpu className="h-6 w-6 text-teal-600" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">硬件透传监控</h1>
          <p className="text-sm text-muted-foreground">静默/申请双模式 · 17 项硬件权限 · 审批与实时监控</p>
        </div>
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="pt-5">
          <div className="text-2xl font-bold text-amber-600">{monitor?.pendingCount ?? pending.length}</div>
          <p className="text-xs text-muted-foreground mt-1">待审批申请</p>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <div className="text-2xl font-bold text-emerald-600">{monitor?.activeGrants.length ?? 0}</div>
          <p className="text-xs text-muted-foreground mt-1">活跃授权中</p>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <div className="text-2xl font-bold">{monitor?.perms.length ?? 17}</div>
          <p className="text-xs text-muted-foreground mt-1">硬件权限项</p>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <div className="text-2xl font-bold">{monitor?.recentAudit.length ?? 0}</div>
          <p className="text-xs text-muted-foreground mt-1">近期审计事件</p>
        </CardContent></Card>
      </div>

      {/* 待审批队列 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="h-4 w-4" />待审批申请</CardTitle>
          <CardDescription>用户提交的硬件使用申请（批准后即时生效；可设有效期，到期自动失效）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {pending.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无待审批申请</p>}
          {pending.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <div className="flex-1 min-w-40">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{p.username}</span>
                  {p.displayName && <span className="text-muted-foreground text-xs">{p.displayName}</span>}
                  <Badge variant="outline">{p.permLabel}</Badge>
                  {p.workspaceName && <span className="text-xs text-muted-foreground">沙箱：{p.workspaceName}</span>}
                </div>
                {p.reason && <p className="text-xs text-muted-foreground mt-1">理由：{p.reason}</p>}
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(p.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="有效小时（空=永久）"
                  className="w-36 h-8 text-xs"
                  inputMode="numeric"
                  value={expireInput[p.id] ?? ""}
                  onChange={(e) => setExpireInput({ ...expireInput, [p.id]: e.target.value })}
                />
                <Button size="sm" variant="default" disabled={busyId === p.id} onClick={() => decide(p.id, "GRANTED")}>
                  {busyId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}批准
                </Button>
                <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => decide(p.id, "DENIED")}>
                  <XCircle className="h-4 w-4" />拒绝
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 活跃授权 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" />活跃授权</CardTitle>
          <CardDescription>当前生效的硬件授权（resolveHardwarePolicy 解析时视为 enabled）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(monitor?.activeGrants ?? []).length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无活跃授权</p>}
          {(monitor?.activeGrants ?? []).map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <div className="flex-1 min-w-40 text-sm">
                <span className="font-medium">{g.username}</span>
                <Badge variant="outline" className="ml-2">{g.permLabel}</Badge>
                {g.workspaceName && <span className="text-xs text-muted-foreground ml-2">沙箱：{g.workspaceName}</span>}
                <span className="text-xs text-muted-foreground ml-2">剩余 {fmtExpire(g.expiresAt)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>批准人：{g.decidedByName ?? "—"}</span>
                <Button size="sm" variant="outline" disabled={busyId === g.id} onClick={() => decide(g.id, "REVOKED")}>
                  <Ban className="h-4 w-4" />撤销
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 权限分布 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">权限分布（按组）</CardTitle>
          <CardDescription>17 项硬件权限当前活跃授权分布（危险权限红标）</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
            {(monitor?.perms ?? []).map((p) => (
              <div key={p.permId} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span className="flex items-center gap-1.5">
                  {p.danger && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
                  {p.permLabel}
                  <span className="text-xs text-muted-foreground">{p.group}</span>
                </span>
                <Badge variant={p.activeGrants > 0 ? "default" : "secondary"}>{p.activeGrants}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 审计流 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">硬件操作审计流</CardTitle>
          <CardDescription>HARDWARE_* 审计事件（申请/批准/拒绝/撤销 + 策略变更）</CardDescription>
        </CardHeader>
        <CardContent>
          {(monitor?.recentAudit ?? []).length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无审计事件</p>}
          <div className="space-y-1.5 max-h-72 overflow-auto">
            {(monitor?.recentAudit ?? []).map((a, i) => (
              <div key={i} className="flex items-center gap-2 text-xs rounded border px-2 py-1.5">
                <span className="text-muted-foreground w-36 shrink-0">{new Date(a.at).toLocaleString()}</span>
                <Badge variant="outline" className="shrink-0">{a.op.replace("HARDWARE_", "")}</Badge>
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
