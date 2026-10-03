import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { authenticateApiToken, TOKEN_PERM } from "@/lib/api-token-auth"
import { rateLimit } from "@/lib/rate-limit"

// ============================================================
// OpenAPI VNC 会话录像网关（r27 第三方对接 / SIEM 取证流）
//   GET /api/openapi/recordings?op=list&id=<recId>            查询录像列表 / 单条详情
// 鉴权：x-api-key（READ）；企业录像文件本体不走 OpenAPI（仅元数据）——
// 文件级回放/下载在管理后台完成（RBAC + 签名票据 + 审计链）。
// ============================================================

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const auth = await authenticateApiToken(req, TOKEN_PERM.READ, "recordings")
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

  if (!rateLimit(`openapiRec:${auth.ctx!.userId}`, 120, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "调用过于频繁", data: null, traceId }, { status: 429 })
  }

  const sp = req.nextUrl.searchParams
  const op = sp.get("op") || "list"

  try {
    if (op === "list") {
      const keyword = sp.get("keyword") || ""
      const status = sp.get("status") || ""
      const take = Math.min(200, Math.max(1, Number(sp.get("take") || 50)))
      const recordings = await db.vncRecording.findMany({
        where: {
          deletedAt: null,
          ...(status ? { status } : {}),
          ...(keyword ? { OR: [{ workspaceName: { contains: keyword } }, { username: { contains: keyword } }, { sessionId: { contains: keyword } }] } : {}),
        },
        orderBy: { startedAt: "desc" },
        take,
        select: {
          id: true, workspaceName: true, workspaceUuid: true, username: true, sessionId: true,
          segmentIndex: true, status: true, trigger: true, startedAt: true, endedAt: true,
          durationSec: true, sizeBytes: true, resolution: true, fps: true, policySource: true,
          note: true, viewCount: true, downloadCount: true,
        },
      })
      return NextResponse.json({ code: 0, msg: "ok", data: { recordings }, traceId })
    }
    if (op === "get") {
      const id = sp.get("id") || ""
      const rec = await db.vncRecording.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true, workspaceId: true, workspaceName: true, workspaceUuid: true, userId: true, username: true,
          sessionId: true, segmentIndex: true, status: true, trigger: true, startedAt: true, endedAt: true,
          durationSec: true, sizeBytes: true, resolution: true, fps: true, policySource: true,
          note: true, viewCount: true, lastViewedAt: true, downloadCount: true, lastDownloadAt: true, createdAt: true,
        },
      })
      if (!rec) return NextResponse.json({ code: 40402, msg: "录像不存在", data: null, traceId }, { status: 404 })
      return NextResponse.json({ code: 0, msg: "ok", data: rec, traceId })
    }
    return NextResponse.json({ code: 40001, msg: "未知 op（支持 list / get）", data: null, traceId }, { status: 400 })
  } catch (e) {
    console.error(`[openapi-recordings] ${traceId}`, e)
    return NextResponse.json({ code: 50000, msg: "服务内部错误", data: null, traceId }, { status: 500 })
  }
}
