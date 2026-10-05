import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { verifyWorkNodeAuth } from "@/lib/worknode-auth"
import { readPrintJobFile, verifyPrintDownloadToken } from "@/lib/print-pool"

// ============================================================
// r40：打印文件下载（客户端 ← 主控；任务交付通道）
// GET /api/master/print/file/<jobId>?t=<token>&e=<exp>
//   Header: x-node-uuid + x-node-key（凭证因子）+ t/e（HMAC 一次性令牌因子）
//   · 令牌 = HMAC-SHA256(authSecret, print:jobId:nodeUuid:exp) 截 40 hex，
//     派发指令 payload 内签发（10 分钟有效）—— 双因子：凭证被盗但无令牌不可下载
//   · 任务必须属于该节点；PENDING/SENT/DELIVERED 可下载（失败重试场景）
//   · 下载成功 → PENDING/SENT 晋级 SENT（客户端已开始处理）+ sentAt
//   · 响应带 X-File-Sha256（客户端完整性校验）+ application/pdf 流
//   · CANCELED/TIMED_OUT/PRINTED 终态 → 拒绝（迟到领取防护）
// ============================================================

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  const auth = await verifyWorkNodeAuth(req, "print-file")
  if (!auth.ok) return auth.resp!
  const node = auth.node!

  const t = req.nextUrl.searchParams.get("t") || ""
  const eRaw = req.nextUrl.searchParams.get("e") || ""
  const e = Number(eRaw)
  if (!verifyPrintDownloadToken(jobId, node.nodeUuid, t, e)) {
    return NextResponse.json({ code: 40300, msg: "下载令牌无效或已过期（一次性 HMAC 令牌，10 分钟有效）" }, { status: 403 })
  }

  const job = await db.printJob.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ code: 40400, msg: "打印任务不存在" }, { status: 404 })
  if (job.nodeUuid !== node.nodeUuid) {
    return NextResponse.json({ code: 40300, msg: "任务不属于该节点" }, { status: 403 })
  }
  if (["CANCELED", "TIMED_OUT", "PRINTED", "FAILED"].includes(job.status)) {
    return NextResponse.json({ code: 40900, msg: `任务已${job.status === "CANCELED" ? "取消" : job.status === "TIMED_OUT" ? "超时收口" : "完结"}，文件不再可下载` }, { status: 409 })
  }

  const buf = readPrintJobFile(jobId)
  if (!buf) {
    return NextResponse.json({ code: 40400, msg: "打印文件已被清理（超 TTL）—— 任务将失败收口" }, { status: 404 })
  }

  // 首次领取 → SENT（客户端已开始处理；重下载幂等）
  if (job.status === "PENDING") {
    await db.printJob.update({ where: { id: job.id }, data: { status: "SENT", sentAt: new Date() } }).catch(() => null)
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${job.fileName.replace(/[^\w.\-]/g, "_")}"`,
      "X-File-Sha256": job.fileSha256,
      "X-Job-No": job.jobNo,
      "Cache-Control": "no-store",
    },
  })
}
