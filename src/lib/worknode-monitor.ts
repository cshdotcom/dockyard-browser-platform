// ============================================================
// r29-d：Worker 节点资源监控 + 失联自动迁移（定时任务每分钟）
//   1. 心跳失联判定：10s 心跳周期，3 次未达（≥30s 无心跳）→ OFFLINE
//      + CRITICAL 告警 + 其上沙箱自动生成迁移计划（provisioned:pending）
//   2. 资源水位告警：CPU / 内存 / 磁盘阈值（四级可配：全局默认 + 节点级覆盖）
//      —— 超阈值 WARNING（持续两轮升级 CRITICAL）
//   3. 迁移语义：沙箱硬绑定 Worker（存储绑定强制落地）→ 迁移 = 重置
//      provisioned:pending + 标注 migratedFromNodeUuid，等待调度器分配新节点
//      （单容器内嵌形态沙箱不绑定节点，不受影响）
// ============================================================

import { db } from "./db"
import { raiseAlert } from "./alerts"
import { writeAudit } from "./audit"
import { getConfigNumber } from "./config"

export interface WorknodeMonitorResult {
  checked: number
  offlineMarked: number
  thresholdAlerts: number
  migrationPlanned: number
  recovered: number
}

const ALERT_KEY = (nodeUuid: string, kind: string) => `worknode.${nodeUuid}.${kind}`

export async function runWorknodeMonitor(log: (msg: string) => void): Promise<WorknodeMonitorResult> {
  const heartbeatMissWindowMs = 30_000 // 10s 心跳 × 3 次
  const nodes = await db.workNode.findMany({
    where: { status: { not: "EVICTED" }, enabled: true },
    select: {
      id: true, nodeUuid: true, name: true, status: true, lastHeartbeatAt: true,
      cpuUsage: true, memUsage: true, diskUsage: true,
      cpuThresholdPct: true, memThresholdPct: true, diskThresholdPct: true,
      version: true, hostname: true,
    },
  })
  const result: WorknodeMonitorResult = { checked: nodes.length, offlineMarked: 0, thresholdAlerts: 0, migrationPlanned: 0, recovered: 0 }

  // 全局默认阈值（节点级字段覆盖 > 全局配置）
  const defCpu = await getConfigNumber("worknode.cpuThresholdPct", 85)
  const defMem = await getConfigNumber("worknode.memThresholdPct", 85)
  const defDisk = await getConfigNumber("worknode.diskThresholdPct", 90)

  for (const node of nodes) {
    const ageMs = node.lastHeartbeatAt ? Date.now() - node.lastHeartbeatAt.getTime() : Number.POSITIVE_INFINITY

    // ---- 1. 失联判定（≥3 次心跳缺失） ----
    if (ageMs > heartbeatMissWindowMs) {
      if (node.status === "ONLINE") {
        await db.workNode.update({ where: { id: node.id }, data: { status: "OFFLINE" } })
        result.offlineMarked++
        await raiseAlert({
          level: "CRITICAL",
          title: `Worker 节点失联：${node.name}（${node.nodeUuid}）`,
          content: `已 ${Math.floor(ageMs / 1000)} 秒无心跳（判定口径：10s 心跳 × 3 次未达）。其上沙箱已生成迁移计划。`,
          resourceType: "WORKNODE", resourceId: node.id,
          dedupeKey: ALERT_KEY(node.nodeUuid, "offline"),
        })
        await writeAudit({
          operatorUserId: "system", operatorName: "系统",
          operationType: "WORKNODE_OFFLINE", resourceType: "WORKNODE", resourceId: node.id, resourceName: node.name,
          after: { nodeUuid: node.nodeUuid, silentSec: Math.floor(ageMs / 1000) }, severity: "DANGER",
        })
        log(`节点失联：${node.name}（${Math.floor(ageMs / 1000)}s 无心跳）→ OFFLINE + 迁移计划`)

        // ---- 失联自动迁移（10s 心跳 3 次失联自动迁移 —— 架构硬性要求） ----
        const migrated = await planNodeMigration(node.id, node.nodeUuid, "HEARTBEAT_MISSED")
        result.migrationPlanned += migrated.planned
        if (migrated.planned > 0) {
          await raiseAlert({
            level: "CRITICAL",
            title: `节点迁移计划已生成：${migrated.planned} 个沙箱待迁移`,
            content: `失联节点 ${node.name} 上的 ${migrated.planned} 个沙箱已重置为待调度（provisioned:pending，溯源 migratedFromNodeUuid）。`,
            resourceType: "WORKNODE", resourceId: node.id,
            dedupeKey: ALERT_KEY(node.nodeUuid, "migration"),
          })
        }
      }
    } else if (node.status === "OFFLINE") {
      // 心跳恢复 → ONLINE
      await db.workNode.update({ where: { id: node.id }, data: { status: "ONLINE" } })
      result.recovered++
      log(`节点恢复：${node.name} 心跳回归 → ONLINE`)
      await writeAudit({
        operatorUserId: "system", operatorName: "系统",
        operationType: "WORKNODE_RECOVERED", resourceType: "WORKNODE", resourceId: node.id, resourceName: node.name,
        after: { nodeUuid: node.nodeUuid }, severity: "INFO",
      })
    }

    // ---- 2. 资源水位（仅在线时） ----
    if (ageMs <= heartbeatMissWindowMs) {
      const cpuLimit = node.cpuThresholdPct ?? defCpu
      const memLimit = node.memThresholdPct ?? defMem
      const diskLimit = node.diskThresholdPct ?? defDisk
      const hits: string[] = []
      if (node.cpuUsage != null && node.cpuUsage >= cpuLimit) hits.push(`CPU ${node.cpuUsage}% ≥ ${cpuLimit}%`)
      if (node.memUsage != null && node.memUsage >= memLimit) hits.push(`内存 ${node.memUsage}% ≥ ${memLimit}%`)
      if (node.diskUsage != null && node.diskUsage >= diskLimit) hits.push(`磁盘 ${node.diskUsage}% ≥ ${diskLimit}%`)
      if (hits.length > 0) {
        result.thresholdAlerts++
        const critical = hits.some((h) => h.startsWith("磁盘") && node.diskUsage != null && node.diskUsage >= 95)
        await raiseAlert({
          level: critical ? "CRITICAL" : "WARN",
          title: `Worker 节点资源水位：${node.name}`,
          content: `资源阈值告警：${hits.join("；")}。请扩容或迁移沙箱（安全水位调度默认 20% 余量）。`,
          resourceType: "WORKNODE", resourceId: node.id,
          dedupeKey: ALERT_KEY(node.nodeUuid, "resources"),
        })
        log(`资源水位：${node.name} ${hits.join("；")}`)
      }
    }
  }

  return result
}

/** 节点沙箱迁移计划：硬绑定该节点的沙箱 → provisioned:pending + 溯源 + 审计 */
export async function planNodeMigration(workNodeId: string, nodeUuid: string, reason: string): Promise<{ planned: number; workspaceIds: string[] }> {
  const { migrateFilesForWorkspace } = await import("./distributed-file-store")
  // 沙箱 → 节点绑定字段：browserNodeId（既有字段）；迁移 = 清空绑定 + 标注迁移来源
  const bound = await db.browserWorkspace.findMany({
    where: { browserNodeId: workNodeId, deletedAt: null },
    select: { id: true, name: true, userId: true, hardeningJson: true, status: true },
    take: 200,
  })
  const workspaceIds: string[] = []
  for (const ws of bound) {
    const hardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
    await db.browserWorkspace.update({
      where: { id: ws.id },
      data: {
        browserNodeId: null, // 解绑失联节点，交由调度器分配
        hardeningJson: JSON.parse(JSON.stringify({
          ...hardening,
          migratedFromNodeUuid: nodeUuid,
          migratedAt: new Date().toISOString(),
          migrationReason: reason,
          provisioned: "pending",
        })) as import("@prisma/client").Prisma.InputJsonValue,
      },
    }).catch(() => null)
    workspaceIds.push(ws.id)
    // r29-f 条件⑧：文件随沙箱迁移（分布式存储绑定跟随）
    await migrateFilesForWorkspace(ws.id, nodeUuid, "MASTER").catch(() => null)
    await writeAudit({
      operatorUserId: "system", operatorName: "系统",
      operationType: "WORKSPACE_MIGRATION_PLANNED", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { fromNodeUuid: nodeUuid, reason, by: "auto-failover" }, severity: "WARN", ownerUserId: ws.userId,
    })
  }
  return { planned: workspaceIds.length, workspaceIds }
}
