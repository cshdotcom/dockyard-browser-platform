import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { fmtDate } from "@/lib/utils-server"
import { Megaphone, Globe2, Users } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"
import { AnnouncementsView, type AnnouncementRow } from "./announcements-view"

// 用户侧公告页：对当前用户可见的公告（GLOBAL / GROUP∈我的组 / USER=我）
// 展示形态：POPUP 弹窗（未读自动弹出）/ MARQUEE 跑马灯 / FORCE_VIEW 全屏强制阅读
export const metadata = { title: "平台公告" }

const DISPLAY_LABEL: Record<string, string> = { POPUP: "弹窗", MARQUEE: "跑马灯", FORCE_VIEW: "强制阅读" }
const TYPE_LABEL: Record<string, string> = { GLOBAL: "全站", GROUP: "用户组", USER: "定向" }

export default async function AnnouncementsPage() {
  const ctx = await requireAuth()
  const gids = await userGroupIds(ctx.userId)

  const where = {
    enabled: true,
    OR: [
      { type: "GLOBAL" },
      { type: "GROUP", groupId: { in: gids } },
      { type: "USER", userId: ctx.userId },
    ],
  }

  const [anns, globalCount, groupCount, userCount] = await Promise.all([
    db.announcement.findMany({ where, orderBy: { createdAt: "desc" } }),
    db.announcement.count({ where: { type: "GLOBAL", enabled: true } }),
    db.announcement.count({ where: { type: "GROUP", groupId: { in: gids }, enabled: true } }),
    db.announcement.count({ where: { type: "USER", userId: ctx.userId, enabled: true } }),
  ])

  const reads = anns.length
    ? await db.announcementRead.findMany({ where: { userId: ctx.userId, announcementId: { in: anns.map((a) => a.id) } } })
    : []
  const readSet = new Set(reads.map((r) => r.announcementId))

  const rows: AnnouncementRow[] = anns.map((a) => ({
    id: a.id,
    title: a.title,
    content: a.content,
    type: a.type,
    typeLabel: TYPE_LABEL[a.type] || a.type,
    displayType: a.displayType,
    displayLabel: DISPLAY_LABEL[a.displayType] || a.displayType,
    read: readSet.has(a.id),
    createdAt: fmtDate(a.createdAt),
  }))

  const unreadCount = rows.filter((r) => !r.read).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">平台公告</h1>
        <p className="text-sm text-muted-foreground mt-1">
          面向你的全站通知、组通知与定向消息；重要公告会以强制阅读方式呈现
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="可见公告" value={rows.length} sub="启用中" icon={<Megaphone className="h-4 w-4" />} />
        <StatCard title="未读" value={unreadCount} sub={unreadCount > 0 ? "包含弹窗与强制阅读公告" : "全部已读"} icon={<Megaphone className="h-4 w-4" />} tone={unreadCount > 0 ? "warning" : "success"} />
        <StatCard title="全站公告" value={globalCount} sub="GLOBAL" icon={<Globe2 className="h-4 w-4" />} />
        <StatCard title="组 / 定向" value={groupCount + userCount} sub={`组 ${groupCount} · 定向 ${userCount}`} icon={<Users className="h-4 w-4" />} />
      </div>

      <AnnouncementsView rows={rows} />
    </div>
  )
}
