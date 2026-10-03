import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { announcementTargetsUser } from "@/lib/announcement-targets"
import { fmtDate } from "@/lib/utils-server"
import { Megaphone, Globe2, Users } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"
import { AnnouncementsView, type AnnouncementRow } from "./announcements-view"

// 用户侧公告页：对当前用户可见的公告（GLOBAL / GROUP∈我的组 / USER=我）
// 展示形态：POPUP 弹窗（未读自动弹出）/ MARQUEE 跑马灯 / FORCE_VIEW 全屏强制阅读
// r22：支持 ?focus=<id> 定位（站内信「查看详情」落地：自动打开详情弹窗）；仅站内信公告也纳入列表回看
export const metadata = { title: "平台公告" }

const DISPLAY_LABEL: Record<string, string> = { POPUP: "弹窗", MARQUEE: "跑马灯", FORCE_VIEW: "强制阅读" }
const TYPE_LABEL: Record<string, string> = { GLOBAL: "全站", GROUP: "用户组", USER: "定向" }

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const gids = await userGroupIds(ctx.userId)
  // focus 定位参数：站内信「查看详情」跳转 /announcements?focus=<id>（自动打开详情弹窗）
  const sp = await searchParams
  const focusRaw = sp.focus
  const focusId = typeof focusRaw === "string" && focusRaw ? focusRaw : Array.isArray(focusRaw) ? focusRaw[0] : undefined

  const now = new Date()
  // r30：范围多选 union 匹配 —— 先取时间窗内全部启用公告（量级小），
  // 内存匹配 GLOBAL / 组多选任一命中 / 用户多选命中（含组+用户混合范围）
  const candidates = await db.announcement.findMany({
    where: {
      enabled: true,
      AND: [
        { OR: [{ startAt: null }, { startAt: { lte: now } }] },
        { OR: [{ endAt: null }, { endAt: { gt: now } }] },
      ],
    },
    orderBy: { createdAt: "desc" },
  })
  const anns = candidates.filter((a) => announcementTargetsUser(a, ctx.userId, gids))
  const globalCount = anns.filter((a) => a.type === "GLOBAL").length
  const groupCount = anns.filter((a) => a.type !== "GLOBAL" && a.type !== "USER").length
  const userCount = anns.filter((a) => a.type === "USER").length

  const reads = anns.length
    ? await db.announcementRead.findMany({ where: { userId: ctx.userId, announcementId: { in: anns.map((a) => a.id) } } })
    : []
  const readSet = new Set(reads.map((r) => r.announcementId))

  const rows: AnnouncementRow[] = anns.map((a) => {
    // 多选发布通道解析（旧数据回退单值 displayType）
    let displayTypes: string[] = []
    try {
      const parsed = JSON.parse(a.displayTypes || "[]")
      if (Array.isArray(parsed)) displayTypes = parsed.filter((x) => typeof x === "string")
    } catch { /* ignore */ }
    // 仅站内信公告（无展示通道）不进入公告列表渲染（只在通知铃呈现）
    return {
      id: a.id,
      title: a.title,
      content: a.content,
      type: a.type,
      typeLabel: TYPE_LABEL[a.type] || a.type,
      displayType: a.displayType,
      displayLabel: DISPLAY_LABEL[a.displayType] || a.displayType,
      displayTypes,
      notifyInbox: !!a.notifyInbox,
      read: readSet.has(a.id),
      createdAt: fmtDate(a.createdAt),
    }
  })
  // 列表展示：至少有一种展示通道的公告（纯站内信公告只在通知铃/消息中心出现）
  const displayRows = rows.filter((r) => (r.displayTypes?.length ? r.displayTypes : [r.displayType]).length > 0)
  // focus 落地：站内信「查看详情」指向的公告若为仅站内信（无展示通道），也纳入列表以打开详情弹窗
  let listRows = displayRows
  if (focusId) {
    const target = rows.find((r) => r.id === focusId)
    if (target && !displayRows.some((r) => r.id === focusId)) listRows = [...displayRows, target]
  }

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
        <StatCard title="可见公告" value={displayRows.length} sub="含展示通道（弹窗/跑马灯/强制阅读）" icon={<Megaphone className="h-4 w-4" />} />
        <StatCard title="未读" value={unreadCount} sub={unreadCount > 0 ? "包含弹窗与强制阅读公告" : "全部已读"} icon={<Megaphone className="h-4 w-4" />} tone={unreadCount > 0 ? "warning" : "success"} />
        <StatCard title="全站公告" value={globalCount} sub="GLOBAL" icon={<Globe2 className="h-4 w-4" />} />
        <StatCard title="组 / 定向" value={groupCount + userCount} sub={`组 ${groupCount} · 定向 ${userCount}`} icon={<Users className="h-4 w-4" />} />
      </div>

      <AnnouncementsView rows={listRows} focusId={focusId} />
    </div>
  )
}
