import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { rateLimit } from "@/lib/rate-limit"
import { verifyPassword } from "@/lib/crypto"
import { writeAudit } from "@/lib/audit"
import { extractClientIp } from "@/lib/client-ip"
import { novncDialTarget } from "@/lib/external/novnc"

// ============================================================
// r37：访客 VNC 票据签发（免登录访问分享链接）
//
// POST /api/guest/vnc-ticket { token, password? }
//   · 校验链：链接存在/未撤销/未过期/次数 → 访客开关 → 密码 → 沙箱否决
//     → 发起人访客四级链（链接创建后策略收紧即拒） → 会话运行中
//   · 只读语义：permission=VIEW 或 全局只读 → ro=1（服务端强制，客户端无法伪造）
//   · IP 限速 6 次/分钟（防爆破密码）+ 密码恒定失败语义
//   · 审计：GUEST_VNC_ACCESS（含来源 IP；guestUseCount 独立计数）
// ============================================================

export const dynamic = "force-dynamic"

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function POST(req: NextRequest) {
  const ip = extractClientIp((n) => req.headers.get(n), req.headers.get("x-real-ip") || undefined)
  if (!rateLimit(`guestVnc:${ip}`, 6, 60_000).allowed) {
    return NextResponse.json({ code: 42901, msg: "尝试过于频繁，请稍后再试" }, { status: 429 })
  }
  let body: { token?: string; password?: string }
  try {
    body = (await req.json()) as { token?: string; password?: string }
  } catch {
    return NextResponse.json({ code: 40000, msg: "bad json" }, { status: 400 })
  }
  const token = (body.token || "").trim()
  if (!/^[a-f0-9]{16,128}$/i.test(token)) {
    return NextResponse.json({ code: 40000, msg: "链接无效" }, { status: 400 })
  }
  const fail = (msg: string, status = 403, code = 40300) =>
    NextResponse.json({ code, msg }, { status })

  const link = await db.workspaceShareLink.findUnique({ where: { token } })
  if (!link) return fail("分享链接不存在（可能已失效或被撤销）", 404, 40400)
  if (link.revokedAt) return fail("该分享链接已被撤销")
  if (link.expireAt && link.expireAt.getTime() < Date.now()) return fail("该分享链接已过期")
  if (link.maxUses > 0 && link.useCount >= link.maxUses) return fail("该分享链接使用次数已达上限")

  // 密码（恒定语义：设置了 → 必须匹配）
  if (link.passwordHash) {
    const pw = (body.password || "").trim()
    if (!pw) return fail("该链接设置了访问密码", 401, 40100)
    const ok = await verifyPassword(pw, link.passwordHash).catch(() => false)
    if (!ok) {
      await writeAudit({
        operationType: "GUEST_VNC_ACCESS", resourceType: "WORKSPACE", resourceId: link.workspaceId,
        after: { ok: false, reason: "password mismatch", ip }, severity: "WARN",
      }).catch(() => null)
      return fail("访问密码不正确", 401, 40101)
    }
  }

  const ws = await db.browserWorkspace.findFirst({ where: { id: link.workspaceId, deletedAt: null } })
  if (!ws || ws.deletedAt) return fail("链接指向的工作区已不存在", 404, 40400)
  if (ws.shareDisabled) return fail("该工作区已被管理员禁止共享，链接已失效")
  if (ws.mode !== "novnc_full") return fail("该工作区不是 VNC 模式（访客远程桌面不可用）")
  if (ws.status === "FROZEN") return fail(`工作区已离线冻结封存${ws.freezeReason ? `（${ws.freezeReason}）` : ""}`)
  if (!ws.novncSessionId || (ws.status !== "RUNNING" && ws.status !== "IDLE")) return fail("远程桌面会话未运行（请稍后再试）")

  // 发起人访客四级链（链接创建后管理员收紧策略 → 旧链接立即拒接）
  if (link.guestAllowed) {
    const { resolveGuestShareControl } = await import("@/lib/share-policy")
    const creatorId = link.createdByUserId || ws.userId
    if (creatorId) {
      const ctl = await resolveGuestShareControl({ userId: creatorId, workspaceId: ws.id, role: "USER" })
      if (!ctl.allowed) return fail(`访客访问已被管理员限制：${ctl.reason}`)
    }
  } else {
    return fail("该链接未开放访客访问（需登录兑换）")
  }

  // 只读语义（服务端强制）
  const globalViewOnly = await getConfigBool("session.vncGlobalViewOnly", false)
  const readonly = link.permission !== "OPERATE" || globalViewOnly

  // 拨号目标
  const tgt = await novncDialTarget(ws.novncSessionId, ws.containerRef)
  if (!tgt) return fail("远程桌面通道暂不可用，请稍后重试", 503, 50300)

  // 访客会话时长（独立配置；默认 120 分钟）
  const guestMaxMin = await getConfigNumber("share.guestMaxSessionMinutes", 120)
  const durSec = guestMaxMin > 0 ? guestMaxMin * 60 : 0

  const expSec = 60
  const payload = {
    v: ws.id, ro: readonly ? 1 : 0, dur: durSec,
    exp: Math.floor(Date.now() / 1000) + expSec,
    n: crypto.randomBytes(16).toString("hex"), tgt,
  }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
  const sig = b64url(crypto.createHmac("sha256", ENV.vncBridgeSecret).update(payloadB64).digest())
  const ticket = `${payloadB64}.${sig}`

  // 访客计数与审计
  await db.workspaceShareLink.update({
    where: { id: link.id },
    data: { guestUseCount: { increment: 1 }, lastGuestAt: new Date(), lastGuestIp: ip, useCount: { increment: 1 }, lastUsedAt: new Date() },
  }).catch(() => null)
  await writeAudit({
    operationType: "GUEST_VNC_ACCESS", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
    ownerUserId: ws.userId,
    after: { ok: true, linkId: link.id, permission: link.permission, readonly, ip, guestUseCount: link.guestUseCount + 1 },
  }).catch(() => null)

  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: {
      ticket,
      wsUrlQuery: `vnc=${encodeURIComponent(ws.id)}&ticket=${encodeURIComponent(ticket)}`,
      bridge: { mode: ENV.vncBridgePublic, port: ENV.vncBridgePort, url: ENV.vncBridgeUrl },
      readonly,
      sessionMaxSec: durSec,
      expiresInSec: expSec,
      workspaceName: ws.name,
      permission: link.permission,
    },
  })
}
