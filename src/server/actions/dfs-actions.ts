"use server"

// ============================================================
// r29-f：分布式文件存储管理 Server Actions
//   · listFileObjectsAction —— 对象清单（绑定/层/副本/落点/通道 + 筛选）
//   · dfsStatsAction        —— 总览统计
//   · triggerDfsMaintenanceAction —— 手动触发维护（中转下沉/副本修复/分层）
//   · recordFileAccessAction —— 访问上报（共享下沉判定；OpenAPI/测试用）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, requireWritableMode } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

export async function listFileObjectsAction(input: unknown): Promise<ActionResult<{
  files: Array<{
    id: string; fileKey: string; name: string; sizeMb: number; bindType: string; bindId: string | null
    bindLabel: string // r31：归属可读名（用户名/沙箱名/组名；点击筛选用）
    tier: string; replicas: number; uploadChannel: string; relayed: boolean
    lastAccessAt: string; placements: Array<{ nodeUuid: string; role: string; status: string }>
  }>
  nodes: Array<{ nodeUuid: string; name: string; online: boolean }> // r31：节点多选筛选项
  total: number
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({
      bindType: z.string().optional(), tier: z.string().optional(),
      nodeUuids: z.array(z.string().max(64)).max(50).optional(), // r31：多节点筛选
      bindId: z.string().optional(), // r31：点击归属 → 精确筛选该归属
      keyword: z.string().optional(), take: z.number().int().min(1).max(200).optional(),
    }), input)

    // 节点筛选：fileObject → placements 命中任一节点
    let nodeFilteredIds: string[] | null = null
    if (p.nodeUuids && p.nodeUuids.length > 0) {
      const pls = await db.filePlacement.findMany({
        where: { nodeUuid: { in: p.nodeUuids } },
        select: { fileId: true },
        take: 2000,
      })
      nodeFilteredIds = [...new Set(pls.map((x) => x.fileId))]
      if (nodeFilteredIds.length === 0) return { files: [], nodes: [], total: 0 }
    }

    const rows = await db.fileObject.findMany({
      where: {
        ...(p.bindType ? { bindType: p.bindType } : {}),
        ...(p.tier ? { tier: p.tier } : {}),
        ...(p.bindId ? { bindId: p.bindId } : {}),
        ...(p.keyword ? { OR: [{ name: { contains: p.keyword } }, { fileKey: { contains: p.keyword } }] } : {}),
        ...(nodeFilteredIds ? { id: { in: nodeFilteredIds } } : {}),
      },
      select: {
        id: true, fileKey: true, name: true, sizeBytes: true, bindType: true, bindId: true,
        tier: true, replicas: true, uploadChannel: true, relayed: true, lastAccessAt: true,
        placements: { select: { nodeUuid: true, role: true, status: true } },
      },
      orderBy: { lastAccessAt: "desc" },
      take: p.take || 100,
    })

    // r31：归属解析（用户名/沙箱名/组名；内存 join 规避逐行查询）
    const userIds = [...new Set(rows.filter((r) => r.bindType === "USER" && r.bindId).map((r) => r.bindId!))]
    const wsIds = [...new Set(rows.filter((r) => r.bindType === "SANDBOX" && r.bindId).map((r) => r.bindId!))]
    const groupIds = [...new Set(rows.filter((r) => r.bindType === "SHARE" && r.bindId && r.bindId.startsWith("group:")).map((r) => r.bindId!.slice(6)))]
    const emptyUsers: Array<{ id: string; username: string; displayName: string | null }> = []
    const emptyWs: Array<{ id: string; name: string }> = []
    const emptyGroups: Array<{ id: string; name: string }> = []
    const [users, wss, groups] = await Promise.all([
      userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } }) : Promise.resolve(emptyUsers),
      wsIds.length ? db.browserWorkspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }) : Promise.resolve(emptyWs),
      groupIds.length ? db.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : Promise.resolve(emptyGroups),
    ])
    const userById = new Map(users.map((u) => [u.id, u.displayName || u.username]))
    const wsById = new Map(wss.map((w) => [w.id, w.name]))
    const groupById = new Map(groups.map((g) => [g.id, g.name]))
    const bindLabel = (bindType: string, bindId: string | null): string => {
      if (!bindId) return ""
      if (bindType === "USER") return userById.get(bindId) || "未知用户"
      if (bindType === "SANDBOX") return wsById.get(bindId) || "已删除沙箱"
      if (bindType === "SHARE" && bindId.startsWith("group:")) return groupById.get(bindId.slice(6)) || "未知用户组"
      return bindId
    }

    // r31：节点筛选项（全部 Worker 节点 + 在线状态）
    const workNodes = await db.workNode.findMany({
      where: { status: { not: "EVICTED" } },
      select: { nodeUuid: true, name: true, status: true },
      orderBy: { name: "asc" },
      take: 100,
    })

    return {
      files: rows.map((r) => ({
        id: r.id, fileKey: r.fileKey, name: r.name, sizeMb: Math.round((r.sizeBytes / 1048576) * 100) / 100,
        bindType: r.bindType, bindId: r.bindId, bindLabel: bindLabel(r.bindType, r.bindId),
        tier: r.tier, replicas: r.replicas,
        uploadChannel: r.uploadChannel, relayed: r.relayed,
        lastAccessAt: r.lastAccessAt.toISOString(), placements: r.placements,
      })),
      nodes: workNodes.map((n) => ({ nodeUuid: n.nodeUuid, name: n.name, online: n.status === "ONLINE" })),
      total: rows.length,
    }
  })
}

export async function dfsStatsAction(): Promise<ActionResult<{
  totalFiles: number; totalMb: number; relayPending: number; coldFiles: number
  lostPlacements: number; byChannel: { relay: number; direct: number }
  nodeSpread: Array<{ nodeUuid: string; files: number }>
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const [total, agg, relayPending, cold, lost, chRelay, chDirect, spread] = await Promise.all([
      db.fileObject.count(),
      db.fileObject.aggregate({ _sum: { sizeBytes: true } }),
      db.fileObject.count({ where: { relayed: false, uploadChannel: "MASTER_RELAY" } }),
      db.fileObject.count({ where: { tier: "COLD" } }),
      db.filePlacement.count({ where: { status: "LOST" } }),
      db.fileObject.count({ where: { uploadChannel: "MASTER_RELAY" } }),
      db.fileObject.count({ where: { uploadChannel: "DIRECT_WORKER" } }),
      db.filePlacement.groupBy({ by: ["nodeUuid"], _count: { fileId: true }, where: { status: "ACTIVE" } }),
    ])
    return {
      totalFiles: total,
      totalMb: Math.round(((agg._sum.sizeBytes || 0) / 1048576) * 10) / 10,
      relayPending, coldFiles: cold, lostPlacements: lost,
      byChannel: { relay: chRelay, direct: chDirect },
      nodeSpread: spread.map((s) => ({ nodeUuid: s.nodeUuid, files: s._count.fileId })).sort((a, b) => b.files - a.files),
    }
  })
}

export async function triggerDfsMaintenanceAction(): Promise<ActionResult<{ relayExpired: number; lostMarked: number; repairsPlanned: number; tiered: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const { runDfsMaintenance } = await import("@/lib/distributed-file-store")
    const r = await runDfsMaintenance()
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "DFS_MAINTENANCE_RUN", resourceType: "SYSTEM_CONFIG", resourceId: "dfs",
      after: r, severity: "INFO",
    })
    return r
  })
}

export async function recordFileAccessAction(input: unknown): Promise<ActionResult<{ ok: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ fileKey: z.string().min(1).max(256), accessNodeUuid: z.string().min(1).max(64) }), input)
    const { recordFileAccess } = await import("@/lib/distributed-file-store")
    return await recordFileAccess(p.fileKey, p.accessNodeUuid)
  })
}

export async function getFileObjectDetailAction(input: unknown): Promise<ActionResult<{ decision: unknown }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ id: zId }), input)
    const row = await db.fileObject.findUnique({
      where: { id: p.id },
      select: { placements: { select: { nodeUuid: true, role: true, status: true, syncJobId: true } } },
    })
    if (!row) throw new Error("文件对象不存在")
    return { decision: row.placements }
  })
}
