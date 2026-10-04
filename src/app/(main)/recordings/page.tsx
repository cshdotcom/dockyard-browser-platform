import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { myRecordingsAction, type RecordingRow } from "@/server/actions/recordings"
import { MyRecordingsPanel } from "./my-recordings-panel"
import { Camera, Video, HardDrive, Clock } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"

// ============================================================
// 我的录像（r27 用户空间；r31 增强筛选）：本人工作区 VNC 会话录像
// 权限：仅本人录像（回放/下载）；删除与治理归管理员（审计完整性）
// 可见性受 vnc.recordingUserVisible 全局开关管控（关闭=本页空态提示）
// r31 筛选：关键词搜索 + 可搜索多选沙箱（沙箱多时 Tab 无法定位 → 多选筛选）
// ============================================================
export const metadata = { title: "我的记录（录像/截图）" }

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

  // r34：截图统计与最近截图（与录像同处「我的记录」页 —— 用户诉求：截图录像放同一个里面）
  const shotAgg = await db.fileMeta.aggregate({
    where: { userId: ctx.userId, category: "SCREENSHOT", deletedAt: null },
    _count: { _all: true },
    _sum: { size: true },
  }).catch(() => ({ _count: { _all: 0 }, _sum: { size: 0 } }))
  const recentShots = await db.fileMeta.findMany({
    where: { userId: ctx.userId, category: "SCREENSHOT", deletedAt: null },
    select: { id: true, fileName: true, size: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 8,
  }).catch(() => [])
  const fmtDate = (d: Date) => new Date(d).toLocaleString("zh-CN")



  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的记录（录像 / 截图）</h1>
        <p className="text-sm text-muted-foreground mt-1">
          您工作区的 VNC 会话录像与截图统一存放于您的专属记录空间（云端存储、计入个人配额）；回放与下载全程审计留痕
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="记录素材" value={usage.segments} sub="录像分段数" icon={<Video className="h-4 w-4" />} />
        <StatCard title="截图" value={shotAgg._count._all} sub={fmtBytes(shotAgg._sum.size || 0)} icon={<Camera className="h-4 w-4" />} />
        <StatCard
          title="空间占用"
          value={fmtBytes(usage.totalBytes + (shotAgg._sum.size || 0))}
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

      {/* r34：最近截图卡（点击直达文件管理定位） */}
      {recentShots.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-1.5"><Camera className="h-4 w-4 text-cyan-600" />最近截图</h2>
            <a href="/files?domain=SCREENSHOT" className="text-xs text-teal-600 hover:underline">在文件管理中查看全部 →</a>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            {recentShots.map((s) => (
              <a key={s.id} href={`/files?focus=${s.id}&domain=SCREENSHOT`} className="group rounded-md border p-2 hover:border-teal-300 hover:bg-teal-50/40 transition-colors" title={`${s.fileName} · ${fmtDate(s.createdAt)}`}>
                <div className="flex items-center gap-1.5 min-w-0">
                  <Camera className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                  <span className="text-[11px] truncate">{s.fileName}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">{fmtDate(s.createdAt)}</p>
                <p className="text-[10px] text-muted-foreground">{fmtBytes(s.size || 0)}</p>
              </a>
            ))}
          </div>
        </div>
      )}

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
