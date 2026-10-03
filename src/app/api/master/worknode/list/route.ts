import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

// ============================================================
// r29：Worker 节点列表（Master 查询；ADMIN+）
// GET /api/master/worknode/list?region=&status=
//   在线判定：lastHeartbeatAt 30s 内（>10s 未心跳=OFFLINE，由查询侧实时计算）
//   API_KEY 永不返回（库中仅存 SHA-256）
// ============================================================

const ONLINE_WINDOW_MS = 30_000

export async function GET(req: NextRequest) {
  const { getAuthContext } = await import("@/lib/permissions")
  const ctx = await getAuthContext().catch(() => null)
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
  if (ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
    return NextResponse.json({ code: 40300, msg: "仅管理员可查看节点列表" }, { status: 403 })
  }

  const region = req.nextUrl.searchParams.get("region") || ""
  const statusFilter = req.nextUrl.searchParams.get("status") || ""

  const nodes = await db.workNode.findMany({
    where: {
      ...(region ? { region } : {}),
      ...(statusFilter && statusFilter !== "ALL" ? { status: statusFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, nodeUuid: true, name: true, region: true, note: true,
      status: true, enabled: true,
      cpuUsage: true, memUsage: true, diskUsage: true, diskFreeMb: true,
      sandboxCount: true, sandboxRunning: true, netInKbps: true, netOutKbps: true,
      version: true, hostname: true, lastHeartbeatAt: true,
      maxSandboxes: true, storageUsedMb: true,
      evictedAt: true, evictReason: true, createdAt: true,
    },
  })

  const now = Date.now()
  const rows = nodes.map((n) => {
    // 实时在线态：心跳 30s 窗口（库态为最近上报时状态）
    const live = n.status === "ONLINE" && n.lastHeartbeatAt && now - n.lastHeartbeatAt.getTime() < ONLINE_WINDOW_MS
    const liveStatus = n.status === "EVICTED" ? "EVICTED" : live ? "ONLINE" : n.status === "PENDING" ? "PENDING" : "OFFLINE"
    return {
      ...n,
      lastHeartbeatAt: n.lastHeartbeatAt?.toISOString() || null,
      evictedAt: n.evictedAt?.toISOString() || null,
      createdAt: n.createdAt.toISOString(),
      liveStatus,
      heartbeatAgeSec: n.lastHeartbeatAt ? Math.floor((now - n.lastHeartbeatAt.getTime()) / 1000) : null,
    }
  })

  return NextResponse.json({ code: 0, msg: "ok", data: { nodes: rows } })
}
