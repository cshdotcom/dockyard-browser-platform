"use server"

// ============================================================
// r29-g：行为监控时间轴 Server Action（鉴权薄包装）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { buildBehaviorTimeline, type TimelineEvent } from "@/lib/behavior-timeline"

export async function getBehaviorTimelineAction(input: unknown): Promise<ActionResult<{ events: TimelineEvent[]; counts: { browse: number; file: number; network: number; system: number } }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({
      workspaceId: zId,
      fromMin: z.number().int().min(1).max(43200).optional(),
      keyword: z.string().max(120).optional(),
      take: z.number().int().min(10).max(500).optional(),
    }), input)
    // r34：所有者本人可查自己沙箱的时间轴（用户诉求：沙箱里可看自己的明文记录）；管理员全量
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { userId: true } })
    if (!ws) throw new Error("工作区不存在")
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if (!isAdmin && ws.userId !== ctx.userId) throw new Error("无权查看该沙箱时间轴")
    return await buildBehaviorTimeline({ workspaceId: p.workspaceId, fromMin: p.fromMin, keyword: p.keyword, take: p.take })
  })
}

export type { TimelineEvent } from "@/lib/behavior-timeline"
