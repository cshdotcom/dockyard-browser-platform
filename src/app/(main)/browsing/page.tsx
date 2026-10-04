import { requireAuth } from "@/lib/permissions"
import { MyBrowsingPanel } from "./my-browsing-panel"
import { History, Bookmark } from "lucide-react"
import { StatCard } from "@/components/shared/confirm"
import { myBrowsingWorkspacesAction } from "@/server/actions/browsing"

// ============================================================
// 我的浏览数据（r28 用户空间）：本人沙箱的浏览历史 / 书签
// 沙箱隔离：仅本人沙箱（服务端强制 userId 过滤）；
// 用户本地删除（软标记）不影响平台审计归档
// ============================================================
export const metadata = { title: "我的浏览数据" }

export default async function MyBrowsingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const initialTab = (sp.tab as string | undefined) || "history"

  const res = await myBrowsingWorkspacesAction()
  const wsList = (res.data as Array<{ historyCount: number; bookmarkCount: number; status: string }>) || []
  const totalHistory = wsList.reduce((s, w) => s + w.historyCount, 0)
  const totalBookmarks = wsList.reduce((s, w) => s + w.bookmarkCount, 0)
  const running = wsList.filter((w) => w.status === "RUNNING").length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的浏览数据</h1>
        <p className="text-sm text-muted-foreground mt-1">
          您各沙箱的浏览历史与书签（沙箱运行时自动采集；仅您本人可见，按沙箱隔离）
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard title="浏览历史" value={totalHistory} sub="条记录" icon={<History className="h-4 w-4" />} />
        <StatCard title="书签" value={totalBookmarks} sub="条书签" icon={<Bookmark className="h-4 w-4" />} />
        <StatCard title="运行中沙箱" value={running} sub={`共 ${wsList.length} 个沙箱`} icon={<Bookmark className="h-4 w-4" />} />
      </div>

      <MyBrowsingPanel initialTab={initialTab} />
    </div>
  )
}
