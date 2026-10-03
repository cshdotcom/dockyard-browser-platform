import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { randomBytes, createHash } from "crypto"
import { z } from "zod"

// ============================================================
// r29：Worker 节点注册（Master 侧）
// POST /api/master/worknode/create —— 仅超级管理员
//   生成 WORKER_NODE_UUID + WORKER_API_KEY（明文仅本次响应返回一次，库中只存 SHA-256）
// ============================================================

const schema = z.object({
  name: z.string().min(2).max(60),
  region: z.string().min(1).max(60).default("default"),
  note: z.string().max(200).optional(),
  maxSandboxes: z.number().int().min(1).max(200).default(20),
})

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getAuthContext().catch(() => null)
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
    if (ctx.role !== "SUPER_ADMIN") {
      return NextResponse.json({ code: 40300, msg: "仅超级管理员可创建 Worker 节点" }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const p = schema.safeParse(body)
    if (!p.success) {
      return NextResponse.json({ code: 40001, msg: `参数错误：${p.error.issues[0]?.message || "格式非法"}` }, { status: 400 })
    }

    const dup = await db.workNode.findFirst({ where: { name: p.data.name } })
    if (dup) return NextResponse.json({ code: 40900, msg: "已存在同名节点" }, { status: 409 })

    const nodeUuid = `wn-${randomBytes(8).toString("hex")}`
    const apiKey = `wak-${randomBytes(24).toString("hex")}`

    const node = await db.workNode.create({
      data: {
        nodeUuid,
        name: p.data.name,
        region: p.data.region,
        note: p.data.note,
        apiKeyHash: hashKey(apiKey),
        maxSandboxes: p.data.maxSandboxes,
        status: "PENDING",
        createdByUserId: ctx.userId,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKNODE_CREATE", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
      after: { nodeUuid, region: node.region, maxSandboxes: node.maxSandboxes },
      severity: "WARN",
    }).catch(() => null)

    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        nodeId: node.id,
        nodeUuid,
        apiKey,
        deploy: {
          MASTER_API_URL: new URL(req.nextUrl.origin).origin,
          WORKER_NODE_UUID: nodeUuid,
          WORKER_API_KEY: apiKey,
        },
      },
    })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: `创建失败：${(e as Error).message}` }, { status: 500 })
  }
}
