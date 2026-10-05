"use client"

// r38：用户侧硬件权限申请面板（沙箱详情页挂载）
// · 展示当前生效授权（GRANTED 未过期）+ 申请历史
// · 提交新申请（17 项硬件权限选择 + 理由）→ 管理员在 /admin/hardware 审批
// · 申请批准后 resolveHardwarePolicy 即视为 enabled（无需重启沙箱）

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loader2, Send, Cpu, CheckCircle2 } from "lucide-react"
import { createHardwareRequestAction, listMyHardwareRequestsAction, type HardwareRequestItem } from "@/server/actions/hardware-requests"
import { listHardwarePermDefsAction } from "@/server/actions/hardware-policy-actions"

export function UserHardwareRequests({ workspaceId }: { workspaceId: string }) {
  const [requests, setRequests] = useState<HardwareRequestItem[]>([])
  const [defs, setDefs] = useState<Array<{ id: string; label: string; group: string; danger: boolean | null }>>([])
  const [permId, setPermId] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await listMyHardwareRequestsAction()
      if (res.code === 0) setRequests((res.data as { requests: HardwareRequestItem[] }).requests)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void listHardwarePermDefsAction().then((r) => {
      if (r.code === 0) {
        const list = r.data as Array<{ id: string; label: string; group: string; danger: boolean | null }>
        setDefs(list)
        if (list.length > 0) setPermId(list[0].id)
      }
    })
  }, [refresh])

  const grantedNow = useMemo(() => {
    const now = Date.now()
    return requests.filter((r) => r.mode === "GRANTED" && (!r.expiresAt || new Date(r.expiresAt).getTime() > now))
  }, [requests])

  const onSubmit = async () => {
    if (!permId) return toast.error("请选择硬件权限")
    setBusy(true)
    try {
      const res = await createHardwareRequestAction({ permId, workspaceId, reason: reason || undefined })
      if (res.code === 0) {
        toast.success(res.msg || "申请已提交，等待管理员审批")
        setReason("")
        void refresh()
      } else {
        toast.error(res.msg || "提交失败")
      }
    } finally {
      setBusy(false)
    }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, Array<{ id: string; label: string; danger: boolean | null }>>()
    for (const d of defs) {
      if (!g.has(d.group)) g.set(d.group, [])
      g.get(d.group)!.push({ id: d.id, label: d.label, danger: d.danger })
    }
    return Array.from(g.entries())
  }, [defs])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><Cpu className="h-4 w-4" />硬件权限申请</CardTitle>
        <CardDescription>
          需要摄像头/麦克风/USB 等硬件时提交申请，管理员批准后即时生效（静默模式无需申请 —— 由管理员在策略中直接放行）
          {grantedNow.length > 0 && ` · 当前生效 ${grantedNow.length} 项`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 生效授权 */}
        {grantedNow.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />生效中的授权</p>
            {grantedNow.map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded border border-emerald-200 dark:border-emerald-800 px-2 py-1.5 text-xs">
                <span className="font-medium">{g.permLabel}</span>
                <span className="text-muted-foreground">
                  {g.expiresAt ? `剩余至 ${new Date(g.expiresAt).toLocaleString()}` : "长期有效"} · 批准人 {g.decidedByName ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 申请表单 */}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">硬件权限</p>
              <select
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
                value={permId}
                onChange={(e) => setPermId(e.target.value)}
              >
                {grouped.map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>{i.label}{i.danger ? "（高危）" : ""}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">申请理由（选填）</p>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：视频会议需要麦克风" className="h-9" />
            </div>
          </div>
          <Button size="sm" onClick={onSubmit} disabled={busy || !permId}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}提交申请
          </Button>
        </div>

        {/* 历史 */}
        {loading ? (
          <p className="text-xs text-muted-foreground text-center py-2 flex items-center justify-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />加载中…</p>
        ) : requests.length > 0 ? (
          <div className="space-y-1 max-h-48 overflow-auto">
            {requests.slice(0, 20).map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs rounded border px-2 py-1.5">
                <Badge
                  variant="outline"
                  className={
                    r.mode === "GRANTED" ? "border-emerald-300 text-emerald-700 dark:text-emerald-300"
                      : r.mode === "PENDING" ? "border-amber-300 text-amber-700 dark:text-amber-300"
                        : "text-muted-foreground"
                  }
                >
                  {r.mode === "GRANTED" ? "已授权" : r.mode === "PENDING" ? "待审批" : r.mode === "DENIED" ? "已拒绝" : r.mode === "REVOKED" ? "已撤销" : r.mode}
                </Badge>
                <span className="font-medium">{r.permLabel}</span>
                {r.reason && <span className="truncate text-muted-foreground">“{r.reason}”</span>}
                <span className="ml-auto shrink-0 text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center">暂无申请记录</p>
        )}
      </CardContent>
    </Card>
  )
}
