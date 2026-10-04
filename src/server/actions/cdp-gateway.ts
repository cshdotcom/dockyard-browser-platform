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
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getConfig, getConfigNumber, getConfigBool } from "@/lib/config"
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
