import { requireAdmin } from "@/lib/permissions"
import { StatCard } from "@/components/shared/confirm"
import { listHistoryAction, listBookmarksAction } from "@/server/actions/browsing"
import { db } from "@/lib/db"
import { AdminBrowsingPanel } from "./admin-browsing-panel"
import { History, Bookmark, Database, Gauge } from "lucide-react"

// ============================================================
// 浏览数据管理（r28 管理后台）：全站浏览历史 / 书签明文库
// 全量筛选（用户搜索多选/沙箱/时间范围/关键词/域名）+ 导出（脱敏）
// + 批量删除 + 手动触发采集；沙箱隔离字段可见
// ============================================================
export const metadata = { title: "浏览数据管理" }

export default async function AdminBrowsingPage() {
  const ctx = await requireAdmin()

  const [histRes, bmRes, wsList, userCount, lastTask] = await Promise.all([
    listHistoryAction({ page: 1, pageSize: 20 }),
    listBookmarksAction({ page: 1, pageSize: 20 }),
    db.browserWorkspace.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, uuid: true, userId: true },
      orderBy: { lastActiveAt: "desc" },
      take: 200,
    }),
    db.user.count({ where: { deletedAt: null, enabled: true } }),
    db.scheduleTaskLog.findFirst({ where: { taskCode: "browsing_collect" }, orderBy: { startAt: "desc" }, select: { startAt: true, summary: true } }),
  ])

  const totalHistory = histRes.data?.total || 0
  const totalBookmarks = bmRes.data?.total || 0

  // 沙箱归属映射（管理员默认只看自己创建的，可切换全部/用户筛选）
  const wsOwners = await db.browserWorkspace.findMany({
    where: { deletedAt: null },
    select: { userId: true },
    distinct: ["userId"],
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">浏览数据管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          全站沙箱浏览历史 / 书签明文库（每 2 分钟自动采集；支持筛选、搜索、导出、批量操作）
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <StatCard title="浏览历史" value={totalHistory} sub="条记录" icon={<History className="h-4 w-4" />} />
        <StatCard title="书签" value={totalBookmarks} sub="条书签" icon={<Bookmark className="h-4 w-4" />} />
        <StatCard title="沙箱数" value={wsList.length} sub={`${wsOwners.length} 个归属用户`} icon={<Database className="h-4 w-4" />} />
        <StatCard
          title="最近采集"
          value={lastTask?.startAt ? new Date(lastTask.startAt).toLocaleString("zh-CN", { hour12: false }) : "待首轮"}
          sub="任务每 2 分钟自动运行（浏览历史 + 书签对账）"
          icon={<Gauge className="h-4 w-4" />}
        />
      </div>

      <AdminBrowsingPanel
        viewer={{ userId: ctx.userId, username: ctx.username, role: ctx.role, userCount }}
        workspaces={wsList.map((w) => ({ id: w.id, name: w.name, uuid: w.uuid, userId: w.userId }))}
        initialHistory={histRes.data?.rows || []}
        initialBookmarks={bmRes.data?.rows || []}
      />
    </div>
  )
}
