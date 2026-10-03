import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { myRecordingsAction, type RecordingRow } from "@/server/actions/recordings"
import { MyRecordingsPanel } from "./my-recordings-panel"
import { Video, HardDrive, Clock } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"

// ============================================================
// 我的录像（r27 用户空间；r31 增强筛选）：本人工作区 VNC 会话录像
// 权限：仅本人录像（回放/下载）；删除与治理归管理员（审计完整性）
// 可见性受 vnc.recordingUserVisible 全局开关管控（关闭=本页空态提示）
// r31 筛选：关键词搜索 + 可搜索多选沙箱（沙箱多时 Tab 无法定位 → 多选筛选）
// ============================================================
export const metadata = { title: "我的录像" }

export default async function MyRecordingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = (sp.q as string | undefined) || ""
  const wsParam = (sp.ws as string | undefined) || ""
  const wsIds = wsParam ? wsParam.split(",").filter(Boolean).slice(0, 50) : []

  // 本人沙箱清单（多选筛选项：含运行状态点与录像计数）
  const wsList = await db.browserWorkspace.findMany({
    where: { userId: ctx.userId, deletedAt: null },
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  }).catch(() => [])
  // 录像计数（按沙箱聚合）
  const recCounts = await db.vncRecording.groupBy({
    by: ["workspaceId"],
    where: { userId: ctx.userId, deletedAt: null },
    _count: { id: true },
  }).catch(() => [] as Array<{ workspaceId: string; _count: { id: number } }>)
  const countById = new Map<string, number>(recCounts.map((c) => [c.workspaceId, c._count.id] as [string, number]))
  const workspaces = wsList.map((w) => ({
    id: w.id,
    name: w.name,
    status: w.status,
    recordingCount: countById.get(w.id) || 0,
  }))

  const res = await myRecordingsAction({ keyword: q || undefined, ...(wsIds.length > 0 ? { workspaceIds: wsIds } : {}), take: 200 })
  const rows: RecordingRow[] = res.data?.rows || []
  const usage = res.data?.usage || { segments: 0, totalBytes: 0, totalDurationSec: 0, quotaGb: 0, oldestAt: null }
  const retentionDays = res.data?.retentionDays ?? 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的录像</h1>
        <p className="text-sm text-muted-foreground mt-1">
          您工作区的 VNC 会话录像（存放在您的专属空间）；回放与下载全程审计留痕
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard title="录像素材" value={usage.segments} sub="分段数" icon={<Video className="h-4 w-4" />} />
        <StatCard
          title="空间占用"
          value={fmtBytes(usage.totalBytes)}
          sub={usage.quotaGb > 0 ? `配额 ${usage.quotaGb}GB` : "不限"}
          icon={<HardDrive className="h-4 w-4" />}
          tone={usage.quotaGb > 0 && usage.totalBytes > usage.quotaGb * 1024 ** 3 * 0.8 ? "warning" : "default"}
        />
        <StatCard
          title="总时长"
          value={`${(usage.totalDurationSec / 3600).toFixed(1)}h`}
          sub={retentionDays > 0 ? `保留 ${retentionDays} 天` : "永久保留"}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      <MyRecordingsPanel rows={rows} keyword={q} wsIds={wsIds} workspaces={workspaces} quotaPct={usage.quotaGb > 0 ? Math.min(100, (usage.totalBytes / (usage.quotaGb * 1024 ** 3)) * 100) : null} />
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
