import { requireAdmin } from "@/lib/permissions"
import { WorkNodesPanel } from "./worknodes-panel"
import { db } from "@/lib/db"

// ============================================================
// Worker 节点管理（r29）：Master/Worker 双包架构中枢
// 仅 SUPER_ADMIN 可创建/驱逐；ADMIN+ 可查看
// 凭证（API_KEY）创建时一次性展示，永不再现
// ============================================================
export const metadata = { title: "Worker 节点" }

export default async function AdminWorkNodesPage() {
  const ctx = await requireAdmin()
  const nodes = await db.workNode.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, nodeUuid: true, name: true, region: true, note: true, status: true, enabled: true,
      cpuUsage: true, memUsage: true, diskUsage: true, diskFreeMb: true,
      sandboxCount: true, sandboxRunning: true, version: true, hostname: true,
      lastHeartbeatAt: true, maxSandboxes: true, storageUsedMb: true,
      evictedAt: true, evictReason: true, createdAt: true,
    },
  })

  const now = Date.now()
  const rows = nodes.map((n) => ({
    ...n,
    lastHeartbeatAt: n.lastHeartbeatAt?.toISOString() || null,
    evictedAt: n.evictedAt?.toISOString() || null,
    createdAt: n.createdAt.toISOString(),
    liveStatus: n.status === "EVICTED" ? "EVICTED" : n.status === "PENDING" ? "PENDING"
      : n.lastHeartbeatAt && now - n.lastHeartbeatAt.getTime() < 30_000 ? "ONLINE" : "OFFLINE",
    heartbeatAgeSec: n.lastHeartbeatAt ? Math.floor((now - n.lastHeartbeatAt.getTime()) / 1000) : null,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Worker 节点</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Master/Worker 分布式架构：节点注册（一次性凭证）/ 心跳资源监控（10s）/ 区域调度 / 密钥泄露驱逐
        </p>
      </div>
      <WorkNodesPanel initialNodes={rows} canManage={ctx.role === "SUPER_ADMIN"} />
    </div>
  )
}
