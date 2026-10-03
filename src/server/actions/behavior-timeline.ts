"use server"

// ============================================================
// r29-g：行为监控时间轴 Server Action（鉴权薄包装）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { buildBehaviorTimeline, type TimelineEvent } from "@/lib/behavior-timeline"

export async function getBehaviorTimelineAction(input: unknown): Promise<ActionResult<{ events: TimelineEvent[]; counts: { browse: number; file: number; network: number; system: number } }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({
      workspaceId: zId,
      fromMin: z.number().int().min(1).max(43200).optional(),
      keyword: z.string().max(120).optional(),
      take: z.number().int().min(10).max(500).optional(),
    }), input)
    return await buildBehaviorTimeline({ workspaceId: p.workspaceId, fromMin: p.fromMin, keyword: p.keyword, take: p.take })
  })
}
