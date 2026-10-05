import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { verifyWorkNodeAuth } from "@/lib/worknode-auth"

// ============================================================
// r40：打印任务阶段状态回报（客户端 → 主控；即时通道，不等下轮心跳）
// POST /api/master/print/report   Header: x-node-uuid + x-node-key
// Body: { jobId, phase, error?, clientInfo? }
//   phase ∈ DELIVERED（文件已下载/校验）| PRINTING（已提交打印）| PRINTED（完成）| FAILED
//   · 状态机单向前进（STATUS_ORDER；重放/乱序回报拒绝）
//   · 任务必须属于该节点（防跨节点伪造）
//   · PRINTED/FAILED 为终态（终态后再回报 → 幂等 200 但不落库）
//   · 审计 PRINT_POOL 全阶段事件（管理员监控时间线）
// ============================================================

export const dynamic = "force-dynamic"

const PHASES = ["DELIVERED", "PRINTING", "PRINTED", "FAILED"] as const
const ORDER: Record<string, number> = {
  PENDING: 0, SENT: 1, DELIVERED: 2, PRINTING: 3, PRINTED: 4, FAILED: 4, CANCELED: 4, TIMED_OUT: 4,
}

const schema = z.object({
  jobId: z.string().min(1).max(64),
  phase: z.enum(PHASES),
  error: z.string().max(500).optional(),
  clientInfo: z.string().max(200).optional(),
})

export async function POST(req: NextRequest) {
  const auth = await verifyWorkNodeAuth(req, "print-report")
  if (!auth.ok) return auth.resp!
  const node = auth.node!

  const body = await req.json().catch(() => null)
  const p = schema.safeParse(body)
  if (!p.success) {
    return NextResponse.json({ code: 40001, msg: "状态回报格式非法" }, { status: 400 })
  }

  const job = await db.printJob.findUnique({ where: { id: p.data.jobId } })
  if (!job) return NextResponse.json({ code: 40400, msg: "打印任务不存在" }, { status: 404 })
  if (job.nodeUuid !== node.nodeUuid) {
    await writeAudit({
      operatorName: `worker:${node.name}`,
      operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
      after: { phase: "CROSS_NODE_REPORT_DENIED", jobNode: job.nodeUuid, reporter: node.nodeUuid },
      severity: "DANGER",
    }).catch(() => null)
    return NextResponse.json({ code: 40300, msg: "任务不属于该节点（跨节点回报被拒绝）" }, { status: 403 })
  }

  // 终态幂等（重复回报不报错，但不改状态）
  if (ORDER[job.status] >= 4) {
    return NextResponse.json({ code: 0, msg: "任务已终态（幂等回报）", data: { status: job.status, ignored: true } })
  }
  // 单向前进
  if (ORDER[p.data.phase] <= ORDER[job.status]) {
    return NextResponse.json({ code: 0, msg: "状态未前进（乱序/重放忽略）", data: { status: job.status, ignored: true } })
  }

  const now = new Date()
  const data: Record<string, unknown> = {
    status: p.data.phase,
    ...(p.data.phase === "DELIVERED" ? { deliveredAt: now } : {}),
    ...(p.data.phase === "PRINTED" || p.data.phase === "FAILED" ? { finishedAt: now } : {}),
    ...(p.data.error ? { error: p.data.error.slice(0, 500) } : {}),
    ...(p.data.clientInfo ? { attempts: { increment: 1 } } : {}),
  }
  await db.printJob.update({ where: { id: job.id }, data })

  await writeAudit({
    operatorUserId: job.userId, operatorName: job.username,
    operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
    after: {
      phase: p.data.phase, printer: job.printerName, deliverMode: job.deliverMode,
      bytes: job.fileBytes, sourceUrl: job.sourceUrl.slice(0, 180),
      client: node.name, clientInfo: p.data.clientInfo?.slice(0, 200) || "",
      error: p.data.error?.slice(0, 200) || "",
    },
    severity: p.data.phase === "FAILED" ? "WARN" : "INFO",
  }).catch(() => null)

  return NextResponse.json({ code: 0, msg: "ok", data: { status: p.data.phase } })
}
