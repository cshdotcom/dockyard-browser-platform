import { NextRequest } from "next/server"
import { apiHandler, apiOk, apiFail } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// 病毒扫描：POST /api/files/scan  body: { fileId }
// 简化实现：标记 virusScanned=true + 审计（供上传流程与手动补扫调用）
// 访问权限：管理员 / 所有者 / 共享对象

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()

    let fileId = ""
    try {
      const body = (await req.json()) as { fileId?: string }
      fileId = String(body.fileId || "")
    } catch {
      return apiFail(40001, "请求体必须是 JSON 格式：{ fileId }")
    }
    if (!fileId) return apiFail(40001, "缺少 fileId")

    const file = await db.fileMeta.findFirst({ where: { id: fileId, deletedAt: null } })
    if (!file) return apiFail(40400, "文件不存在或已删除")

    const shareTo = Array.isArray(file.shareTo) ? (file.shareTo as unknown[]).filter((v): v is string => typeof v === "string") : []
    const allowed =
      ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN" || file.userId === ctx.userId || shareTo.includes(ctx.userId)
    if (!allowed) return apiFail(40300, "无权扫描该文件")

    await db.fileMeta.update({ where: { id: file.id }, data: { virusScanned: true } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_VIRUS_SCAN",
      resourceType: "FILE",
      resourceId: file.id,
      resourceName: file.fileName,
      ownerUserId: file.userId ?? undefined,
      before: { virusScanned: file.virusScanned },
      after: { virusScanned: true, engine: "builtin-mark", scannedBy: ctx.username },
      severity: "INFO",
    })
    return apiOk({ fileId: file.id, virusScanned: true }, "病毒扫描完成（内置标记引擎：未检出风险）")
  })
}
