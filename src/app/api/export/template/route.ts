import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, requirePermission, userGroupIds } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { apiHandler } from "@/lib/api"
import { bizError, ErrorCode } from "@/lib/errors"

// 模板 JSON 导出：requireAuth + 可见性归属校验 + 文件下载 + 审计
// 权限锁：blockExportData（数据导出统一锁）
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockExportData", "导出数据已被权限锁禁止")

    const id = req.nextUrl.searchParams.get("id") || ""
    if (!id) throw bizError(ErrorCode.PARAM_ERROR, "缺少模板 id 参数")

    const t = await db.browserTemplate.findFirst({ where: { id, deletedAt: null } })
    if (!t) throw bizError(ErrorCode.NOT_FOUND, "模板不存在或已删除")

    // 可见性归属校验：GLOBAL / 我所在组 / 我自己
    if (t.scope !== "GLOBAL" && t.userId !== ctx.userId) {
      if (t.scope !== "GROUP" || !t.groupId) throw bizError(ErrorCode.FORBIDDEN, "无权导出该模板")
      const gids = await userGroupIds(ctx.userId)
      if (!gids.includes(t.groupId)) throw bizError(ErrorCode.FORBIDDEN, "无权导出该模板")
    }

    // 导出结构：可回灌导入的完整模板定义
    let config: unknown = {}
    try {
      config = JSON.parse(t.configJson)
    } catch {
      config = {}
    }
    const payload = {
      name: t.name,
      description: t.description || "",
      scope: t.scope,
      tags: Array.isArray(t.tags) ? t.tags : [],
      version: t.version,
      parentId: t.parentId,
      config,
      exportedAt: new Date().toISOString(),
      exportedBy: ctx.username,
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "TEMPLATE_EXPORT",
      resourceType: "TEMPLATE",
      resourceId: t.id,
      resourceName: t.name,
      ownerUserId: t.userId,
      after: { name: t.name, scope: t.scope, version: t.version },
    })

    // 文件名：ASCII 回退 + RFC 5987 UTF-8 编码（中文文件名兼容）
    const safeName = t.name.replace(/[^\w-]+/g, "_").slice(0, 50) || "template"
    const utf8Name = encodeURIComponent(`${t.name}.json`).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="template-${safeName}.json"; filename*=UTF-8''${utf8Name}`,
      },
    })
  })
}
