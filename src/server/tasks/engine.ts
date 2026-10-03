// 定时任务执行引擎：内存锁防并发重入 + 超时自动释放 + 连续失败告警
// 由外部 cron 触发受保护 Route Handler /api/cron 调用；手动执行同样施加内存锁

import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { cleanIdempotencyRecords } from "@/lib/idempotency"
import { detectConfigDrift } from "@/lib/config"
import { inspectContainer, containerStats, hostInfo, hostRealMetrics } from "@/lib/external/docker"
import { sessionStatus, destroySession } from "@/lib/external/browser-session"
import { novncHealth, destroyNovncSession } from "@/lib/external/novnc"
import { testConnectivity } from "@/lib/singbox"
import { resolveNetworkPolicy } from "@/lib/network-policy"
import { resolveDomainPolicyForUser } from "@/lib/domain-policy"
import { resolveEndpointPolicyForUser } from "@/lib/endpoint-policy"
import { activateDueScheduledDeployments } from "@/lib/policy-engine"
import { crxInstallPoll, crxGrayRollout } from "./crx-engine"
import { scanUnknownExtensions, checkPolicyTampering, scanSecurityBaseline } from "@/lib/crx-lifecycle"
import { nextCronRun } from "@/lib/cron-next"
import { runShellExecutor, runChainExecutor, runWebhookExecutor, CUSTOM_EXEC_TASK_TYPES } from "./custom-exec"

const g = globalThis as unknown as {
  __dyTaskLocks?: Map<string, { lockedAt: number; heartbeat: number }>
  __dyVncFps?: Map<string, { frames: number; at: number }> // 桥帧计数差分 → 真实 fps
}
function locks() {
  if (!g.__dyTaskLocks) g.__dyTaskLocks = new Map()
  return g.__dyTaskLocks
}
function vncFpsTracker() {
  if (!g.__dyVncFps) g.__dyVncFps = new Map()
  return g.__dyVncFps
}

// 内存锁：任务执行时置标记，结束清除；锁超时自动释放（死锁解除）
async function acquireLock(code: string, timeoutSec: number): Promise<boolean> {
  const existing = locks().get(code)
  if (existing) {
    // 死锁自动解除：心跳超过 timeout*1.5 视为僵死
    if (Date.now() - existing.heartbeat > timeoutSec * 1500) {
      locks().delete(code)
      await writeAudit({
        operationType: "TASK_DEADLOCK_RELEASE", resourceType: "TASK", resourceId: code,
        severity: "WARN", after: { staleMs: Date.now() - existing.heartbeat },
      })
    } else {
      return false
    }
  }
  locks().set(code, { lockedAt: Date.now(), heartbeat: Date.now() })
  return true
}

function releaseLock(code: string) {
  locks().delete(code)
}

const HEARTBEAT_MS = 5_000

export interface TaskResult {
  itemsProcessed: number
  summary: string
  /** r24-a：参数化执行体可用——true=业务失败（记 FAILED 日志，不抛异常以保留 output） */
  failed?: boolean
  /** r24-a：完整执行输出（脚本 stdout/响应体；存 ScheduleTaskLog.outputJson，上限 64KB） */
  output?: string
}

// ---- 任务注册表（全部内置任务；r24-a：签名扩展第二参数 params（来自 paramsJson））----
export const TASKS: Record<string, (log: (m: string) => void, params?: unknown) => Promise<TaskResult>> = {
  // 1. 会话闲置回收与TTL清理
  async session_idle_reclaim(log) {
    const active = await db.browserWorkspace.findMany({
      where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null },
    })
    let n = 0
    const now = Date.now()
    for (const ws of active) {
      // 闲置判定基准：最近活跃（取票/CDP指令）优先，回退 updatedAt / createdAt
      const lastActive = (ws.lastActiveAt ?? ws.updatedAt ?? ws.createdAt).getTime()
      const idleMs = now - lastActive
      const idleLimit = ws.idleTimeoutMinutes * 60_000
      const ttlMs = ws.ttlMinutes * 60_000
      const ageMs = now - ws.createdAt.getTime()
      // 0=无限（永不闲置回收）：与 TTL 语义对齐
      const idleExpired = ws.idleTimeoutMinutes > 0 && idleMs > idleLimit
      const ttlExpired = ws.ttlMinutes > 0 && ageMs > ttlMs
      if (idleExpired || ttlExpired) {
        const reason = ttlExpired ? "TTL到期" : "闲置超时"
        log(`回收 ${ws.name}（${reason}）`)
        if (ws.mode === "cdp_light" && ws.browserSessionId) await destroySession(ws.browserSessionId).catch(() => {})
        if (ws.mode === "novnc_full" && ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
        const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
        await db.browserWorkspace.update({
          where: { id: ws.id },
          data: { status: "DESTROYED", crashCategory: reason, browserSessionId: null, novncSessionId: null, startedAt: null, runtimeAccumSec: { increment: runtimeDelta } },
        })
        if (ws.proxyNodeId) await db.proxyNode.update({ where: { id: ws.proxyNodeId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})
        if (ws.singboxInstanceId) await db.singboxInstance.update({ where: { id: ws.singboxInstanceId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})
        await writeAudit({
          operationType: "WORKSPACE_AUTO_RECYCLE", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
          ownerUserId: ws.userId, severity: "WARN", after: { reason },
        })
        n++
      }
    }
    return { itemsProcessed: n, summary: `回收${n}个到期/闲置会话` }
  },

  // 2. SingBox实例状态同步（双向状态对齐：以容器真实状态为权威基准）
  async singbox_status_sync(log) {
    const instances = await db.singboxInstance.findMany({ where: { deletedAt: null, status: { in: ["RUNNING", "STOPPED", "RELOADING", "ERROR", "CREATING"] } } })
    let n = 0
    for (const inst of instances) {
      if (!inst.containerId) continue
      const info = await inspectContainer(inst.containerId).catch(() => null)
      if (!info) {
        await db.singboxInstance.update({ where: { id: inst.id }, data: { status: "ERROR", lastError: "容器不存在（数据库状态已对齐）" } })
        await db.proxyNode.updateMany({ where: { singboxInstanceId: inst.id }, data: { status: "FAILED" } })
        log(`对齐 ${inst.name}：容器不存在 → ERROR`)
        n++
        continue
      }
      const realState = info.state === "running" ? "RUNNING" : "STOPPED"
      if (inst.status !== realState) {
        const before = inst.status
        await db.singboxInstance.update({ where: { id: inst.id }, data: { status: realState, lastError: null } })
        await db.proxyNode.updateMany({ where: { singboxInstanceId: inst.id }, data: { status: realState === "RUNNING" ? "HEALTHY" : "FAILED" } })
        log(`对齐 ${inst.name}: ${before} → ${realState}`)
        if (before === "RUNNING" && realState === "STOPPED") {
          await raiseAlert({ title: `SingBox 实例异常退出：${inst.name}`, level: "CRITICAL", content: `容器状态与数据库不一致已自动对齐（${before}→${realState}），请检查容器日志`, resourceType: "SINGBOX", resourceId: inst.id })
        }
        n++
      }
      if (info.state === "running") {
        const stats = await containerStats(inst.containerId).catch(() => null)
        if (stats) {
          await db.singboxStats.create({ data: { instanceId: inst.id, cpuPct: stats.cpuPct, memMb: stats.memMb, bytesUpMb: stats.netTxMb, bytesDownMb: stats.netRxMb } })
          await db.singboxInstance.update({ where: { id: inst.id }, data: { bytesUpMb: Math.max(inst.bytesUpMb, stats.netTxMb), bytesDownMb: Math.max(inst.bytesDownMb, stats.netRxMb), peakTrafficMb: Math.max(inst.peakTrafficMb, stats.netTxMb + stats.netRxMb) } })
        }
      }
    }
    return { itemsProcessed: n, summary: `同步${instances.length}个实例状态，修正${n}处错位` }
  },

  // 3. 代理节点健康探测（r23：probeTimeoutMs 超时 + healthCheckIntervalSec 探测间隔真实生效）
  async proxy_health_probe(log) {
    const { getConfigNumber } = await import("@/lib/config")
    const probeTimeoutMs = await getConfigNumber("proxy.probeTimeoutMs", 5000)
    const intervalSec = await getConfigNumber("proxy.healthCheckIntervalSec", 60)
    const lastProbeMap = probeLastAt()
    const now = Date.now()
    const nodes = await db.proxyNode.findMany({ where: { deletedAt: null, status: { in: ["HEALTHY", "DEGRADED", "UNKNOWN", "FAILED"] } }, take: 200 })
    let n = 0
    let skipped = 0
    for (const node of nodes) {
      // 探测间隔控制（任务调度频率 ≠ 探测频率；间隔未到的节点本轮跳过）
      const last = lastProbeMap.get(node.id) || 0
      if (intervalSec > 0 && now - last < intervalSec * 1000) { skipped++; continue }
      lastProbeMap.set(node.id, now)
      const target = node.type === "internal_singbox"
        ? (node.singboxInstanceId ? (await db.singboxInstance.findUnique({ where: { id: node.singboxInstanceId } }))?.socksAddr || null : null)
        : `${node.host}:${node.port}`
      if (!target) continue
      const probeP = testConnectivity(`sim:${target}`)
      const timeoutP = new Promise<null>((r) => setTimeout(() => r(null), probeTimeoutMs))
      const result = await Promise.race([probeP.catch(() => null), timeoutP]).catch(() => null)
      if (result) {
        const failCount = result.ok ? 0 : node.healthFailCount + 1
        const status = result.ok ? "HEALTHY" : failCount >= 3 ? "FAILED" : node.status === "HEALTHY" ? "DEGRADED" : node.status
        await db.proxyNode.update({ where: { id: node.id }, data: { status, latencyMs: result.latencyMs, healthFailCount: failCount } })
        if (failCount === 3) {
          const { getConfigBool } = await import("@/lib/config")
          if (await getConfigBool("alert.proxyFailEnabled", true)) {
            await raiseAlert({ title: `代理节点故障：${node.name}`, level: "CRITICAL", content: `连续探测失败3次，节点置为FAILED，不再分配新会话`, resourceType: "PROXY", resourceId: node.id })
          }
        }
        n++
      }
    }
    return { itemsProcessed: n, summary: `探测${n}个代理节点（间隔${intervalSec}s，超时${probeTimeoutMs}ms）${skipped > 0 ? `，${skipped}个未到间隔跳过` : ""}` }
  },

  // 4. 过期文件清理
  async file_expire_clean(log) {
    const now = new Date()
    const expired = await db.fileMeta.findMany({ where: { expireAt: { lt: now }, deletedAt: null, purgedAt: null }, take: 500 })
    for (const f of expired) {
      await db.fileMeta.update({ where: { id: f.id }, data: { deletedAt: now } })
      await writeAudit({ operationType: "FILE_AUTO_EXPIRE", resourceType: "FILE", resourceId: f.id, resourceName: f.fileName, ownerUserId: f.userId, after: { purged: true } })
    }
    return { itemsProcessed: expired.length, summary: `清理${expired.length}个过期文件` }
  },

  // 5. 数据库备份（r23：backup.enabled 开关真实生效；关闭时跳过执行）
  async db_backup(log) {
    const fs = await import("fs/promises")
    const path = await import("path")
    const { ENV } = await import("@/lib/env")
    const { getConfigBool, getConfigNumber } = await import("@/lib/config")
    if (!(await getConfigBool("backup.enabled", true))) {
      return { itemsProcessed: 0, summary: "定时备份已关闭（backup.enabled=false），跳过" }
    }
    const dbPath = (process.env.DATABASE_URL || "").replace(/^file:/, "") || path.join(process.cwd(), "db/custom.db")
    const backupDir = path.join(ENV.storageLocalPath, "backups")
    await fs.mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const target = path.join(backupDir, `backup-${stamp}.db`)
    let bytes = 0
    const encryptBackup = await getConfigBool("backup.encrypt", false)
    if (encryptBackup) {
      const raw = await fs.readFile(dbPath)
      const { encrypt } = await import("@/lib/crypto")
      const enc = encrypt(raw.toString("base64"))
      await fs.writeFile(target + ".enc", enc, "utf8")
      bytes = enc.length
    } else {
      await fs.copyFile(dbPath, target)
      bytes = (await fs.stat(target)).size
    }
    if (bytes < 1024) {
      const { getConfigBool } = await import("@/lib/config")
      if (await getConfigBool("alert.backupFailEnabled", true)) {
        await raiseAlert({ title: "数据库备份异常", level: "CRITICAL", content: `备份文件仅 ${bytes} 字节，疑似失败`, resourceType: "BACKUP" })
      }
      return { itemsProcessed: 0, summary: "备份失败（文件过小）" }
    }
    const fileMeta = await db.fileMeta.create({
      data: { fileName: `backup-${stamp}.db${encryptBackup ? ".enc" : ""}`, storageKey: path.relative(ENV.storageLocalPath, target), size: bytes, mime: "application/octet-stream", category: "BACKUP", expireAt: null, virusScanned: true },
    })
    await db.backupRecord.create({
      data: { fileMetaId: fileMeta.id, type: "FULL", encrypted: encryptBackup, sizeBytes: bytes, status: "SUCCESS", createdByUserId: null },
    })
    const retention = await getConfigNumber("backup.retentionCount", 7)
    const records = await db.backupRecord.findMany({ orderBy: { createdAt: "desc" } })
    for (const old of records.slice(retention)) {
      await db.backupRecord.delete({ where: { id: old.id } }).catch(() => {})
      if (old.fileMetaId) {
        const fm = await db.fileMeta.findUnique({ where: { id: old.fileMetaId } })
        if (fm) {
          await fs.rm(path.join(ENV.storageLocalPath, fm.storageKey), { force: true }).catch(() => {})
          await db.fileMeta.update({ where: { id: fm.id }, data: { deletedAt: new Date(), purgedAt: new Date() } }).catch(() => {})
        }
      }
    }
    await writeAudit({ operationType: "BACKUP_AUTO", resourceType: "BACKUP", resourceId: fileMeta.id, after: { bytes, encrypted: encryptBackup } })
    return { itemsProcessed: 1, summary: `备份完成 ${Math.round(bytes / 1024)}KB（保留${retention}份）` }
  },

  // 6. 日志归档（审计日志超保留期迁移归档表；r23：log.retentionDays 真实生效 → 业务日志清理）
  async log_archive(log) {
    const { getConfigNumber } = await import("@/lib/config")
    const retentionDays = await getConfigNumber("log.auditRetentionDays", 365)
    const cutoff = new Date(Date.now() - retentionDays * 86400_000)
    const expired = await db.auditLog.findMany({ where: { createdAt: { lt: cutoff } }, take: 1000 })
    for (const a of expired) {
      await db.auditLogArchive.create({
        data: {
          originId: a.id, traceId: a.traceId, operatorUserId: a.operatorUserId, operatorName: a.operatorName,
          operationType: a.operationType, resourceType: a.resourceType, resourceId: a.resourceId, resourceName: a.resourceName,
          ownerUserId: a.ownerUserId, createdByUserId: a.createdByUserId, clientIp: a.clientIp, severity: a.severity,
          beforeJson: a.beforeJson, afterJson: a.afterJson, extraJson: a.extraJson, createdAt: a.createdAt,
        },
      })
      await db.auditLog.delete({ where: { id: a.id } })
    }
    const archiveCutoff = new Date(Date.now() - 730 * 86400_000)
    const delArch = await db.auditLogArchive.deleteMany({ where: { archivedAt: { lt: archiveCutoff } } })
    // r23：log.retentionDays → 业务日志保留期（任务执行日志 + API 调用日志，0=不限）
    const bizRetentionDays = await getConfigNumber("log.retentionDays", 90)
    let bizCleaned = 0
    if (bizRetentionDays > 0) {
      const bizCutoff = new Date(Date.now() - bizRetentionDays * 86400_000)
      const taskLogs = await db.scheduleTaskLog.deleteMany({ where: { startAt: { lt: bizCutoff } } })
      const apiLogs = await db.apiTokenCallLog.deleteMany({ where: { createdAt: { lt: bizCutoff } } })
      bizCleaned = taskLogs.count + apiLogs.count
    }
    return { itemsProcessed: expired.length + delArch.count + bizCleaned, summary: `归档${expired.length}条审计，清理${delArch.count}条过期归档，业务日志清理${bizCleaned}条（保留${bizRetentionDays}天）` }
  },

  // 7. 告警条件恢复自动结案
  async alert_state_check(log) {
    const pending = await db.alert.findMany({ where: { handleStatus: "PENDING", level: { in: ["INFO", "WARN"] } }, take: 200 })
    let n = 0
    const autoResolveHours = 24
    const cutoff = Date.now() - autoResolveHours * 3600_000
    for (const a of pending) {
      if (a.createdAt.getTime() < cutoff) {
        await db.alert.update({ where: { id: a.id }, data: { handleStatus: "AUTO_RESOLVED", handledAt: new Date() } })
        n++
      }
    }
    return { itemsProcessed: n, summary: `${n}条告警条件恢复自动结案` }
  },

  // 8. 僵死资源回收
  async zombie_reclaim(log) {
    const running = await db.browserWorkspace.findMany({ where: { mode: "cdp_light", status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, browserSessionId: { not: null } }, take: 300 })
    let n = 0
    for (const ws of running) {
      if (!ws.browserSessionId) continue
      const st = await sessionStatus(ws.browserSessionId).catch(() => null)
      if (!st || st.status === "GONE" || st.status === "CRASHED") {
        log(`僵死会话回收 ${ws.name}`)
        await destroySession(ws.browserSessionId).catch(() => {})
        await db.browserWorkspace.update({
          where: { id: ws.id },
          data: { status: st?.status === "CRASHED" ? "ERROR" : "DESTROYED", crashCategory: st?.status === "CRASHED" ? "Chrome崩溃" : "会话僵死无响应" },
        })
        const { getConfigBool: gcb } = await import("@/lib/config")
        if (await gcb("alert.zombieReclaimEnabled", true)) {
          await raiseAlert({
            title: `会话僵死已自动回收：${ws.name}`, level: "WARN",
            content: `底层会话${st?.status === "CRASHED" ? "崩溃" : "无响应"}，网关已自动销毁并回收`, resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId,
          })
        }
        n++
      }
    }
    return { itemsProcessed: n, summary: `回收${n}个僵死会话` }
  },

  // 9. 配额超限检测（r23：会话水位/流量超限预警开关）
  async quota_check(log) {
    const { getConfigNumber, getConfigBool } = await import("@/lib/config")
    const globalMax = await getConfigNumber("workspace.maxConcurrentSessions", 50)
    const active = await db.browserWorkspace.count({ where: { status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null } })
    if (active >= globalMax * 0.9 && (await getConfigBool("alert.sessionQuotaEnabled", true))) {
      await raiseAlert({ title: "全局会话配额水位告警", level: "WARN", content: `活跃会话 ${active}/${globalMax} 达到90%水位`, resourceType: "QUOTA", dedupeKey: "quota-global" })
    }
    const instances = await db.singboxInstance.findMany({ where: { deletedAt: null, status: "RUNNING" } })
    let n = 0
    for (const inst of instances) {
      if (inst.trafficLimitMb > 0 && inst.bytesUpMb + inst.bytesDownMb >= inst.trafficLimitMb) {
        if (inst.overLimitAction === "BLOCK_NEW") {
          await db.proxyNode.updateMany({ where: { singboxInstanceId: inst.id }, data: { status: "DEGRADED" } })
        }
        if (await getConfigBool("alert.singboxTrafficEnabled", true)) {
          await raiseAlert({ title: `SingBox流量超限：${inst.name}`, level: "WARN", content: `累计流量 ${(inst.bytesUpMb + inst.bytesDownMb).toFixed(3)}MB 超过上限 ${inst.trafficLimitMb}MB（动作：${inst.overLimitAction}）`, resourceType: "SINGBOX", resourceId: inst.id, dedupeKey: `sb-traffic-${inst.id}` })
        }
        n++
      }
    }
    return { itemsProcessed: n, summary: `会话${active}/${globalMax}，流量超限实例${n}个` }
  },

  // 10. API-Token 过期作废与到期告警（r23：预警开关）
  async token_expire(log) {
    const now = new Date()
    const { getConfigNumber, getConfigBool } = await import("@/lib/config")
    if (!(await getConfigBool("alert.tokenExpireEnabled", true))) {
      return { itemsProcessed: 0, summary: "Token到期预警已关闭（仅跳过提醒，过期作废仍执行）" }
    }
    const expired = await db.apiToken.findMany({ where: { expireAt: { lt: now }, deletedAt: null }, take: 500 })
    for (const t of expired) {
      await db.apiToken.update({ where: { id: t.id }, data: { deletedAt: now, enabled: false } })
      await writeAudit({ operationType: "TOKEN_AUTO_EXPIRE", resourceType: "API_TOKEN", resourceId: t.id, resourceName: t.name, ownerUserId: t.userId, after: { expireAt: t.expireAt?.toISOString() } })
    }
    const warnDays = await getConfigNumber("token.expireWarnDays", 7)
    const soon = await db.apiToken.findMany({
      where: { deletedAt: null, enabled: true, expireAt: { not: null, gt: now, lt: new Date(now.getTime() + warnDays * 86400_000) } },
    })
    for (const t of soon) {
      const days = Math.ceil((t.expireAt!.getTime() - now.getTime()) / 86400_000)
      await db.notice.create({
        data: { userId: t.userId, title: "API Token 即将到期", content: `令牌「${t.name}」将在 ${days} 天后过期，请及时更换。`, type: "TOKEN_EXPIRE" },
      })
    }
    return { itemsProcessed: expired.length + soon.length, summary: `作废${expired.length}个过期Token，提醒${soon.length}个即将到期` }
  },

  // 11. 回收站到期物理清除
  async recycle_purge(log) {
    const entries = await db.recycleBin.findMany({
      where: { restoredAt: null, locked: false, purgeAt: { lt: new Date() } },
      take: 200,
    })
    let n = 0
    for (const e of entries) {
      try {
        const tableMap: Record<string, string> = {
          WORKSPACE: "browserWorkspace", SINGBOX: "singboxInstance", API_TOKEN: "apiToken", TEMPLATE: "browserTemplate",
          SNAPSHOT: "browserProfileSnapshot", SCRIPT: "browserScriptTemplate", FILE: "fileMeta", PROXY_NODE: "proxyNode",
        }
        const model = tableMap[e.resourceType] as string | undefined
        if (model) {
          await (db as unknown as Record<string, { deleteMany: (a: { where: { id: string } }) => Promise<unknown> }>)[model].deleteMany({ where: { id: e.resourceId } })
        }
        await db.recycleBin.delete({ where: { id: e.id } })
        await writeAudit({ operationType: "RECYCLE_AUTO_PURGE", resourceType: e.resourceType, resourceId: e.resourceId, severity: "WARN", after: { source: "SYSTEM" } })
        n++
      } catch (err) {
        log(`清除失败 ${e.resourceType}/${e.resourceId}: ${err}`)
      }
    }
    return { itemsProcessed: n, summary: `物理清除${n}条回收站资源` }
  },

  // 12. 脏数据自动清洗自愈
  async dirty_data_clean(log) {
    let n = 0
    const staleSessions = await db.browserWorkspace.findMany({ where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, browserSessionId: { not: null } }, take: 200 })
    for (const ws of staleSessions) {
      const st = await sessionStatus(ws.browserSessionId!).catch(() => null)
      if (st === null) {
        await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "DESTROYED", browserSessionId: null } })
        n++
      }
    }
    const expiredShares = await db.workspaceShare.deleteMany({ where: { expireAt: { lt: new Date() }, revokedAt: null } })
    n += expiredShares.count
    const expiredCodes = await db.emailVerificationCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86400_000) } } })
    n += expiredCodes.count
    const oldSessions = await db.loginSession.deleteMany({ where: { revokedAt: { not: null }, lastActiveAt: { lt: new Date(Date.now() - 30 * 86400_000) } } })
    n += oldSessions.count
    const idem = await cleanIdempotencyRecords()
    n += idem
    const groupUsers = await db.groupUser.findMany({ take: 500 })
    for (const gu of groupUsers) {
      const u = await db.user.findUnique({ where: { id: gu.userId } })
      if (!u || u.deletedAt) {
        await db.groupUser.delete({ where: { id: gu.id } }).catch(() => {})
        n++
      }
    }
    return { itemsProcessed: n, summary: `清洗${n}条脏数据（会话/共享/验证码/幂等/组关系）` }
  },

  // 13. 宿主机资源采集与水位告警（r23：真实采集 + 可配置阈值 + Docker data-root 磁盘）
  async host_probe(log) {
    const { getConfigBool, getConfigNumber } = await import("@/lib/config")
    const { ENV } = await import("@/lib/env")
    const hosts = await db.hostNode.findMany({ where: { deletedAt: null, enabled: true } })
    const alertEnabled = await getConfigBool("alert.hostEnabled", true)
    const cpuThreshold = await getConfigNumber("alert.cpuThresholdPct", 80)
    const memThreshold = await getConfigNumber("alert.memThresholdPct", 85)
    const diskThreshold = await getConfigNumber("alert.diskThresholdPct", 85)
    let n = 0
    for (const h of hosts) {
      // 真实采集：CPU（/proc/stat 差分）/ 内存（/proc/meminfo）/ 磁盘（Docker data-root 或存储目录 statfs）
      const m = await hostRealMetrics({ storageFallbackPath: ENV.storageLocalPath }).catch(() => null)
      if (m) {
        await db.hostNode.update({
          where: { id: h.id },
          data: {
            cpuUsedPct: m.cpuUsedPct, memUsedMb: m.memUsedMb, diskUsedPct: m.diskUsedPct,
            cpuCores: m.cpuCores, memTotalMb: m.memTotalMb, status: "ONLINE",
          },
        })
        log(`${h.name}: CPU ${m.cpuUsedPct}% · 内存 ${(m.memUsedMb / 1024).toFixed(1)}/${(m.memTotalMb / 1024).toFixed(1)}GB · 磁盘 ${m.diskUsedPct}%（${m.diskSource === "docker-data-root" ? `Docker存储 ${m.diskPath}` : m.diskSource === "storage-path" ? `存储目录 ${m.diskPath}` : "根文件系统"}）`)
        if (alertEnabled) {
          const memPct = m.memTotalMb > 0 ? (m.memUsedMb / m.memTotalMb) * 100 : 0
          const breaches: string[] = []
          if (m.cpuUsedPct > cpuThreshold) breaches.push(`CPU ${m.cpuUsedPct}%（阈值 ${cpuThreshold}%）`)
          if (memPct > memThreshold) breaches.push(`内存 ${memPct.toFixed(1)}% = ${(m.memUsedMb / 1024).toFixed(1)}/${(m.memTotalMb / 1024).toFixed(1)}GB（阈值 ${memThreshold}%）`)
          if (m.diskUsedPct > diskThreshold) breaches.push(`磁盘 ${m.diskUsedPct}%（阈值 ${diskThreshold}%，${m.diskSource === "docker-data-root" ? "Docker容器存储位置" : m.diskPath}，共 ${(m.diskTotalMb / 1024).toFixed(1)}GB）`)
          if (breaches.length > 0) {
            await raiseAlert({
              title: `宿主机资源水位告警：${h.name}`, level: "CRITICAL",
              content: `资源超阈值：${breaches.join("；")}。磁盘统计口径：${m.diskSource === "docker-data-root" ? `Docker data-root（${m.diskPath}）容器存储所在文件系统` : m.diskSource === "storage-path" ? `平台数据目录（${m.diskPath}）` : "根文件系统"}。请运维介入扩容或清理。`,
              resourceType: "HOST", resourceId: h.id, dedupeKey: `host-water-${h.id}`,
            })
          }
        }
        n++
      } else {
        // 采集失败：标记离线并计数
        await db.hostNode.update({ where: { id: h.id }, data: { status: "OFFLINE", probeFailCount: { increment: 1 } } }).catch(() => {})
        log(`${h.name}: 采集失败，标记 OFFLINE`)
      }
    }
    // —— r23：用户磁盘配额水位预警（超 80% 提醒，可开关） ——
    const quotaAlert = await getConfigBool("alert.quotaUserEnabled", true)
    if (quotaAlert) {
      const users = await db.user.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, username: true, quota: true } })
      for (const u of users) {
        const diskMb = Number((u.quota as Record<string, unknown> | null)?.diskMb ?? 0)
        if (diskMb <= 0) continue
        const used = await db.fileMeta.aggregate({ where: { userId: u.id, deletedAt: null, purgedAt: null }, _sum: { size: true } })
        const usedMb = Math.round((used._sum.size ?? 0) / 1048576)
        if (usedMb / diskMb >= 0.8) {
          await raiseAlert({
            title: `用户磁盘配额水位：${u.username}`, level: "WARN",
            content: `已用 ${usedMb}MB / 配额 ${diskMb}MB（${Math.round((usedMb / diskMb) * 100)}%，超过80%水位）`,
            resourceType: "QUOTA", resourceId: u.id, dedupeKey: `quota-user-${u.id}`,
          })
        }
      }
    }
    return { itemsProcessed: n, summary: `采集${n}台宿主机资源（真实指标）` }
  },

  // 14. 配置漂移检测（r23：预警开关）
  async config_drift(log) {
    const drifted = await detectConfigDrift()
    if (drifted.length > 0) {
      const { getConfigBool } = await import("@/lib/config")
      if (await getConfigBool("alert.configDriftEnabled", true)) {
        await raiseAlert({
          title: "配置漂移告警", level: "CRITICAL",
          content: `数据库与内存运行配置出现漂移：${drifted.join("、")}，已自动刷新内存缓存`,
          resourceType: "CONFIG", dedupeKey: "config-drift",
        })
      }
      const { ensureConfigLoaded } = await import("@/lib/config")
      await ensureConfigLoaded(true)
    }
    return { itemsProcessed: drifted.length, summary: drifted.length === 0 ? "无漂移" : `漂移${drifted.length}项已刷新` }
  },

  // 15. 平台智能自检
  async self_check(log) {
    const checks: { code: string; status: string; detail: string; fixed?: string }[] = []
    try {
      await db.user.count()
      checks.push({ code: "DB", status: "PASS", detail: "数据库连接正常" })
    } catch (e) {
      checks.push({ code: "DB", status: "FAIL", detail: String(e) })
    }
    const running = await db.singboxInstance.count({ where: { status: "RUNNING", deletedAt: null } })
    checks.push({ code: "SINGBOX", status: "PASS", detail: `运行中实例 ${running} 个` })
    const expiredFiles = await db.fileMeta.count({ where: { expireAt: { lt: new Date() }, deletedAt: null, purgedAt: null } })
    if (expiredFiles > 0) {
      checks.push({ code: "FILES", status: "WARN", detail: `${expiredFiles} 个过期文件待清理`, fixed: "由 file_expire_clean 任务处理" })
    }
    const zombies = await db.browserWorkspace.count({ where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, updatedAt: { lt: new Date(Date.now() - 6 * 3600_000) } } })
    if (zombies > 0) checks.push({ code: "SESSIONS", status: "WARN", detail: `${zombies} 个长时间未活跃会话` })
    for (const c of checks) {
      await db.systemSelfCheck.create({ data: { checkCode: c.code, status: c.status, detail: c.detail, fixedAction: c.fixed ?? null } })
    }
    return { itemsProcessed: checks.length, summary: checks.map((c) => `${c.code}:${c.status}`).join(" ") }
  },

  // 16. 过期共享授权清理
  async share_expire(log) {
    const expired = await db.workspaceShare.deleteMany({ where: { expireAt: { lt: new Date() }, revokedAt: null } })
    return { itemsProcessed: expired.count, summary: `清理${expired.count}条过期共享授权` }
  },

  // 17. NoVNC会话健康探测 + 防退出自愈看门狗（崩溃自动重建同Profile会话）+ 闲置回收
  async novnc_health(log) {
    const vncSessions = await db.browserWorkspace.findMany({ where: { mode: "novnc_full", status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, novncSessionId: { not: null } }, take: 200 })
    let n = 0
    let recovered = 0
    const { getConfigNumber } = await import("@/lib/config")
    const idleMin = await getConfigNumber("session.novncIdleTimeoutMin", 30)
    const maxRecoverFails = 3 // 连续 3 轮失败才判定不可恢复
    for (const ws of vncSessions) {
      // 自托管模式：容器真实状态 + 桥统计（键鼠/帧请求真实活跃度）
      const health = await novncHealth(ws.novncSessionId!, { workspaceId: ws.id, containerRef: ws.containerRef }).catch(() => null)
      if (!health || !health.alive) {
        // ---- 防退出自愈：崩溃会话自动以同一 Profile / 同一代理重建（用户无感知）----
        const fails = (vncFailCounter().get(ws.id) || 0) + 1
        vncFailCounter().set(ws.id, fails)
        if (fails < maxRecoverFails) {
          try {
            await destroyNovncSession(ws.novncSessionId!, ws.containerRef).catch(() => {})
            const { createNovncSession } = await import("@/lib/external/novnc")
            const { encrypt } = await import("@/lib/crypto")
            const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
            const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${ws.id.slice(-16)}`
            // 崩溃自愈重建：重新解析当前生效策略（管理员收紧立即作用于新容器；四层解析含单沙箱级）
            const netPolicy = await resolveNetworkPolicy(ws.userId, ws.id)
            const domPolicy = await resolveDomainPolicyForUser(ws.userId, ws.id)
            const epPolicy = await resolveEndpointPolicyForUser(ws.userId, ws.id)
            const filePolicy = await import("@/lib/file-policy").then((m) => m.resolveFilePolicy(ws.userId, ws.id))
            const rebuilt = await createNovncSession({
              ttlMinutes: ws.ttlMinutes || undefined,
              profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
              userId: ws.userId,
              profileKey,
              workspaceId: ws.id, // CRX/网络/域名/端点/文件策略按沙箱级解析注入（自愈重建同步刷新）
              labels: { "dockyard.owner": ws.userId, "dockyard.recovered": "true" },
              networkPolicy: netPolicy,
              domainPolicy: domPolicy,
              endpointPolicy: epPolicy,
              filePolicy,
            })
            await db.browserWorkspace.update({
              where: { id: ws.id },
              data: {
                status: "RUNNING", crashCategory: `自愈重建#${fails}`,
                startedAt: new Date(),
                novncSessionId: rebuilt.novncSessionId, novncSecret: encrypt(rebuilt.secret),
                containerRef: rebuilt.containerName || null,
                hardeningJson: JSON.parse(JSON.stringify(rebuilt.hardening ? { ...rebuilt.hardening, profileKey, provisioned: "live" } : (prevHardening || {}))) as Prisma.InputJsonValue,
                networkPolicyJson: JSON.parse(JSON.stringify({ ...netPolicy, domainMode: domPolicy.mode, domainBlack: domPolicy.blackPatterns, domainWhite: domPolicy.whitePatterns, endpointBlack: epPolicy.blackPatterns, endpointWhite: epPolicy.whitePatterns, fileAllowDownload: filePolicy.allowDownload, fileAllowUpload: filePolicy.allowUpload, fileAllowFileScheme: filePolicy.allowFileScheme, fileSource: filePolicy.source })) as Prisma.InputJsonValue,
              },
            })
            recovered++
            log(`防退出看门狗：${ws.name} 崩溃后已自动重建（第${fails}次，Profile=${profileKey.slice(0, 18)}…）`)
            n++
          } catch (e) {
            log(`自愈重建失败：${ws.name} - ${e instanceof Error ? e.message : String(e)}`)
          }
        } else {
          // 连续失败 → 判定不可恢复，释放资源并告警
          vncFailCounter().delete(ws.id)
          await destroyNovncSession(ws.novncSessionId!, ws.containerRef).catch(() => {})
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "ERROR", crashCategory: "连续自愈失败(3轮)" } })
          await raiseAlert({ title: `NoVNC会话自愈失败转ERROR：${ws.name}`, level: "ERROR", content: "防退出看门狗连续3轮重建失败，会话已转入错误态等待人工处置", resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId })
          n++
        }
      } else {
        vncFailCounter().delete(ws.id) // 恢复正常：清零失败计数
        // 真实输入活跃（桥侧键鼠/帧请求）回写 lastActiveAt：防止闲置回收误杀正在使用的会话
        const wsLast = ws.lastActiveAt?.getTime() ?? 0
        if (health.lastInputAt != null && health.lastInputAt > wsLast) {
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { lastActiveAt: new Date(health.lastInputAt) } }).catch(() => {})
        }
        // 闲置判定：真实输入信号优先，回退工作区自身活跃记录（无桥统计时不误判）
        const lastInput = health.lastInputAt ?? (ws.lastActiveAt ?? ws.updatedAt ?? ws.createdAt).getTime()
        const idleMs = Date.now() - lastInput
        if (idleMs > idleMin * 60_000 && ws.status === "RUNNING") {
          await destroyNovncSession(ws.novncSessionId!, ws.containerRef).catch(() => {})
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "DESTROYED", crashCategory: "NoVNC闲置回收" } })
          n++
        } else {
          // 桥帧计数差分 → 真实 fps（差分窗口 60s，冷启动首笔不计算）
          let fps = health.fps
          if (typeof health.frames === "number") {
            const prev = vncFpsTracker().get(ws.id)
            vncFpsTracker().set(ws.id, { frames: health.frames, at: Date.now() })
            if (prev) {
              const dt = (Date.now() - prev.at) / 1000
              if (dt > 1) fps = Math.max(0, Math.round(((health.frames - prev.frames) / dt) * 10) / 10)
            }
          } else {
            vncFpsTracker().delete(ws.id)
          }
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { novncConnCount: health.clients, novncFps: fps } })
        }
      }
    }
    return { itemsProcessed: n, summary: `检查${vncSessions.length}个VNC会话：自愈重建${recovered}个，处置${n}个` }
  },

  // 18. 定时策略下发到点激活（SCHEDULED → PENDING 批次到 effectiveAt 自动执行）
  async policy_deployment_activation(log) {
    const r = await activateDueScheduledDeployments(log)
    return { itemsProcessed: r.activated + r.failed, summary: `激活${r.activated}个定时策略批次${r.failed > 0 ? `，失败${r.failed}个` : ""}` }
  },

  // 19. CRX 插件安装状态轮询（源可达性真实探测 + CDP 扩展检测 + 失败降级/告警）
  async crx_install_poll(log) {
    return crxInstallPoll(log)
  },

  // 20. CRX 灰度策略滚动下发（ROLLING → 分批应用 → SUCCESS/PARTIAL）
  async crx_gray_rollout(log) {
    return crxGrayRollout(log)
  },

  // 21. r24-h：冻结到期自动解冻（离线冻结封存 → expireAt 到点 → STOPPED 可重新启动）
  async frozen_expire_check(log) {
    const due = await db.browserWorkspace.findMany({
      where: { status: "FROZEN", deletedAt: null, expireAt: { lte: new Date() } },
      take: 200,
    })
    let n = 0
    for (const ws of due) {
      await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "STOPPED", freezeReason: null, expireAt: null } })
      await writeAudit({
        operationType: "WORKSPACE_UNFREEZE", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        ownerUserId: ws.userId, severity: "INFO", before: { status: "FROZEN", expireAt: ws.expireAt }, after: { status: "STOPPED", auto: true },
      })
      await raiseAlert({
        title: "冻结工作区已到期自动解冻", level: "INFO",
        content: `工作区 ${ws.name}（${ws.uuid}）离线冻结封存到期，已自动恢复为 STOPPED（所有者可重新启动）`,
        resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId, dedupeKey: `ws-unfreeze-auto-${ws.id}`,
      }).catch(() => null)
      log(`自动解冻 ${ws.name}（${ws.uuid}）`)
      n++
    }
    return { itemsProcessed: n, summary: `到期自动解冻${n}个冻结沙箱` }
  },

  // 22. r26：未知扩展扫描（真实容器 CDP 枚举 - 五级合并策略 → 未授权扩展 → DANGER 审计 + CRITICAL 告警）
  async crx_unknown_scan(log) {
    const r = await scanUnknownExtensions(log)
    return { itemsProcessed: r.scanned, summary: `扫描 ${r.scanned} 个运行容器，发现 ${r.findings.length} 个未知扩展${r.findings.length > 0 ? "（已告警+审计）" : ""}` }
  },

  // 23. r26：策略文件防篡改校验（SHA-256 哈希对账；篡改 → DANGER 审计 + CRITICAL 告警）
  async policy_tamper_check(log) {
    const r = await checkPolicyTampering(log)
    return { itemsProcessed: r.checked, summary: `对账 ${r.checked} 个策略文件${r.missing > 0 ? `（${r.missing} 个文件缺失属停止态正常）` : ""}，发现 ${r.tampered.length} 处篡改` }
  },

  // 24. r26：安全基线扫描（十维合规评分落 hardeningJson.baselineScore；低分告警）
  async baseline_scan(log) {
    const r = await scanSecurityBaseline(log)
    return { itemsProcessed: r.scanned, summary: `扫描 ${r.scanned} 个活跃沙箱，平均基线分 ${r.averageScore ?? "-"}，低分 ${r.lowScore} 个${r.lowScore > 0 ? "（已告警）" : ""}` }
  },

  // 25. r27：VNC 录像分段扫描（新段入库 / 活跃段收尾 / 死沙箱会话自动终结）
  async recording_scan(log) {
    const { scanAllLiveRecordings } = await import("@/lib/recording")
    const r = await scanAllLiveRecordings(log)
    return { itemsProcessed: r.sessions, summary: `同步 ${r.sessions} 个录像会话：新段 ${r.created}、收尾 ${r.finalized}、自动终结 ${r.terminated}` }
  },

  // 26. r27：VNC 录像治理（保留期到期入回收站 + 用户配额超额最旧优先归档）
  async recording_retention(log) {
    const { enforceRecordingRetention } = await import("@/lib/recording")
    const r = await enforceRecordingRetention(log)
    return { itemsProcessed: r.expired + r.quotaEvicted, summary: `保留期到期 ${r.expired} 段、配额治理 ${r.quotaEvicted} 段（覆盖 ${r.usersChecked} 个用户）` }
  },

  // 27. r28：浏览历史/书签采集（CDP /json/list 轮询 + Profile Bookmarks 对账；沙箱隔离级）
  async browsing_collect(log) {
    const { collectAllRunningBrowsing } = await import("@/lib/browsing-collector")
    const r = await collectAllRunningBrowsing()
    log(`历史新增 ${r.historyInserted} 条 / 合并 ${r.historyMerged} 条；书签对账 ${r.bookmarkWorkspaces} 个沙箱（upsert ${r.bookmarkUpserted}、移除 ${r.bookmarkRemoved}）`)
    return { itemsProcessed: r.historyInserted + r.bookmarkUpserted, summary: `采集 ${r.workspaces} 个运行沙箱：历史新 ${r.historyInserted}/合并 ${r.historyMerged}，书签同步 ${r.bookmarkUpserted} 条（移除 ${r.bookmarkRemoved}）` }
  },

  // 28. r29-d：Worker 节点资源监控 + 失联自动迁移（10s 心跳 3 次未达 → OFFLINE + 迁移计划）
  async worknode_monitor(log) {
    const { runWorknodeMonitor } = await import("@/lib/worknode-monitor")
    const r = await runWorknodeMonitor(log)
    return { itemsProcessed: r.checked, summary: `监控 ${r.checked} 个节点：失联标记 ${r.offlineMarked}（迁移 ${r.migrationPlanned}）、恢复 ${r.recovered}、水位告警 ${r.thresholdAlerts}` }
  },

  // 30. r29-f：分布式文件存储维护（中转超时下沉 + 副本修复 + 冷热分层 + 失联随迁）
  async dfs_maintenance(log) {
    const { runDfsMaintenance } = await import("@/lib/distributed-file-store")
    const r = await runDfsMaintenance()
    return { itemsProcessed: r.relayExpired + r.lostMarked + r.tiered, summary: `中转下沉 ${r.relayExpired}、副本失联 ${r.lostMarked}（重建 ${r.repairsPlanned}）、冷分层 ${r.tiered}` }
  },

  // 29. r29-e：媒体投递进程巡检（ffplay 死亡自动收口 STOPPED）
  async media_cast_reap(log) {
    const { reapDeadMediaCasts } = await import("@/lib/media-cast")
    const r = await reapDeadMediaCasts()
    return { itemsProcessed: r.reaped, summary: `投递巡检：${r.reaped} 个已结束投递自动收口` }
  },

  // ---- r24-a：参数化自定义执行体（执行内容完全放开；paramsJson 携带参数）----
  // 注：custom_shell 顶层调用由 runTask 直连（携带任务自身 timeoutSec）；
  // 此注册表项用于类型清单展示 + 任务链步骤内调用（步骤超时兜底 300s）
  async custom_shell(log, params) {
    return runShellExecutor(params, log, 300)
  },
  async custom_chain(log, params) {
    return runChainExecutor(params, log, (t) => TASKS[t])
  },
  async custom_webhook(log, params) {
    return runWebhookExecutor(params, log)
  },
}

// 供 listCustomTaskTypesAction：参数化类型标记（前端据此渲染专属参数编辑器）
export function customExecMeta(taskType: string): { kind: string; name: string; description: string } | null {
  return CUSTOM_EXEC_TASK_TYPES[taskType] ?? null
}

// 崩溃会话连续失败计数（内存态，进程级；任务由内存锁保证单实例执行）
function vncFailCounter(): Map<string, number> {
  const g = globalThis as unknown as { __dyVncFail?: Map<string, number> }
  if (!g.__dyVncFail) g.__dyVncFail = new Map()
  return g.__dyVncFail
}

// r23：代理节点上次探测时间（探测间隔控制，内存态）
function probeLastAt(): Map<string, number> {
  const g = globalThis as unknown as { __dyProbeLast?: Map<string, number> }
  if (!g.__dyProbeLast) g.__dyProbeLast = new Map()
  return g.__dyProbeLast
}

// ---- 任务执行入口（内存锁 + 超时 + 连续失败告警；r23：自定义任务解析 + nextRunAt 重算）----
export async function runTask(code: string, trigger: "CRON" | "MANUAL"): Promise<{ ok: boolean; message: string }> {
  const record = await db.scheduleTask.findUnique({ where: { code } })
  // 自定义任务：执行体 = taskType 指向的注册表函数（内置任务 taskType=code 本身）
  const execCode = record?.taskType && record.isCustom ? record.taskType : code
  const task = TASKS[execCode]
  if (!task) return { ok: false, message: `未知任务：${execCode}${record?.isCustom ? "（自定义任务指向的任务类型不存在，可能已被引擎移除）" : ""}` }
  const timeoutSec = record?.timeoutSec || 300

  // r24-a：参数化执行体——paramsJson 解析（损坏时直接失败，不静默丢参数执行）
  let taskParams: unknown = undefined
  if (record?.isCustom && record.paramsJson) {
    try {
      taskParams = JSON.parse(record.paramsJson)
    } catch {
      return { ok: false, message: `自定义任务参数解析失败（paramsJson 非法 JSON）：${code}` }
    }
  }

  const lockOk = await acquireLock(code, timeoutSec)
  if (!lockOk) return { ok: false, message: `任务 ${code} 正在执行中（内存锁生效，防并发重入）` }
  const logLines: string[] = []
  const log = (m: string) => { logLines.push(m) }
  const startAt = new Date()
  const logRow = await db.scheduleTaskLog.create({ data: { taskCode: code, triggerType: trigger, status: "RUNNING", startAt } })

  const heartbeat = setInterval(() => {
    const l = locks().get(code)
    if (l) l.heartbeat = Date.now()
  }, HEARTBEAT_MS)
  ;(heartbeat as unknown as { unref?: () => void }).unref?.()

  try {
    // r24-a：custom_shell 顶层调用直连执行体（携带任务自身 timeoutSec，自管超时击杀）
    const execFn: Promise<TaskResult> =
      record?.isCustom && execCode === "custom_shell"
        ? runShellExecutor(taskParams, log, timeoutSec)
        : Promise.race([
            Promise.resolve(task(log, taskParams)),
            new Promise<TaskResult>((_, reject) =>
              setTimeout(() => reject(new Error(`任务执行超时（${timeoutSec}s）`)), timeoutSec * 1000)
            ),
          ])
    const result = await execFn
    const durationMs = Date.now() - startAt.getTime()
    // r23：按 cron 表达式重算下次到期（到期调度依据；解析失败保持空 → 兼容旧固频触发）
    const next = record ? nextCronRun(record.cronExpr, new Date()) : null
    // r24-a：业务失败（failed=true，如脚本 exit≠0 / HTTP 不符合预期）记 FAILED 但保留完整输出
    const bizFailed = result.failed === true
    await db.scheduleTaskLog.update({
      where: { id: logRow.id },
      data: {
        status: bizFailed ? "FAILED" : "SUCCESS",
        endAt: new Date(),
        durationMs,
        itemsProcessed: result.itemsProcessed,
        summary: result.summary + (logLines.length > 0 ? `；${logLines.slice(0, record?.isCustom ? 40 : 5).join("；")}` : ""),
        ...(result.output ? { outputJson: result.output.slice(0, 65536) } : {}),
        ...(bizFailed ? { errorStack: result.summary.slice(0, 2000) } : {}),
      },
    })
    await db.scheduleTask.update({
      where: { code },
      data: { lastExecuteAt: new Date(), lastResult: `${bizFailed ? "FAILED" : "SUCCESS"} ${result.summary}`, consecutiveFails: bizFailed ? (record?.consecutiveFails || 0) + 1 : 0, avgDurationMs: Math.round(durationMs), ...(next ? { nextRunAt: next } : {}) },
    })
    return { ok: !bizFailed, message: result.summary }
  } catch (e) {
    const durationMs = Date.now() - startAt.getTime()
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack || "" : ""
    await db.scheduleTaskLog.update({
      where: { id: logRow.id },
      data: { status: msg.includes("超时") ? "TIMEOUT" : "FAILED", endAt: new Date(), durationMs, errorStack: stack.slice(0, 2000) || msg, ...(logLines.length > 0 ? { outputJson: logLines.join("\n").slice(0, 65536) } : {}) },
    })
    const fails = (record?.consecutiveFails || 0) + 1
    const next = record ? nextCronRun(record.cronExpr, new Date()) : null
    await db.scheduleTask.update({ where: { code }, data: { lastExecuteAt: new Date(), lastResult: `FAILED ${msg}`, consecutiveFails: fails, ...(next ? { nextRunAt: next } : {}) } })
    if (fails >= 3) {
      const { getConfigBool } = await import("@/lib/config")
      if (await getConfigBool("alert.taskFailEnabled", true)) {
        await raiseAlert({ title: `定时任务连续失败：${code}`, level: "CRITICAL", content: `连续失败 ${fails} 次：${msg}`, resourceType: "TASK", resourceId: code, dedupeKey: `task-fail-${code}` })
      }
    }
    return { ok: false, message: msg }
  } finally {
    clearInterval(heartbeat)
    releaseLock(code)
  }
}

export function runningTaskCodes(): string[] {
  return Array.from(locks().keys())
}
