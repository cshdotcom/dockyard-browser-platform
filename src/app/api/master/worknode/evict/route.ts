import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { z } from "zod"

// ============================================================
// r29：Worker 节点驱逐（密钥泄露处置；仅超级管理员）
// POST /api/master/worknode/evict { nodeId, reason }
//   驱逐后：节点 EVICTED → 心跳永久 403 → 对应 Worker 永久失效无法接入集群
// ============================================================

const schema = z.object({
  nodeId: z.string().min(10).max(64),
  reason: z.string().min(4).max(200),
})

export async function POST(req: NextRequest) {
  try {
    const ctx = await getAuthContext().catch(() => null)
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
    if (ctx.role !== "SUPER_ADMIN") {
      return NextResponse.json({ code: 40300, msg: "仅超级管理员可驱逐 Worker 节点" }, { status: 403 })
    }
    const body = await req.json().catch(() => ({}))
    const p = schema.safeParse(body)
    if (!p.success) return NextResponse.json({ code: 40001, msg: "参数错误（原因至少 4 字符）" }, { status: 400 })

    const node = await db.workNode.findUnique({ where: { id: p.data.nodeId } })
    if (!node) return NextResponse.json({ code: 40400, msg: "节点不存在" }, { status: 404 })
    if (node.status === "EVICTED") return NextResponse.json({ code: 40900, msg: "该节点已被驱逐" }, { status: 409 })

    await db.workNode.update({
      where: { id: node.id },
      data: { status: "EVICTED", enabled: false, evictedAt: new Date(), evictReason: p.data.reason },
    })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKNODE_EVICT", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
      before: { status: node.status },
      after: { reason: p.data.reason, nodeUuid: node.nodeUuid, permanent: true },
      severity: "WARN",
    }).catch(() => null)

    return NextResponse.json({ code: 0, msg: "ok", data: { evicted: true } })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: `驱逐失败：${(e as Error).message}` }, { status: 500 })
  }
}
