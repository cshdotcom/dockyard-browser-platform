import { requireAdmin } from "@/lib/permissions"
import { DfsPanel } from "./dfs-panel"

// ============================================================
// r29-f：分布式文件存储管理（9 大条件路由与治理中枢）
// ============================================================
export const metadata = { title: "分布式存储" }

export default async function AdminDfsPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">分布式文件存储</h1>
        <p className="text-sm text-muted-foreground mt-1">
          9 大条件路由与治理：沙箱绑定强制落地 / ≥10MB 直沉 Worker（小文件主控中转 24h）/ 共享下沉被访问端 / 冷热分层 30 天 / 20% 安全水位调度 / 多副本 1-3 跨节点 / 副本失联修复 / 沙箱迁移文件随迁 / 中转超时强制下沉
        </p>
      </div>
      <DfsPanel />
    </div>
  )
}
