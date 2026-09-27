import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { toCsv, fmtDate } from "@/lib/utils-server"

// 用户CSV导出：GET /api/export/users?ids=id1,id2（缺省全部）
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAdmin()

    const idsParam = req.nextUrl.searchParams.get("ids")
    const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null

    const where = ids && ids.length > 0 ? { id: { in: ids } } : { deletedAt: null }

    const users = await db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, username: true, email: true, displayName: true, role: true, enabled: true, frozen: true,
        emailVerified: true, twoFactorEnabled: true, force2faSetup: true, mustChangePassword: true,
        lastLoginAt: true, lastLoginIp: true, createdAt: true, deletedAt: true, quota: true,
      },
    })

    // 组信息批量（无外键关联，内存组装）
    const userIds = users.map((u) => u.id)
    const memberships = userIds.length
      ? await db.groupUser.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, groupId: true },
        })
      : []
    const involvedGroupIds = [...new Set(memberships.map((m) => m.groupId))]
    const involvedGroups = involvedGroupIds.length
      ? await db.group.findMany({ where: { id: { in: involvedGroupIds }, deletedAt: null }, select: { id: true, name: true } })
      : []
    const groupNameById = new Map(involvedGroups.map((g) => [g.id, g.name]))
    const groupsByUser = new Map<string, string[]>()
    for (const m of memberships) {
      const gname = groupNameById.get(m.groupId)
      if (!gname) continue
      const arr = groupsByUser.get(m.userId) || []
      arr.push(gname)
      groupsByUser.set(m.userId, arr)
    }

    const headers = [
      "id", "username", "email", "displayName", "role", "enabled", "frozen", "emailVerified",
      "twoFactorEnabled", "force2faSetup", "mustChangePassword", "quotaSessions", "quotaNovncSessions",
      "quotaDiskMb", "groups", "lastLoginAt", "lastLoginIp", "createdAt", "deletedAt",
    ]
    const rows = users.map((u) => {
      const quota = (u.quota as Record<string, number | null> | null) || {}
      return [
        u.id, u.username, u.email || "", u.displayName || "", u.role,
        String(u.enabled), String(u.frozen), String(u.emailVerified),
        String(u.twoFactorEnabled), String(u.force2faSetup), String(u.mustChangePassword),
        quota.sessions ?? "", quota.novncSessions ?? "", quota.diskMb ?? "",
        (groupsByUser.get(u.id) || []).join(" | "),
        u.lastLoginAt ? fmtDate(u.lastLoginAt) : "", u.lastLoginIp || "",
        fmtDate(u.createdAt), u.deletedAt ? fmtDate(u.deletedAt) : "",
      ]
    })

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EXPORT",
      resourceType: "USER",
      severity: "WARN",
      after: { count: users.length, scope: ids && ids.length > 0 ? "selected" : "all" },
      extra: { exportFormat: "csv" },
    })

    const csv = toCsv(headers, rows)
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dockyard-users-${Date.now()}.csv"`,
      },
    })
  })
}

