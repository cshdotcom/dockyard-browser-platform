import { requireAdmin } from "@/lib/permissions"
import { IpBanTable } from "./ipban-table"

// r23-C：IP 封禁管理（管理员）—— 统计卡 + 列表（搜索/状态筛选/分页）+ 手动封禁 / 解封 / 批量删除
export const metadata = { title: "IP 封禁" }

export default async function AdminIpBanPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">IP 封禁</h1>
        <p className="text-sm text-muted-foreground mt-1">
          登录失败 / API-Key 无效调用按 IP 窗口计数自动封禁；支持手动封禁、解封（清零计数）与历史记录清理，配置阈值见「系统配置 → 安全防护」
        </p>
      </div>
      <IpBanTable />
    </div>
  )
}
