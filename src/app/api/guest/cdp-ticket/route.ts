import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { db } from "@/lib/db"
import { getConfig, getConfigNumber, getConfigBool } from "@/lib/config"
import { rateLimit } from "@/lib/rate-limit"
import { verifyPassword } from "@/lib/crypto"
import { writeAudit } from "@/lib/audit"
import { extractClientIp } from "@/lib/client-ip"

// ============================================================
// r37：访客 CDP 票据签发（免登录拿外网 CDP 连接地址 —— 短票据形态）
//
// POST /api/guest/cdp-ticket { token, password? }
//   · 仅 link.guestCdp && permission=OPERATE 的链接可用（读写级）
//   · 密码校验 + IP 限速 6/min + 恒定失败语义
//   · 返回 ws(s)://<cdp.publicGatewayHost>[:port]/t/<HMAC票据>
//     （单次防重放 + 建连窗口 cdp.ticketWindowSec；时长上限走访客配置）
//   · 与持久票据 /p/<tid> 互补：访客场景用短票据（页面取票 → 工具建连）
// ============================================================

export const dynamic = "force-dynamic"

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function POST(req: NextRequest) {
  const ip = extractClientIp((n) => req.headers.get(n), req.headers.get("x-real-ip") || undefined)
  if (!rateLimit(`guestCdp:${ip}`, 6, 60_000).allowed) {
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
  if (!link) return fail("分享链接不存在", 404, 40400)
  if (link.revokedAt) return fail("该分享链接已被撤销")
  if (link.expireAt && link.expireAt.getTime() < Date.now()) return fail("该分享链接已过期")

  if (!link.guestCdp || link.permission !== "OPERATE") {
    return fail("该链接未开放访客 CDP 接入（需 OPERATE 级且显式开启）")
  }

  if (link.passwordHash) {
    const pw = (body.password || "").trim()
    if (!pw) return fail("该链接设置了访问密码", 401, 40100)
    const ok = await verifyPassword(pw, link.passwordHash).catch(() => false)
    if (!ok) {
      await writeAudit({
        operationType: "GUEST_CDP_ACCESS", resourceType: "WORKSPACE", resourceId: link.workspaceId,
        after: { ok: false, reason: "password mismatch", ip }, severity: "WARN",
      }).catch(() => null)
      return fail("访问密码不正确", 401, 40101)
    }
  }

  const ws = await db.browserWorkspace.findFirst({ where: { id: link.workspaceId, deletedAt: null } })
  if (!ws || ws.deletedAt) return fail("链接指向的工作区已不存在", 404, 40400)
  if (ws.shareDisabled) return fail("该工作区已被管理员禁止共享，链接已失效")
  if (ws.status !== "RUNNING" || !ws.cdpUrl) return fail("沙箱 CDP 端点未就绪（请先启动工作区）", 409, 40900)

  // 发起人访客链（收紧即拒）
  {
    const { resolveGuestShareControl } = await import("@/lib/share-policy")
    const creatorId = link.createdByUserId || ws.userId
    if (creatorId) {
      const ctl = await resolveGuestShareControl({ userId: creatorId, workspaceId: ws.id, role: "USER" })
      if (!ctl.allowed) return fail(`访客访问已被管理员限制：${ctl.reason}`)
    }
  }

  const publicHost = await getConfig("cdp.publicGatewayHost", "")
  const gatewayPort = await getConfigNumber("cdp.gatewayPort", 3006)
  const useTls = await getConfigBool("cdp.gatewayTls", false)
  const windowSec = await getConfigNumber("cdp.ticketWindowSec", 300)
  const { getConfigNumber: gcn } = await import("@/lib/config")
  const guestMaxMin = await gcn("share.guestMaxSessionMinutes", 120)
  const durSec = guestMaxMin > 0 ? guestMaxMin * 60 : 0

  if (!publicHost) return fail("管理员尚未配置 CDP 公网网关", 503, 50301)

  const payload = {
    v: ws.id, u: `guest:${token.slice(0, 8)}`, tgt: ws.cdpUrl,
    exp: Math.floor(Date.now() / 1000) + windowSec,
    dur: durSec, n: crypto.randomBytes(12).toString("hex"),
  }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
  const secret = process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"
  const sig = b64url(crypto.createHmac("sha256", secret).update(payloadB64).digest())
  const ticket = `${payloadB64}.${sig}`
  const scheme = useTls ? "wss" : "ws"
  const gatewayUrl = `${scheme}://${publicHost}${gatewayPort !== 80 && gatewayPort !== 443 ? `:${gatewayPort}` : ""}/t/${ticket}`

  await db.workspaceShareLink.update({
    where: { id: link.id },
    data: { guestUseCount: { increment: 1 }, lastGuestAt: new Date(), lastGuestIp: ip },
  }).catch(() => null)
  await writeAudit({
    operationType: "GUEST_CDP_ACCESS", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
    ownerUserId: ws.userId,
    after: { ok: true, linkId: link.id, ip, gatewayUrl: `…/t/${ticket.slice(0, 12)}…` },
    severity: "WARN",
  }).catch(() => null)

  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: {
      gatewayUrl,
      windowSec,
      durationSec: durSec,
      workspaceName: ws.name,
      note: `外网地址含签名票据（${windowSec}s 内有效、单次使用）；请在有效期内在自动化工具中使用`,
    },
  })
}
