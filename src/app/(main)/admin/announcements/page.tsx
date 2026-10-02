import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { AnnouncementsTable, type AnnouncementRow } from "./announcements-table"
import { Megaphone, Globe2, Eye, ToggleRight } from "lucide-react"

// 公告管理（管理员）：CRUD + 展示方式预览
export const metadata = { title: "公告管理" }

export default async function AdminAnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters

  const where: Record<string, unknown> = {}
  if (f.type) where.type = f.type
  if (f.displayType) where.displayType = f.displayType
  if (f.enabled) where.enabled = f.enabled === "true"
  if (q.keyword) where.OR = [{ title: { contains: q.keyword } }, { content: { contains: q.keyword } }]

  const [rows, total, totalCount, enabledCount, globalCount] = await Promise.all([
    db.announcement.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "title", "type"], { createdAt: "desc" }),
    }),
    db.announcement.count({ where }),
    db.announcement.count(),
    db.announcement.count({ where: { enabled: true } }),
    db.announcement.count({ where: { type: "GLOBAL" } }),
  ])

  // 范围名称（组名 / 用户名）与创建人（内存 join）
  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((v): v is string => !!v))]
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))]
  const creatorIds = [...new Set(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v))]
  const groups = groupIds.length ? await db.group.findMany({ where: { id: { in: groupIds }, deletedAt: null }, select: { id: true, name: true } }) : []
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : []
  const creators = creatorIds.length ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } }) : []
  const groupMap = new Map<string, string>(groups.map((g): [string, string] => [g.id, g.name]))
  const userMap = new Map<string, string>(users.map((u): [string, string] => [u.id, u.username]))
  const creatorMap = new Map<string, string>(creators.map((c): [string, string] => [c.id, c.username]))

  const list: AnnouncementRow[] = rows.map((a) => {
    // 多选发布通道解析（旧数据无 displayTypes → 回退单值）
    let displayTypes: string[] = []
    try {
      const parsed = JSON.parse(a.displayTypes || "[]")
      if (Array.isArray(parsed)) displayTypes = parsed.filter((x) => typeof x === "string")
    } catch { /* ignore */ }
    return {
      id: a.id,
      title: a.title,
      content: a.content,
      type: a.type,
      groupId: a.groupId,
      groupName: a.groupId ? groupMap.get(a.groupId) || a.groupId : null,
      userId: a.userId,
      targetUsername: a.userId ? userMap.get(a.userId) || a.userId : null,
      displayType: a.displayType,
      displayTypes,
      notifyInbox: !!a.notifyInbox,
      notifiedAt: a.notifiedAt ? fmtDate(a.notifiedAt) : null,
      startAt: a.startAt ? fmtDate(a.startAt) : null,
      endAt: a.endAt ? fmtDate(a.endAt) : null,
      persistAfterRead: !!a.persistAfterRead,
      allowDismiss: a.allowDismiss !== false,
      enabled: a.enabled,
      creatorName: a.createdByUserId ? creatorMap.get(a.createdByUserId) || a.createdByUserId : "系统",
      createdAt: fmtDate(a.createdAt),
    }
  })

  // 表单选择器数据：组选项 + 用户选项（USER 类型选择器搜索用）
  const [groupOptions, userOptions] = await Promise.all([
    db.group.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null }, select: { id: true, username: true, displayName: true }, orderBy: { username: "asc" }, take: 500 }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">公告管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Markdown/HTML 富文本公告：弹窗、跑马灯、强制阅读三种展示方式可多选组合，站内信（通知铃）可叠加或单独发送
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="公告总数" value={totalCount} sub={`当前筛选 ${total} 条`} icon={<Megaphone className="h-4 w-4" />} />
        <StatCard title="启用中" value={enabledCount} sub={`${totalCount - enabledCount} 条已停用`} icon={<ToggleRight className="h-4 w-4" />} tone="success" />
        <StatCard title="全站公告" value={globalCount} sub="GLOBAL 类型" icon={<Globe2 className="h-4 w-4" />} />
        <StatCard title="发布通道" value="4 通道" sub="弹窗 / 跑马灯 / 强制阅读 / 站内信" icon={<Eye className="h-4 w-4" />} />
      </div>

      <AnnouncementsTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
        groupOptions={groupOptions.map((g) => ({ id: g.id, name: g.name }))}
        userOptions={userOptions.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName || "" }))}
      />
    </div>
  )
}
