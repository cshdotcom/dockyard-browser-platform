// ============================================================
// VNC 会话录像引擎（r27 企业级录屏审计）
// 职责：
//   1. 策略四级链解析：沙箱覆盖 > 用户覆盖 > 用户组(继承链) > 全局默认
//   2. 沙箱启动时开录：用户空间建目录 storage/recordings/<userId>/<sandboxId>/
//      录像参数随沙箱进程树下发（fps/分段秒数/最长时长/大小上限）
//   3. 扫描任务：发现分段文件 → 入库（RECORDING→COMPLETED）；沙箱已死自动终结
//   4. 保留期 / 用户配额自动治理（最旧优先入回收站）
//   5. 回放签名票据（HMAC + 时效）供 /api/recordings/stream 鉴权
// 安全模型：
//   · 文件落在用户专属目录（storage/recordings/<userId>/），路径分量全部白名单校验
//   · 回放 = Cookie 会话鉴权 或 签名票据（60 秒时效，仅授予通过 RBAC 的请求）
//   · 用户对录像只读（查看/下载），删除/恢复/清除仅管理员（审计完整性）
// ============================================================

import { db } from "./db"
import { ENV } from "./env"
import { getConfigBool, getConfigNumber } from "./config"
import { writeAudit } from "./audit"
import { createHmac, timingSafeEqual } from "crypto"
import { mkdir, readdir, stat, rm, writeFile } from "fs/promises"
import { join } from "path"
import { execFile } from "child_process"

export interface RecordingPolicy {
  enabled: boolean
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL_DEFAULT"
  sourceGroupId?: string | null
  sourceWorkspaceId?: string | null
  resolvedAt: string
}

export interface RecordingTuning {
  fps: number
  segmentSec: number
  maxMinutes: number // 单次会话录像时长上限（0=不限）
  maxSegmentMb: number // 单段大小保护上限（超出即视为异常，终结该会话录像）
}

// 路径分量白名单（防穿越）：cuid/uuid/emb-xxx/dy-browser-xxx
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id)
}

export function recordingsRoot(): string {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "recordings")
}

export function recordingSessionDir(userId: string, sessionId: string): string | null {
  if (!safeId(userId) || !safeId(sessionId)) return null
  return join(recordingsRoot(), userId, sessionId)
}

export function recordingStorageKey(userId: string, sessionId: string, file: string): string | null {
  if (!safeId(userId) || !safeId(sessionId) || !/^seg-\d{3,6}\.mp4$/.test(file)) return null
  return `recordings/${userId}/${sessionId}/${file}`
}

export function recordingAbsPath(storageKey: string): string | null {
  if (!/^recordings\/[A-Za-z0-9_-]{4,64}\/[A-Za-z0-9_-]{4,64}\/seg-\d{3,6}\.mp4$/.test(storageKey)) return null
  return join(ENV.storageLocalPath.replace(/\/$/, ""), storageKey)
}

// ---- 1. 策略四级链解析（与网络策略 idle-policy 同构）----
export async function resolveRecordingPolicy(userId: string, workspaceId?: string | null): Promise<RecordingPolicy> {
  const resolvedAt = new Date().toISOString()
  // 0) 沙箱级覆盖（归属校验）
  if (workspaceId) {
    const ws = await db.browserWorkspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { userId: true, recordingOverride: true },
    })
    if (ws && ws.userId === userId && (ws.recordingOverride === "on" || ws.recordingOverride === "off")) {
      return { enabled: ws.recordingOverride === "on", source: "SANDBOX", sourceWorkspaceId: workspaceId, resolvedAt }
    }
  }
  // 1) 用户级覆盖
  const user = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { vncRecording: true },
  })
  if (user && user.vncRecording !== null && user.vncRecording !== undefined) {
    return { enabled: user.vncRecording, source: "USER", resolvedAt }
  }
  // 2) 组级（沿 parentId 继承链向上取第一个显式组级值）
  const memberships = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  if (memberships.length > 0) {
    const groups = await db.group.findMany({
      where: { deletedAt: null, enabled: true },
      select: { id: true, parentId: true, vncRecording: true },
    })
    const groupsById = new Map(groups.map((g) => [g.id, g]))
    const seen = new Set<string>()
    for (const m of memberships) {
      let cur: string | null = m.groupId
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const g = groupsById.get(cur)
        if (!g) break
        if (g.vncRecording !== null && g.vncRecording !== undefined) {
          return { enabled: g.vncRecording, source: "GROUP", sourceGroupId: g.id, resolvedAt }
        }
        cur = g.parentId
      }
    }
  }
  // 3) 全局默认
  const enabled = await getConfigBool("vnc.recordingEnabled", false)
  return { enabled, source: "GLOBAL_DEFAULT", resolvedAt }
}

// ---- 录像参数（帧率/分段/上限；数值安全钳制）----
export async function recordingTuning(): Promise<RecordingTuning> {
  const fps = Math.max(4, Math.min(30, await getConfigNumber("vnc.recordingFps", 12)))
  const segMin = Math.max(1, Math.min(120, await getConfigNumber("vnc.recordingSegmentMinutes", 15)))
  const maxMinutes = Math.max(0, Math.min(4320, await getConfigNumber("vnc.recordingMaxMinutes", 0)))
  return { fps, segmentSec: segMin * 60, maxMinutes, maxSegmentMb: 2048 }
}

// ---- 2. 录像会话注册（沙箱进程树已启动后由业务层调用）----
// 目录由沙箱引擎预先创建（DY_RECORD_DIR 随进程树下发）；此处补：会话标记 +
// 首段 DB 行（幂等：唯一约束 [sessionId, segmentIndex] 兜底）+ 审计。
// 若扫描任务先行补行（窗口期竞态），此处静默跳过，不重复建档。
export async function registerWorkspaceRecording(opts: {
  workspace: { id: string; uuid: string; name: string; userId: string }
  username?: string | null
  sessionId: string // 沙箱进程树 id（emb-*/dy-browser-*）
  resolution: string
  policy: RecordingPolicy
  tuning: RecordingTuning
  trigger?: "AUTO" | "MANUAL"
  metadata?: Record<string, unknown> | null
}): Promise<{ registered: boolean; recordDir: string | null }> {
  const dir = recordingSessionDir(opts.workspace.userId, opts.sessionId)
  if (dir) await mkdir(dir, { recursive: true }).catch(() => null)
  // 已有同会话行 → 扫描任务已补行（或重复调用）→ 幂等返回
  const existing = await db.vncRecording.findFirst({ where: { sessionId: opts.sessionId }, select: { id: true } })
  if (existing) return { registered: false, recordDir: dir }
  const username = opts.username ?? (await db.user.findUnique({ where: { id: opts.workspace.userId }, select: { username: true } }))?.username ?? null
  if (dir) {
    await writeFile(
      join(dir, "session.json"),
      JSON.stringify(
        {
          workspaceId: opts.workspace.id,
          workspaceUuid: opts.workspace.uuid,
          workspaceName: opts.workspace.name,
          userId: opts.workspace.userId,
          username,
          sessionId: opts.sessionId,
          fps: opts.tuning.fps,
          segmentSec: opts.tuning.segmentSec,
          maxMinutes: opts.tuning.maxMinutes,
          resolution: opts.resolution,
          policySource: opts.policy.source,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: "utf8" },
    ).catch(() => null)
  }
  await db.vncRecording.create({
    data: {
      workspaceId: opts.workspace.id,
      workspaceUuid: opts.workspace.uuid,
      workspaceName: opts.workspace.name,
      userId: opts.workspace.userId,
      username,
      sessionId: opts.sessionId,
      segmentIndex: 0,
      status: "RECORDING",
      trigger: opts.trigger || "AUTO",
      startedAt: new Date(),
      resolution: opts.resolution,
      fps: opts.tuning.fps,
      policySource: opts.policy.source,
      metadata: (opts.metadata || undefined) as never,
    },
  }).catch(() => null) // 唯一约束兜底（扫描任务已补行）
  await writeAudit({
    operationType: "RECORDING_START",
    resourceType: "RECORDING",
    resourceId: opts.sessionId,
    resourceName: opts.workspace.name,
    ownerUserId: opts.workspace.userId,
    severity: "INFO",
    after: { sessionId: opts.sessionId, fps: opts.tuning.fps, segmentSec: opts.tuning.segmentSec, policySource: opts.policy.source, trigger: opts.trigger || "AUTO" },
  })
  return { registered: true, recordDir: dir }
}

// ---- 3. 分段扫描（定时任务；也可停止时显式调用）----
// 语义：RECORDING 行 = 当前活跃分段；发现下一分段文件出现 → 当前行 COMPLETED（时间/大小回填）
// + 新建 RECORDING 行；沙箱已死（或会话标记超时）→ 终结整组。
// 幂等：唯一约束 [sessionId, segmentIndex] 兜底补行竞态。
export async function scanRecordingSegments(sessionId: string): Promise<{ created: number; finalized: number }> {
  const rows = await db.vncRecording.findMany({
    where: { sessionId, deletedAt: null },
    orderBy: { segmentIndex: "asc" },
  })
  if (rows.length === 0) return { created: 0, finalized: 0 }
  const first = rows[0]
  const dir = recordingSessionDir(first.userId, sessionId)
  if (!dir) return { created: 0, finalized: 0 }
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((f) => /^seg-\d{3,6}\.mp4$/.test(f)).sort()
  } catch {
    return { created: 0, finalized: 0 }
  }
  let created = 0
  let finalized = 0
  // 文件 → 行对齐：新出现分段且无行 → 补行；行对应文件稳定 → COMPLETED
  const rowIndexByIndex = new Map(rows.map((r) => [r.segmentIndex, r]))
  for (const f of files) {
    const segIdx = Number(/seg-(\d+)\.mp4/.exec(f)?.[1] ?? NaN)
    if (!Number.isFinite(segIdx)) continue
    const abs = join(dir, f)
    let st: { size: number; mtimeMs: number }
    try {
      st = await stat(abs)
    } catch {
      continue
    }
    const existing = rowIndexByIndex.get(segIdx)
    const nextFile = files[files.indexOf(f) + 1] // 下一分段出现 = 本段已收尾
    if (!existing) {
      // 补行（平台重启窗口期漏建）
      await db.vncRecording
        .create({
          data: {
            workspaceId: first.workspaceId,
            workspaceUuid: first.workspaceUuid,
            workspaceName: first.workspaceName,
            userId: first.userId,
            username: first.username,
            sessionId,
            segmentIndex: segIdx,
            status: nextFile || st.mtimeMs < Date.now() - 120_000 ? "COMPLETED" : "RECORDING",
            trigger: first.trigger,
            startedAt: new Date(st.mtimeMs - (await probeDurationSec(abs)) * 1000),
            endedAt: nextFile || st.mtimeMs < Date.now() - 120_000 ? new Date(st.mtimeMs) : null,
            durationSec: await probeDurationSec(abs),
            sizeBytes: st.size,
            storageKey: recordingStorageKey(first.userId, sessionId, f),
            resolution: first.resolution,
            fps: first.fps,
            policySource: first.policySource,
          },
        })
        .catch(() => null) // 唯一约束兜底（registerWorkspaceRecording 已建档）
      created++
    } else if (existing.status === "RECORDING" && (nextFile || st.mtimeMs < Date.now() - 120_000)) {
      // ffmpeg 分段滚动（或写完未扫描到）→ 收尾本段
      await db.vncRecording.update({
        where: { id: existing.id },
        data: {
          status: "COMPLETED",
          endedAt: new Date(st.mtimeMs),
          durationSec: await probeDurationSec(abs),
          sizeBytes: st.size,
          storageKey: existing.storageKey || recordingStorageKey(first.userId, sessionId, f),
        },
      })
      finalized++
    } else if (existing.status === "COMPLETED" && existing.sizeBytes === 0) {
      // 历史行缺大小（早前扫描失败）→ 补
      await db.vncRecording.update({
        where: { id: existing.id },
        data: { sizeBytes: st.size, storageKey: existing.storageKey || recordingStorageKey(first.userId, sessionId, f) },
      }).catch(() => null)
    }
  }
  return { created, finalized }
}

// ---- 全量扫描入口（定时任务 recording_scan）----
// 逐会话组：同步分段（新段入库/活跃段收尾）→ 沙箱已死则整组终结（自愈兜底：
// 覆盖停止/回收/冻结/销毁全路径，任何漏掉显式终结的会话都能在此收口）。
export async function scanAllLiveRecordings(log?: (msg: string) => void): Promise<{ sessions: number; created: number; finalized: number; terminated: number }> {
  const groups = await db.vncRecording.findMany({
    where: { deletedAt: null },
    select: { sessionId: true },
    distinct: ["sessionId"],
    take: 500,
  })
  let created = 0
  let finalized = 0
  let terminated = 0
  for (const g of groups) {
    const r = await scanRecordingSegments(g.sessionId).catch(() => ({ created: 0, finalized: 0 }))
    created += r.created
    finalized += r.finalized
    const live = await db.vncRecording.count({ where: { sessionId: g.sessionId, status: "RECORDING", deletedAt: null } })
    if (live > 0 && !(await sandboxAlive(g.sessionId))) {
      await finalizeRecordingSession(g.sessionId, { reason: "扫描任务发现沙箱已停止（自动终结）" }).catch(() => 0)
      terminated++
      log?.(`录像会话 ${g.sessionId} 沙箱已停止 → 自动终结`)
    }
  }
  return { sessions: groups.length, created, finalized, terminated }
}

// ffprobe 读真实时长（缺失/失败回退 mtime 推断值）
async function probeDurationSec(abs: string): Promise<number> {
  try {
    const r = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", abs], { timeout: 15_000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve({ stdout: String(stdout) })
      })
    })
    const d = Number(r.stdout.trim())
    if (Number.isFinite(d) && d > 0) return Math.round(d)
  } catch {
    /* ffprobe 不可用 */
  }
  return 0
}

// ---- 沙箱存活探测（孤儿终结判据）----
async function sandboxAlive(sessionId: string): Promise<boolean> {
  try {
    const { embeddedSandbox, embeddedSandboxAlive } = await import("./embedded-sandbox")
    const entry = await embeddedSandbox(sessionId)
    if (entry) return embeddedSandboxAlive(entry)
  } catch {
    /* 引擎不可用 */
  }
  // docker 容器形态
  try {
    const { ENV: env, externalAvailable } = await import("./env")
    if (externalAvailable.docker) {
      const res = await fetch(`${env.dockerApiUrl.replace(/\/$/, "")}/containers/${encodeURIComponent(sessionId)}/json`, {
        signal: AbortSignal.timeout(env.dockerApiTimeout),
      })
      if (res.ok) {
        const j = (await res.json()) as { State?: { Running?: boolean } }
        return !!j.State?.Running
      }
    }
  } catch {
    /* 探测失败按存活处理（下轮再试） */
  }
  return true
}

// ---- 终结整组录像（沙箱停止/销毁时调用；扫描任务对死沙箱自动兜底）----
export async function finalizeRecordingSession(sessionId: string, opts?: { operatorUserId?: string; operatorName?: string; reason?: string }): Promise<number> {
  await scanRecordingSegments(sessionId).catch(() => null)
  const rows = await db.vncRecording.findMany({ where: { sessionId, status: "RECORDING", deletedAt: null } })
  for (const r of rows) {
    // 剩余 RECORDING 行：文件在则按 mtime 收尾；文件缺失（未写盘即停）→ FAILED
    const abs = r.storageKey ? recordingAbsPath(r.storageKey) : null
    const dir = recordingSessionDir(r.userId, sessionId)
    const segFile = dir ? join(dir, `seg-${String(r.segmentIndex).padStart(3, "0")}.mp4`) : null
    const absOk = abs ? await fileExists(abs) : false
    const segOk = segFile ? await fileExists(segFile) : false
    const target = absOk ? abs : segOk ? segFile : null
    if (target) {
      const st = await stat(target).catch(() => null)
      await db.vncRecording.update({
        where: { id: r.id },
        data: {
          status: "COMPLETED",
          endedAt: st ? new Date(st.mtimeMs) : new Date(),
          durationSec: await probeDurationSec(target),
          sizeBytes: st?.size ?? 0,
          storageKey: r.storageKey || (segFile ? recordingStorageKey(r.userId, sessionId, `seg-${String(r.segmentIndex).padStart(3, "0")}.mp4`) : null),
        },
      })
    } else {
      await db.vncRecording.update({
        where: { id: r.id },
        data: { status: "FAILED", endedAt: new Date(), note: opts?.reason || "沙箱停止时未发现分段文件（录像未写盘或时长过短）" },
      })
    }
  }
  if (rows.length > 0) {
    await writeAudit({
      operatorUserId: opts?.operatorUserId || null,
      operatorName: opts?.operatorName || null,
      operationType: "RECORDING_STOP",
      resourceType: "RECORDING",
      resourceId: sessionId,
      resourceName: rows[0].workspaceName,
      ownerUserId: rows[0].userId,
      severity: "INFO",
      before: { liveSegments: rows.length },
      after: { reason: opts?.reason || "session_end" },
    })
  }
  return rows.length
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ---- 4. 保留期 + 用户配额治理（定时任务）----
export async function enforceRecordingRetention(log?: (msg: string) => void): Promise<{ expired: number; quotaEvicted: number; usersChecked: number }> {
  const retentionDays = Math.max(0, await getConfigNumber("vnc.recordingRetentionDays", 90))
  let expired = 0
  if (retentionDays > 0) {
    const deadline = new Date(Date.now() - retentionDays * 86_400_000)
    const due = await db.vncRecording.findMany({
      where: { deletedAt: null, purgeAt: null, OR: [{ startedAt: { lt: deadline } }, { endedAt: { lt: deadline } }] },
      take: 500,
      orderBy: { startedAt: "asc" },
    })
    for (const r of due) {
      await softDeleteRecording(r, "保留期到期自动归档（SYSTEM）", "SYSTEM")
      expired++
    }
    if (expired > 0) log?.(`保留期治理：${expired} 段录像到期转入回收站（保留 ${retentionDays} 天）`)
  }
  // 配额治理：按用户聚合未删录像总字节，超额最旧优先软删
  const quotaGb = Math.max(0, await getConfigNumber("vnc.recordingQuotaGb", 5))
  let quotaEvicted = 0
  let usersChecked = 0
  if (quotaGb > 0) {
    const quotaBytes = quotaGb * 1024 * 1024 * 1024
    const usage = await db.vncRecording.groupBy({
      by: ["userId"],
      where: { deletedAt: null },
      _sum: { sizeBytes: true },
    })
    for (const u of usage) {
      usersChecked++
      const total = u._sum.sizeBytes ?? 0
      if (total <= quotaBytes) continue
      const oversize = total - quotaBytes
      const oldest = await db.vncRecording.findMany({
        where: { userId: u.userId, deletedAt: null },
        orderBy: { startedAt: "asc" },
        take: 200,
      })
      let freed = 0
      for (const r of oldest) {
        if (freed >= oversize) break
        await softDeleteRecording(r, `录像配额治理：超配额（${(total / 1024 / 1024 / 1024).toFixed(2)}GB / ${quotaGb}GB）最旧优先归档（SYSTEM）`, "SYSTEM")
        freed += r.sizeBytes
        quotaEvicted++
      }
      log?.(`配额治理：用户 ${u.userId} 超 ${(oversize / 1024 / 1024).toFixed(0)}MB，软删最旧 ${quotaEvicted} 段`)
    }
  }
  return { expired, quotaEvicted, usersChecked }
}

// ---- 软删入回收站（复用 RecycleBin 通用资源模型）----
export async function softDeleteRecording(
  rec: { id: string; workspaceName: string; userId: string; sessionId: string; segmentIndex: number; status: string; sizeBytes: number; durationSec: number; storageKey: string | null },
  reason: string,
  deletedByType: "USER" | "ADMIN" | "SYSTEM",
  deletedByUserId?: string | null,
  operatorName?: string | null,
  recoverDays = 30,
): Promise<void> {
  const purgeAt = new Date(Date.now() + recoverDays * 86_400_000)
  await db.vncRecording.update({ where: { id: rec.id }, data: { deletedAt: new Date(), purgeAt } })
  await db.recycleBin.create({
    data: {
      resourceType: "RECORDING",
      resourceId: rec.id,
      resourceName: `${rec.workspaceName} · 第${rec.segmentIndex + 1}段（${Math.round(rec.durationSec / 60)}分钟 / ${(rec.sizeBytes / 1024 / 1024).toFixed(1)}MB）`,
      ownerUserId: rec.userId,
      deletedByUserId: deletedByUserId ?? null,
      deletedByType,
      reason,
      originalSnapshot: JSON.stringify({ id: rec.id, sessionId: rec.sessionId, segmentIndex: rec.segmentIndex, status: rec.status, storageKey: rec.storageKey, sizeBytes: rec.sizeBytes, durationSec: rec.durationSec, workspaceName: rec.workspaceName, userId: rec.userId }),
      purgeAt,
    },
  })
  await writeAudit({
    operatorUserId: deletedByUserId ?? null,
    operatorName: operatorName ?? null,
    operationType: "RECORDING_DELETE",
    resourceType: "RECORDING",
    resourceId: rec.id,
    resourceName: rec.workspaceName,
    ownerUserId: rec.userId,
    severity: "WARN",
    before: { status: rec.status, sizeBytes: rec.sizeBytes, storageKey: rec.storageKey },
    after: { deleted: true, reason, recoverDeadline: purgeAt.toISOString() },
  })
}

// ---- 物理清除（回收站 purge；文件 + 行）----
export async function purgeRecordingRow(recordingId: string, opts?: { operatorUserId?: string; operatorName?: string; fromRecycle?: boolean }): Promise<{ purged: boolean; freedBytes: number }> {
  const rec = await db.vncRecording.findUnique({ where: { id: recordingId } })
  if (!rec) return { purged: false, freedBytes: 0 }
  let freed = 0
  if (rec.storageKey) {
    const abs = recordingAbsPath(rec.storageKey)
    if (abs) {
      const st = await stat(abs).catch(() => null)
      if (st) freed = st.size
      await rm(abs, { force: true }).catch(() => null)
    }
  }
  // 目录空了顺带清掉（含 session.json 标记）
  if (rec.sessionId) {
    const dir = recordingSessionDir(rec.userId, rec.sessionId)
    if (dir) {
      const rest = await readdir(dir).catch(() => ["_"])
      if (rest.length === 0) await rm(dir, { recursive: true, force: true }).catch(() => null)
    }
  }
  await db.vncRecording.delete({ where: { id: recordingId } })
  await writeAudit({
    operatorUserId: opts?.operatorUserId ?? null,
    operatorName: opts?.operatorName ?? null,
    operationType: "RECORDING_PURGE",
    resourceType: "RECORDING",
    resourceId: recordingId,
    resourceName: rec.workspaceName,
    ownerUserId: rec.userId,
    severity: "DANGER",
    before: { storageKey: rec.storageKey, sizeBytes: rec.sizeBytes, sessionId: rec.sessionId, segmentIndex: rec.segmentIndex },
    after: { physicallyDeleted: true, freedBytes: freed, fromRecycle: opts?.fromRecycle || false },
  })
  return { purged: true, freedBytes: freed }
}

// ---- 5. 回放签名票据（60 秒时效；授予通过 RBAC 的回放请求）----
export function signPlaybackToken(recordingId: string, userId: string, ttlSec = 60): string {
  const exp = Date.now() + ttlSec * 1000
  const payload = `${recordingId}.${userId}.${exp}`
  const mac = createHmac("sha256", ENV.authSecret).update(`dy-rec-play:${payload}`).digest("hex")
  return `${payload}.${mac}`
}

export function verifyPlaybackToken(token: string): { recordingId: string; userId: string } | null {
  const parts = String(token || "").split(".")
  if (parts.length !== 4) return null
  const [recordingId, userId, exp, mac] = parts
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null
  const expect = createHmac("sha256", ENV.authSecret).update(`dy-rec-play:${recordingId}.${userId}.${exp}`).digest("hex")
  try {
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expect, "hex"))) return null
  } catch {
    return null
  }
  if (!safeId(recordingId) || !safeId(userId)) return null
  return { recordingId, userId }
}

// ---- 查看配额/统计（用户空间卡片）----
export async function recordingUserUsage(userId: string): Promise<{ segments: number; totalBytes: number; totalDurationSec: number; quotaGb: number; oldestAt: Date | null }> {
  const agg = await db.vncRecording.aggregate({
    where: { userId, deletedAt: null },
    _count: { id: true },
    _sum: { sizeBytes: true, durationSec: true },
    _min: { startedAt: true },
  })
  return {
    segments: agg._count.id,
    totalBytes: agg._sum.sizeBytes ?? 0,
    totalDurationSec: agg._sum.durationSec ?? 0,
    quotaGb: Math.max(0, await getConfigNumber("vnc.recordingQuotaGb", 5)),
    oldestAt: agg._min.startedAt ?? null,
  }
}
