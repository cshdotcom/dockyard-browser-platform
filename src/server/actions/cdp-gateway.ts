"use server"

// ============================================================
// r28：CDP 外网网关地址（超级鉴权 + 容器内网地址零暴露）
//
// 架构：管理员在宿主机做内网穿透 → 穿透域名指向宿主机映射的 cdp-gateway 端口（默认 3006）。
//      用户拿到的外网地址 = ws(s)://<cdp.publicGatewayHost>[:port]/t/<HMAC 票据>
//      票据：单次防重放 + 300s 建连窗口 + 连接时长上限（用户策略链）；
//      容器内 CDP 端点（ws://127.0.0.1:<port>/devtools/...）仅存在于票据 payload，永不回显。
// 容器内不装任何穿透组件（host 网络约束满足）。
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId, zPrecision } from "@/lib/validators"
import { z } from "zod"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getConfig, getConfigNumber, getConfigBool } from "@/lib/config"
import { randomHex } from "@/lib/crypto"
import { createHmac, randomBytes } from "crypto"

// 与 mini-services/cdp-gateway 同构（HMAC-SHA256 票据）
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function signCdpTicket(p: { v: string; u: string; tgt: string; exp: number; dur: number; n: string }): string {
  const secret = process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"
  const payloadB64 = b64url(Buffer.from(JSON.stringify(p), "utf8"))
  const sig = b64url(createHmac("sha256", secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

// ---- 用户级 CDP 连接时长上限（分钟；用户>组>全局；0=不限） ----
async function resolveCdpDurationMinutes(userId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { vncSessionMaxMinutes: true } })
  if (user?.vncSessionMaxMinutes != null) return user.vncSessionMaxMinutes
  const links = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  for (const l of links) {
    const g = await db.group.findUnique({ where: { id: l.groupId }, select: { vncSessionMaxMinutes: true } })
    if (g?.vncSessionMaxMinutes != null) return g.vncSessionMaxMinutes
  }
  return await getConfigNumber("session.cdpMaxMinutes", 0)
}

export async function getCdpGatewayTicketAction(input: unknown): Promise<ActionResult<{
  gatewayUrl: string | null
  gatewayScheme: "ws" | "wss" | null
  publicHost: string | null
  expiresAt: string
  durationMinutes: number
  workspaceId: string
  workspaceName: string
  note: string
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId } = zodValidate(z.object({ workspaceId: zId }), input)

    const ws = await db.browserWorkspace.findUnique({ where: { id: workspaceId } })
    if (!ws || ws.deletedAt) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    if (ws.status === "FROZEN") throw Object.assign(new Error(`沙箱已离线冻结：${ws.freezeReason || "调查取证中"}`), { code: 403 })

    // RBAC：所有者 / 被共享 OPERATE / GROUP_ADMIN 所辖组 / ADMIN+
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    let allowed = isAdmin || ws.userId === ctx.userId
    if (!allowed && ctx.role === "GROUP_ADMIN" && ws.groupId) {
      allowed = !!(await db.groupUser.findFirst({ where: { groupId: ws.groupId, userId: ctx.userId } }))
    }
    if (!allowed && ws.userId) {
      const share = await db.workspaceShare.findFirst({
        where: { workspaceId: ws.id, targetUserId: ctx.userId, revokedAt: null, permission: "OPERATE", OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
      })
      allowed = !!share
    }
    if (!allowed) throw Object.assign(new Error("无该沙箱的 CDP 控制权限"), { code: 403 })
    if (!ws.cdpUrl || ws.status !== "RUNNING") throw Object.assign(new Error("沙箱未运行或 CDP 端点不可用（请先启动）"), { code: 409 })

    // 公网网关配置（r36：后台「CDP」配置卡可改；未配置时仅返回说明，不暴露内网地址）
    const publicHost = await getConfig("cdp.publicGatewayHost", "")
    const gatewayPort = await getConfigNumber("cdp.gatewayPort", 3006)
    const useTls = await getConfigBool("cdp.gatewayTls", false)
    const windowSec = await getConfigNumber("cdp.ticketWindowSec", 300)
    const durMin = await resolveCdpDurationMinutes(ctx.userId)

    let gatewayUrl: string | null = null
    if (publicHost) {
      const ticket = signCdpTicket({
        v: ws.id, u: ctx.userId, tgt: ws.cdpUrl,
        exp: Math.floor(Date.now() / 1000) + windowSec,
        dur: durMin > 0 ? durMin * 60 : 0,
        n: randomBytes(12).toString("hex"),
      })
      const scheme = useTls ? "wss" : "ws"
      gatewayUrl = `${scheme}://${publicHost}${gatewayPort !== 80 && gatewayPort !== 443 ? `:${gatewayPort}` : ""}/t/${ticket}`
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "CDP_GATEWAY_TICKET", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      ownerUserId: ws.userId,
      after: { publicHost: publicHost || "(未配置网关)", windowSec, durationMin: durMin },
      severity: "INFO",
    }).catch(() => null)

    return {
      gatewayUrl,
      gatewayScheme: gatewayUrl ? (useTls ? "wss" : "ws") : null,
      publicHost: publicHost || null,
      expiresAt: new Date(Date.now() + windowSec * 1000).toISOString(),
      durationMinutes: durMin,
      workspaceId: ws.id,
      workspaceName: ws.name,
      note: publicHost
        ? `外网地址含签名票据（${windowSec}s 内有效、单次使用）；容器内网地址不对外暴露；网关已启用 IP 防爆破封禁与跨站劫持拦截`
        : "管理员尚未配置 CDP 公网网关：请在「系统配置 → CDP → 公网网关地址」填写穿透域名（配置后此处即可取外网连接地址）",
    }
  })
}

// ============================================================
// r37：CDP 公网连接地址（持久票据）全生命周期管理
//
// 核心语义：
//   · 地址 = ws(s)://<cdp.publicGatewayHost>[:port]/p/<tid>（48 hex 不可猜测）
//   · 有效期：永久（expireAt=null）/ 自定义分钟（expireAt=now+min）
//   · 次数上限：maxUses（0=不限；每次建连 resolve 计数）
//   · 「重新创建」（轮换）：旧票据 revokedAt 立即生效（网关实时校验）+ 生成新地址
//   · 管理员强制：吊销/轮换/改有效期（用户/用户组/沙箱级 + 批量）
//   · RBAC：与 getCdpGatewayTicketAction 一致（所有者/OPERATE 共享/组管理员/ADMIN+）
//   · 全局开关：cdp.allowPersistentTokens（false=用户侧禁建，管理员仍可强制）
// ============================================================

interface CdpTokenRow {
  id: string
  tid: string
  workspaceId: string
  workspaceName: string
  label: string | null
  note: string | null
  address: string | null
  expireAt: string | null
  expired: boolean
  maxUses: number
  useCount: number
  lastUsedAt: string | null
  lastUsedIp: string | null
  revokedAt: string | null
  revokeReason: string | null
  rotatedFromId: string | null
  createdVia: string
  createdByUserId: string | null
  createdAt: string
}

/** 公网地址拼装（网关未配置 → null，前端展示「未配置」引导） */
async function buildPersistentAddress(): Promise<string | null> {
  const publicHost = await getConfig("cdp.publicGatewayHost", "")
  if (!publicHost) return null
  const gatewayPort = await getConfigNumber("cdp.gatewayPort", 3006)
  const useTls = await getConfigBool("cdp.gatewayTls", false)
  const scheme = useTls ? "wss" : "ws"
  return `${scheme}://${publicHost}${gatewayPort !== 80 && gatewayPort !== 443 ? `:${gatewayPort}` : ""}/p/`
}

/** 沙箱 CDP 控制权限（与短票据同链：所有者/OPERATE 共享/组管理员/ADMIN+） */
async function assertCdpControl(ctx: { userId: string; role: string; username: string }, ws: { id: string; userId: string | null; groupId: string | null }): Promise<void> {
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  if (isAdmin || ws.userId === ctx.userId) return
  if (ctx.role === "GROUP_ADMIN" && ws.groupId) {
    const link = await db.groupUser.findFirst({ where: { groupId: ws.groupId, userId: ctx.userId } })
    if (link) return
  }
  if (ws.userId) {
    const share = await db.workspaceShare.findFirst({
      where: { workspaceId: ws.id, targetUserId: ctx.userId, revokedAt: null, permission: "OPERATE", OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
    })
    if (share) return
  }
  throw Object.assign(new Error("无该沙箱的 CDP 控制权限"), { code: 403 })
}

function toRow(
  t: { id: string; tid: string; workspaceId: string; label: string | null; note: string | null; expireAt: Date | null; maxUses: number; useCount: number; lastUsedAt: Date | null; lastUsedIp: string | null; revokedAt: Date | null; revokeReason: string | null; rotatedFromId: string | null; createdVia: string; createdByUserId: string | null; createdAt: Date },
  workspaceName: string,
  addrPrefix: string | null,
): CdpTokenRow {
  const now = Date.now()
  return {
    id: t.id, tid: t.tid, workspaceId: t.workspaceId, workspaceName,
    label: t.label, note: t.note,
    address: addrPrefix ? `${addrPrefix}${t.tid}` : null,
    expireAt: t.expireAt?.toISOString() ?? null,
    expired: !!t.expireAt && t.expireAt.getTime() <= now,
    maxUses: t.maxUses, useCount: t.useCount,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: t.lastUsedIp,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    revokeReason: t.revokeReason, rotatedFromId: t.rotatedFromId,
    createdVia: t.createdVia, createdByUserId: t.createdByUserId,
    createdAt: t.createdAt.toISOString(),
  }
}

const zExpiry = z.object({
  mode: z.enum(["permanent", "custom"]).default("permanent"),
  minutes: zPrecision("自定义有效期（分钟）", 1, 5256000).optional(),
})
function resolveExpiry(e: { mode: string; minutes?: number }): Date | null {
  if (e.mode === "permanent") return null
  const min = Number(e.minutes) || 0
  if (min <= 0) throw Object.assign(new Error("自定义有效期必须大于 0 分钟"), { code: 400 })
  return new Date(Date.now() + min * 60_000)
}

// ---- ① 列表（沙箱全部票据：含已吊销，血缘/审计可追溯） ----
export async function listCdpEndpointTokensAction(input: unknown): Promise<ActionResult<{ tokens: CdpTokenRow[]; addressPrefix: string | null; gatewayConfigured: boolean; globalAllow: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId } = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true, userId: true, groupId: true } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    await assertCdpControl(ctx, ws)

    const tokens = await db.cdpEndpointToken.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } })
    const addrPrefix = await buildPersistentAddress()
    const globalAllow = await getConfigBool("cdp.allowPersistentTokens", true)
    return {
      tokens: tokens.map((t) => toRow(t, ws.name, addrPrefix)),
      addressPrefix: addrPrefix,
      gatewayConfigured: !!addrPrefix,
      globalAllow,
    }
  })
}

// ---- ② 创建（永久/自定义有效期 + 次数上限 + 标签） ----
export async function createCdpEndpointTokenAction(input: unknown): Promise<ActionResult<CdpTokenRow & { gatewayNote: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({
      workspaceId: zId,
      label: z.string().min(1).max(60).optional(),
      note: z.string().max(200).optional(),
      expiry: zExpiry.optional().default({ mode: "permanent" }),
      maxUses: zPrecision("次数上限", 0, 1000000).optional().default(0),
    }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.workspaceId, deletedAt: null } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    await assertCdpControl(ctx, ws)

    // 全局开关（管理员豁免 —— 管理员可强制创建）
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const globalAllow = await getConfigBool("cdp.allowPersistentTokens", true)
    if (!globalAllow && !isAdmin) {
      throw Object.assign(new Error("管理员已全局停用 CDP 持久连接地址（仅管理员可强制创建）"), { code: 403 })
    }
    // 数量上限（防滥用；后台可配）
    const maxPerWs = await getConfigNumber("cdp.persistentTokenMaxPerWorkspace", 20)
    const activeCount = await db.cdpEndpointToken.count({ where: { workspaceId: ws.id, revokedAt: null } })
    if (activeCount >= maxPerWs) throw Object.assign(new Error(`该沙箱活跃连接地址已达上限（${maxPerWs} 条），请先吊销不需要的地址`), { code: 409 })

    const expireAt = resolveExpiry(p.expiry)
    const tok = await db.cdpEndpointToken.create({
      data: {
        tid: randomHex(24),
        workspaceId: ws.id, userId: ws.userId,
        label: p.label || null, note: p.note || null,
        expireAt, maxUses: p.maxUses,
        createdVia: isAdmin && ws.userId !== ctx.userId ? "ADMIN" : "USER",
        createdByUserId: ctx.userId,
      },
    })
    const addrPrefix = await buildPersistentAddress()
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_TOKEN_CREATE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      after: { tokenId: tok.id, tid: `${tok.tid.slice(0, 8)}…`, label: tok.label, expireAt: expireAt?.toISOString() || "永久", maxUses: p.maxUses, createdVia: tok.createdVia },
    })
    return {
      ...toRow(tok, ws.name, addrPrefix),
      gatewayNote: addrPrefix ? "地址已生成（吊销/轮换即时生效；网关实时校验）" : "网关公网地址未配置：请管理员在「系统配置 → CDP」填写公网域名后地址生效",
    }
  })
}

// ---- ③ 修改（标签/有效期/次数；未吊销且未过期的可改） ----
export async function updateCdpEndpointTokenAction(input: unknown): Promise<ActionResult<CdpTokenRow>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({
      tokenId: zId,
      label: z.string().min(1).max(60).optional(),
      note: z.string().max(200).optional(),
      expiry: zExpiry.optional(),
      maxUses: zPrecision("次数上限", 0, 1000000).optional(),
    }), input)
    const tok = await db.cdpEndpointToken.findUnique({ where: { id: p.tokenId } })
    if (!tok) throw Object.assign(new Error("连接地址不存在"), { code: 404 })
    const ws = await db.browserWorkspace.findFirst({ where: { id: tok.workspaceId, deletedAt: null } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    await assertCdpControl(ctx, { id: ws.id, userId: ws.userId, groupId: ws.groupId })
    if (tok.revokedAt) throw Object.assign(new Error("已吊销的地址不可修改（请重新创建）"), { code: 409 })

    const expireAt = p.expiry ? resolveExpiry(p.expiry) : undefined
    const updated = await db.cdpEndpointToken.update({
      where: { id: tok.id },
      data: {
        ...(p.label !== undefined ? { label: p.label || null } : {}),
        ...(p.note !== undefined ? { note: p.note || null } : {}),
        ...(expireAt !== undefined ? { expireAt } : {}),
        ...(p.maxUses !== undefined ? { maxUses: p.maxUses } : {}),
      },
    })
    const addrPrefix = await buildPersistentAddress()
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_TOKEN_UPDATE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      after: { tokenId: tok.id, label: p.label, expireAt: expireAt?.toISOString() || (p.expiry ? "永久" : undefined), maxUses: p.maxUses },
    })
    return toRow(updated, ws.name, addrPrefix)
  })
}

// ---- ④ 吊销（地址立即失效：网关实时校验） ----
export async function revokeCdpEndpointTokenAction(input: unknown): Promise<ActionResult<{ revoked: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ tokenId: zId, reason: z.string().max(200).optional() }), input)
    const tok = await db.cdpEndpointToken.findUnique({ where: { id: p.tokenId } })
    if (!tok) throw Object.assign(new Error("连接地址不存在"), { code: 404 })
    const ws = await db.browserWorkspace.findFirst({ where: { id: tok.workspaceId, deletedAt: null } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    // 管理员强制吊销 + 所有者/OPERATE 均可
    await assertCdpControl(ctx, { id: ws.id, userId: ws.userId, groupId: ws.groupId })
    if (tok.revokedAt) return { revoked: true }
    await db.cdpEndpointToken.update({
      where: { id: tok.id },
      data: { revokedAt: new Date(), revokeReason: p.reason || (ctx.userId === ws.userId ? "所有者吊销" : "管理员强制吊销") },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_TOKEN_REVOKE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      after: { tokenId: tok.id, tid: `${tok.tid.slice(0, 8)}…`, reason: p.reason || "手动吊销" },
      severity: "WARN",
    })
    return { revoked: true }
  })
}

// ---- ⑤ 重新创建（轮换：旧地址立即失效 + 新地址生成；泄露自救一键操作） ----
export async function rotateCdpEndpointTokenAction(input: unknown): Promise<ActionResult<{ oldRevoked: boolean; newToken: CdpTokenRow }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({
      tokenId: zId,
      reason: z.string().max(200).optional(),
      expiry: zExpiry.optional(), // 缺省继承旧票据配置
      maxUses: zPrecision("次数上限", 0, 1000000).optional(),
      label: z.string().min(1).max(60).optional(),
    }), input)
    const tok = await db.cdpEndpointToken.findUnique({ where: { id: p.tokenId } })
    if (!tok) throw Object.assign(new Error("连接地址不存在"), { code: 404 })
    const ws = await db.browserWorkspace.findFirst({ where: { id: tok.workspaceId, deletedAt: null } })
    if (!ws) throw Object.assign(new Error("沙箱不存在"), { code: 404 })
    await assertCdpControl(ctx, { id: ws.id, userId: ws.userId, groupId: ws.groupId })
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const globalAllow = await getConfigBool("cdp.allowPersistentTokens", true)
    if (!globalAllow && !isAdmin) throw Object.assign(new Error("管理员已全局停用持久地址（轮换仍需新地址，请联系管理员）"), { code: 403 })

    // 1) 旧票据吊销（已吊销则幂等跳过）
    if (!tok.revokedAt) {
      await db.cdpEndpointToken.update({
        where: { id: tok.id },
        data: { revokedAt: new Date(), revokeReason: p.reason || "轮换重建（地址更换）" },
      })
    }
    // 2) 新票据（继承旧配置；显式参数覆盖）
    const expireAt = p.expiry ? resolveExpiry(p.expiry) : tok.expireAt
    const created = await db.cdpEndpointToken.create({
      data: {
        tid: randomHex(24),
        workspaceId: ws.id, userId: ws.userId,
        label: p.label || tok.label, note: tok.note,
        expireAt, maxUses: p.maxUses ?? tok.maxUses,
        rotatedFromId: tok.id,
        createdVia: isAdmin && ws.userId !== ctx.userId ? "ADMIN" : "USER",
        createdByUserId: ctx.userId,
      },
    })
    const addrPrefix = await buildPersistentAddress()
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_TOKEN_ROTATE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, ownerUserId: ws.userId,
      after: { oldTokenId: tok.id, newTokenId: created.id, newTid: `${created.tid.slice(0, 8)}…`, expireAt: expireAt?.toISOString() || "永久" },
      severity: "WARN",
    })
    return { oldRevoked: true, newToken: toRow(created, ws.name, addrPrefix) }
  })
}

// ---- ⑥ 管理员批量（用户/用户组/沙箱级 × 吊销/轮换/立即过期/延长） ----
export async function adminBatchCdpTokensAction(input: unknown): Promise<ActionResult<{ affected: number; rotated: number; failures: Array<{ id: string; reason: string }> }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    if (ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw Object.assign(new Error("仅管理员可批量管理 CDP 连接地址"), { code: 403 })
    const p = zodValidate(z.object({
      scope: z.enum(["workspace", "user", "group", "all-active"]),
      ids: z.array(z.string().max(64)).max(500).default([]),
      op: z.enum(["revoke", "rotate", "expire-now", "extend"]),
      minutes: zPrecision("延长/自定义分钟", 1, 5256000).optional(),
      reason: z.string().max(200).optional(),
    }), input)

    // 目标票据解析
    let where: PrismaFilter
    switch (p.scope) {
      case "workspace":
        if (!p.ids.length) throw Object.assign(new Error("请选择沙箱"), { code: 400 })
        where = { workspaceId: { in: p.ids }, revokedAt: null }
        break
      case "user":
        if (!p.ids.length) throw Object.assign(new Error("请选择用户"), { code: 400 })
        where = { userId: { in: p.ids }, revokedAt: null }
        break
      case "group": {
        if (!p.ids.length) throw Object.assign(new Error("请选择用户组"), { code: 400 })
        // 组成员的用户 id 集合 → userId in
        const members = await db.groupUser.findMany({ where: { groupId: { in: p.ids } }, select: { userId: true } })
        const userIds = [...new Set(members.map((m) => m.userId))]
        if (!userIds.length) return { affected: 0, rotated: 0, failures: [] }
        where = { userId: { in: userIds }, revokedAt: null }
        break
      }
      case "all-active":
        where = { revokedAt: null }
        break
    }
    const tokens = await db.cdpEndpointToken.findMany({ where, take: 2000 })
    const failures: Array<{ id: string; reason: string }> = []
    let rotated = 0

    for (const t of tokens) {
      try {
        if (p.op === "revoke") {
          await db.cdpEndpointToken.update({ where: { id: t.id }, data: { revokedAt: new Date(), revokeReason: p.reason || "管理员批量吊销" } })
        } else if (p.op === "expire-now") {
          await db.cdpEndpointToken.update({ where: { id: t.id }, data: { expireAt: new Date(Date.now() - 1000) } })
        } else if (p.op === "extend") {
          const base = t.expireAt && t.expireAt.getTime() > Date.now() ? t.expireAt.getTime() : Date.now()
          await db.cdpEndpointToken.update({ where: { id: t.id }, data: { expireAt: new Date(base + (p.minutes || 60) * 60_000) } })
        } else if (p.op === "rotate") {
          await db.cdpEndpointToken.update({ where: { id: t.id }, data: { revokedAt: new Date(), revokeReason: p.reason || "管理员批量轮换（地址更换）" } })
          await db.cdpEndpointToken.create({
            data: {
              tid: randomHex(24),
              workspaceId: t.workspaceId, userId: t.userId,
              label: t.label, note: t.note,
              expireAt: p.minutes ? new Date(Date.now() + p.minutes * 60_000) : t.expireAt,
              maxUses: t.maxUses, rotatedFromId: t.id,
              createdVia: "ADMIN", createdByUserId: ctx.userId,
            },
          })
          rotated++
        }
      } catch (e) {
        failures.push({ id: t.id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "CDP_TOKEN_ADMIN_BATCH",
      resourceType: "WORKSPACE", resourceId: p.scope === "workspace" ? p.ids[0] : "batch",
      after: { scope: p.scope, ids: p.ids.slice(0, 20), op: p.op, tokens: tokens.length, rotated, failCount: failures.length, reason: p.reason },
      severity: "WARN",
    })
    return { affected: tokens.length, rotated, failures }
  })
}

type PrismaFilter = { workspaceId?: { in: string[] }; userId?: { in: string[] }; revokedAt?: null }
