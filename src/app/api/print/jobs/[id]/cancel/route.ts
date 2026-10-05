import { NextRequest, NextResponse } from "next/server"
import { getAuthContext } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { deletePrintJobFile } from "@/lib/print-pool"

// ============================================================
// r40：取消打印任务（用户侧；仅本人任务）
// POST /api/print/jobs/<id>/cancel
//   · 仅 PENDING/SENT 可取消（DELIVERED 后客户端已在打印流程中，无法可靠中止）
//   · 联动取消仍在队列的 print.dispatch 指令（防迟到领取）
//   · 文件即时清理；终态任务 → 409
// ============================================================

export const dynamic = "force-dynamic"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })

  const job = await db.printJob.findUnique({ where: { id } })
  if (!job || job.userId !== ctx.userId) {
    return NextResponse.json({ code: 40400, msg: "打印任务不存在" }, { status: 404 })
  }
  if (!["PENDING", "SENT"].includes(job.status)) {
    return NextResponse.json({ code: 40900, msg: `任务当前状态 ${job.status}，不可取消（已进入客户端打印流程或已完结）` }, { status: 409 })
  }

  // 取消未执行的派发指令（迟到领取防护）
  await db.workNodeCommand.updateMany({
    where: { cmd: "print.dispatch", payloadJson: { contains: `"jobId":"${job.id}"` }, doneAt: null },
    data: { doneAt: new Date(), resultJson: JSON.stringify({ ok: false, error: "canceled by user" }) },
  }).catch(() => null)

  await db.printJob.update({
    where: { id: job.id },
    data: { status: "CANCELED", finishedAt: new Date(), error: "用户取消" },
  })
  deletePrintJobFile(job.id)

  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username,
    operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
    ownerUserId: job.userId,
    after: { phase: "CANCELED", printer: job.printerName, bytes: job.fileBytes },
  }).catch(() => null)

  return NextResponse.json({ code: 0, msg: "打印任务已取消", data: { jobNo: job.jobNo, status: "CANCELED" } })
}
