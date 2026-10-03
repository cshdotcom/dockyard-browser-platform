"use client"

// ============================================================
// r29-b：用户端监控横幅（知情模式）
//   · 轮询 myMonitorStatusAction（30s）——静默特权授权对用户不可见（服务端过滤）
//   · 红点脉冲 + 监控通道明示 + 授权管理员名 + 一键切断
//   · 切断 → cutOffMonitorAction（仅 CONSENT 模式可切；审计 MONITOR_USER_CUTOFF）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Eye, ShieldOff, Loader2 } from "lucide-react"
import { myMonitorStatusAction, cutOffMonitorAction } from "@/server/actions/monitor-actions"

const CHANNEL_LABEL: Record<string, string> = { camera: "摄像头", microphone: "麦克风", screenShare: "屏幕共享" }

export function MonitorBanner({ workspaceId }: { workspaceId: string }) {
  const [grants, setGrants] = React.useState<Array<{ channel: string; grantedByName: string }>>([])
  const [cutting, setCutting] = React.useState(false)

  React.useEffect(() => {
    let stop = false
    const poll = async () => {
      const res = await myMonitorStatusAction({ workspaceIds: [workspaceId] }).catch(() => null)
      if (!stop && res?.code === 0 && res.data) {
        setGrants(res.data.grants.map((g) => ({ channel: g.channel, grantedByName: g.grantedByName })))
      }
    }
    void poll()
    const t = setInterval(() => void poll(), 30_000)
    return () => { stop = true; clearInterval(t) }
  }, [workspaceId])

  if (grants.length === 0) return null

  const cutOff = async () => {
    setCutting(true)
    try {
      const res = await cutOffMonitorAction({ workspaceId })
      if (res.code === 0) {
        toast.success(`已切断管理员监控（${res.data?.cut || 0} 项授权终止）`)
        setGrants([])
      } else toast.error(res.msg || "切断失败")
    } finally {
      setCutting(false)
    }
  }

  const channels = grants.map((g) => CHANNEL_LABEL[g.channel] || g.channel).join("、")
  const by = grants[0]?.grantedByName

  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
      </span>
      <Eye className="h-4 w-4 shrink-0" />
      <span className="min-w-0">
        管理员<span className="font-medium"> {by} </span>正在监控此沙箱：
        <span className="font-medium">{channels}</span>
        <span className="ml-1 text-[11px] opacity-70">（知情模式，您可随时切断）</span>
      </span>
      <button
        onClick={() => void cutOff()}
        disabled={cutting}
        className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md bg-red-600 hover:bg-red-700 text-white px-2.5 py-1 text-xs font-medium disabled:opacity-60"
      >
        {cutting ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
        一键切断
      </button>
    </div>
  )
}
