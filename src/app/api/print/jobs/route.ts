import { NextRequest, NextResponse } from "next/server"
import { createHash } from "crypto"
import { getAuthContext } from "@/lib/permissions"
import { isPermissionLocked } from "@/lib/permissions"
import { executeBrowserAction } from "@/lib/external/cdp-control"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { extractClientIp } from "@/lib/client-ip"
import {
  poolEnabled, savePrintJobFile, newPrintJobNo, signPrintDownloadToken,
  resolvePrintPolicyForUser, checkPrintAllowed, sweepPrintJobs, sweepPrintJobFiles,
  PRINT_DELIVER_MODES,
} from "@/lib/print-pool"

// ============================================================
// r40：用户侧打印任务（沙箱页面 → 远程客户端物理打印机）
//
// POST /api/print/jobs { workspaceId, printerId, deliverMode?, copies?, duplex?, landscape?, printBackground?, scale? }
//   1. 门禁：printing.poolEnabled 全局开关 + blockRemotePrintPool 权限锁 + 限流 12/min
//   2. 渲染：executeBrowserAction print_pdf（CDP Page.printToPDF，返回 PDF + 源页面 URL）
//   3. 策略：URL 级打印管控服务端强制（PrintingEnabled / Allowed/BlockedForUrls —— 与
//      Chromium 注入策略同语义双防线：浏览器侧拦打印框，服务侧拦渲染出纸）
//   4. 校验目标打印机 ONLINE + 节点 ONLINE；大小上限 print.jobMaxBytes
//   5. 落盘 storage/print-jobs/<jobId>.pdf + PrintJob 入库 + 指令队列 print.dispatch
//      （payload 携 HMAC 一次性下载令牌：凭证 + 令牌双因子）
//
// GET /api/print/jobs?limit=20 —— 我的任务列表（倒序）+ 超时收口顺带触发
// ============================================================

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") || 20), 1), 100)

  // 查询路径顺带收口（超时任务/过期文件；无独立定时器）
  await sweepPrintJobs().catch(() => null)
  await sweepPrintJobFiles().catch(() => null)

  const jobs = await db.printJob.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  })
  // 打印机客户端名补充（printerId 松散关联 → 批量反查）
  const printerIds = [...new Set(jobs.map((j) => j.printerId).filter(Boolean))] as string[]
  const printerRows = printerIds.length > 0
    ? await db.remotePrinter.findMany({ where: { id: { in: printerIds } }, select: { id: true, clientName: true } })
    : []
  const clientByPrinter = new Map(printerRows.map((p) => [p.id, p.clientName]))
  return NextResponse.json({
    code: 0, msg: "ok",
    data: {
      jobs: jobs.map((j) => ({
        id: j.id, jobNo: j.jobNo, workspaceName: j.workspaceName, printerName: j.printerName,
        clientName: (j.printerId ? clientByPrinter.get(j.printerId) : "") || "",
        fileName: j.fileName, fileBytes: j.fileBytes, status: j.status, deliverMode: j.deliverMode,
        copies: j.copies, sourceUrl: j.sourceUrl, error: j.error,
        createdAt: j.createdAt.toISOString(), deliveredAt: j.deliveredAt?.toISOString() || null, finishedAt: j.finishedAt?.toISOString() || null,
      })),
    },
  })
}

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })

  let body: {
    workspaceId?: string
    printerId?: string
    deliverMode?: string
    copies?: number
    duplex?: string
    landscape?: boolean
    printBackground?: boolean
    scale?: number
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ code: 40000, msg: "bad json" }, { status: 400 })
  }
  const workspaceId = (body.workspaceId || "").trim()
  const printerId = (body.printerId || "").trim()
  if (!workspaceId) return NextResponse.json({ code: 40000, msg: "缺少 workspaceId" }, { status: 400 })
  if (!printerId) return NextResponse.json({ code: 40000, msg: "缺少 printerId（目标远程打印机）" }, { status: 400 })
  const deliverMode = PRINT_DELIVER_MODES.includes(body.deliverMode as never) ? body.deliverMode! : "dialog"
  const copies = Math.min(Math.max(Number(body.copies || 1), 1), 50)
  const duplex = ["default", "simplex", "duplex"].includes(body.duplex || "") ? body.duplex! : "default"

  // ---- 门禁 ----
  if (!(await poolEnabled())) {
    return NextResponse.json({ code: 40300, msg: "管理员已停用远程打印机池" }, { status: 403 })
  }
  if (await isPermissionLocked(ctx.userId, "blockRemotePrintPool")) {
    return NextResponse.json({ code: 40300, msg: "管理员已禁止你使用远程打印机池（权限锁）" }, { status: 403 })
  }
  if (!rateLimit(`printPool:${ctx.userId}`, 12, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "打印请求过于频繁，请稍后再试" }, { status: 429 })
  }

  // ---- 目标打印机校验（ONLINE + 节点在线）----
  const printer = await db.remotePrinter.findUnique({ where: { id: printerId } })
  if (!printer) return NextResponse.json({ code: 40400, msg: "目标打印机不存在" }, { status: 404 })
  if (printer.status === "DISABLED") return NextResponse.json({ code: 40300, msg: "该打印机已被管理员禁用" }, { status: 403 })
  if (printer.status !== "ONLINE") return NextResponse.json({ code: 40900, msg: "该打印机当前离线（客户端未上报）" }, { status: 409 })
  const targetNode = await db.workNode.findUnique({ where: { nodeUuid: printer.nodeUuid } })
  if (!targetNode || !targetNode.enabled || targetNode.status === "EVICTED") {
    return NextResponse.json({ code: 40900, msg: "打印机所属客户端节点已失效" }, { status: 409 })
  }
  if (targetNode.status !== "ONLINE") {
    return NextResponse.json({ code: 40900, msg: "打印机所属客户端节点离线（等待心跳恢复）" }, { status: 409 })
  }

  // ---- 渲染（CDP printToPDF；拿 PDF + 源页面 URL）----
  let pdfBuf: Buffer
  let sourceUrl = ""
  let workspaceIdReal = ""
  let workspaceName = ""
  let mode = ""
  try {
    const result = await executeBrowserAction({
      action: "print_pdf",
      workspaceIdOrUuid: workspaceId,
      ctx: { userId: ctx.userId, username: ctx.username, isAdmin: ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN", via: "INTERNAL" },
      params: {
        landscape: !!body.landscape,
        printBackground: body.printBackground !== false,
        scale: body.scale,
      },
      allowNovnc: true,
    })
    const data = (result.data as { dataBase64?: string; bytes?: number; simulated?: boolean; url?: string }) || null
    if (!data?.dataBase64) throw new Error("打印渲染失败（页面可能无可打印内容）")
    pdfBuf = Buffer.from(data.dataBase64, "base64")
    sourceUrl = (data.url || "").slice(0, 500)
    workspaceIdReal = result.workspaceId
    workspaceName = result.workspaceName || ""
    mode = result.mode
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: e instanceof Error ? e.message : "打印渲染失败" }, { status: 500 })
  }

  // ---- URL 级打印策略（服务端强制双防线）----
  const policy = await resolvePrintPolicyForUser(ctx.userId, workspaceId)
  const check = checkPrintAllowed(sourceUrl, policy)
  if (!check.allowed) {
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "PRINT_POOL", resourceType: "WORKSPACE", resourceId: workspaceIdReal, resourceName: workspaceName,
      ownerUserId: ctx.userId,
      after: { phase: "POLICY_DENIED", sourceUrl: sourceUrl.slice(0, 180), reason: check.reason, printer: printer.name },
      severity: "WARN",
    }).catch(() => null)
    return NextResponse.json({ code: 40300, msg: `打印被企业策略拦截：${check.reason}` }, { status: 403 })
  }

  // ---- 大小上限 ----
  const maxBytes = 50 * 1024 * 1024
  if (pdfBuf.length > maxBytes) {
    return NextResponse.json({ code: 40000, msg: `打印文件过大（${(pdfBuf.length / 1024 / 1024).toFixed(1)}MB > 50MB 上限）` }, { status: 400 })
  }

  // ---- 落盘 + 入库 + 派发指令 ----
  const jobNo = newPrintJobNo()
  const fileSha256 = createHash("sha256").update(pdfBuf).digest("hex")
  const job = await db.printJob.create({
    data: {
      jobNo,
      workspaceId: workspaceIdReal, workspaceName,
      userId: ctx.userId, username: ctx.username,
      printerId: printer.id, nodeUuid: printer.nodeUuid,
      printerKey: printer.printerKey, printerName: printer.name,
      sourceUrl,
      fileName: `print-${jobNo}.pdf`, fileBytes: pdfBuf.length, fileSha256,
      fileKey: "pending",
      status: "PENDING",
      deliverMode, copies, duplex, landscape: !!body.landscape,
      printParamsJson: JSON.stringify({ mode, printBackground: body.printBackground !== false, scale: body.scale || 1 }),
      createdByIp: extractClientIp((n) => req.headers.get(n), req.headers.get("x-real-ip") || undefined).slice(0, 64),
    },
  })
  savePrintJobFile(job.id, pdfBuf)
  await db.printJob.update({ where: { id: job.id }, data: { fileKey: `print-jobs/${job.id}.pdf` } })

  // 指令队列派发（心跳携出；payload 携 HMAC 一次性下载令牌）
  const token = signPrintDownloadToken(job.id, printer.nodeUuid)
  await db.workNodeCommand.create({
    data: {
      nodeUuid: printer.nodeUuid,
      cmd: "print.dispatch",
      payloadJson: JSON.stringify({
        jobId: job.id, jobNo, fileName: job.fileName, bytes: pdfBuf.length, sha256: fileSha256,
        downloadPath: `/api/master/print/file/${job.id}?t=${token.t}&e=${token.e}`,
        deliverMode, copies, duplex, landscape: !!body.landscape,
        printerKey: printer.printerKey, printerName: printer.name,
        requestedBy: ctx.username.slice(0, 60), sourceUrl: sourceUrl.slice(0, 300),
      }),
    },
  })

  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username,
    operationType: "PRINT_POOL", resourceType: "WORKSPACE", resourceId: workspaceIdReal, resourceName: workspaceName,
    ownerUserId: ctx.userId,
    after: {
      phase: "CREATED", jobNo, printer: printer.name, node: targetNode.name,
      deliverMode, copies, duplex, bytes: pdfBuf.length, sha256: fileSha256.slice(0, 16),
      sourceUrl: sourceUrl.slice(0, 180), mode,
    },
  }).catch(() => null)

  return NextResponse.json({
    code: 0, msg: "打印任务已创建，等待客户端接收",
    data: {
      jobId: job.id, jobNo, status: "PENDING",
      printerName: printer.name, clientName: printer.clientName,
      bytes: pdfBuf.length, deliverMode,
    },
  })
}
