import { requireAdmin } from "@/lib/permissions"
import { listRecordingsAction, listRecordingRecycleAction, type RecordingRow } from "@/server/actions/recordings"
import { StatCard } from "@/components/shared/confirm"
import { RecordingsPanel } from "./recordings-panel"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { Video, HardDrive, Clock, Radio } from "lucide-react"

// ============================================================
// 录像管理（r27 管理后台）：全站 VNC 会话录像回放 / 下载 / 回收站 / 治理策略
// RBAC：ADMIN+ 全站；GROUP_ADMIN 所辖组；（用户空间「我的录像」在 /recordings）
// ============================================================
export const metadata = { title: "录像管理" }

export default async function AdminRecordingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAdmin()
  const sp = await searchParams
  const q = (sp.q as string | undefined) || ""
  const tab = (sp.tab as string | undefined) === "recycle" ? "recycle" : "list"
  const status = (sp.status as string | undefined) || "ALL"
  const canManage = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"

  const [listRes, recycleRes, userVisible, quotaGb, retentionDays, fps, segMin] = await Promise.all([
    listRecordingsAction({ keyword: q || undefined, status: status as "ALL" | "RECORDING" | "COMPLETED" | "FAILED", take: 200 }),
    tab === "recycle" ? listRecordingRecycleAction({}) : Promise.resolve({ code: 0, data: { entries: [] } as { entries: never[] } }),
    getConfigBool("vnc.recordingUserVisible", true),
    getConfigNumber("vnc.recordingQuotaGb", 5),
    getConfigNumber("vnc.recordingRetentionDays", 90),
    getConfigNumber("vnc.recordingFps", 12),
    getConfigNumber("vnc.recordingSegmentMinutes", 15),
  ])

  const rows: RecordingRow[] = listRes.data?.rows || []
  const stats = listRes.data?.stats || { segments: 0, sessions: 0, totalBytes: 0, totalDurationSec: 0, recordingNow: 0, quotaGb: 0, retentionDays: 0, userVisible: true }
  const recycleEntries = recycleRes.data?.entries || []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">录像管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          VNC 会话录屏审计中枢：回放 / 下载 / 取证备注 / 回收站 / 保留期与配额治理（后台可查看全站录像）
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="录像会话" value={stats.sessions} sub={`${stats.segments} 个分段`} icon={<Video className="h-4 w-4" />} />
        <StatCard title="正在录制" value={stats.recordingNow} sub="进行中的会话" icon={<Radio className="h-4 w-4" />} tone={stats.recordingNow > 0 ? "success" : "default"} />
        <StatCard
          title="存储占用"
          value={fmtBytes(stats.totalBytes)}
          sub={`${(stats.totalDurationSec / 3600).toFixed(1)} 小时素材`}
          icon={<HardDrive className="h-4 w-4" />}
        />
        <StatCard
          title="治理策略"
          value={`${retentionDays}天`}
          sub={`配额 ${quotaGb}GB/用户 · ${fps}fps · 分段${segMin}分钟`}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      <RecordingsPanel
        rows={rows}
        recycleEntries={recycleEntries}
        tab={tab}
        status={status}
        keyword={q}
        canManage={canManage}
        userVisible={userVisible}
        isSuper={ctx.role === "SUPER_ADMIN"}
      />
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
