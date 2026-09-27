import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireRole } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { toCsv, fmtDate } from "@/lib/utils-server"

// 审计日志CSV导出：GET /api/export/audit?from&to&resourceId&operator（缺省近30天全量，单次上限5000行）
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireRole(["SUPER_ADMIN", "ADMIN", "GROUP_ADMIN"])

    const sp = req.nextUrl.searchParams
    const fromStr = sp.get("from")
    const toStr = sp.get("to")
    const resourceId = sp.get("resourceId")?.trim() || undefined
    const operator = sp.get("operator")?.trim() || undefined
    const resourceType = sp.get("resourceType")?.trim() || undefined

    const from = fromStr && !Number.isNaN(new Date(fromStr).getTime()) ? new Date(fromStr) : new Date(Date.now() - 30 * 86400_000)
    const to = toStr && !Number.isNaN(new Date(toStr).getTime()) ? new Date(new Date(toStr).getTime() + 86399_000) : new Date()

    const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } }
    if (resourceId) where.resourceId = { contains: resourceId }
    if (operator) where.operatorName = { contains: operator }
    if (resourceType) where.resourceType = { contains: resourceType }

    const logs = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 5000,
    })

    const headers = [
      "id", "createdAt", "traceId", "operatorUserId", "operatorName", "operationType",
      "resourceType", "resourceId", "resourceName", "ownerUserId", "createdByUserId",
      "clientIp", "severity", "beforeJson", "afterJson", "extraJson",
    ]
    const rows = logs.map((a) => [
      a.id, fmtDate(a.createdAt), a.traceId || "", a.operatorUserId || "", a.operatorName || "",
      a.operationType, a.resourceType, a.resourceId || "", a.resourceName || "",
      a.ownerUserId || "", a.createdByUserId || "", a.clientIp || "", a.severity,
      a.beforeJson || "", a.afterJson || "", a.extraJson || "",
    ])

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "EXPORT",
      resourceType: "AUDIT_LOG",
      severity: "WARN",
      after: { count: logs.length, from: from.toISOString(), to: to.toISOString(), resourceId, operator },
      extra: { exportFormat: "csv" },
    })

    const csv = toCsv(headers, rows)
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dockyard-audit-${Date.now()}.csv"`,
      },
    })
  })
}
