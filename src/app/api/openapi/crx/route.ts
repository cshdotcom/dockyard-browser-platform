import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { authenticateApiToken, TOKEN_PERM } from "@/lib/api-token-auth"
import { rateLimit } from "@/lib/rate-limit"
import { getConfigBool } from "@/lib/config"
import {
  saveCrxPluginAction, toggleCrxPluginAction, recycleCrxPluginAction, restoreCrxPluginAction,
  saveCrxPolicyEntryAction, removeCrxPolicyEntryAction, saveCrxBlocklistAction, removeCrxBlocklistAction,
  retryCrxInstallAction, createCrxGrayTaskAction,
} from "@/server/actions/crx"

// ============================================================
// OpenAPI CRX 插件管理网关（第三方对接）
//   GET  /api/openapi/crx?op=library|status|refs|blocklist|gray        查询
//   POST /api/openapi/crx       body: { op: "...", ... }              操作
// 覆盖：插件库 CRUD / 沙箱插件状态 / 单插件源改写 / 手动重试 / 黑名单 / 引用关系 / 灰度
// 鉴权：x-api-key（READ 查询 / WRITE 写入 / ADMIN 灰度与回收站）；全部写不可篡改审计
// ============================================================

const OPS = ["library", "plugin-get", "status", "status-workspace", "refs", "blocklist", "gray"] as const
const POST_OPS = [
  "plugin-create", "plugin-update", "plugin-toggle", "plugin-recycle", "plugin-restore",
  "policy-entry-save", "policy-entry-remove", "blocklist-save", "blocklist-remove",
  "install-retry", "gray-create", "sandbox-settings",
] as const

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const auth = await authenticateApiToken(req, TOKEN_PERM.READ)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

  if (!rateLimit(`openapiCrx:${auth.ctx!.userId}`, 120, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "调用过于频繁", data: null, traceId }, { status: 429 })
  }

  const sp = req.nextUrl.searchParams
  const op = sp.get("op") || "library"

  try {
    if (op === "library") {
      const includeDeleted = sp.get("includeDeleted") === "true"
      const plugins = await db.crxPlugin.findMany({
        where: includeDeleted ? {} : { deletedAt: null },
        select: { crxId: true, name: true, zhNote: true, tags: true, permissions: true, updateUrl: true, backupUpdateUrl: true, lockedVersion: true, allowIncognito: true, allowUserDisable: true, highRisk: true, highRiskReason: true, enabled: true, updatedAt: true },
        take: 200,
      })
      return NextResponse.json({ code: 0, msg: "ok", data: { plugins }, traceId })
    }
    if (op === "plugin-get") {
      const crxId = sp.get("crxId") || ""
      const plugin = await db.crxPlugin.findUnique({ where: { crxId } })
      if (!plugin) return NextResponse.json({ code: 40401, msg: "插件不存在", data: null, traceId }, { status: 404 })
      return NextResponse.json({ code: 0, msg: "ok", data: { plugin }, traceId })
    }
    if (op === "status") {
      const state = sp.get("state") || undefined
      const rows = await db.crxInstallStatus.findMany({ where: state ? { state } : {}, orderBy: { updatedAt: "desc" }, take: 200 })
      return NextResponse.json({ code: 0, msg: "ok", data: { statuses: rows }, traceId })
    }
    if (op === "status-workspace") {
      const workspaceId = sp.get("workspaceId") || ""
      const rows = await db.crxInstallStatus.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" } })
      return NextResponse.json({ code: 0, msg: "ok", data: { statuses: rows }, traceId })
    }
    if (op === "refs") {
      const crxId = sp.get("crxId") || ""
      const [entries, gray] = await Promise.all([
        db.crxPolicyEntry.findMany({ where: { crxId, deletedAt: null } }),
        db.crxGrayTask.findMany({ where: { status: { in: ["PENDING", "ROLLING"] } } }),
      ])
      return NextResponse.json({ code: 0, msg: "ok", data: { references: entries, runningGrayTasks: gray.length }, traceId })
    }
    if (op === "blocklist") {
      const rows = await db.crxBlocklistEntry.findMany({ take: 200 })
      return NextResponse.json({ code: 0, msg: "ok", data: { blocklist: rows }, traceId })
    }
    if (op === "gray") {
      const rows = await db.crxGrayTask.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
      return NextResponse.json({ code: 0, msg: "ok", data: { grayTasks: rows }, traceId })
    }
    return NextResponse.json({ code: 40001, msg: `未知 op：${op}（可用：${OPS.join(" / ")}）`, data: null, traceId })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: e instanceof Error ? e.message : "查询失败", data: null, traceId }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const auth = await authenticateApiToken(req, TOKEN_PERM.WRITE)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })

  const mcpEnabled = await getConfigBool("mcp.enabled", true)
  if (!mcpEnabled) return NextResponse.json({ code: 40300, msg: "OpenAPI 网关已被管理员关闭", data: null, traceId }, { status: 403 })
  if (!rateLimit(`openapiCrxPost:${auth.ctx!.userId}`, 60, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "调用过于频繁", data: null, traceId }, { status: 429 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = String(body.op || "")

  // 灰度创建需 ADMIN 权限
  if (op === "gray-create") {
    const adminAuth = await authenticateApiToken(req, TOKEN_PERM.ADMIN)
    if (!adminAuth.ok) return NextResponse.json(adminAuth.body, { status: adminAuth.status })
  }

  try {
    let result: { code: number; msg?: string; data?: unknown }
    switch (op) {
      case "plugin-create":
      case "plugin-update":
        result = await saveCrxPluginAction(body)
        break
      case "plugin-toggle":
        result = await toggleCrxPluginAction(body)
        break
      case "plugin-recycle":
        result = await recycleCrxPluginAction(body)
        break
      case "plugin-restore":
        result = await restoreCrxPluginAction(body)
        break
      case "policy-entry-save":
        result = await saveCrxPolicyEntryAction(body)
        break
      case "policy-entry-remove":
        result = await removeCrxPolicyEntryAction(body)
        break
      case "blocklist-save":
        result = await saveCrxBlocklistAction(body)
        break
      case "blocklist-remove":
        result = await removeCrxBlocklistAction(body)
        break
      case "install-retry":
        result = await retryCrxInstallAction(body)
        break
      case "gray-create":
        result = await createCrxGrayTaskAction(body)
        break
      case "sandbox-settings":
        result = await (await import("@/server/actions/crx")).setSandboxCrxSettingsAction(body)
        break
      default:
        return NextResponse.json({ code: 40001, msg: `未知 op：${op}（可用：${POST_OPS.join(" / ")}）`, data: null, traceId })
    }
    return NextResponse.json({ ...result, traceId })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: e instanceof Error ? e.message : "操作失败", data: null, traceId }, { status: 500 })
  }
}
