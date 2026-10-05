import { NextRequest, NextResponse } from "next/server"
import { getAuthContext } from "@/lib/permissions"
import { executeBrowserAction } from "@/lib/external/cdp-control"
import { getConfigBool } from "@/lib/config"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"

// ============================================================
// r37：远程打印（沙箱页面 → 客户端本地打印机）
//
// POST /api/vnc-proxy/print { workspaceId, landscape?, paperWidth?, paperHeight?, scale?, printBackground? }
//   · 服务端经 CDP Page.printToPDF 渲染当前页面 → PDF 流回传
//   · 客户端收到 PDF → 隐藏 iframe 打印 → 用户选择本地/网络打印机
//   · 双模式可用（cdp_light / novnc_full —— VNC 会话经 r36 修复后同样有真实 CDP 端点）
//   · 门禁：feature.remotePrint 全局开关 + blockRemotePrint 权限锁 + 用户/管理员/OPERATE 共享
//   · 限速 12 次/分钟/用户；审计 REMOTE_PRINT
// ============================================================

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })

  let body: {
    workspaceId?: string
    landscape?: boolean
    printBackground?: boolean
    paperWidth?: number
    paperHeight?: number
    scale?: number
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ code: 40000, msg: "bad json" }, { status: 400 })
  }
  const workspaceId = (body.workspaceId || "").trim()
  if (!workspaceId) return NextResponse.json({ code: 40000, msg: "缺少 workspaceId" }, { status: 400 })

  // 全局开关 + 权限锁
  if (!(await getConfigBool("feature.remotePrint", true))) {
    return NextResponse.json({ code: 40300, msg: "管理员已停用远程打印功能" }, { status: 403 })
  }
  const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { permissionLocks: true } })
  const locks = (user?.permissionLocks as Record<string, boolean>) || {}
  if (locks.blockRemotePrint === true) {
    return NextResponse.json({ code: 40300, msg: "管理员已禁止你使用远程打印（权限锁）" }, { status: 403 })
  }
  if (!rateLimit(`remotePrint:${ctx.userId}`, 12, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "打印请求过于频繁，请稍后再试" }, { status: 429 })
  }

  try {
    const result = await executeBrowserAction({
      action: "print_pdf",
      workspaceIdOrUuid: workspaceId,
      ctx: { userId: ctx.userId, username: ctx.username, isAdmin: ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN", via: "INTERNAL" },
      params: {
        landscape: !!body.landscape,
        printBackground: body.printBackground !== false,
        paperWidth: body.paperWidth,
        paperHeight: body.paperHeight,
        scale: body.scale,
      },
      allowNovnc: true,
    })
    const data = (result.data as { dataBase64: string; bytes: number; simulated: boolean }) || null
    if (!data?.dataBase64) {
      return NextResponse.json({ code: 50000, msg: "打印渲染失败（页面可能无可打印内容）" }, { status: 500 })
    }
    const buf = Buffer.from(data.dataBase64, "base64")
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "REMOTE_PRINT", resourceType: "WORKSPACE", resourceId: result.workspaceId, resourceName: result.workspaceName,
      ownerUserId: null,
      after: { bytes: buf.length, mode: result.mode, landscape: !!body.landscape },
    }).catch(() => null)
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="print-${Date.now()}.pdf"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: e instanceof Error ? e.message : "打印失败" }, { status: 500 })
  }
}
