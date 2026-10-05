"use server"

// ============================================================
// r40：打印机池管理中心（管理员 actions）
//
// printAdminMonitorAction    —— 总览（统计卡/打印机池/任务队列/审计流）
// printAdminPrinterOpAction  —— 打印机禁用/启用/删除/位置标注
// printAdminJobOpAction      —— 任务重派（TIMED_OUT/FAILED）/ 强制取消 / 清文件
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { bizError, ErrorCode } from "@/lib/errors"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { sweepPrintJobs, sweepPrintJobFiles, signPrintDownloadToken, deletePrintJobFile, readPrintJobFile } from "@/lib/print-pool"

export interface PrintAdminMonitorData {
  stats: { totalJobs: number; inFlight: number; printed: number; failed: number; timedOut: number; canceled: number }
  printers: Array<{
    id: string; name: string; printerKey: string; description: string; location: string
    status: string; clientName: string; nodeUuid: string; nodeName: string; nodeStatus: string
    lastSeenAt: string; jobCount: number
  }>
  recentJobs: Array<{
    id: string; jobNo: string; username: string; workspaceName: string; printerName: string
    nodeName: string; status: string; deliverMode: string; copies: number; fileBytes: number
    sourceUrl: string; error: string | null; createdAt: string; finishedAt: string | null
  }>
  recentAudit: Array<{ at: string; operator: string; op: string; target: string; severity: string }>
  config: { poolEnabled: boolean; dispatchTimeoutSec: number; deliverTimeoutSec: number; fileTtlHours: number }
}

export async function printAdminMonitorAction(input?: unknown): Promise<ActionResult<PrintAdminMonitorData>> {
  return actionHandler(async () => {
    await requireAdmin()
    zodValidate(z.object({}).optional(), input ?? {})

    // 查询路径顺带收口
    await sweepPrintJobs().catch(() => null)
    await sweepPrintJobFiles().catch(() => null)

    const { getConfig, getConfigBool, getConfigNumber } = await import("@/lib/config")

    const [totalJobs, printed, failed, timedOut, canceled, printerRows, jobRows, auditRows] = await Promise.all([
      db.printJob.count(),
      db.printJob.count({ where: { status: "PRINTED" } }),
      db.printJob.count({ where: { status: "FAILED" } }),
      db.printJob.count({ where: { status: "TIMED_OUT" } }),
      db.printJob.count({ where: { status: "CANCELED" } }),
      db.remotePrinter.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }], take: 100 }),
      db.printJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      db.auditLog.findMany({
        where: { operationType: "PRINT_POOL" },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { createdAt: true, operatorName: true, operationType: true, resourceName: true, severity: true, afterJson: true },
      }),
    ])

    const nodes = printerRows.length > 0
      ? await db.workNode.findMany({ where: { nodeUuid: { in: [...new Set(printerRows.map((p) => p.nodeUuid))] } }, select: { nodeUuid: true, name: true, status: true } })
      : []
    const nodeByUuid = new Map(nodes.map((n) => [n.nodeUuid, n]))

    const jobCountByPrinter = new Map<string, number>()
    for (const j of jobRows) {
      if (j.printerId) jobCountByPrinter.set(j.printerId, (jobCountByPrinter.get(j.printerId) || 0) + 1)
    }

    const recentJobs = jobRows.map((j) => ({
      id: j.id, jobNo: j.jobNo, username: j.username, workspaceName: j.workspaceName,
      printerName: j.printerName, nodeName: nodeByUuid.get(j.nodeUuid)?.name || j.nodeUuid.slice(0, 12),
      status: j.status, deliverMode: j.deliverMode, copies: j.copies, fileBytes: j.fileBytes,
      sourceUrl: j.sourceUrl, error: j.error, createdAt: j.createdAt.toISOString(), finishedAt: j.finishedAt?.toISOString() || null,
    }))

    return {
      stats: {
        totalJobs,
        inFlight: totalJobs - printed - failed - timedOut - canceled,
        printed, failed, timedOut, canceled,
      },
      printers: printerRows.map((p) => ({
        id: p.id, name: p.name, printerKey: p.printerKey, description: p.description, location: p.location,
        status: p.status, clientName: p.clientName, nodeUuid: p.nodeUuid,
        nodeName: nodeByUuid.get(p.nodeUuid)?.name || p.nodeUuid.slice(0, 12),
        nodeStatus: nodeByUuid.get(p.nodeUuid)?.status || "UNKNOWN",
        lastSeenAt: p.lastSeenAt.toISOString(),
        jobCount: jobCountByPrinter.get(p.id) || 0,
      })),
      recentJobs,
      recentAudit: auditRows.map((a) => ({
        at: a.createdAt.toISOString(), operator: a.operatorName || "—",
        op: (a.afterJson ? (JSON.parse(a.afterJson).phase || a.operationType) : a.operationType) as string,
        target: a.resourceName || "—", severity: a.severity,
      })),
      config: {
        poolEnabled: await getConfigBool("printing.poolEnabled", true),
        dispatchTimeoutSec: await getConfigNumber("print.dispatchTimeoutSec", 180),
        deliverTimeoutSec: await getConfigNumber("print.deliverTimeoutSec", 600),
        fileTtlHours: await getConfigNumber("print.fileTtlHours", 24),
      },
    }
  })
}

// ---------------- 打印机操作 ----------------
export async function printAdminPrinterOpAction(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return actionHandler(async () => {
    const operator = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: zId,
        op: z.enum(["disable", "enable", "delete", "setLocation"]),
        location: z.string().max(120).optional(),
      }),
      input,
    )
    const printer = await db.remotePrinter.findUnique({ where: { id: p.id } })
    if (!printer) throw bizError(ErrorCode.NOT_FOUND, "打印机不存在")

    if (p.op === "disable") {
      if (printer.status === "DISABLED") throw bizError(ErrorCode.CONFLICT, "打印机已是禁用状态")
      await db.remotePrinter.update({ where: { id: p.id }, data: { status: "DISABLED" } })
    } else if (p.op === "enable") {
      if (printer.status !== "DISABLED") throw bizError(ErrorCode.CONFLICT, "打印机未处于禁用状态（状态由客户端上报驱动）")
      await db.remotePrinter.update({ where: { id: p.id }, data: { status: "ONLINE", lastSeenAt: new Date() } })
    } else if (p.op === "delete") {
      await db.remotePrinter.delete({ where: { id: p.id } })
    } else if (p.op === "setLocation") {
      await db.remotePrinter.update({ where: { id: p.id }, data: { location: (p.location || "").slice(0, 120) } })
    }

    await writeAudit({
      operatorUserId: operator.userId, operatorName: operator.username,
      operationType: "PRINT_POOL", resourceType: "REMOTE_PRINTER", resourceId: p.id, resourceName: printer.name,
      after: { phase: `PRINTER_${p.op.toUpperCase()}`, location: p.location || "" },
    })
    return { ok: true as const }
  })
}

// ---------------- 任务操作（重派/强制取消）----------------
export async function printAdminJobOpAction(input: unknown): Promise<ActionResult<{ jobNo: string; status: string }>> {
  return actionHandler(async () => {
    const operator = await requireAdmin()
    const p = zodValidate(
      z.object({ id: zId, op: z.enum(["retry", "cancel", "cleanFile"]) }),
      input,
    )
    const job = await db.printJob.findUnique({ where: { id: p.id } })
    if (!job) throw bizError(ErrorCode.NOT_FOUND, "打印任务不存在")

    if (p.op === "retry") {
      if (!["TIMED_OUT", "FAILED"].includes(job.status)) {
        throw bizError(ErrorCode.CONFLICT, `仅失败/超时任务可重派（当前 ${job.status}）`)
      }
      // 文件必须仍在（TTL 内）
      if (!readPrintJobFile(job.id)) {
        await db.printJob.update({ where: { id: job.id }, data: { status: "FAILED", error: "重派失败：文件已过 TTL 清理" } })
        throw bizError(ErrorCode.NOT_FOUND, "打印文件已过保留期清理，无法重派")
      }
      // 目标节点/打印机必须在线
      const node = await db.workNode.findUnique({ where: { nodeUuid: job.nodeUuid } })
      if (!node || !node.enabled || node.status !== "ONLINE") {
        throw bizError(ErrorCode.CONFLICT, "目标客户端节点离线，无法重派")
      }
      const token = signPrintDownloadToken(job.id, job.nodeUuid)
      await db.workNodeCommand.create({
        data: {
          nodeUuid: job.nodeUuid,
          cmd: "print.dispatch",
          payloadJson: JSON.stringify({
            jobId: job.id, jobNo: job.jobNo, fileName: job.fileName, bytes: job.fileBytes, sha256: job.fileSha256,
            downloadPath: `/api/master/print/file/${job.id}?t=${token.t}&e=${token.e}`,
            deliverMode: job.deliverMode, copies: job.copies, duplex: job.duplex, landscape: job.landscape,
            printerKey: job.printerKey, printerName: job.printerName,
            requestedBy: `admin:${operator.username}`.slice(0, 60), sourceUrl: job.sourceUrl.slice(0, 300),
            retried: true,
          }),
        },
      })
      await db.printJob.update({
        where: { id: job.id },
        data: { status: "PENDING", attempts: { increment: 1 }, error: null, sentAt: null, deliveredAt: null, finishedAt: null, createdAt: new Date() },
      })
      await writeAudit({
        operatorUserId: operator.userId, operatorName: operator.username,
        operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
        after: { phase: "RETRY_DISPATCHED", attempts: job.attempts + 1 },
      })
      return { jobNo: job.jobNo, status: "PENDING" }
    }

    if (p.op === "cancel") {
      if (["PRINTED", "CANCELED", "TIMED_OUT"].includes(job.status)) {
        throw bizError(ErrorCode.CONFLICT, `任务已终态（${job.status}）`)
      }
      await db.workNodeCommand.updateMany({
        where: { cmd: "print.dispatch", payloadJson: { contains: `"jobId":"${job.id}"` }, doneAt: null },
        data: { doneAt: new Date(), resultJson: JSON.stringify({ ok: false, error: "canceled by admin" }) },
      }).catch(() => null)
      await db.printJob.update({ where: { id: job.id }, data: { status: "CANCELED", finishedAt: new Date(), error: `管理员强制取消（${operator.username}）` } })
      deletePrintJobFile(job.id)
      await writeAudit({
        operatorUserId: operator.userId, operatorName: operator.username,
        operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
        after: { phase: "ADMIN_CANCELED" },
      })
      return { jobNo: job.jobNo, status: "CANCELED" }
    }

    // cleanFile：立即清磁盘文件（保留记录）
    deletePrintJobFile(job.id)
    await db.printJob.update({ where: { id: job.id }, data: { fileKey: "" } }).catch(() => null)
    await writeAudit({
      operatorUserId: operator.userId, operatorName: operator.username,
      operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: job.id, resourceName: job.jobNo,
      after: { phase: "FILE_CLEANED" },
    })
    return { jobNo: job.jobNo, status: job.status }
  })
}
