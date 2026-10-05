import { NextRequest, NextResponse } from "next/server"
import { createHash, timingSafeEqual } from "crypto"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"

// ============================================================
// r40：WorkNode 凭证认证共享模块（主控侧 API 专用）
//
// 抽取自 heartbeat 路由（r29/r36）—— r40 打印机池新增 3 个客户端通道
// API（打印机注册 / 任务状态回报 / 文件下载），统一凭证语义：
//   Header: x-node-uuid + x-node-key
//   · UUID/Key 格式预校验（防畸形探测）
//   · 节点存在性 / EVICTED / enabled 三态
//   · SHA-256(nodeKey) 与 apiKeyHash timingSafeEqual 对账（防时序侧信道）
//   · 认证失败审计（WORKNODE_AUTH_FAIL + DANGER）
// ============================================================

export interface WorkNodeAuthResult {
  ok: boolean
  resp?: NextResponse
  node?: {
    id: string
    nodeUuid: string
    name: string
    status: string
    enabled: boolean
  }
}

export async function verifyWorkNodeAuth(
  req: NextRequest,
  via: string,
): Promise<WorkNodeAuthResult> {
  const nodeUuid = req.headers.get("x-node-uuid") || ""
  const nodeKey = req.headers.get("x-node-key") || ""
  if (!/^wn-[a-f0-9]{16}$/.test(nodeUuid) || !/^wak-[a-f0-9]{48}$/.test(nodeKey)) {
    return { ok: false, resp: NextResponse.json({ code: 40001, msg: "节点凭证格式非法" }, { status: 400 }) }
  }

  const node = await db.workNode.findUnique({ where: { nodeUuid } })
  if (!node) return { ok: false, resp: NextResponse.json({ code: 40400, msg: "节点不存在（已在主控删除）" }, { status: 404 }) }
  if (node.status === "EVICTED") {
    return { ok: false, resp: NextResponse.json({ code: 40300, msg: "该节点已被驱逐（密钥已失效），请部署新节点" }, { status: 403 }) }
  }
  if (!node.enabled) {
    return { ok: false, resp: NextResponse.json({ code: 40300, msg: "该节点已被禁用" }, { status: 403 }) }
  }

  const expect = Buffer.from(node.apiKeyHash, "hex")
  const got = Buffer.from(createHash("sha256").update(nodeKey).digest("hex"), "hex")
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
    await writeAudit({
      operationType: "WORKNODE_AUTH_FAIL", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
      after: { nodeUuid, via, ts: new Date().toISOString() },
      severity: "DANGER",
    }).catch(() => null)
    return { ok: false, resp: NextResponse.json({ code: 40300, msg: "API Key 校验失败" }, { status: 403 }) }
  }

  return { ok: true, node: { id: node.id, nodeUuid: node.nodeUuid, name: node.name, status: node.status, enabled: node.enabled } }
}
