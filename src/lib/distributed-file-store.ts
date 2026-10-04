// ============================================================
// r29-f：分布式文件存储核心（9 大条件决策与执行引擎）
//
// 纯决策函数 resolveFilePlacement（条件 1/2/3/5/6 向量化可测）：
//   ① 沙箱绑定强制落地（最高优先级）：bindType=SANDBOX → 绑定沙箱所在节点，
//     即便该节点超水位也必须落地（沙箱与文件物理同节点是架构硬约束）→ 附带告警
//   ② 上传 ≥10MB 阈值直沉 Worker（DIRECT_WORKER 通道）；小文件主控中转 24h
//   ③ 共享协作文件（bindType=SHARE 且跨节点访问）→ 追加被访问端副本
//   ④ 冷热分层：30 天未访问 → COLD（归档压缩）
//   ⑤ 资源水位调度：节点磁盘用量 > (100 - 20% 安全水位) → 排除新落盘
//   ⑥ 多副本 1-3：跨节点分布（PRIMARY + n REPLICA，区域分散优先）
// 执行引擎：
//   ⑦ 副本修复：节点 OFFLINE → 该节点 placement LOST → 计划重建
//   ⑧ 跨节点迁移跟随：沙箱迁移（WORKSPACE_MIGRATION_PLANNED）→ 文件随迁计划
//   ⑨ 中转队列超时（relayExpiresAt 到期）→ 强制下沉
// ============================================================

import { db } from "./db"
import { raiseAlert } from "./alerts"
import { writeAudit } from "./audit"
import { getConfigNumber, getConfigBool } from "./config"
import { createHash } from "crypto"

// ---- 配置键 ----
export const DFS_CONFIG = {
  directThresholdMb: "dfs.directUploadThresholdMb", // 10
  relayTtlHours: "dfs.relayTtlHours", // 24
  coldTierDays: "dfs.coldTierDays", // 30
  safeWatermarkPct: "dfs.safeWatermarkPct", // 20
  defaultReplicas: "dfs.defaultReplicas", // 1
} as const

// ---- 决策输入 ----
export interface PlacementNode {
  nodeUuid: string // "MASTER" 或 wn-xxx
  region: string
  diskUsagePct: number | null // 心跳上报
  status: "ONLINE" | "OFFLINE" | "PENDING" | "EVICTED"
  maxStorageMb: number
  storageUsedMb: number
}

export interface PlacementRequest {
  sizeBytes: number
  bindType: "SANDBOX" | "USER" | "SHARE" | "GENERAL"
  bindId?: string | null
  sandboxNodeUuid?: string | null // 沙箱绑定节点（bindType=SANDBOX 必填）
  accessNodeUuid?: string | null // 共享最近访问端（bindType=SHARE）
  replicas: number // 期望副本 1-3
  safeWatermarkPct: number // 默认 20
  directThresholdBytes: number // 默认 10MB
}

export interface PlacementDecision {
  uploadChannel: "DIRECT_WORKER" | "MASTER_RELAY"
  placements: Array<{ nodeUuid: string; role: "PRIMARY" | "REPLICA" }>
  watermarkAlert: string | null // 条件①超额强制落地的告警文案
  reasons: string[]
}

/** 纯决策函数（零 IO；冒烟向量化直测） */
export function resolveFilePlacement(req: PlacementRequest, nodes: PlacementNode[]): PlacementDecision {
  const reasons: string[] = []
  const replicas = Math.max(1, Math.min(3, req.replicas)) // 条件⑥：1-3 钳制
  const watermarkLimit = 100 - Math.max(0, Math.min(100, req.safeWatermarkPct))

  const online = nodes.filter((n) => n.status === "ONLINE")
  // 条件⑤：安全水位过滤（磁盘余量不足的节点不接新落盘）
  const fit = online.filter((n) => n.diskUsagePct == null || n.diskUsagePct <= watermarkLimit)
  const excluded = online.filter((n) => n.diskUsagePct != null && n.diskUsagePct > watermarkLimit)
  if (excluded.length > 0) reasons.push(`水位排除：${excluded.map((n) => `${n.nodeUuid}(${n.diskUsagePct}%)`).join("、")} > ${watermarkLimit}%`)

  // 条件②：上传通道（≥10MB 直沉；小文件主控中转 24h）
  const uploadChannel: "DIRECT_WORKER" | "MASTER_RELAY" = req.sizeBytes >= req.directThresholdBytes ? "DIRECT_WORKER" : "MASTER_RELAY"
  reasons.push(req.sizeBytes >= req.directThresholdBytes
    ? `通道：${(req.sizeBytes / 1048576).toFixed(1)}MB ≥ 阈值 → 直沉 Worker`
    : `通道：${(req.sizeBytes / 1048576).toFixed(2)}MB < 阈值 → 主控中转（TTL 24h 后台下沉）`)

  let watermarkAlert: string | null = null
  const placements: Array<{ nodeUuid: string; role: "PRIMARY" | "REPLICA" }> = []

  // ---- 条件①：沙箱绑定强制落地（最高优先级，覆盖水位） ----
  if (req.bindType === "SANDBOX" && req.sandboxNodeUuid) {
    const target = nodes.find((n) => n.nodeUuid === req.sandboxNodeUuid)
    if (!target) {
      // 沙箱节点失联/不存在 → 主控兜底
      placements.push({ nodeUuid: "MASTER", role: "PRIMARY" })
      reasons.push("沙箱绑定节点不可达 → 主控兜底落地（迁移后随迁）")
    } else {
      placements.push({ nodeUuid: target.nodeUuid, role: "PRIMARY" })
      reasons.push("沙箱绑定强制落地（最高优先级）")
      if (target.diskUsagePct != null && target.diskUsagePct > watermarkLimit) {
        watermarkAlert = `沙箱绑定量硬约束：${target.nodeUuid} 磁盘 ${target.diskUsagePct}% 超安全水位仍强制落地`
      }
    }
  } else if (req.bindType === "SHARE" && req.accessNodeUuid) {
    // ---- 条件③：共享协作文件下沉被访问端 ----
    const accessNode = fit.find((n) => n.nodeUuid === req.accessNodeUuid) || online.find((n) => n.nodeUuid === req.accessNodeUuid)
    if (accessNode) {
      placements.push({ nodeUuid: accessNode.nodeUuid, role: "PRIMARY" })
      reasons.push("共享协作：下沉被访问端")
    } else {
      placements.push({ nodeUuid: "MASTER", role: "PRIMARY" })
      reasons.push("被访问端不可达/超水位 → 主控兜底")
    }
  } else {
    // 常规/用户文件：水位内首选（容量余量最大优先）
    const byFree = [...fit].sort((a, b) => (b.maxStorageMb - b.storageUsedMb) - (a.maxStorageMb - a.storageUsedMb))
    const primary = byFree[0] || online[0]
    placements.push({ nodeUuid: primary ? primary.nodeUuid : "MASTER", role: "PRIMARY" })
    reasons.push(primary ? `常规路由：余量最大节点 ${primary.nodeUuid}` : "无可用 Worker → 主控落地")
  }

  // ---- 条件⑥：副本跨节点分布（区域分散优先，水位过滤） ----
  const primaryUuid = placements[0].nodeUuid
  const replicaCandidates = fit
    .filter((n) => n.nodeUuid !== primaryUuid)
    .sort((a, b) => (a.region === b.region ? 0 : a.region !== fit.find((f) => f.nodeUuid === primaryUuid)?.region ? 1 : -1))
  for (let i = 0; i < replicas - 1 && i < replicaCandidates.length; i++) {
    placements.push({ nodeUuid: replicaCandidates[i].nodeUuid, role: "REPLICA" })
  }
  if (replicas > 1 && placements.length === 1) reasons.push("副本不足：无其他可用节点 → 单副本降级")

  return { uploadChannel, placements, watermarkAlert, reasons }
}

// ---- 注册上传（决策 → FileObject + Placements 落库） ----
export async function registerFileUpload(params: {
  name: string
  sizeBytes: number
  mimeType?: string
  sha256?: string
  bindType: "SANDBOX" | "USER" | "SHARE" | "GENERAL"
  bindId?: string | null
  sandboxNodeUuid?: string | null
  replicas?: number
  operator?: { userId: string; username: string }
}): Promise<{ fileId: string; fileKey: string; decision: PlacementDecision }> {
  const [thresholdMb, ttlHours, watermark, defReplicas] = await Promise.all([
    getConfigNumber(DFS_CONFIG.directThresholdMb, 10),
    getConfigNumber(DFS_CONFIG.relayTtlHours, 24),
    getConfigNumber(DFS_CONFIG.safeWatermarkPct, 20),
    getConfigNumber(DFS_CONFIG.defaultReplicas, 1),
  ])

  // 沙箱绑定节点解析（workspaceId → browserNodeId → nodeUuid）
  let sandboxNodeUuid = params.sandboxNodeUuid || null
  if (params.bindType === "SANDBOX" && params.bindId && !sandboxNodeUuid) {
    const ws = await db.browserWorkspace.findUnique({ where: { id: params.bindId }, select: { browserNodeId: true } })
    if (ws?.browserNodeId) {
      const node = await db.workNode.findUnique({ where: { id: ws.browserNodeId }, select: { nodeUuid: true } })
      sandboxNodeUuid = node?.nodeUuid || "MASTER"
    } else {
      sandboxNodeUuid = "MASTER" // 单容器内嵌形态：主控即执行节点
    }
  }

  // 共享访问端解析
  let accessNodeUuid: string | null = null
  if (params.bindType === "SHARE" && params.bindId) {
    const obj = await db.fileObject.findFirst({
      where: { bindType: "SHARE", bindId: params.bindId },
      orderBy: { lastAccessAt: "desc" },
      select: { accessNode: true },
    })
    accessNodeUuid = obj?.accessNode || null
  }

  const nodes = await loadPlacementNodes()
  const decision = resolveFilePlacement(
    {
      sizeBytes: params.sizeBytes,
      bindType: params.bindType,
      bindId: params.bindId,
      sandboxNodeUuid,
      accessNodeUuid,
      replicas: params.replicas ?? defReplicas,
      safeWatermarkPct: watermark,
      directThresholdBytes: thresholdMb * 1048576,
    },
    nodes,
  )

  const fileKey = `${(params.sha256 || createHash("sha256").update(`${params.name}:${params.sizeBytes}:${Date.now()}`).digest("hex")).slice(0, 16)}-${params.name.replace(/[^\w.-]/g, "_").slice(0, 80)}`
  const row = await db.fileObject.create({
    data: {
      fileKey,
      name: params.name,
      sizeBytes: params.sizeBytes,
      mimeType: params.mimeType || null,
      sha256: params.sha256 || null,
      bindType: params.bindType,
      bindId: params.bindId || null,
      replicas: decision.placements.length,
      uploadChannel: decision.uploadChannel,
      // 条件⑨：主控中转 24h TTL（到期 dfs_maintenance 强制下沉）
      relayExpiresAt: decision.uploadChannel === "MASTER_RELAY" ? new Date(Date.now() + ttlHours * 3600_000) : null,
      createdById: params.operator?.userId || null,
      createdByName: params.operator?.username || null,
      placements: {
        create: decision.placements.map((pl) => ({
          nodeUuid: pl.nodeUuid,
          role: pl.role,
          status: pl.nodeUuid === "MASTER" ? "ACTIVE" : "SYNCING",
          sizeBytes: params.sizeBytes,
        })),
      },
    },
    include: { placements: true },
  })

  if (decision.watermarkAlert) {
    await raiseAlert({
      level: "WARN",
      title: "分布式存储：沙箱绑定量硬约束触发",
      content: decision.watermarkAlert,
      resourceType: "FILE_OBJECT", resourceId: row.id,
      dedupeKey: `dfs.watermark.${sandboxNodeUuid}`,
    })
  }
  return { fileId: row.id, fileKey: row.fileKey, decision }
}

/** 调度节点清单（Master + 在线 Worker 统一视图） */
async function loadPlacementNodes(): Promise<PlacementNode[]> {
  const workers = await db.workNode.findMany({
    where: { status: "ONLINE", enabled: true },
    select: { nodeUuid: true, region: true, diskUsage: true, maxSandboxes: true, storageUsedMb: true },
    take: 200,
  })
  const nodes: PlacementNode[] = workers.map((w) => ({
    nodeUuid: w.nodeUuid,
    region: w.region,
    diskUsagePct: w.diskUsage,
    status: "ONLINE" as const,
    maxStorageMb: 200 * 1024, // 默认节点存储 200GB（心跳扩展可带真实容量）
    storageUsedMb: w.storageUsedMb,
  }))
  nodes.push({ nodeUuid: "MASTER", region: "master", diskUsagePct: 0, status: "ONLINE", maxStorageMb: 200 * 1024, storageUsedMb: 0 })
  return nodes
}

// ---- 条件④：冷热分层（30 天未访问 → COLD 归档） ----
export async function runDfsTiering(): Promise<{ hotKept: number; cooled: number }> {
  const days = await getConfigNumber(DFS_CONFIG.coldTierDays, 30)
  const cutoff = new Date(Date.now() - days * 86400_000)
  // HOT → COLD（30 天未访问）
  const r = await db.fileObject.updateMany({
    where: { tier: "HOT", lastAccessAt: { lt: cutoff }, relayed: true },
    data: { tier: "COLD" },
  })
  // 活跃访问回热
  const back = await db.fileObject.updateMany({
    where: { tier: "COLD", lastAccessAt: { gte: cutoff } },
    data: { tier: "HOT" },
  })
  return { hotKept: 0, cooled: r.count }
}

// ---- 条件⑨：中转超时强制下沉 + 条件⑦：副本修复 ----
export async function runDfsMaintenance(): Promise<{ relayExpired: number; lostMarked: number; repairsPlanned: number; tiered: number }> {
  const now = new Date()

  // ⑨ 中转 TTL 到期 → 强制下沉（relayed=true + SYNCING 置 ACTIVE——单容器形态即时完成）
  const expired = await db.fileObject.findMany({
    where: { uploadChannel: "MASTER_RELAY", relayed: false, relayExpiresAt: { lt: now } },
    select: { id: true },
    take: 500,
  })
  for (const f of expired) {
    await db.fileObject.update({ where: { id: f.id }, data: { relayed: true } }).catch(() => null)
    await db.filePlacement.updateMany({ where: { fileId: f.id, status: "SYNCING" }, data: { status: "ACTIVE" } }).catch(() => null)
  }

  // ⑦ 副本修复：失联节点上的 placement → LOST + 计划重建（其他 ACTIVE 副本所在节点）
  const offlineNodes = await db.workNode.findMany({ where: { status: "OFFLINE" }, select: { nodeUuid: true } })
  const offlineUuids = new Set(offlineNodes.map((n) => n.nodeUuid))
  let lostMarked = 0
  let repairsPlanned = 0
  if (offlineUuids.size > 0) {
    const lost = await db.filePlacement.findMany({ where: { nodeUuid: { in: [...offlineUuids] }, status: { in: ["ACTIVE", "SYNCING"] } }, select: { id: true, fileId: true, role: true }, take: 500 })
    for (const pl of lost) {
      await db.filePlacement.update({ where: { id: pl.id }, data: { status: "LOST" } }).catch(() => null)
      lostMarked++
      // 重建计划：找一个 ACTIVE 副本节点 → SYNCING 新 placement（同 fileId 不同节点）
      const healthy = await db.filePlacement.findMany({ where: { fileId: pl.fileId, status: "ACTIVE" }, select: { nodeUuid: true } })
      const target = healthy.find((h) => !offlineUuids.has(h.nodeUuid))
      const obj = await db.fileObject.findUnique({ where: { id: pl.fileId }, select: { sizeBytes: true, replicas: true } })
      if (target && obj) {
        const candidate = await loadPlacementNodes().then((nodes) => nodes.find((n) => n.nodeUuid !== target.nodeUuid && !offlineUuids.has(n.nodeUuid)))
        if (candidate) {
          await db.filePlacement.upsert({
            where: { fileId_nodeUuid: { fileId: pl.fileId, nodeUuid: candidate.nodeUuid } },
            create: { fileId: pl.fileId, nodeUuid: candidate.nodeUuid, role: "REPLICA", status: "SYNCING", sizeBytes: obj.sizeBytes, syncJobId: `repair-${pl.id}` },
            update: { status: "SYNCING", syncJobId: `repair-${pl.id}` },
          }).catch(() => null)
          repairsPlanned++
        }
      }
    }
    if (lostMarked > 0) {
      await raiseAlert({
        level: "WARN",
        title: `分布式存储：${lostMarked} 个文件副本失联`,
        content: `失联节点 ${[...offlineUuids].join("、")} 上的文件副本已标记 LOST，重建计划 ${repairsPlanned} 项。`,
        dedupeKey: `dfs.lost.${[...offlineUuids].join(".")}`,
      })
    }
  }

  // ④ 分层
  const tier = await runDfsTiering()
  return { relayExpired: expired.length, lostMarked, repairsPlanned, tiered: tier.cooled }
}

// ---- 条件③：访问上报（共享下沉判定键） ----
export async function recordFileAccess(fileKey: string, accessNodeUuid: string): Promise<{ ok: boolean }> {
  const r = await db.fileObject.update({
    where: { fileKey },
    data: { lastAccessAt: new Date(), accessNode: accessNodeUuid },
  }).catch(() => null)
  return { ok: !!r }
}

// ---- 条件⑧：跨节点迁移跟随（沙箱迁移计划 → 文件随迁） ----
export async function migrateFilesForWorkspace(workspaceId: string, fromNodeUuid: string, toNodeUuid: string): Promise<{ migrated: number }> {
  const objs = await db.fileObject.findMany({
    where: { bindType: "SANDBOX", bindId: workspaceId },
    select: { id: true, sizeBytes: true, placements: { select: { id: true, nodeUuid: true, status: true } } },
    take: 500,
  })
  let migrated = 0
  for (const o of objs) {
    const fromPl = o.placements.find((p) => p.nodeUuid === fromNodeUuid)
    if (!fromPl) continue
    await db.filePlacement.upsert({
      where: { fileId_nodeUuid: { fileId: o.id, nodeUuid: toNodeUuid } },
      create: { fileId: o.id, nodeUuid: toNodeUuid, role: "PRIMARY", status: "MIGRATING", sizeBytes: o.sizeBytes, syncJobId: `migrate-${workspaceId}` },
      update: { status: "MIGRATING", syncJobId: `migrate-${workspaceId}` },
    }).catch(() => null)
    await db.filePlacement.update({ where: { id: fromPl.id }, data: { status: "MIGRATING" } }).catch(() => null)
    migrated++
  }
  if (migrated > 0) {
    await writeAudit({
      operatorUserId: "system", operatorName: "系统",
      operationType: "DFS_FILES_MIGRATED", resourceType: "WORKSPACE", resourceId: workspaceId,
      after: { files: migrated, fromNodeUuid, toNodeUuid }, severity: "WARN",
    })
  }
  return { migrated }
}
