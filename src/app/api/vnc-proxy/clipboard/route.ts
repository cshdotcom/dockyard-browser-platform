import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { writeAudit } from "@/lib/audit"
import { touchSimNovncInput } from "@/lib/external/novnc"

// VNC 剪贴板代理通道：前端剪贴板 → NextJS后端代理 → NoVNC远程桌面
// 中文/全角/特殊符号完整支持；UTF-8 校验过滤控制字符；双向受管理员全局开关管控
export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId })

  const body = await req.json().catch(() => ({})) as { workspaceId?: string; text?: string }
  if (!body.workspaceId || typeof body.text !== "string") {
    return NextResponse.json({ code: 40001, msg: "参数错误", traceId })
  }

  const ws = await db.browserWorkspace.findFirst({ where: { id: body.workspaceId, deletedAt: null } })
  if (!ws || ws.mode !== "novnc_full") {
    return NextResponse.json({ code: 40400, msg: "NoVNC 会话不存在", traceId })
  }
  // r24-h：离线冻结封存期间剪贴板中转禁用
  if (ws.status === "FROZEN") {
    return NextResponse.json({ code: 40300, msg: "工作区已被管理员离线冻结封存，冻结期间剪贴板通道关闭", traceId })
  }
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  const share = await db.workspaceShare.findFirst({
    where: { workspaceId: ws.id, targetUserId: ctx.userId, permission: "OPERATE", revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
  })
  if (ws.userId !== ctx.userId && !isAdmin && !share) {
    return NextResponse.json({ code: 40300, msg: "无权操作该会话", traceId })
  }

  // 管理员全局剪贴板开关：关闭时禁止前端 → 远程桌面投递（仅允许出向）
  const clipboardGlobal = await getConfigBool("workspace.clipboardGlobal", true)
  if (!clipboardGlobal) {
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "VNC_CLIPBOARD_BLOCKED",
      resourceType: "WORKSPACE", resourceId: ws.id, severity: "WARN",
      after: { reason: "全局双向剪贴板已关闭" },
    })
    return NextResponse.json({ code: 40300, msg: "管理员已关闭双向剪贴板：仅允许远程桌面内容向外输出", traceId })
  }

  // 字数限制（防超大剪贴板卡死会话）
  const maxChars = await getConfigNumber("workspace.clipboardMaxChars", 5000)
  if (body.text.length > maxChars) {
    return NextResponse.json({ code: 40001, msg: `剪贴板内容超过上限 ${maxChars} 字符`, traceId })
  }

  // UTF-8 控制字符过滤
  const cleaned = body.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")

  // r34：真实写入沙箱 X 剪贴板（此前为模拟投递 —— 用户报障“什么都没传回来”根因）
  //   内嵌沙箱：同容器 xclip（沙箱专用用户 + 独立 X 显示）；外部容器：docker exec xclip
  //   回写 lastActiveAt：剪贴板操作属于活跃信号（防闲置回收误杀）
  const { setSandboxClipboard } = await import("@/lib/sandbox-clipboard")
  const r = await setSandboxClipboard(body.workspaceId, cleaned).catch((e: unknown) => ({
    ok: false, channel: "unavailable" as const, reason: e instanceof Error ? e.message : String(e),
  }))
  if (ws.novncSessionId) touchSimNovncInput(ws.novncSessionId)
  void db.browserWorkspace.update({ where: { id: ws.id }, data: { lastActiveAt: new Date() } }).catch(() => {})

  // 审计：记录剪贴板操作标记（不存储剪贴板明文内容）
  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username, operationType: r.ok ? "VNC_CLIPBOARD_PUSH" : "VNC_CLIPBOARD_BLOCKED",
    resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
    after: { chars: cleaned.length, direction: "client→desktop", channel: r.channel, ok: r.ok, reason: r.reason || null },
  })

  if (!r.ok) {
    return NextResponse.json({ code: 50000, msg: `剪贴板投递失败：${r.reason || "沙箱剪贴板通道不可用"}`, traceId })
  }
  return NextResponse.json({ code: 0, msg: "剪贴板已投递到沙箱（可直接 Ctrl+V 粘贴）", data: { chars: cleaned.length, channel: r.channel }, traceId })
}

// 远程桌面 → 本地（拉取）
export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await getAuthContext()
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId })
  const wid = req.nextUrl.searchParams.get("workspaceId")
  if (!wid) return NextResponse.json({ code: 40001, msg: "参数错误", traceId })
  const ws = await db.browserWorkspace.findFirst({ where: { id: wid, deletedAt: null } })
  if (!ws) return NextResponse.json({ code: 40400, msg: "会话不存在", traceId })

  // 归属校验（拉取需所有者/OPERATE 共享/管理员）
  const isAdminPull = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  if (ws.userId !== ctx.userId && !isAdminPull) {
    const share = await db.workspaceShare.findFirst({
      where: { workspaceId: ws.id, targetUserId: ctx.userId, permission: "OPERATE", revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
    })
    if (!share) return NextResponse.json({ code: 40300, msg: "无权拉取该沙箱剪贴板", traceId })
  }

  // r34：真实读取沙箱 X 剪贴板（xclip -selection clipboard -out，回退 primary）
  const { getSandboxClipboard } = await import("@/lib/sandbox-clipboard")
  const r = await getSandboxClipboard(wid).catch((e: unknown) => ({
    text: null, channel: "unavailable", reason: e instanceof Error ? e.message : String(e),
  }))

  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "VNC_CLIPBOARD_PULL",
    resourceType: "WORKSPACE", resourceId: ws.id,
    after: { direction: "desktop→client", channel: r.channel, chars: r.text?.length || 0 },
  })
  return NextResponse.json({ code: 0, msg: "ok", data: { text: r.text ?? "", channel: r.channel, reason: r.reason || null }, traceId })
}
