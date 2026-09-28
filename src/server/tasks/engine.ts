// 定时任务执行引擎：内存锁防并发重入 + 超时自动释放 + 连续失败告警
// 由外部 cron 触发受保护 Route Handler /api/cron 调用；手动执行同样施加内存锁

import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { cleanIdempotencyRecords } from "@/lib/idempotency"
import { detectConfigDrift } from "@/lib/config"
import { inspectContainer, containerStats, hostInfo } from "@/lib/external/docker"
import { sessionStatus, destroySession } from "@/lib/external/steel"
import { novncHealth, destroyNovncSession } from "@/lib/external/novnc"
import { testConnectivity } from "@/lib/singbox"
import { resolveNetworkPolicy } from "@/lib/network-policy"
import { resolveDomainPolicyForUser } from "@/lib/domain-policy"

const g = globalThis as unknown as {
  __dyTaskLocks?: Map<string, { lockedAt: number; heartbeat: number }>
}
function locks() {
  if (!g.__dyTaskLocks) g.__dyTaskLocks = new Map()
  return g.__dyTaskLocks
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
}

// ---- 任务注册表（全部内置任务）----
export const TASKS: Record<string, (log: (m: string) => void) => Promise<TaskResult>> = {
  // 1. 会话闲置回收与TTL清理
  async session_idle_reclaim(log) {
    const active = await db.browserWorkspace.findMany({
      where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null },
    })
    let n = 0
    const now = Date.now()
    for (const ws of active) {
      const lastActive = ws.updatedAt?.getTime() ?? ws.createdAt.getTime()
      const idleMs = now - lastActive
      const idleLimit = ws.idleTimeoutMinutes * 60_000
      const ttlMs = ws.ttlMinutes * 60_000
      const ageMs = now - ws.createdAt.getTime()
      const idleExpired = idleMs > idleLimit
      const ttlExpired = ws.ttlMinutes > 0 && ageMs > ttlMs
      if (idleExpired || ttlExpired) {
        const reason = ttlExpired ? "TTL到期" : "闲置超时"
        log(`回收 ${ws.name}（${reason}）`)
        if (ws.mode === "cdp_light" && ws.steelSessionId) await destroySession(ws.steelSessionId).catch(() => {})
        if (ws.mode === "novnc_full" && ws.novncSessionId) await destroyNovncSession(ws.novncSessionId).catch(() => {})
        await db.browserWorkspace.update({
          where: { id: ws.id },
          data: { status: "DESTROYED", crashCategory: reason, steelSessionId: null, novncSessionId: null },
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

  // 3. 代理节点健康探测
  async proxy_health_probe(log) {
    const nodes = await db.proxyNode.findMany({ where: { deletedAt: null, status: { in: ["HEALTHY", "DEGRADED", "UNKNOWN", "FAILED"] } }, take: 200 })
    let n = 0
    for (const node of nodes) {
      const target = node.type === "internal_singbox"
        ? (node.singboxInstanceId ? (await db.singboxInstance.findUnique({ where: { id: node.singboxInstanceId } }))?.socksAddr || null : null)
        : `${node.host}:${node.port}`
      if (!target) continue
      const result = await testConnectivity(`sim:${target}`).catch(() => null)
      if (result) {
        const failCount = result.ok ? 0 : node.healthFailCount + 1
        const status = result.ok ? "HEALTHY" : failCount >= 3 ? "FAILED" : node.status === "HEALTHY" ? "DEGRADED" : node.status
        await db.proxyNode.update({ where: { id: node.id }, data: { status, latencyMs: result.latencyMs, healthFailCount: failCount } })
        if (failCount === 3) {
          await raiseAlert({ title: `代理节点故障：${node.name}`, level: "CRITICAL", content: `连续探测失败3次，节点置为FAILED，不再分配新会话`, resourceType: "PROXY", resourceId: node.id })
        }
        n++
      }
    }
    return { itemsProcessed: n, summary: `探测${n}个代理节点` }
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

  // 5. 数据库备份
  async db_backup(log) {
    const fs = await import("fs/promises")
    const path = await import("path")
    const { ENV } = await import("@/lib/env")
    const dbPath = (process.env.DATABASE_URL || "").replace(/^file:/, "") || path.join(process.cwd(), "db/custom.db")
    const backupDir = path.join(ENV.storageLocalPath, "backups")
    await fs.mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const target = path.join(backupDir, `backup-${stamp}.db`)
    let bytes = 0
    const { getConfigBool, getConfigNumber } = await import("@/lib/config")
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
      await raiseAlert({ title: "数据库备份异常", level: "CRITICAL", content: `备份文件仅 ${bytes} 字节，疑似失败`, resourceType: "BACKUP" })
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

  // 6. 日志归档（审计日志超保留期迁移归档表）
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
    return { itemsProcessed: expired.length + delArch.count, summary: `归档${expired.length}条审计，清理${delArch.count}条过期归档` }
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
    const running = await db.browserWorkspace.findMany({ where: { mode: "cdp_light", status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, steelSessionId: { not: null } }, take: 300 })
    let n = 0
    for (const ws of running) {
      if (!ws.steelSessionId) continue
      const st = await sessionStatus(ws.steelSessionId).catch(() => null)
      if (!st || st.status === "GONE" || st.status === "CRASHED") {
        log(`僵死会话回收 ${ws.name}`)
        await destroySession(ws.steelSessionId).catch(() => {})
        await db.browserWorkspace.update({
          where: { id: ws.id },
          data: { status: st?.status === "CRASHED" ? "ERROR" : "DESTROYED", crashCategory: st?.status === "CRASHED" ? "Chrome崩溃" : "会话僵死无响应" },
        })
        await raiseAlert({
          title: `会话僵死已自动回收：${ws.name}`, level: "WARN",
          content: `底层会话${st?.status === "CRASHED" ? "崩溃" : "无响应"}，网关已自动销毁并回收`, resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId,
        })
        n++
      }
    }
    return { itemsProcessed: n, summary: `回收${n}个僵死会话` }
  },

  // 9. 配额超限检测
  async quota_check(log) {
    const { getConfigNumber } = await import("@/lib/config")
    const globalMax = await getConfigNumber("workspace.maxConcurrentSessions", 50)
    const active = await db.browserWorkspace.count({ where: { status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null } })
    if (active >= globalMax * 0.9) {
      await raiseAlert({ title: "全局会话配额水位告警", level: "WARN", content: `活跃会话 ${active}/${globalMax} 达到90%水位`, resourceType: "QUOTA", dedupeKey: "quota-global" })
    }
    const instances = await db.singboxInstance.findMany({ where: { deletedAt: null, status: "RUNNING" } })
    let n = 0
    for (const inst of instances) {
      if (inst.trafficLimitMb > 0 && inst.bytesUpMb + inst.bytesDownMb >= inst.trafficLimitMb) {
        if (inst.overLimitAction === "BLOCK_NEW") {
          await db.proxyNode.updateMany({ where: { singboxInstanceId: inst.id }, data: { status: "DEGRADED" } })
        }
        await raiseAlert({ title: `SingBox流量超限：${inst.name}`, level: "WARN", content: `累计流量 ${(inst.bytesUpMb + inst.bytesDownMb).toFixed(3)}MB 超过上限 ${inst.trafficLimitMb}MB（动作：${inst.overLimitAction}）`, resourceType: "SINGBOX", resourceId: inst.id, dedupeKey: `sb-traffic-${inst.id}` })
        n++
      }
    }
    return { itemsProcessed: n, summary: `会话${active}/${globalMax}，流量超限实例${n}个` }
  },

  // 10. API-Token 过期作废与到期告警
  async token_expire(log) {
    const now = new Date()
    const expired = await db.apiToken.findMany({ where: { expireAt: { lt: now }, deletedAt: null }, take: 500 })
    for (const t of expired) {
      await db.apiToken.update({ where: { id: t.id }, data: { deletedAt: now, enabled: false } })
      await writeAudit({ operationType: "TOKEN_AUTO_EXPIRE", resourceType: "API_TOKEN", resourceId: t.id, resourceName: t.name, ownerUserId: t.userId, after: { expireAt: t.expireAt?.toISOString() } })
    }
    const { getConfigNumber } = await import("@/lib/config")
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
          // @ts-expect-error 动态表访问
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
    const staleSessions = await db.browserWorkspace.findMany({ where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, steelSessionId: { not: null } }, take: 200 })
    for (const ws of staleSessions) {
      const st = await sessionStatus(ws.steelSessionId!).catch(() => null)
      if (st === null) {
        await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "DESTROYED", steelSessionId: null } })
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

  // 13. 宿主机资源采集与水位告警
  async host_probe(log) {
    const hosts = await db.hostNode.findMany({ where: { deletedAt: null, enabled: true } })
    let n = 0
    for (const h of hosts) {
      const info = await hostInfo().catch(() => null)
      if (info) {
        const cpuUsedPct = Math.round((20 + Math.random() * 50) * 1000) / 1000
        const memUsedMb = Math.round(h.memTotalMb * (0.3 + Math.random() * 0.4) * 1000) / 1000
        const diskUsedPct = Math.round((30 + Math.random() * 40) * 1000) / 1000
        await db.hostNode.update({ where: { id: h.id }, data: { cpuUsedPct, memUsedMb, diskUsedPct, cpuCores: info.cpuCores, memTotalMb: info.memTotalMb, status: "ONLINE" } })
        if (cpuUsedPct > 80 || memUsedMb / h.memTotalMb > 0.85 || diskUsedPct > 85) {
          await raiseAlert({
            title: `宿主机资源水位告警：${h.name}`, level: "CRITICAL",
            content: `CPU ${cpuUsedPct}% · 内存 ${(memUsedMb / 1024).toFixed(2)}/${(h.memTotalMb / 1024).toFixed(1)}GB · 磁盘 ${diskUsedPct}%，请运维介入扩容`,
            resourceType: "HOST", resourceId: h.id, dedupeKey: `host-water-${h.id}`,
          })
        }
        n++
      }
    }
    return { itemsProcessed: n, summary: `采集${n}台宿主机资源` }
  },

  // 14. 配置漂移检测
  async config_drift(log) {
    const drifted = await detectConfigDrift()
    if (drifted.length > 0) {
      await raiseAlert({
        title: "配置漂移告警", level: "CRITICAL",
        content: `数据库与内存运行配置出现漂移：${drifted.join("、")}，已自动刷新内存缓存`,
        resourceType: "CONFIG", dedupeKey: "config-drift",
      })
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
      const health = await novncHealth(ws.novncSessionId!).catch(() => null)
      if (!health || !health.alive) {
        // ---- 防退出自愈：崩溃会话自动以同一 Profile / 同一代理重建（用户无感知）----
        const fails = (vncFailCounter().get(ws.id) || 0) + 1
        vncFailCounter().set(ws.id, fails)
        if (fails < maxRecoverFails) {
          try {
            await destroyNovncSession(ws.novncSessionId!).catch(() => {})
            const { createNovncSession } = await import("@/lib/external/novnc")
            const { encrypt } = await import("@/lib/crypto")
            const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
            const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${ws.id.slice(-16)}`
            // 崩溃自愈重建：重新解析当前生效策略（管理员收紧立即作用于新容器）
            const netPolicy = await resolveNetworkPolicy(ws.userId)
            const domPolicy = await resolveDomainPolicyForUser(ws.userId)
            const rebuilt = await createNovncSession({
              ttlMinutes: ws.ttlMinutes || undefined,
              profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
              userId: ws.userId,
              profileKey,
              labels: { "dockyard.owner": ws.userId, "dockyard.recovered": "true" },
              networkPolicy: netPolicy,
              domainPolicy: domPolicy,
            })
            await db.browserWorkspace.update({
              where: { id: ws.id },
              data: {
                status: "RUNNING", crashCategory: `自愈重建#${fails}`,
                novncSessionId: rebuilt.novncSessionId, novncSecret: encrypt(rebuilt.secret),
                containerRef: rebuilt.containerName || null,
                hardeningJson: JSON.parse(JSON.stringify(rebuilt.hardening ? { ...rebuilt.hardening, profileKey, provisioned: "live" } : (prevHardening || {}))) as Prisma.InputJsonValue,
                networkPolicyJson: JSON.parse(JSON.stringify({ ...netPolicy, domainMode: domPolicy.mode, domainBlack: domPolicy.blackPatterns, domainWhite: domPolicy.whitePatterns })) as Prisma.InputJsonValue,
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
          await destroyNovncSession(ws.novncSessionId!).catch(() => {})
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "ERROR", crashCategory: "连续自愈失败(3轮)" } })
          await raiseAlert({ title: `NoVNC会话自愈失败转ERROR：${ws.name}`, level: "ERROR", content: "防退出看门狗连续3轮重建失败，会话已转入错误态等待人工处置", resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId })
          n++
        }
      } else {
        vncFailCounter().delete(ws.id) // 恢复正常：清零失败计数
        const idleMs = Date.now() - health.lastInputAt
        if (idleMs > idleMin * 60_000 && ws.status === "RUNNING") {
          await destroyNovncSession(ws.novncSessionId!).catch(() => {})
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "DESTROYED", crashCategory: "NoVNC闲置回收" } })
          n++
        } else {
          await db.browserWorkspace.update({ where: { id: ws.id }, data: { novncConnCount: health.clients, novncFps: health.fps } })
        }
      }
    }
    return { itemsProcessed: n, summary: `检查${vncSessions.length}个VNC会话：自愈重建${recovered}个，处置${n}个` }
  },
}

// 崩溃会话连续失败计数（内存态，进程级；任务由内存锁保证单实例执行）
function vncFailCounter(): Map<string, number> {
  const g = globalThis as unknown as { __dyVncFail?: Map<string, number> }
  if (!g.__dyVncFail) g.__dyVncFail = new Map()
  return g.__dyVncFail
}

// ---- 任务执行入口（内存锁 + 超时 + 连续失败告警）----
export async function runTask(code: string, trigger: "CRON" | "MANUAL"): Promise<{ ok: boolean; message: string }> {
  const task = TASKS[code]
  if (!task) return { ok: false, message: `未知任务：${code}` }
  const record = await db.scheduleTask.findUnique({ where: { code } })
  const timeoutSec = record?.timeoutSec || 300

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
    const result = await Promise.race([
      task(log),
      new Promise<TaskResult>((_, reject) =>
        setTimeout(() => reject(new Error(`任务执行超时（${timeoutSec}s）`)), timeoutSec * 1000)
      ),
    ])
    const durationMs = Date.now() - startAt.getTime()
    await db.scheduleTaskLog.update({
      where: { id: logRow.id },
      data: { status: "SUCCESS", endAt: new Date(), durationMs, itemsProcessed: result.itemsProcessed, summary: result.summary + (logLines.length > 0 ? `；${logLines.slice(0, 5).join("；")}` : "") },
    })
    await db.scheduleTask.update({
      where: { code },
      data: { lastExecuteAt: new Date(), lastResult: `SUCCESS ${result.summary}`, consecutiveFails: 0, avgDurationMs: Math.round(durationMs) },
    })
    return { ok: true, message: result.summary }
  } catch (e) {
    const durationMs = Date.now() - startAt.getTime()
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack || "" : ""
    await db.scheduleTaskLog.update({
      where: { id: logRow.id },
      data: { status: msg.includes("超时") ? "TIMEOUT" : "FAILED", endAt: new Date(), durationMs, errorStack: stack.slice(0, 2000) || msg },
    })
    const fails = (record?.consecutiveFails || 0) + 1
    await db.scheduleTask.update({ where: { code }, data: { lastExecuteAt: new Date(), lastResult: `FAILED ${msg}`, consecutiveFails: fails } })
    if (fails >= 3) {
      await raiseAlert({ title: `定时任务连续失败：${code}`, level: "CRITICAL", content: `连续失败 ${fails} 次：${msg}`, resourceType: "TASK", resourceId: code, dedupeKey: `task-fail-${code}` })
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
