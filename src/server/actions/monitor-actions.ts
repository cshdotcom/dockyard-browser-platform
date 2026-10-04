"use server"

// ============================================================
// r29-b/c：实时监控中心 Server Actions
//   · listMonitoredSandboxesAction —— 16 宫格数据（RUNNING 沙箱 + 授权 + 持有者）
//   · captureSandboxShotAction     —— CDP 快照（JPEG base64，10s 服务端缓存）
//   · navigateSandboxAction        —— 强制跳转 URL
//   · closeSandboxTabAction        —— 强制关标签
//   · pushSandboxMessageAction     —— 消息推送（页面浮层横幅）
//   · interruptSandboxAction       —— 会话中断（停沙箱保工作区）
//   · injectInputAction            —— 远程键鼠注入（控制租约互斥）
//   · grantMonitorAction           —— 监控授权（知情/静默双模式；静默仅超管）
//   · revokeMonitorAction          —— 撤销授权
//   · cutOffMonitorAction          —— 用户一键切断（仅知情模式）
//   · myMonitorStatusAction        —— 用户端横幅状态（静默授权永不返回）
// 全部操作强制审计（MONITOR_* 事件族）。
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, requireAuth, requireSuperAdmin, requireWritableMode } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// ---- 16 宫格列表 ----
export async function listMonitoredSandboxesAction(input: unknown): Promise<ActionResult<{
  cells: Array<{
    id: string; name: string; status: string; ownerName: string; groupName: string | null
    startedAt: string | null; novncConnCount: number; novncActiveMin: number
    hasSnapshot: boolean
    recentDomain: string | null
    grants: Array<{ channel: string; mode: string; by: string }>
    controlHolder: { adminName: string; acquiredAt: number } | null
    novncSessionId: string | null
  }>
  total: number
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ keyword: z.string().optional(), take: z.number().int().min(1).max(16).optional() }), input)

    // 关键词目标集（用户名匹配需先解析用户 id 集）
    let keywordUserIds: string[] | null = null
    if (p.keyword) {
      const matched = await db.user.findMany({ where: { username: { contains: p.keyword } }, select: { id: true }, take: 100 })
      keywordUserIds = matched.map((u) => u.id)
    }
    const workspaces = await db.browserWorkspace.findMany({
      where: {
        status: "RUNNING", deletedAt: null, mode: "novnc_full",
        ...(p.keyword ? { OR: [{ name: { contains: p.keyword } }, ...(keywordUserIds && keywordUserIds.length > 0 ? [{ userId: { in: keywordUserIds } }] : [])] } : {}),
      },
      select: {
        id: true, name: true, status: true, startedAt: true, novncConnCount: true, novncActiveMin: true, cdpUrl: true, novncSessionId: true, userId: true, groupId: true,
      },
      orderBy: [{ novncConnCount: "desc" }, { startedAt: "desc" }],
      take: p.take || 16,
    })

    // 批量装配：归属用户名/组名 + 活跃授权 + 最近浏览域名（一次批量，避免逐格 N+1）
    const ids = workspaces.map((w) => w.id)
    const userIds = [...new Set(workspaces.map((w) => w.userId).filter(Boolean))]
    const groupIds = [...new Set(workspaces.map((w) => w.groupId).filter((x): x is string => !!x))]
    const [grants, users, groups, latest] = await Promise.all([
      ids.length ? db.monitorGrant.findMany({ where: { workspaceId: { in: ids }, active: true }, select: { workspaceId: true, channel: true, mode: true, grantedByName: true } }) : Promise.resolve([] as Array<{ workspaceId: string; channel: string; mode: string; grantedByName: string }>),
      userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : Promise.resolve([] as Array<{ id: string; username: string }>),
      groupIds.length ? db.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>),
      ids.length ? db.browseHistoryEntry.findMany({
        where: { workspaceId: { in: ids }, deletedAt: null },
        select: { workspaceId: true, domain: true, visitAt: true },
        orderBy: { visitAt: "desc" },
        take: 96,
      }) : Promise.resolve([] as Array<{ workspaceId: string; domain: string | null; visitAt: Date }>),
    ])
    const userById = new Map(users.map((u) => [u.id, u.username]))
    const groupById = new Map(groups.map((g) => [g.id, g.name]))
    // 最近域名（倒序遍历取每格首条）
    const recentByWs = new Map<string, string | null>()
    for (const r of latest) {
      if (!recentByWs.has(r.workspaceId)) recentByWs.set(r.workspaceId, r.domain)
    }

    const { controlLeaseHolder } = await import("@/lib/cdp-control")
    const grantsByWs = new Map<string, Array<{ channel: string; mode: string; by: string }>>()
    for (const g of grants) {
      const arr = grantsByWs.get(g.workspaceId) || []
      arr.push({ channel: g.channel, mode: g.mode, by: g.grantedByName })
      grantsByWs.set(g.workspaceId, arr)
    }

    return {
      cells: workspaces.map((w) => ({
        id: w.id, name: w.name, status: w.status, ownerName: userById.get(w.userId) || "-", groupName: w.groupId ? groupById.get(w.groupId) || null : null,
        startedAt: w.startedAt?.toISOString() || null, novncConnCount: w.novncConnCount, novncActiveMin: w.novncActiveMin,
        hasSnapshot: !!w.cdpUrl,
        recentDomain: recentByWs.get(w.id) || null,
        grants: grantsByWs.get(w.id) || [],
        controlHolder: controlLeaseHolder(w.id),
        novncSessionId: w.novncSessionId,
      })),
      total: workspaces.length,
    }
  })
}

// ---- CDP 快照 ----
export async function captureSandboxShotAction(input: unknown): Promise<ActionResult<{ b64: string | null; ts: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { id: true, cdpUrl: true, status: true, userId: true, name: true } })
    if (!ws) throw new Error("沙箱不存在")
    if (ws.status !== "RUNNING" || !ws.cdpUrl) return { b64: null, ts: Date.now() }

    const { captureScreenshot } = await import("@/lib/cdp-control")
    const shot = await captureScreenshot(ws.cdpUrl, ws.id).catch(() => null)
    return { b64: shot?.b64 || null, ts: Date.now() }
  })
}

// ---- 强制跳转 URL ----
export async function navigateSandboxAction(input: unknown): Promise<ActionResult<{ navigated: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, url: z.string().url().max(2048) }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null, status: "RUNNING" }, select: { id: true, cdpUrl: true, name: true, userId: true } })
    if (!ws?.cdpUrl) throw new Error("沙箱不在运行状态")

    const { forceNavigateAll } = await import("@/lib/cdp-control")
    const n = await forceNavigateAll(ws.cdpUrl, p.url)
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_FORCE_NAVIGATE", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { url: p.url, navigated: n }, severity: "WARN", ownerUserId: ws.userId,
    })
    return { navigated: n }
  })
}

// ---- 强制关标签 ----
export async function closeSandboxTabAction(input: unknown): Promise<ActionResult<{ closed: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, targetId: z.string().min(1) }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null, status: "RUNNING" }, select: { id: true, cdpUrl: true, name: true, userId: true } })
    if (!ws?.cdpUrl) throw new Error("沙箱不在运行状态")

    const { closeTab } = await import("@/lib/cdp-control")
    const closed = await closeTab(ws.cdpUrl, p.targetId)
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_CLOSE_TAB", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { targetId: p.targetId, closed }, severity: "WARN", ownerUserId: ws.userId,
    })
    return { closed }
  })
}

// ---- 消息推送 ----
export async function pushSandboxMessageAction(input: unknown): Promise<ActionResult<{ delivered: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, message: z.string().min(1).max(500) }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null, status: "RUNNING" }, select: { id: true, cdpUrl: true, name: true, userId: true } })
    if (!ws?.cdpUrl) throw new Error("沙箱不在运行状态")

    const { pushMessage } = await import("@/lib/cdp-control")
    const delivered = await pushMessage(ws.cdpUrl, p.message, ctx.username)
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_PUSH_MESSAGE", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { message: p.message, delivered }, severity: "WARN", ownerUserId: ws.userId,
    })
    return { delivered }
  })
}

// ---- 会话中断（停止运行保工作区：用户可重新启动） ----
export async function interruptSandboxAction(input: unknown): Promise<ActionResult<{ stopped: boolean }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, reason: z.string().max(200).optional() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { id: true, name: true, userId: true, novncSessionId: true, status: true } })
    if (!ws) throw new Error("沙箱不存在")

    if (ws.status === "RUNNING" && ws.novncSessionId) {
      const { destroyNovncSession } = await import("@/lib/external/novnc")
      await destroyNovncSession(ws.novncSessionId).catch(() => null)
    }
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "STOPPED", novncSessionId: null } }).catch(() => {})
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_SESSION_INTERRUPT", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { reason: p.reason || "", by: ctx.username }, severity: "DANGER", ownerUserId: ws.userId,
    })
    return { stopped: true }
  })
}

// ---- 远程键鼠注入（控制租约互斥：同沙箱同时仅一管理员可注入） ----
export async function injectInputAction(input: unknown): Promise<ActionResult<{ ok: boolean; holder?: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({
      workspaceId: zId,
      input: z.object({
        type: z.enum(["key", "mouseLeft", "mouseRight", "mouseMove", "mouseScroll"]),
        key: z.string().max(32).optional(), x: z.number().optional(), y: z.number().optional(), text: z.string().max(8).optional(),
      }),
    }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null, status: "RUNNING" }, select: { id: true, cdpUrl: true, name: true, userId: true } })
    if (!ws?.cdpUrl) throw new Error("沙箱不在运行状态")

    const cdpControl = await import("@/lib/cdp-control")
    const lease = cdpControl.acquireControlLease(ws.id, ctx.userId, ctx.username)
    if (!lease.ok) return { ok: false, holder: lease.holder?.adminName }

    const ok = await cdpControl.dispatchInput(ws.cdpUrl, p.input)
    return { ok }
  })
}

// ---- 控制租约管理（显式接管/释放；心跳由查看方轮询自然续期） ----
export async function controlLeaseAction(input: unknown): Promise<ActionResult<{ ok: boolean; holder?: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, action: z.enum(["acquire", "release", "renew"]) }), input)
    const cdpControl = await import("@/lib/cdp-control")
    if (p.action === "acquire") {
      const lease = cdpControl.acquireControlLease(p.workspaceId, ctx.userId, ctx.username)
      return { ok: lease.ok, holder: lease.holder?.adminName }
    }
    if (p.action === "release") return { ok: cdpControl.releaseControlLease(p.workspaceId, ctx.userId) }
    return { ok: cdpControl.heartbeatControlLease(p.workspaceId, ctx.userId) }
  })
}

// ---- 监控授权：授予（知情/静默双模式） ----
const grantSchema = z.object({
  workspaceId: zId,
  channel: z.enum(["camera", "microphone", "screenShare"]),
  mode: z.enum(["CONSENT", "SILENT"]),
  reason: z.string().max(300).optional(),
})

export async function grantMonitorAction(input: unknown): Promise<ActionResult<{ grantId: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(grantSchema, input)

    // 静默特权模式：仅超级管理员 + 理由必填（取证留痕）
    if (p.mode === "SILENT") {
      if (ctx.role !== "SUPER_ADMIN") throw new Error("静默特权模式仅超级管理员可授权")
      if (!p.reason || p.reason.trim().length < 4) throw new Error("静默特权模式必须填写授权理由（至少 4 字，取证留痕）")
    }

    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { id: true, name: true, userId: true, status: true } })
    if (!ws) throw new Error("沙箱不存在")

    // 幂等：同沙箱同通道已激活 → 更新为新模式（不重复建行）
    const existing = await db.monitorGrant.findFirst({ where: { workspaceId: ws.id, channel: p.channel, active: true } })
    let grantId: string
    if (existing) {
      await db.monitorGrant.update({
        where: { id: existing.id },
        data: { mode: p.mode, reason: p.reason || null, grantedByUserId: ctx.userId, grantedByName: ctx.username, active: true, endedAt: null, cutOffBy: null, startedAt: new Date() },
      })
      grantId = existing.id
    } else {
      const g = await db.monitorGrant.create({
        data: { workspaceId: ws.id, userId: ws.userId, channel: p.channel, mode: p.mode, reason: p.reason || null, grantedByUserId: ctx.userId, grantedByName: ctx.username },
      })
      grantId = g.id
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: p.mode === "SILENT" ? "MONITOR_SILENT_GRANT" : "MONITOR_CONSENT_GRANT",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { channel: p.channel, mode: p.mode, reason: p.reason || "" }, severity: p.mode === "SILENT" ? "DANGER" : "WARN", ownerUserId: ws.userId,
    })
    return { grantId }
  })
}

// ---- 撤销授权 ----
export async function revokeMonitorAction(input: unknown): Promise<ActionResult<{ revoked: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, grantId: zId.optional(), channel: z.string().optional() }), input)
    const where = p.grantId
      ? { id: p.grantId, active: true }
      : { workspaceId: p.workspaceId, ...(p.channel ? { channel: p.channel } : {}), active: true }
    const r = await db.monitorGrant.updateMany({ where, data: { active: false, cutOffBy: "ADMIN_REVOKE", endedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_REVOKE", resourceType: "WORKSPACE", resourceId: p.workspaceId,
      after: { revoked: r.count, by: ctx.username }, severity: "WARN",
    })
    return { revoked: r.count }
  })
}

// ---- 用户一键切断（仅知情模式；静默特权用户不可见不可切） ----
export async function cutOffMonitorAction(input: unknown): Promise<ActionResult<{ cut: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    // 校验沙箱归属（仅所有者可切断自己沙箱的知情授权）
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null }, select: { userId: true } })
    if (!ws || ws.userId !== ctx.userId) throw new Error("仅沙箱所有者可切断本人沙箱的监控授权")

    // 仅 CONSENT 模式可切（SILENT 行对用户不可见 → 永不匹配）
    const r = await db.monitorGrant.updateMany({ where: { workspaceId: p.workspaceId, userId: ctx.userId, mode: "CONSENT", active: true }, data: { active: false, cutOffBy: "USER_CUTOFF", endedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "MONITOR_USER_CUTOFF", resourceType: "WORKSPACE", resourceId: p.workspaceId,
      after: { cut: r.count, by: ctx.username }, severity: "WARN",
    })
    return { cut: r.count }
  })
}

// ---- 用户端横幅状态（轮询；静默授权绝不返回） ----
export async function myMonitorStatusAction(input: unknown): Promise<ActionResult<{ grants: Array<{ workspaceId: string; workspaceName: string; channel: string; mode: string; grantedByName: string; startedAt: string }> }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ workspaceIds: z.array(zId).max(64).optional() }), input)
    const grants = await db.monitorGrant.findMany({
      where: { userId: ctx.userId, mode: "CONSENT", active: true, ...(p.workspaceIds ? { workspaceId: { in: p.workspaceIds } } : {}) },
      select: { workspaceId: true, channel: true, mode: true, grantedByName: true, startedAt: true },
      orderBy: { startedAt: "desc" },
      take: 32,
    })
    // 沙箱名批量装配（仅未删除的）
    const wsIds = [...new Set(grants.map((g) => g.workspaceId))]
    const wss = wsIds.length ? await db.browserWorkspace.findMany({ where: { id: { in: wsIds }, deletedAt: null }, select: { id: true, name: true } }) : []
    const wsById = new Map(wss.map((w) => [w.id, w.name]))
    return {
      grants: grants
        .filter((g) => wsById.has(g.workspaceId))
        .map((g) => ({ workspaceId: g.workspaceId, workspaceName: wsById.get(g.workspaceId) || "-", channel: g.channel, mode: g.mode, grantedByName: g.grantedByName, startedAt: g.startedAt.toISOString() })),
    }
  })
}
