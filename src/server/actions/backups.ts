"use server"

// 备份恢复 Server Actions：
// - createBackupAction：SQLite 数据库文件复制到 storage/backups/backup-<ts>.db（可选 AES-256-GCM 加密）+ fileMeta + BackupRecord + 审计 + 异常告警
// - restoreBackupAction：先临时备份 → 开维护模式 → 写回数据库文件 → 关维护模式 → CRITICAL 审计
// 说明：备份/恢复必须可在维护模式下执行（恢复过程自身会开关维护模式），故不做 requireWritableMode 拦截。

import { z } from "zod"
import { Prisma } from "@prisma/client"
import { promises as fs } from "fs"
import path from "path"
import crypto from "crypto"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAdmin, requireSuperAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { setConfig, getConfigBool, getConfig } from "@/lib/config"
import { raiseAlert } from "@/lib/alerts"
import { ENV } from "@/lib/env"
import { bizError, ErrorCode } from "@/lib/errors"

// DATABASE_URL 形如 file:/home/z/my-project/db/custom.db —— 去掉 file: 前缀即数据库文件绝对路径
function dbFilePath(): string {
  const url = process.env.DATABASE_URL || "file:./db/custom.db"
  let p = url.startsWith("file:") ? url.slice(5) : url
  p = p.split("?")[0]
  if (!path.isAbsolute(p)) p = path.resolve(process.cwd(), p)
  return p
}

function key32(): Buffer {
  return crypto.createHash("sha256").update(String(ENV.encryptionKey)).digest()
}

function backupStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

interface BackupOutcome {
  recordId: string
  fileMetaId: string
  fileName: string
  type: "FULL" | "PARTIAL"
  encrypted: boolean
  sizeBytes: number
  checksum: string
  healthy: boolean
  note: string
}

// 备份核心流程（createBackup 与 restore 前置临时备份共用）
async function performBackup(
  ctx: { userId: string; username: string },
  type: "FULL" | "PARTIAL",
  note: string
): Promise<BackupOutcome> {
  const src = dbFilePath()
  const data = await fs.readFile(src) // SQLite 主库文件字节快照

  const encrypted = await getConfigBool("backup.encrypt", false)
  const fileName = `backup-${backupStamp(new Date())}${encrypted ? ".db.enc" : ".db"}`
  const storageKey = `backups/${fileName}`
  const destDir = path.join(ENV.storageLocalPath, "backups")
  await fs.mkdir(destDir, { recursive: true })

  const checksum = crypto.createHash("sha256").update(data).digest("hex")
  let sizeBytes: number
  if (encrypted) {
    // AES-256-GCM：文件结构 = iv(12B) + authTag(16B) + 密文
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key32(), iv)
    const enc = Buffer.concat([cipher.update(data), cipher.final()])
    const tag = cipher.getAuthTag()
    const out = Buffer.concat([iv, tag, enc])
    await fs.writeFile(path.join(ENV.storageLocalPath, storageKey), out)
    sizeBytes = out.length
  } else {
    await fs.writeFile(path.join(ENV.storageLocalPath, storageKey), data)
    sizeBytes = data.length
  }

  // 完整性校验：备份文件必须 > 1024 字节，否则视为失败并产生 CRITICAL 告警
  const healthy = sizeBytes > 1024

  const fileMeta = await db.fileMeta.create({
    data: {
      fileName,
      storageKey,
      size: sizeBytes,
      mime: encrypted ? "application/octet-stream" : "application/x-sqlite3",
      checksum,
      category: "BACKUP",
      createdByUserId: ctx.userId,
      virusScanned: true,
    },
  })
  const record = await db.backupRecord.create({
    data: {
      fileMetaId: fileMeta.id,
      type,
      tableList: Prisma.DbNull,
      encrypted,
      sizeBytes,
      checksum,
      status: healthy ? "SUCCESS" : "FAILED",
      createdByUserId: ctx.userId,
    },
  })

  if (!healthy) {
    await raiseAlert({
      title: "数据库备份文件异常",
      level: "CRITICAL",
      content: `备份 ${fileName} 大小仅 ${sizeBytes} 字节（阈值 1024），疑似备份失败。请立即检查磁盘空间与数据库状态。`,
      resourceType: "BACKUP",
      resourceId: record.id,
      dedupeKey: `backup-size-abnormal-${fileName}`,
    })
  }

  // r36：多节点副本推送（异步不阻断返回；后台 backup.pushNodes 配置的 Worker 节点）
  if (healthy) {
    void pushBackupReplicas({ backupId: record.id, fileKey: `backups/${fileName}`, absPath: path.join(ENV.storageLocalPath, storageKey), sizeBytes, checksum })
  }

  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: "BACKUP_CREATE",
    resourceType: "BACKUP",
    resourceId: record.id,
    resourceName: fileName,
    after: { type, encrypted, sizeBytes, checksum: checksum.slice(0, 16) + "…", status: record.status, note },
    severity: "WARN",
  })

  return {
    recordId: record.id,
    fileMetaId: fileMeta.id,
    fileName,
    type,
    encrypted,
    sizeBytes,
    checksum,
    healthy,
    note,
  }
}

// ============================================================
// r36：多节点备份副本推送（Master → Worker 指令队列分块通道）
// 流程：读备份文件字节 → 按 2MB 分块 base64 → 逐节点入 WorkNodeCommand 队列
//（begin → append* → finish 含整体 sha256；Worker 心跳顺取顺执行，结果回传更新
//  BackupRecord.replicasJson：PENDING→SENT→OK/FAIL）。异步执行、失败告警、不阻断备份返回。
// ============================================================
const REPLICA_CHUNK_BYTES = 2 * 1024 * 1024 // 2MB/块（base64 后 ~2.7MB，心跳体可控）

export async function pushBackupReplicas(opts: { backupId: string; fileKey: string; absPath: string; sizeBytes: number; checksum: string }): Promise<void> {
  try {
    const cfg = (await getConfig("backup.pushNodes", "")).trim()
    if (!cfg) return
    const nodeUuids = cfg.split(",").map((s) => s.trim()).filter((s) => /^wn-[a-f0-9]{16}$/.test(s))
    if (nodeUuids.length === 0) return

    // 节点存在性与在线状态校验（未注册/离线 → 跳过并在副本状态中留 PENDING-SKIP 痕迹）
    const nodes = await db.workNode.findMany({ where: { nodeUuid: { in: nodeUuids } } })
    const byUuid = new Map(nodes.map((n) => [n.nodeUuid, n]))

    const data = await fs.readFile(opts.absPath).catch(() => null)
    if (!data || data.length !== opts.sizeBytes) {
      await raiseAlert({
        title: "备份副本推送失败（文件不可读）",
        level: "WARN",
        content: `备份 ${opts.fileKey} 推送多节点前读取失败（磁盘异常或文件被移动），副本未创建。`,
        resourceType: "BACKUP",
        resourceId: opts.backupId,
        dedupeKey: `backup-replica-read-${opts.backupId}`,
      }).catch(() => null)
      return
    }

    const replicas: Array<{ nodeUuid: string; state: string; skip?: string; at?: string }> = []
    for (const uuid of nodeUuids) {
      const node = byUuid.get(uuid)
      if (!node || node.status === "EVICTED" || !node.enabled) {
        replicas.push({ nodeUuid: uuid, state: "SKIP", skip: node ? "节点已禁用/驱逐" : "节点未注册", at: new Date().toISOString() })
        continue
      }
      // 分块指令（顺序入队；Worker 心跳按序执行）
      await db.workNodeCommand.create({
        data: { nodeUuid: uuid, cmd: "backup.replica.begin", payloadJson: JSON.stringify({ fileKey: opts.fileKey, sizeBytes: opts.sizeBytes, sha256: opts.checksum, backupId: opts.backupId }) },
      })
      for (let off = 0; off < data.length; off += REPLICA_CHUNK_BYTES) {
        const chunk = data.subarray(off, Math.min(off + REPLICA_CHUNK_BYTES, data.length))
        await db.workNodeCommand.create({
          data: {
            nodeUuid: uuid,
            cmd: "backup.replica.append",
            payloadJson: JSON.stringify({
              fileKey: opts.fileKey,
              offset: off,
              contentB64: chunk.toString("base64"),
              chunkSha256: crypto.createHash("sha256").update(chunk).digest("hex"),
            }),
          },
        })
      }
      await db.workNodeCommand.create({
        data: { nodeUuid: uuid, cmd: "backup.replica.finish", payloadJson: JSON.stringify({ fileKey: opts.fileKey, sha256: opts.checksum, backupId: opts.backupId }) },
      })
      replicas.push({ nodeUuid: uuid, state: "SENT" })
    }

    await db.backupRecord.update({ where: { id: opts.backupId }, data: { replicasJson: JSON.stringify(replicas) } }).catch(() => null)
    await writeAudit({
      operationType: "BACKUP_REPLICA_PUSH",
      resourceType: "BACKUP",
      resourceId: opts.backupId,
      resourceName: opts.fileKey,
      after: { nodes: nodeUuids.join(","), chunks: Math.ceil(opts.sizeBytes / REPLICA_CHUNK_BYTES), sizeBytes: opts.sizeBytes },
      severity: "INFO",
    }).catch(() => null)
  } catch (e) {
    await raiseAlert({
      title: "备份副本推送异常",
      level: "WARN",
      content: `多节点备份推送出现异常：${e instanceof Error ? e.message : String(e)}（主备份本体已落盘不受影响）`,
      resourceType: "BACKUP",
      resourceId: opts.backupId,
      dedupeKey: `backup-replica-err-${opts.backupId}`,
    }).catch(() => null)
  }
}

// ---- 1. 立即备份 ----

export interface CreateBackupResult {
  backupId: string
  fileName: string
  sizeBytes: number
  encrypted: boolean
  durationMs: number
}

export async function createBackupAction(input: unknown): Promise<ActionResult<CreateBackupResult>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    zodValidate(z.object({ confirm: z.boolean().optional() }), input ?? {})

    const start = Date.now()
    const r = await performBackup(ctx, "FULL", "手动立即备份")
    const durationMs = Date.now() - start
    if (!r.healthy) {
      throw new Error(`备份文件异常（仅 ${r.sizeBytes} 字节，≤1024），已产生 CRITICAL 告警，请立即排查`)
    }
    return { backupId: r.recordId, fileName: r.fileName, sizeBytes: r.sizeBytes, encrypted: r.encrypted, durationMs }
  })
}

// ---- 2. 恢复备份（高危：强确认 RESTORE + CRITICAL 审计） ----

const restoreSchema = z.object({ backupId: zId })

export interface RestoreBackupResult {
  backupId: string
  fileName: string
  encrypted: boolean
  sizeBytes: number
  checksumMatch: boolean | null
  tempBackupId: string
  tempBackupFile: string
  steps: string[]
  restartRequired: true
}

export async function restoreBackupAction(input: unknown): Promise<ActionResult<RestoreBackupResult>> {
  return actionHandler(async () => {
    const ctx = await requireSuperAdmin()
    const p = zodValidate(restoreSchema, input)

    const record = await db.backupRecord.findUnique({ where: { id: p.backupId } })
    if (!record) throw bizError(ErrorCode.NOT_FOUND, "备份记录不存在")
    if (record.status === "RESTORING") throw bizError(ErrorCode.CONFLICT, "该备份正在恢复中")
    const fileMeta = await db.fileMeta.findFirst({ where: { id: record.fileMetaId, deletedAt: null, purgedAt: null } })
    if (!fileMeta) throw bizError(ErrorCode.NOT_FOUND, "备份文件元数据不存在或已被清理")

    // 读取备份文件内容（加密备份需解密还原 SQLite 字节流）
    const backupPath = path.join(ENV.storageLocalPath, fileMeta.storageKey.replace(/\\/g, "/"))
    if (fileMeta.storageKey.includes("..")) throw bizError(ErrorCode.PARAM_ERROR, "非法存储路径")
    let raw: Buffer
    try {
      raw = await fs.readFile(backupPath)
    } catch {
      throw bizError(ErrorCode.NOT_FOUND, "备份文件在磁盘上不存在，可能已被清理")
    }
    let data = raw
    if (record.encrypted) {
      try {
        const iv = raw.subarray(0, 12)
        const tag = raw.subarray(12, 28)
        const payload = raw.subarray(28)
        const decipher = crypto.createDecipheriv("aes-256-gcm", key32(), iv)
        decipher.setAuthTag(tag)
        data = Buffer.concat([decipher.update(payload), decipher.final()])
      } catch {
        throw bizError(ErrorCode.INTERNAL, "备份解密失败：文件损坏或加密密钥已变更")
      }
    }
    const checksumMatch = record.checksum
      ? crypto.createHash("sha256").update(data).digest("hex") === record.checksum
      : null

    await db.backupRecord.update({ where: { id: record.id }, data: { status: "RESTORING" } })
    const steps: string[] = []

    try {
      // 步骤1：恢复前自动做一次临时备份（PARTIAL，用于失败回退兜底）
      const temp = await performBackup(ctx, "PARTIAL", "恢复前自动临时备份")
      steps.push(`已完成恢复前临时备份：${temp.fileName}（${temp.sizeBytes} 字节）`)
      if (!temp.healthy) throw new Error("恢复前临时备份异常，已中止恢复（可从 CRITICAL 告警中排查）")

      // 步骤2：开启维护模式（拦截业务写入，保证恢复期间数据静止）
      await setConfig("maintenance.enabled", true, ctx.userId)
      steps.push("已开启维护模式（业务写入已拦截）")

      try {
        // 步骤3：备份文件内容写回数据库文件路径，并清除 WAL/SHM 残留（防止旧预写日志覆盖恢复内容）
        const dbPath = dbFilePath()
        await fs.writeFile(dbPath, data)
        await fs.rm(`${dbPath}-wal`, { force: true })
        await fs.rm(`${dbPath}-shm`, { force: true })
        steps.push("备份内容已写回数据库文件，并清除 WAL/SHM 残留")
      } finally {
        // 步骤4：关闭维护模式（无论写回成败都必须恢复可访问；写入失败也记录但不阻断返回）
        try {
          await setConfig("maintenance.enabled", false, ctx.userId)
          steps.push("已关闭维护模式")
        } catch (e) {
          steps.push(`关闭维护模式失败：${e instanceof Error ? e.message : String(e)}（可手动在系统配置中关闭）`)
        }
      }

      if (checksumMatch === false) {
        steps.push("警告：恢复内容校验和与备份记录不一致（文件可能被篡改或损坏），请核对数据")
      }

      // 写回后的库内容为备份时刻状态：目标备份记录创建晚于快照，可能已不存在于恢复后的库中（属预期）——容错处理
      try {
        await db.backupRecord.update({ where: { id: record.id }, data: { status: "SUCCESS" } })
      } catch {
        steps.push("提示：目标备份记录不存在于恢复后的数据状态（记录创建晚于备份快照，属预期现象）")
      }
      await writeAudit({
        operatorUserId: ctx.userId,
        operatorName: ctx.username,
        operationType: "BACKUP_RESTORE",
        resourceType: "BACKUP",
        resourceId: record.id,
        resourceName: fileMeta.fileName,
        before: { status: "RESTORING" },
        after: { restored: true, checksumMatch, tempBackupId: temp.recordId, encrypted: record.encrypted, sizeBytes: data.length },
        severity: "CRITICAL",
        extra: { steps },
      })

      return {
        backupId: record.id,
        fileName: fileMeta.fileName,
        encrypted: record.encrypted,
        sizeBytes: data.length,
        checksumMatch,
        tempBackupId: temp.recordId,
        tempBackupFile: temp.fileName,
        steps,
        restartRequired: true,
      }
    } catch (e) {
      // 失败也要解除维护模式与状态回滚
      await setConfig("maintenance.enabled", false, ctx.userId).catch(() => {})
      await db.backupRecord.update({ where: { id: record.id }, data: { status: "FAILED" } }).catch(() => {})
      throw e
    }
  })
}
