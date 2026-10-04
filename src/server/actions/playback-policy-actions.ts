"use server"

// r28：回放安全策略管理（用户/组/沙箱三级覆盖设置）

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { resolvePlaybackPolicy, validatePlaybackOverride } from "@/lib/playback-policy"

// ---- 查询生效策略（管理员查看目标用户/沙箱的解析结果）----
export async function getPlaybackPolicyAction(input: unknown): Promise<ActionResult<{ watermark: string; allowExport: boolean; source: string; serverNow: string; userOverride: { watermark?: string; allowExport?: boolean } | null; groupOverride: { watermark?: string; allowExport?: boolean } | null; sandboxOverride: { watermark?: string; allowExport?: boolean } | null }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ userId: zId.optional(), workspaceId: zId.optional() }), input)
    // sandbox 场景：自动取工作区所有者（策略链需要其用户/组级基线）
    let targetUserId = p.userId || ctx.userId
    if (p.workspaceId && !p.userId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.workspaceId }, select: { userId: true } })
      targetUserId = ws?.userId || ctx.userId
    }
    const policy = await resolvePlaybackPolicy(targetUserId, p.workspaceId)

    const user = await db.user.findUnique({ where: { id: targetUserId }, select: { vncPlayback: true } })
    let groupOverride: { watermark?: string; allowExport?: boolean } | null = null
    if (!p.workspaceId) {
      const links = await db.groupUser.findMany({ where: { userId: targetUserId }, select: { groupId: true } })
      for (const l of links) {
        const g = await db.group.findUnique({ where: { id: l.groupId }, select: { vncPlayback: true } })
        if (g?.vncPlayback) { groupOverride = g.vncPlayback as { watermark?: string; allowExport?: boolean }; break }
      }
    }
    let sandboxOverride: { watermark?: string; allowExport?: boolean } | null = null
    if (p.workspaceId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.workspaceId }, select: { vncPlayback: true } })
      if (ws?.vncPlayback) sandboxOverride = ws.vncPlayback as { watermark?: string; allowExport?: boolean }
    }
    return {
      watermark: policy.watermark,
      allowExport: policy.allowExport,
      source: policy.source,
      serverNow: policy.serverNow,
      userOverride: (user?.vncPlayback as { watermark?: string; allowExport?: boolean } | null) || null,
      groupOverride,
      sandboxOverride,
    }
  })
}

const setSchema = z.object({
  scope: z.enum(["user", "group", "sandbox"]),
  targetId: zId,
  watermark: z.enum(["force", "on", "off"]).optional(),
  allowExport: z.boolean().optional(),
  clear: z.boolean().optional(), // true=清除覆盖（完全继承上层）
})

export async function setPlaybackPolicyAction(input: unknown): Promise<ActionResult<{ saved: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(setSchema, input)

    const value = p.clear ? null : validatePlaybackOverride({ ...(p.watermark ? { watermark: p.watermark } : {}), ...(typeof p.allowExport === "boolean" ? { allowExport: p.allowExport } : {}) })

    if (p.scope === "user") {
      await db.user.update({ where: { id: p.targetId }, data: { vncPlayback: value as never } })
    } else if (p.scope === "group") {
      await db.group.update({ where: { id: p.targetId }, data: { vncPlayback: value as never } })
    } else {
      await db.browserWorkspace.update({ where: { id: p.targetId }, data: { vncPlayback: value as never } })
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "PLAYBACK_POLICY_SET", resourceType: p.scope === "user" ? "USER" : p.scope === "group" ? "GROUP" : "WORKSPACE",
      resourceId: p.targetId,
      after: { scope: p.scope, value, by: ctx.username },
      severity: "WARN",
    })
    return { saved: true }
  })
}
