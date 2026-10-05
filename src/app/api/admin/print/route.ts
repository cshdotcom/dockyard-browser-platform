import { NextRequest, NextResponse } from "next/server"
import { getAuthContext } from "@/lib/permissions"
import {
  printAdminMonitorAction, printAdminPrinterOpAction, printAdminJobOpAction,
} from "@/server/actions/print-admin"

// ============================================================
// r40：打印机池管理 HTTP API（管理员；与 server action 同核心，供
// 程序化运维/QA/外部管理调用 —— action 协议无需 Next 客户端运行时）
//
// GET  /api/admin/print                —— 监控总览（统计/打印机池/任务/审计流）
// POST /api/admin/print { op }：
//   op=job.retry    { id }   —— 失败/超时任务重派（新令牌 + 指令重新入队）
//   op=job.cancel   { id }   —— 强制取消（含 DELIVERED 中）
//   op=job.cleanFile{ id }   —— 立即清磁盘 PDF
//   op=printer.disable/enable/delete { id }
//   op=printer.setLocation { id, location }
// 门禁：管理员登录 + 2FA 合规（requireAdmin 链）
// ============================================================

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
  if (ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
    return NextResponse.json({ code: 40300, msg: "需要管理员权限" }, { status: 403 })
  }
  const res = await printAdminMonitorAction({})
  return NextResponse.json(res, { status: res.code === 0 ? 200 : 400 })
}

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
  if (ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
    return NextResponse.json({ code: 40300, msg: "需要管理员权限" }, { status: 403 })
  }

  const body = await req.json().catch(() => null) as { op?: string; id?: string; location?: string } | null
  const op = body?.op || ""
  const id = (body?.id || "").trim()
  if (!id) return NextResponse.json({ code: 40000, msg: "缺少 id" }, { status: 400 })

  let res
  if (op === "job.retry") res = await printAdminJobOpAction({ id, op: "retry" })
  else if (op === "job.cancel") res = await printAdminJobOpAction({ id, op: "cancel" })
  else if (op === "job.cleanFile") res = await printAdminJobOpAction({ id, op: "cleanFile" })
  else if (op === "printer.disable") res = await printAdminPrinterOpAction({ id, op: "disable" })
  else if (op === "printer.enable") res = await printAdminPrinterOpAction({ id, op: "enable" })
  else if (op === "printer.delete") res = await printAdminPrinterOpAction({ id, op: "delete" })
  else if (op === "printer.setLocation") res = await printAdminPrinterOpAction({ id, op: "setLocation", location: body?.location || "" })
  else return NextResponse.json({ code: 40000, msg: `未知操作 op=${op}（job.retry/job.cancel/job.cleanFile/printer.disable/enable/delete/setLocation）` }, { status: 400 })

  return NextResponse.json(res, { status: res.code === 0 ? 200 : 400 })
}
