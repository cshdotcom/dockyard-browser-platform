import { requireAuth } from "@/lib/permissions"
import { myRecordingsAction, type RecordingRow } from "@/server/actions/recordings"
import { MyRecordingsPanel } from "./my-recordings-panel"
import { Video, HardDrive, Clock } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"

// ============================================================
// 我的录像（r27 用户空间）：本人工作区 VNC 会话录像
// 权限：仅本人录像（回放/下载）；删除与治理归管理员（审计完整性）
// 可见性受 vnc.recordingUserVisible 全局开关管控（关闭=本页空态提示）
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

  const res = await myRecordingsAction({ keyword: q || undefined, take: 200 })
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

      <MyRecordingsPanel rows={rows} keyword={q} quotaPct={usage.quotaGb > 0 ? Math.min(100, (usage.totalBytes / (usage.quotaGb * 1024 ** 3)) * 100) : null} />
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
