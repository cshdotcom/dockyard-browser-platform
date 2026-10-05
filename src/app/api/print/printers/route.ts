import { NextRequest, NextResponse } from "next/server"
import { getAuthContext } from "@/lib/permissions"
import { isPermissionLocked } from "@/lib/permissions"
import { db } from "@/lib/db"
import { poolEnabled } from "@/lib/print-pool"

// ============================================================
// r40：用户侧远程打印机池列表
// GET /api/print/printers
//   · 门禁：printing.poolEnabled + blockRemotePrintPool 权限锁
//   · 仅返回 ONLINE 打印机且所属节点 ONLINE（可直接派发）
//   · 附带节点信息（客户端名/版本）与能力（纸张/双面/彩色）
// ============================================================

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })

  if (!(await poolEnabled())) {
    return NextResponse.json({ code: 40300, msg: "管理员已停用远程打印机池" }, { status: 403 })
  }
  if (await isPermissionLocked(ctx.userId, "blockRemotePrintPool")) {
    return NextResponse.json({ code: 40300, msg: "管理员已禁止你使用远程打印机池（权限锁）" }, { status: 403 })
  }

  // ONLINE 打印机 + 节点过滤（节点必须在线；一次查询避免 N+1）
  const printers = await db.remotePrinter.findMany({
    where: { status: "ONLINE" },
    orderBy: [{ nodeUuid: "asc" }, { name: "asc" }],
    take: 200,
  })
  const nodes = await db.workNode.findMany({
    where: { nodeUuid: { in: [...new Set(printers.map((p) => p.nodeUuid))] } },
    select: { nodeUuid: true, name: true, status: true, enabled: true, version: true, hostname: true },
  })
  const nodeByUuid = new Map(nodes.map((n) => [n.nodeUuid, n]))

  const available = printers
    .filter((p) => {
      const n = nodeByUuid.get(p.nodeUuid)
      return n && n.enabled && n.status === "ONLINE"
    })
    .map((p) => {
      const n = nodeByUuid.get(p.nodeUuid)!
      let capabilities: Record<string, unknown> = {}
      try { capabilities = JSON.parse(p.capabilitiesJson || "{}") } catch { /* 容错 */ }
      return {
        id: p.id, name: p.name, description: p.description,
        location: p.location, capabilities,
        client: { name: n.name, hostname: p.clientName || n.hostname, version: n.version },
      }
    })

  return NextResponse.json({
    code: 0, msg: "ok",
    data: {
      printers: available,
      total: printers.length,
      available: available.length,
    },
  })
}
