"use server"

// ============================================================
// r29-a：17 项硬件权限管控（四级策略链）Server Actions
//   查询：getHardwarePolicyAction（生效解析 + 各层覆盖值回显）
//   设置：setHardwarePolicyAction（scope=global|user|group|sandbox）
//     业务核心在 src/lib/hardware-policy-core.ts（冒烟/OpenAPI 共用）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { HARDWARE_PERMS, type HardwarePermMap, type HardwarePermState } from "@/lib/hardware-perms"
import { getConfig } from "@/lib/config"
import { setHardwarePolicyCore, getGlobalHardwareDefaults } from "@/lib/hardware-policy-core"

// ---- 查询生效策略 + 各层覆盖回显 ----
export async function getHardwarePolicyAction(input: unknown): Promise<ActionResult<{
  policy: Record<string, HardwarePermState>
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL"
  explicit: Record<string, boolean>
  override: HardwarePermMap | null
  globalDefaults: HardwarePermMap | null
  clipboardSync: { enabled: boolean; source: string }
  canGrantSilent: boolean
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ scope: z.enum(["global", "user", "group", "sandbox"]), targetId: zId.optional(), targetUserId: zId.optional() }), input)

    // 目标用户解析（沙箱 scope 需要归属用户以解析完整链）
    let targetUserId = p.targetUserId || ctx.userId
    if (p.scope === "sandbox" && p.targetId && !p.targetUserId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.targetId }, select: { userId: true } })
      targetUserId = ws?.userId || ctx.userId
    }
    if (p.scope === "user" && p.targetId) targetUserId = p.targetId

    const { resolveHardwarePolicy, resolveClipboardSync } = await import("@/lib/hardware-perms")
    const resolved = await resolveHardwarePolicy(targetUserId, p.scope === "sandbox" ? p.targetId : undefined)
    const clipboardSync = await resolveClipboardSync(targetUserId, p.scope === "sandbox" ? p.targetId : undefined)

    // 当前 scope 覆盖值回显
    let override: HardwarePermMap | null = null
    if (p.scope === "user" && p.targetId) {
      const u = await db.user.findUnique({ where: { id: p.targetId }, select: { hardwarePolicy: true } })
      override = (u?.hardwarePolicy as HardwarePermMap | null) || null
    } else if (p.scope === "group" && p.targetId) {
      const g = await db.group.findUnique({ where: { id: p.targetId }, select: { hardwarePolicy: true } })
      override = (g?.hardwarePolicy as HardwarePermMap | null) || null
    } else if (p.scope === "sandbox" && p.targetId) {
      const ws = await db.browserWorkspace.findUnique({ where: { id: p.targetId }, select: { hardwareOverride: true } })
      override = (ws?.hardwareOverride as HardwarePermMap | null) || null
    }

    const globalDefaults = await getGlobalHardwareDefaults()

    return {
      policy: resolved.policy,
      source: resolved.source,
      explicit: resolved.explicit,
      override: override && Object.keys(override).length > 0 ? override : null,
      globalDefaults,
      clipboardSync,
      canGrantSilent: ctx.role === "SUPER_ADMIN",
    }
  })
}

const setSchema = z.object({
  scope: z.enum(["global", "user", "group", "sandbox"]),
  targetId: zId.optional(), // global 时缺省
  policy: z.record(z.string(), z.unknown()).optional(), // 稀疏覆盖 { camera: { enabled: true, audit: true } }
  clear: z.boolean().optional(), // true=清除覆盖（完全继承上层）
})

// ---- 保存（global=写 hardware.defaults 配置；其余=对应行级覆盖）----
export async function setHardwarePolicyAction(input: unknown): Promise<ActionResult<{ saved: boolean; refreshed: number; restarted: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(setSchema, input)
    const r = await setHardwarePolicyCore(
      { userId: ctx.userId, username: ctx.username, role: ctx.role },
      { scope: p.scope, targetId: p.targetId, policy: p.policy, clear: p.clear },
    )
    return { saved: r.saved, refreshed: r.refreshed, restarted: r.restarted }
  })
}

// ---- 目录（前端渲染分组用；服务端权威） ----
export async function listHardwarePermDefsAction(): Promise<ActionResult<Array<{ id: string; label: string; group: string; danger: boolean | null; hasNativeKey: boolean }>>> {
  return actionHandler(async () => {
    await requireAdmin()
    return HARDWARE_PERMS.map((d) => ({ id: d.id, label: d.label, group: d.group, danger: d.danger ?? null, hasNativeKey: !!d.chromium }))
  })
}

// ---- 沙箱级硬件状态面板（详情页：当前 17 项生效一览） ----
export async function getWorkspaceHardwareAction(input: unknown): Promise<ActionResult<{
  policy: Record<string, HardwarePermState>
  source: string
  clipboardSync: { enabled: boolean; source: string }
  override: HardwarePermMap | null
}>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { userId: true, hardwareOverride: true } })
    if (!ws?.userId) throw new Error("沙箱不存在或无归属用户")

    const { resolveHardwarePolicy, resolveClipboardSync } = await import("@/lib/hardware-perms")
    const resolved = await resolveHardwarePolicy(ws.userId, p.workspaceId)
    const clipboardSync = await resolveClipboardSync(ws.userId, p.workspaceId)
    return {
      policy: resolved.policy,
      source: resolved.source,
      clipboardSync,
      override: (ws.hardwareOverride as HardwarePermMap | null) || null,
    }
  })
}
