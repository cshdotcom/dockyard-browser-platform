"use server"

// ============================================================
// r27：VNC 会话录像管理 Server Actions
// 角色矩阵（企业合规语义）：
//   USER        → 用户空间：仅本人录像 查看/回放/下载（可见性受全局开关管控）；不可删除（审计完整性）
//   GROUP_ADMIN → 所辖用户组内全部录像 查看/回放/下载；不可删除
//   ADMIN+      → 全站录像 查看/回放/下载/删除入回收站/恢复/物理清除/备注
// 删除 → RecycleBin（RECORDING 类型，30 天可恢复）→ 物理清除（文件级联）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAuth, requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { signPlaybackToken, softDeleteRecording, purgeRecordingRow, recordingUserUsage, recordingTuning } from "@/lib/recording"
import { Prisma } from "@prisma/client"
import { trackBehavior } from "@/lib/risk"

export interface RecordingRow {
  id: string
  workspaceName: string
  workspaceUuid: string | null
  username: string | null
  sessionId: string
  segmentIndex: number
  totalSegments: number
  status: string
  trigger: string
  startedAt: string
  endedAt: string | null
  durationSec: number
  sizeBytes: number
  resolution: string | null
  fps: number
  policySource: string | null
  note: string | null
  viewCount: number
  downloadCount: number
  hasFile: boolean
  fileReady: boolean // COMPLETED 且有 storageKey
}

export interface RecordingStats {
  segments: number
  sessions: number
  totalBytes: number
  totalDurationSec: number
  recordingNow: number
  quotaGb: number
  retentionDays: number
  userVisible: boolean
}

// ---- 角色可见范围（USER=本人；GROUP_ADMIN=所辖组；ADMIN+=全站）----
async function scopeFilter(ctx: { userId: string; role: string }): Promise<Prisma.VncRecordingWhereInput> {
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return {}
  if (ctx.role === "GROUP_ADMIN") {
    const groups = await db.groupAdmin.findMany({ where: { userId: ctx.userId }, select: { groupId: true } })
    const gids = groups.map((g) => g.groupId)
    if (gids.length === 0) return { userId: ctx.userId } // 无所辖组 → 仅本人（兜底）
    const members = await db.groupUser.findMany({ where: { groupId: { in: gids } }, select: { userId: true } })
    const uids = [...new Set([ctx.userId, ...members.map((m) => m.userId)])]
    return { userId: { in: uids } }
  }
  return { userId: ctx.userId }
}

// ---- 列表（分段行；筛选：工作区/用户/状态/时间段/关键词；含会话分组统计）----
export async function listRecordingsAction(input: unknown): Promise<ActionResult<{ rows: RecordingRow[]; stats: RecordingStats; quota: { usedBytes: number; quotaGb: number } | null }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(
      z.object({
        keyword: z.string().max(64).optional(),
        status: z.enum(["RECORDING", "COMPLETED", "FAILED", "ALL"]).optional(),
        from: z.string().optional(), // ISO 日期
        to: z.string().optional(),
        userId: z.string().optional(), // 管理员筛指定用户
        take: z.number().int().min(1).max(200).optional(),
      }),
      input,
    )

    const base = await scopeFilter(ctx)
    // 用户端可见性开关（USER 角色列表整体隐藏）
    if (ctx.role === "USER") {
      const visible = await getConfigBool("vnc.recordingUserVisible", true)
      if (!visible) return { rows: [], stats: emptyStats(), quota: null }
    }

    const where: Prisma.VncRecordingWhereInput = {
      ...base,
      deletedAt: null,
      ...(p.userId && (ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN") ? { userId: p.userId } : {}),
      ...(p.status && p.status !== "ALL" ? { status: p.status } : {}),
      ...(p.keyword ? { OR: [{ workspaceName: { contains: p.keyword } }, { username: { contains: p.keyword } }, { sessionId: { contains: p.keyword } }] } : {}),
      ...(p.from ? { startedAt: { gte: new Date(p.from) } } : {}),
      ...(p.to ? { startedAt: { lte: new Date(p.to) } } : {}),
      ...(p.from && p.to ? { startedAt: { gte: new Date(p.from), lte: new Date(p.to) } } : {}),
    }

    const [rows, agg, liveCount, sessionAgg, tuning, userVisible] = await Promise.all([
      db.vncRecording.findMany({ where, orderBy: [{ startedAt: "desc" }], take: p.take ?? 100 }),
      db.vncRecording.aggregate({ where: { ...base, deletedAt: null }, _count: { id: true }, _sum: { sizeBytes: true, durationSec: true } }),
      db.vncRecording.count({ where: { ...base, deletedAt: null, status: "RECORDING" } }),
      db.vncRecording.findMany({ where: { ...base, deletedAt: null }, select: { sessionId: true }, distinct: ["sessionId"] }),
      recordingTuning(),
      getConfigBool("vnc.recordingUserVisible", true),
    ])

    const segBySession = new Map<string, number>()
    for (const s of sessionAgg) segBySession.set(s.sessionId, (segBySession.get(s.sessionId) || 0) + 1)

    const mapped: RecordingRow[] = rows.map((r) => ({
      id: r.id,
      workspaceName: r.workspaceName,
      workspaceUuid: r.workspaceUuid,
      username: r.username,
      sessionId: r.sessionId,
      segmentIndex: r.segmentIndex,
      totalSegments: segBySession.get(r.sessionId) || 1,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() || null,
      durationSec: r.durationSec,
      sizeBytes: r.sizeBytes,
      resolution: r.resolution,
      fps: r.fps,
      policySource: r.policySource,
      note: r.note,
      viewCount: r.viewCount,
      downloadCount: r.downloadCount,
      hasFile: !!r.storageKey,
      fileReady: r.status === "COMPLETED" && !!r.storageKey,
    }))

    const quotaGb = Math.max(0, await getConfigNumber("vnc.recordingQuotaGb", 5))
    const retentionDays = Math.max(0, await getConfigNumber("vnc.recordingRetentionDays", 90))
    const stats: RecordingStats = {
      segments: agg._count.id,
      sessions: sessionAgg.length,
      totalBytes: agg._sum.sizeBytes ?? 0,
      totalDurationSec: agg._sum.durationSec ?? 0,
      recordingNow: liveCount,
      quotaGb,
      retentionDays,
      userVisible,
    }
    // 仅 USER 展示本人配额；管理员视图在全站范围
    const quota = ctx.role === "USER" ? { usedBytes: stats.totalBytes, quotaGb } : null
    void tuning
    return { rows: mapped, stats, quota }
  })
}

function emptyStats(): RecordingStats {
  return { segments: 0, sessions: 0, totalBytes: 0, totalDurationSec: 0, recordingNow: 0, quotaGb: 0, retentionDays: 0, userVisible: false }
}

// ---- 我的录像（用户空间简版：配额卡片 + 分组列表）----
export async function myRecordingsAction(input: unknown): Promise<ActionResult<{ rows: RecordingRow[]; usage: { segments: number; totalBytes: number; totalDurationSec: number; quotaGb: number; oldestAt: string | null }; retentionDays: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ keyword: z.string().max(64).optional(), take: z.number().int().min(1).max(200).optional() }), input)
    const visible = await getConfigBool("vnc.recordingUserVisible", true)
    const usage = await recordingUserUsage(ctx.userId)
    if (!visible && ctx.role === "USER") {
      return { rows: [], usage: { ...usage, oldestAt: usage.oldestAt?.toISOString() || null }, retentionDays: Math.max(0, await getConfigNumber("vnc.recordingRetentionDays", 90)) }
    }
    const rows = await db.vncRecording.findMany({
      where: { userId: ctx.userId, deletedAt: null, ...(p.keyword ? { OR: [{ workspaceName: { contains: p.keyword } }, { sessionId: { contains: p.keyword } }] } : {}) },
      orderBy: [{ startedAt: "desc" }],
      take: p.take ?? 100,
    })
    const segBySession = new Map<string, number>()
    for (const r of rows) segBySession.set(r.sessionId, (segBySession.get(r.sessionId) || 0) + 1)
    return {
      rows: rows.map((r) => ({
        id: r.id, workspaceName: r.workspaceName, workspaceUuid: r.workspaceUuid, username: r.username,
        sessionId: r.sessionId, segmentIndex: r.segmentIndex, totalSegments: segBySession.get(r.sessionId) || 1,
        status: r.status, trigger: r.trigger, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() || null,
        durationSec: r.durationSec, sizeBytes: r.sizeBytes, resolution: r.resolution, fps: r.fps,
        policySource: r.policySource, note: r.note, viewCount: r.viewCount, downloadCount: r.downloadCount,
        hasFile: !!r.storageKey, fileReady: r.status === "COMPLETED" && !!r.storageKey,
      })),
      usage: { segments: usage.segments, totalBytes: usage.totalBytes, totalDurationSec: usage.totalDurationSec, quotaGb: usage.quotaGb, oldestAt: usage.oldestAt?.toISOString() || null },
      retentionDays: Math.max(0, await getConfigNumber("vnc.recordingRetentionDays", 90)),
    }
  })
}

// ---- 回放票据签发（RBAC 校验后授予 60 秒时效流媒体 URL）----
export async function playbackRecordingAction(input: unknown): Promise<ActionResult<{ streamUrl: string; downloadUrl: string; durationSec: number; sizeBytes: number; resolution: string | null }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const rec = await db.vncRecording.findUnique({ where: { id } })
    if (!rec || rec.deletedAt) throw new Error("录像不存在或已在回收站")

    // RBAC：本人 / 组管理员（所辖）/ ADMIN+
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    if (!isAdmin && rec.userId !== ctx.userId) {
      if (ctx.role === "GROUP_ADMIN") {
        const ws = await db.browserWorkspace.findUnique({ where: { id: rec.workspaceId }, select: { groupId: true } })
        const member = ws?.groupId ? await db.groupUser.findFirst({ where: { groupId: ws.groupId, userId: ctx.userId } }) : null
        if (!member) throw new Error("无该录像的回放权限")
      } else {
        throw new Error("无该录像的回放权限")
      }
    }
    if (!isAdmin && ctx.role !== "GROUP_ADMIN" && rec.userId === ctx.userId) {
      const visible = await getConfigBool("vnc.recordingUserVisible", true)
      if (!visible) throw new Error("管理员已关闭用户端录像可见性")
    }
    if (!rec.storageKey || rec.status !== "COMPLETED") throw new Error("该分段尚未完成写入，稍后再试")

    const token = signPlaybackToken(rec.id, ctx.userId, 60)
    return {
      streamUrl: `/api/recordings/stream/${rec.id}?token=${encodeURIComponent(token)}`,
      downloadUrl: `/api/recordings/stream/${rec.id}?token=${encodeURIComponent(token)}&download=1`,
      durationSec: rec.durationSec,
      sizeBytes: rec.sizeBytes,
      resolution: rec.resolution,
    }
  })
}

// ---- 删除入回收站（仅 ADMIN+；30 天可恢复，物理清除前审计链完整）----
export async function deleteRecordingAction(input: unknown): Promise<ActionResult<{ id: string; recoverDeadline: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id, reason } = zodValidate(z.object({ id: zId, reason: z.string().max(200).optional() }), input)
    const rec = await db.vncRecording.findUnique({ where: { id } })
    if (!rec || rec.deletedAt) throw new Error("录像不存在或已在回收站")
    if (rec.status === "RECORDING") throw new Error("录像仍在进行中（会话结束后才可删除）")
    const recoverDays = 30
    await softDeleteRecording(rec, reason || "管理员手动删除（入录像回收站）", "ADMIN", ctx.userId, ctx.username, recoverDays)
    await trackBehavior(ctx.userId, "DELETE")
    return { id, recoverDeadline: new Date(Date.now() + recoverDays * 86_400_000).toISOString() }
  })
}

// ---- 回收站列表（录像类型；管理员视图 + 用户本人视图）----
export async function listRecordingRecycleAction(input: unknown): Promise<ActionResult<{ entries: Array<{ recycleId: string; recordingId: string; resourceName: string; reason: string | null; deletedByType: string; deletedAt: string; purgeAt: string | null; locked: boolean; ownerUserId: string | null }> }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const p = zodValidate(z.object({ keyword: z.string().max(64).optional() }), input)
    const entries = await db.recycleBin.findMany({
      where: {
        resourceType: "RECORDING",
        restoredAt: null,
        ...(isAdmin ? {} : { ownerUserId: ctx.userId }),
        ...(p.keyword ? { resourceName: { contains: p.keyword } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })
    return {
      entries: entries.map((e) => ({
        recycleId: e.id,
        recordingId: e.resourceId,
        resourceName: e.resourceName || "",
        reason: e.reason,
        deletedByType: e.deletedByType,
        deletedAt: e.createdAt.toISOString(),
        purgeAt: e.purgeAt?.toISOString() || null,
        locked: e.locked,
        ownerUserId: e.ownerUserId,
      })),
    }
  })
}

// ---- 从回收站恢复（管理员专属；恢复后可继续回放）----
export async function restoreRecordingAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const entry = await db.recycleBin.findFirst({ where: { resourceType: "RECORDING", resourceId: id, restoredAt: null } })
    if (!entry) throw new Error("回收站中无该录像（可能已恢复或已清除）")
    if (entry.locked) throw new Error("该回收项已被锁定保护，请先解锁")
    const rec = await db.vncRecording.findUnique({ where: { id } })
    if (!rec) throw new Error("录像数据行已不存在（可能已被物理清除）")
    await db.vncRecording.update({ where: { id }, data: { deletedAt: null, purgeAt: null, restoredAt: new Date() } })
    await db.recycleBin.update({ where: { id: entry.id }, data: { restoredAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "RECORDING_RESTORE", resourceType: "RECORDING", resourceId: id,
      resourceName: rec.workspaceName, ownerUserId: rec.userId, severity: "WARN",
      before: { deleted: true, reason: entry.reason }, after: { restored: true },
    })
    await trackBehavior(ctx.userId, "RESTORE")
    return { id }
  })
}

// ---- 物理清除（管理员专属；文件 + 行级联删除，不可恢复）----
export async function purgeRecordingAction(input: unknown): Promise<ActionResult<{ id: string; freedBytes: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    // 回收站锁保护
    const entry = await db.recycleBin.findFirst({ where: { resourceType: "RECORDING", resourceId: id, restoredAt: null } })
    if (entry?.locked) throw new Error("该回收项已被锁定保护，请先解锁再清除")
    const r = await purgeRecordingRow(id, { operatorUserId: ctx.userId, operatorName: ctx.username, fromRecycle: !!entry })
    if (!r.purged) throw new Error("录像不存在（可能已被清除）")
    if (entry) await db.recycleBin.delete({ where: { id: entry.id } }).catch(() => {})
    await trackBehavior(ctx.userId, "DELETE")
    return { id, freedBytes: r.freedBytes }
  })
}

// ---- 备注（管理员专属：取证标记 / 案件编号等）----
export async function noteRecordingAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id, note } = zodValidate(z.object({ id: zId, note: z.string().max(500) }), input)
    const rec = await db.vncRecording.findUnique({ where: { id } })
    if (!rec) throw new Error("录像不存在")
    await db.vncRecording.update({ where: { id }, data: { note } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "RECORDING_NOTE", resourceType: "RECORDING", resourceId: id,
      resourceName: rec.workspaceName, ownerUserId: rec.userId,
      before: { note: rec.note }, after: { note },
    })
    return { id }
  })
}

// ---- 手动触发扫描（管理员：停止遗漏的会话立即收口）----
export async function triggerRecordingScanAction(): Promise<ActionResult<{ sessions: number; created: number; finalized: number; terminated: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { scanAllLiveRecordings } = await import("@/lib/recording")
    const r = await scanAllLiveRecordings()
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "RECORDING_SCAN", resourceType: "RECORDING",
      severity: "INFO", after: r,
    })
    return r
  })
}
