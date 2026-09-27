import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { authenticateApiToken, tokenResponse, TOKEN_PERM, attachOwnership } from "@/lib/api-token-auth"

// OpenAPI 资源查询接口：所有资源输出统一归属字段
// ownerUserId / ownerUserName / createdByUserId / createdByUserName / userGroupId / userGroupName

export async function GET(req: NextRequest) {
  const auth = await authenticateApiToken(req, TOKEN_PERM.READ)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const ctx = auth.ctx!
  return tokenResponse(req, ctx, async () => {
    const resource = req.nextUrl.searchParams.get("resource") || "workspaces"
    const isAdmin = !!(ctx.permissions & TOKEN_PERM.ADMIN)
    const traceId = crypto.randomUUID()

    let data: Record<string, unknown>[] = []
    if (resource === "workspaces") {
      const rows = await db.browserWorkspace.findMany({
        where: isAdmin ? { deletedAt: null } : { userId: ctx.userId, deletedAt: null },
        take: 100, orderBy: { createdAt: "desc" },
      })
      data = await attachOwnership(
        rows.map((r) => ({
          id: r.id, uuid: r.uuid, name: r.name, mode: r.mode, status: r.status,
          userId: r.userId, groupId: r.groupId, proxyNodeId: r.proxyNodeId, singboxInstanceId: r.singboxInstanceId,
          createdByUserId: r.createdByUserId, ttlMinutes: r.ttlMinutes, tags: r.tags, createdAt: r.createdAt.toISOString(),
        }))
      )
    } else if (resource === "singbox") {
      if (!isAdmin) return NextResponse.json({ code: 40300, msg: "需要 ADMIN 权限位", traceId }, { status: 403 })
      const rows = await db.singboxInstance.findMany({ where: { deletedAt: null }, take: 100, orderBy: { createdAt: "desc" } })
      data = await attachOwnership(
        rows.map((r) => ({
          id: r.id, name: r.name, status: r.status, cpuLimit: r.cpuLimit, memLimitMb: r.memLimitMb,
          socksAddr: r.socksAddr, currentSessions: r.currentSessions, maxSessions: r.maxSessions,
          userId: r.ownerUserId, createdByUserId: r.createdByUserId, configVersion: r.configVersion, createdAt: r.createdAt.toISOString(),
        }))
      )
    } else if (resource === "users") {
      if (!isAdmin) return NextResponse.json({ code: 40300, msg: "需要 ADMIN 权限位", traceId }, { status: 403 })
      const rows = await db.user.findMany({ where: { deletedAt: null }, take: 100, orderBy: { createdAt: "desc" } })
      data = rows.map((u) => ({
        id: u.id, username: u.username, email: u.email, displayName: u.displayName, role: u.role,
        enabled: u.enabled, twoFactorEnabled: u.twoFactorEnabled, lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        ownerUserId: u.id, ownerUserName: u.username, createdByUserId: u.id, createdByUserName: u.username,
        createdAt: u.createdAt.toISOString(),
      }))
    } else if (resource === "tokens") {
      const rows = await db.apiToken.findMany({
        where: isAdmin ? { deletedAt: null } : { userId: ctx.userId, deletedAt: null },
        take: 100, orderBy: { createdAt: "desc" },
      })
      data = await attachOwnership(
        rows.map((t) => ({
          id: t.id, name: t.name, tokenPrefix: t.tokenPrefix, enabled: t.enabled,
          expireAt: t.expireAt?.toISOString() ?? null, lastCallAt: t.lastCallAt?.toISOString() ?? null,
          callCount: t.callCount, userId: t.userId, createdByUserId: t.createdByUserId, createdAt: t.createdAt.toISOString(),
        }))
      )
    } else if (resource === "recycle") {
      if (!isAdmin) return NextResponse.json({ code: 40300, msg: "需要 ADMIN 权限位", traceId }, { status: 403 })
      const rows = await db.recycleBin.findMany({ take: 100, orderBy: { createdAt: "desc" } })
      data = await attachOwnership(
        rows.map((r) => ({
          id: r.id, resourceType: r.resourceType, resourceId: r.resourceId, resourceName: r.resourceName,
          deletedByType: r.deletedByType, reason: r.reason, locked: r.locked, restoredAt: r.restoredAt?.toISOString() ?? null,
          userId: r.ownerUserId, createdByUserId: r.createdByUserId, createdAt: r.createdAt.toISOString(),
        }))
      )
    } else if (resource === "alerts") {
      if (!isAdmin) return NextResponse.json({ code: 40300, msg: "需要 ADMIN 权限位", traceId }, { status: 403 })
      const rows = await db.alert.findMany({ take: 100, orderBy: { createdAt: "desc" } })
      data = rows.map((a) => ({
        id: a.id, title: a.title, level: a.level, content: a.content, handleStatus: a.handleStatus,
        triggerAt: a.triggerAt.toISOString(), createdAt: a.createdAt.toISOString(),
        ownerUserId: a.ownerUserId, createdByUserId: null,
      }))
    } else {
      return NextResponse.json({
        code: 40001,
        msg: "未知资源类型",
        data: { available: ["workspaces", "singbox", "users", "tokens", "recycle", "alerts"] },
        traceId,
      })
    }

    return NextResponse.json({ code: 0, msg: "ok", data: { resource, count: data.length, items: data }, traceId })
  })
}
