import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { db } from "@/lib/db"
import { getConfigNumber } from "@/lib/config"

// ============================================================
// r37：CDP 网关 → 主应用 内部票据解析 API
//
// 形态：POST /api/cdp/resolve  { tid }
// 调用方：mini-services/cdp-gateway（持久票据 /p/<tid> 建连时实时校验）
// 鉴权：共享密钥头 X-Internal-Token（= CDP_GATEWAY_SECRET / VNC_BRIDGE_SECRET；
//      网关与主应用同机部署共享 env；外部无法伪造）
//
// 职责（实时生效的核心）：
//   1. 查 CdpEndpointToken：吊销（revokedAt）/ 过期（expireAt）/ 次数（maxUses）
//   2. 查工作区：RUNNING + cdpUrl 存在（重建会话后 tgt 自动跟随最新容器）
//   3. 时长上限：token 无限制语义 —— 用户策略链（vncSessionMaxMinutes 复用）
//   4. 计数：useCount+1 / lastUsedAt / lastUsedIp（调用方回传）
// 失败语义：fail-closed（主应用不可达/密钥不符/票据无效 → 网关拒绝连接）
// ============================================================

export const dynamic = "force-dynamic"

function internalSecret(): string {
  // 与 mini-services/cdp-gateway 完全一致的回退链（密钥不一致 = 网关全部票据被拒）
  return process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"
}

function tokenOk(req: NextRequest): boolean {
  const got = (req.headers.get("x-internal-token") || "").trim()
  if (!got) return false
  const expect = internalSecret()
  const a = Buffer.from(got)
  const b = Buffer.from(expect)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const traceId = req.headers.get("x-trace-id") || ""
  if (!tokenOk(req)) {
    return NextResponse.json({ ok: false, error: "forbidden: internal token mismatch" }, { status: 403 })
  }
  let body: { tid?: string; ip?: string }
  try {
    body = (await req.json()) as { tid?: string; ip?: string }
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 })
  }
  const tid = (body.tid || "").trim()
  if (!/^[a-f0-9]{32,96}$/i.test(tid)) {
    return NextResponse.json({ ok: false, error: "invalid tid format" }, { status: 400 })
  }

  const tok = await db.cdpEndpointToken.findUnique({ where: { tid } })
  if (!tok) return NextResponse.json({ ok: false, error: "token not found" }, { status: 404 })
  if (tok.revokedAt) {
    return NextResponse.json({ ok: false, error: `token revoked: ${tok.revokeReason || "已吊销"}` }, { status: 403 })
  }
  if (tok.expireAt && tok.expireAt.getTime() <= Date.now()) {
    return NextResponse.json({ ok: false, error: "token expired" }, { status: 403 })
  }
  if (tok.maxUses > 0 && tok.useCount >= tok.maxUses) {
    return NextResponse.json({ ok: false, error: "token use limit reached" }, { status: 403 })
  }

  const ws = await db.browserWorkspace.findUnique({ where: { id: tok.workspaceId } })
  if (!ws || ws.deletedAt) return NextResponse.json({ ok: false, error: "workspace gone" }, { status: 404 })
  if (ws.status === "FROZEN") {
    return NextResponse.json({ ok: false, error: `workspace frozen: ${ws.freezeReason || ""}` }, { status: 403 })
  }
  if (ws.status !== "RUNNING" || !ws.cdpUrl) {
    return NextResponse.json({ ok: false, error: "workspace not running (cdp endpoint unavailable)" }, { status: 409 })
  }

  // 连接时长：用户级 > 全局（复用 CDP 时长策略链语义；0=不限）
  let durSec = 0
  const owner = tok.userId
    ? await db.user.findUnique({ where: { id: tok.userId }, select: { vncSessionMaxMinutes: true } })
    : null
  if (owner?.vncSessionMaxMinutes != null && owner.vncSessionMaxMinutes > 0) {
    durSec = owner.vncSessionMaxMinutes * 60
  } else {
    const globalMin = await getConfigNumber("session.cdpMaxMinutes", 0)
    if (globalMin > 0) durSec = globalMin * 60
  }

  // 计数与审计留痕（轻量：只更新计数，连接成功即算一次使用）
  await db.cdpEndpointToken.update({
    where: { id: tok.id },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date(), lastUsedIp: body.ip || null },
  }).catch(() => null)

  return NextResponse.json({
    ok: true,
    tgt: ws.cdpUrl,
    durSec,
    workspaceId: ws.id,
    label: tok.label || "",
    tid,
  })
}
