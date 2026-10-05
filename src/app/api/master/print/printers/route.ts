import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { verifyWorkNodeAuth } from "@/lib/worknode-auth"

// ============================================================
// r40：客户端打印机池上报（Worker/打印代理 → 主控）
// POST /api/master/print/printers   Header: x-node-uuid + x-node-key
// Body: { clientName?, printers: [{ key, name, description?, capabilities? }] }
//   · 全量同步语义：本次未出现的该节点打印机 → OFFLINE（拔线/改名检测）
//   · upsert（nodeUuid+printerKey 唯一）：新增/刷新 name/能力/lastSeenAt
//   · OFFLINE→ONLINE 自动复活；DISABLED 状态保持（管理员禁用不被上报覆盖）
//   · 双端防伪造（凭证 + printerKey 白名单字符）
// ============================================================

export const dynamic = "force-dynamic"

const schema = z.object({
  clientName: z.string().max(120).optional(),
  printers: z.array(z.object({
    key: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.\- ]+$/, "printerKey 含非法字符"),
    name: z.string().min(1).max(160),
    description: z.string().max(300).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })).max(64),
})

export async function POST(req: NextRequest) {
  const auth = await verifyWorkNodeAuth(req, "print-printers")
  if (!auth.ok) return auth.resp!
  const node = auth.node!

  const body = await req.json().catch(() => null)
  const p = schema.safeParse(body)
  if (!p.success) {
    return NextResponse.json({ code: 40001, msg: `打印机上报格式非法：${p.error.issues[0]?.message || ""}` }, { status: 400 })
  }

  const now = new Date()
  const clientName = (p.data.clientName || "").slice(0, 120)
  const reportedKeys = new Set(p.data.printers.map((x) => x.key))

  // 1) upsert 当前列表
  let upserted = 0
  for (const pr of p.data.printers) {
    const caps = pr.capabilities ? JSON.stringify(pr.capabilities).slice(0, 4000) : "{}"
    const existing = await db.remotePrinter.findUnique({
      where: { nodeUuid_printerKey: { nodeUuid: node.nodeUuid, printerKey: pr.key } },
    })
    if (existing) {
      await db.remotePrinter.update({
        where: { id: existing.id },
        data: {
          name: pr.name,
          description: pr.description || "",
          capabilitiesJson: caps,
          clientName,
          lastSeenAt: now,
          // DISABLED=管理员禁用，上报不覆盖；其余状态复活为 ONLINE
          status: existing.status === "DISABLED" ? "DISABLED" : "ONLINE",
        },
      })
    } else {
      await db.remotePrinter.create({
        data: {
          nodeUuid: node.nodeUuid, printerKey: pr.key, name: pr.name,
          description: pr.description || "", capabilitiesJson: caps,
          clientName, status: "ONLINE", lastSeenAt: now,
        },
      })
      upserted++
    }
  }

  // 2) 本次未出现的该节点在册打印机 → OFFLINE（重启前拔线/共享断开检测）
  const nodePrinters = await db.remotePrinter.findMany({ where: { nodeUuid: node.nodeUuid } })
  let offlined = 0
  for (const rp of nodePrinters) {
    if (reportedKeys.has(rp.printerKey)) continue
    if (rp.status === "OFFLINE" || rp.status === "DISABLED") continue
    await db.remotePrinter.update({ where: { id: rp.id }, data: { status: "OFFLINE", lastSeenAt: now } })
    offlined++
  }

  // 3) 节点顺带活跃（打印机上报≈节点心跳语义之一）
  await db.workNode.update({
    where: { id: node.id },
    data: { lastHeartbeatAt: now, ...(clientName ? { hostname: clientName } : {}) },
  }).catch(() => null)

  if (upserted > 0 || offlined > 0) {
    await writeAudit({
      operatorName: `worker:${node.name}`,
      operationType: "PRINT_POOL", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
      after: { phase: "printers-sync", total: p.data.printers.length, upserted, offlined },
    }).catch(() => null)
  }

  return NextResponse.json({
    code: 0, msg: "ok",
    data: { synced: p.data.printers.length, upserted, offlined, ackIntervalSec: 60 },
  })
}
