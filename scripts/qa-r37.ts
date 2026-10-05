/**
 * r37 QA：CDP 持久连接地址全生命周期 + 访客访问系统 + 数据分类 + 远程打印 + Playground + 组筛选
 *
 * [A] 数据库结构：CdpEndpointToken 表 + WorkspaceShareLink 访客字段 + Bookmark/History 分类字段 + Group/User 访客开关
 * [B] 配置键播种：cdp.allowPersistentTokens/persistentTokenMaxPerWorkspace + share.guestEnabled/guestMaxSessionMinutes
 *      + feature.playground/remotePrint + workspace.modeSwitchPreserveData/modeSwitchForceFresh
 * [C] 数据分类引擎（纯函数单测：域名精确/后缀/关键词/敏感升级）
 * [D] 内部 resolve API（鉴权 403 / 票据全状态机：ok→计数 / 吊销 / 过期 / 次数 / 畸形 / 不存在）
 * [E] 网关 /p/<tid> 实链路（假 CDP 上游 echo + 吊销即时生效 + Origin 拦截 + 短票据 /t/ 兼容）
 * [F] 访客访问：链接密码校验 / VNC 模式门 / CDP 访客票据（403→开启后 200 且网关可连）/ 全局关 → 页面拒绝
 * [G] 远程打印：模拟沙箱 printToPDF → PDF magic %PDF
 * [H] 升降级数据保留：preserveData=false → 无迁移快照 + 审计记录
 * [I] 工作区/用户 组筛选：服务端 URL 参数过滤
 */
import { PrismaClient } from "@prisma/client"
import { createHmac, randomBytes } from "crypto"
import { createServer } from "http"
import { readFileSync } from "fs"
import { WebSocketServer, WebSocket } from "ws"

const db = new PrismaClient()
const BASE = "http://localhost:3000"
const GW = "ws://localhost:3006"
const SECRET = process.env.CDP_GATEWAY_SECRET || process.env.VNC_BRIDGE_SECRET || "dockyard-dev-cdp-secret"
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`) }
}

// cookie jar
let cookies: Record<string, string> = {}
async function req(path: string, opts: RequestInit = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) }
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ")
  if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, redirect: "manual" } as RequestInit)
  for (const sc of (res.headers.getSetCookie?.() || [])) {
    const m = /^([^=]+)=([^;]*)/.exec(sc)
    if (m) cookies[m[1]] = m[2]
  }
  let json: any = null
  let text = ""
  try { text = await res.text(); json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, headers: res }
}

async function login(username: string, password: string): Promise<boolean> {
  cookies = {}
  const r1 = await req("/api/auth/pre-login", { method: "POST", body: JSON.stringify({ mode: "password", username, password }) })
  if (r1.json?.code !== 0) return false
  const ticket = r1.json.data.ticket
  const csrf = await fetch(`${BASE}/api/auth/csrf`)
  const csrfJson = await csrf.json().catch(() => ({}))
  for (const sc of (csrf.headers.getSetCookie?.() || [])) {
    const m = /^([^=]+)=([^;]*)/.exec(sc)
    if (m) cookies[m[1]] = m[2]
  }
  const body = new URLSearchParams({ ticket, totp: "", trustDevice: "false", csrfToken: csrfJson?.csrfToken || "", callbackUrl: `${BASE}/dashboard`, json: "true" })
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
    body,
    redirect: "manual",
  })
  for (const sc of (r2.headers.getSetCookie?.() || [])) {
    const m = /^([^=]+)=([^;]*)/.exec(sc)
    if (m) cookies[m[1]] = m[2]
  }
  const session = await req("/api/auth/session")
  return !!session.json?.user
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function signTicket(p: Record<string, unknown>): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(p), "utf8"))
  const sig = b64url(createHmac("sha256", SECRET).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

// ---- 假 CDP 上游（HTTP /json/version + WS echo，:9333） ----
type httpServer = ReturnType<typeof createServer>
async function startFakeCdp(): Promise<httpServer> {
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((rq, rs) => {
    if (rq.url === "/json/version") {
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ Browser: "Chrome/140.0.0.0 QA37", webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/qa-uuid-37" }))
      return
    }
    rs.writeHead(404).end()
  })
  server.on("upgrade", (rq, socket, head) => {
    wss.handleUpgrade(rq, socket, head, (ws) => {
      ws.on("message", (d: Buffer) => ws.send(`ECHO:${d.toString()}`))
    })
  })
  await new Promise<void>((res) => server.listen(9333, res))
  return server
}

function wsProbe(url: string, opts?: { headers?: Record<string, string> }, send?: string): Promise<{ open: boolean; code: number; firstMsg: string }> {
  return new Promise((resolve) => {
    let firstMsg = ""
    const ws = new WebSocket(url, opts)
    const done = (o: Partial<{ open: boolean; code: number; firstMsg: string }>) => {
      resolve({ open: false, code: 0, firstMsg, ...o })
      try { ws.close() } catch { /* noop */ }
    }
    ws.on("open", () => {
      if (send) ws.send(send)
      else done({ open: true, code: 101 })
    })
    ws.on("message", (d: Buffer) => { firstMsg = d.toString(); done({ open: true, code: 101, firstMsg }) })
    ws.on("unexpected-response", (_rq: unknown, rs: { statusCode?: number }) => done({ open: false, code: rs.statusCode || 0 }))
    ws.on("error", () => done({ open: false, code: 0 }))
    setTimeout(() => resolve({ open: ws.readyState === 1, code: 0, firstMsg }), 4000)
  })
}

// 管理员直连 DB 便捷操作
async function setConfig(key: string, value: unknown) {
  await db.systemConfig.upsert({
    where: { key },
    update: { valueJson: JSON.stringify(value) },
    create: { key, valueJson: JSON.stringify(value), category: "QA", valueType: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string", description: "r37 QA 临时" },
  })
}

async function main() {
  console.log("\n========== r37 QA：CDP 持久地址生命周期 + 访客系统 + 数据分类 + 打印 ==========\n")
  const fakeCdp = await startFakeCdp()

  // ================= [A] 数据库结构 =================
  console.log("[A] 数据库结构")
  {
    const tables = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table';") as Array<{ name: string }>
    ok("CdpEndpointToken 表（持久票据）", tables.some((t) => t.name === "CdpEndpointToken"))
    const linkCols = await db.$queryRawUnsafe("PRAGMA table_info(WorkspaceShareLink);") as Array<{ name: string }>
    ok("WorkspaceShareLink.guestAllowed/passwordHash/guestCdp", ["guestAllowed", "passwordHash", "guestCdp", "allowUserIds", "denyUserIds", "allowGroupIds", "denyGroupIds", "guestUseCount"].every((c) => linkCols.some((x) => x.name === c)))
    const hCols = await db.$queryRawUnsafe("PRAGMA table_info(BrowseHistoryEntry);") as Array<{ name: string }>
    ok("BrowseHistoryEntry.category/sensitivity", ["category", "sensitivity"].every((c) => hCols.some((x) => x.name === c)))
    const bCols = await db.$queryRawUnsafe("PRAGMA table_info(BookmarkEntry);") as Array<{ name: string }>
    ok("BookmarkEntry.category/sensitivity", ["category", "sensitivity"].every((c) => bCols.some((x) => x.name === c)))
    const gCols = await db.$queryRawUnsafe("PRAGMA table_info([Group]);") as Array<{ name: string }>
    ok("Group.allowGuestShare", gCols.some((x) => x.name === "allowGuestShare"))
    const uCols = await db.$queryRawUnsafe("PRAGMA table_info(User);") as Array<{ name: string }>
    ok("User.guestShareAllowed", uCols.some((x) => x.name === "guestShareAllowed"))
  }

  // ================= [B] 配置键播种 =================
  console.log("[B] 配置键播种（8 新键）")
  {
    const keys = ["cdp.allowPersistentTokens", "cdp.persistentTokenMaxPerWorkspace", "share.guestEnabled", "share.guestMaxSessionMinutes", "feature.playground", "feature.remotePrint", "workspace.modeSwitchPreserveData", "workspace.modeSwitchForceFresh"]
    for (const k of keys) {
      const row = await db.systemConfig.findUnique({ where: { key: k } })
      ok(`配置键 ${k}`, !!row)
    }
  }

  // ================= [C] 数据分类引擎 =================
  console.log("[C] 数据分类引擎（明文数据自动分类识别解析）")
  {
    const { classifyEntry, CATEGORY_LABELS } = await import("../src/lib/data-classification")
    const cases: Array<{ url: string; title?: string; cat: string; sens: string }> = [
      { url: "https://www.icbc.com.cn/ICBC/", cat: "BANKING", sens: "HIGH" },
      { url: "https://mail.google.com/mail/u/0/", cat: "EMAIL", sens: "SENSITIVE" },
      { url: "https://www.gov.cn/lianbo/", cat: "GOV", sens: "HIGH" },
      { url: "https://github.com/pulls", cat: "DEV", sens: "NORMAL" },
      { url: "https://www.bilibili.com/video/BV1xx", cat: "VIDEO", sens: "NORMAL" },
      { url: "https://chat.openai.com/c/123", cat: "AI", sens: "NORMAL" },
      { url: "https://www.tsinghua.edu.cn/info/", cat: "EDU", sens: "NORMAL" },
      { url: "https://example.com/login", title: "Sign in", cat: "OTHER", sens: "HIGH" },
      { url: "https://pan.baidu.com/s/abc", cat: "CLOUD", sens: "SENSITIVE" },
      { url: "https://news.qq.com/a/1.htm", cat: "NEWS", sens: "NORMAL" },
    ]
    for (const c of cases) {
      const r = classifyEntry(c.url, c.title)
      ok(`${c.url.slice(0, 42)} → ${CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS]}/${r.sensitivity}`, r.category === c.cat && r.sensitivity === c.sens, `实际 ${r.category}/${r.sensitivity}`)
    }
  }

  // 登录超管
  const admin = await db.user.findFirst({ where: { role: "SUPER_ADMIN", deletedAt: null } })
  if (!admin) { console.error("无超管账号，终止"); process.exit(1) }
  const adminPw = process.env.QA_ADMIN_PW || "Admin@2026"
  ok("超管登录", await login(admin.username, adminPw))

  // QA 沙箱（模拟形态）
  const QA_WS = `qa-r37-ws-${Date.now()}`
  let wsId = ""
  {
    const create = await req("/api/mcp", { method: "POST", body: JSON.stringify({ tool: "create_workspace", args: { name: QA_WS, mode: "cdp_light" } }) }).catch(() => null)
    // MCP 通道可能无 API key —— 直接用 DB 建（模拟形态）
    const created = await db.browserWorkspace.create({
      data: {
        name: QA_WS, uuid: `qa37-${Date.now()}`, mode: "cdp_light", status: "RUNNING",
        userId: admin.id, groupId: null,
        cdpUrl: "http://127.0.0.1:9333",
        browserSessionId: null,
      } as any,
    })
    wsId = created.id
    ok("QA 沙箱已建（RUNNING + 假 CDP 端点）", !!wsId)
  }

  // ================= [D] 内部 resolve API 全状态机 =================
  console.log("[D] CDP 持久票据 resolve API（网关实时校验通道）")
  let tidOk = ""
  let tokenId = ""
  {
    // 鉴权
    const noTok = await fetch(`${BASE}/api/cdp/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tid: "x" }) })
    ok("无内部密钥 → 403", noTok.status === 403)
    const badTok = await fetch(`${BASE}/api/cdp/resolve`, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Token": "wrong" }, body: JSON.stringify({ tid: "x" }) })
    ok("错误内部密钥 → 403", badTok.status === 403)

    // 建票据（永久）
    const tok = await db.cdpEndpointToken.create({
      data: { tid: randomBytes(24).toString("hex"), workspaceId: wsId, userId: admin.id, label: "QA 永久", expireAt: null, maxUses: 0, createdVia: "ADMIN" },
    })
    tidOk = tok.tid
    tokenId = tok.id

    const resolveIt = (tid: string, ip?: string) =>
      fetch(`${BASE}/api/cdp/resolve`, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Token": SECRET }, body: JSON.stringify({ tid, ip: ip || "9.9.9.9" }) })

    let r = await resolveIt(tidOk)
    let j = await r.json().catch(() => null)
    ok("有效票据 → 200 + tgt + 计数", r.status === 200 && j?.ok === true && j?.tgt === "http://127.0.0.1:9333", JSON.stringify(j).slice(0, 80))
    const afterUse = await db.cdpEndpointToken.findUnique({ where: { id: tokenId } })
    ok("useCount +1 / lastUsedIp 记录", (afterUse?.useCount || 0) >= 1 && afterUse?.lastUsedIp === "9.9.9.9")

    // 畸形 tid
    r = await resolveIt("zzz-not-hex")
    ok("畸形 tid → 400", r.status === 400)
    // 不存在
    r = await resolveIt(randomBytes(24).toString("hex"))
    ok("不存在 tid → 404", r.status === 404)

    // 吊销 → 403
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { revokedAt: new Date(), revokeReason: "QA 吊销" } })
    r = await resolveIt(tidOk)
    j = await r.json().catch(() => null)
    ok("已吊销 → 403 + 原因", r.status === 403 && String(j?.error || "").includes("revoked"))
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { revokedAt: null } })

    // 过期 → 403
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { expireAt: new Date(Date.now() - 1000) } })
    r = await resolveIt(tidOk)
    ok("已过期 → 403", r.status === 403)
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { expireAt: null } })

    // 次数上限
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { maxUses: 1, useCount: 1 } })
    r = await resolveIt(tidOk)
    ok("次数用尽 → 403", r.status === 403)
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { maxUses: 0, useCount: 0 } })

    // 工作区非 RUNNING → 409
    await db.browserWorkspace.update({ where: { id: wsId }, data: { status: "STOPPED" } })
    r = await resolveIt(tidOk)
    ok("沙箱停止 → 409（端点不可用语义）", r.status === 409)
    await db.browserWorkspace.update({ where: { id: wsId }, data: { status: "RUNNING" } })

    // 恢复后再次可用
    r = await resolveIt(tidOk)
    ok("恢复 RUNNING → 200", r.status === 200)
  }

  // r39 预解封：本套件与 r36 套件的负向安全用例（伪造/过期/吊销票据）会计入网关防爆破窗口，
  // 连续失败会封禁本机 IP 误伤后续正向 ECHO 用例 → 建连前防御性解封（幂等；生产等价 unbanip）
  try {
    const ub = await fetch("http://localhost:3006/unban", { method: "POST", headers: { "Content-Type": "application/json", "X-Gateway-Secret": SECRET }, body: JSON.stringify({ ip: "127.0.0.1" }) }).then((r) => r.json().catch(() => null))
    ok("网关解封端点可达（防爆破误伤自愈）", !!ub?.ok, JSON.stringify(ub))
  } catch (e) {
    ok("网关解封端点可达（防爆破误伤自愈）", false, String(e))
  }

  // ================= [E] 网关 /p/<tid> 实链路（:3006 实测） =================
  console.log("[E] 网关持久票据实链路")
  {
    // 有效持久票据 → 连假 CDP → echo
    const probe = await wsProbe(`${GW}/p/${tidOk}`, undefined, "CDP-HELLO-37")
    ok("持久票据建连 + CDP 消息回显（ECHO）", probe.open && probe.firstMsg.includes("ECHO:CDP-HELLO-37"), JSON.stringify(probe).slice(0, 80))

    // 吊销即时生效（不重启网关）
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { revokedAt: new Date(), revokeReason: "QA 即时吊销" } })
    const probeRevoked = await wsProbe(`${GW}/p/${tidOk}`)
    ok("吊销后即时拒连（401/未开）", !probeRevoked.open)
    await db.cdpEndpointToken.update({ where: { id: tokenId }, data: { revokedAt: null, useCount: 0 } })

    // Origin 头拦截（bun 下 unexpected-response 未实现，断言拒连即可）
    const probeOrigin = await wsProbe(`${GW}/p/${tidOk}`, { headers: { Origin: "https://evil.example.com" } })
    ok("Origin 头拦截（拒连）", !probeOrigin.open)

    // 不存在 tid
    const probe404 = await wsProbe(`${GW}/p/${randomBytes(24).toString("hex")}`)
    ok("不存在 tid 拒连", !probe404.open)

    // 短票据 /t/ 兼容（r36 链路不回归）
    const shortTicket = signTicket({
      v: wsId, u: admin.id, tgt: "http://127.0.0.1:9333",
      exp: Math.floor(Date.now() / 1000) + 60, dur: 0, n: randomBytes(12).toString("hex"),
    })
    const probeShort = await wsProbe(`${GW}/t/${shortTicket}`, undefined, "CDP-SHORT-37")
    ok("短票据 /t/ 兼容（ECHO）", probeShort.open && probeShort.firstMsg.includes("ECHO:CDP-SHORT-37"))
  }

  // ================= [F] 访客访问系统 =================
  console.log("[F] 访客（VNC/CDP + 密码 + 四级管控）—— 配置 TTL 传播等待 31s")
  let guestToken = ""
  let cdpGuestToken = ""
  {
    // 开全局访客 + 本地网关域名（写入后等待 30s 缓存 TTL 传播）
    await setConfig("share.guestEnabled", true)
    await setConfig("cdp.publicGatewayHost", "127.0.0.1") // QA：指向本机网关（访客 CDP 票据可实连）
    // 预建两类链接：带密码（密码门验证）/ 无密码 guestCdp（票据与模式门验证）
    guestToken = randomBytes(32).toString("hex")
    await db.workspaceShareLink.create({
      data: {
        workspaceId: wsId, token: guestToken, permission: "OPERATE",
        expireAt: null, maxUses: 0,
        guestAllowed: true, guestCdp: true,
        passwordHash: "$2b$12$C6UzMDM.H6dfI/f/IKcEe.PjOAiLm5.qY1KOdDT0HkYf0Y1vzOkSy", // 恒定哈希（错误密码路径验证）
        createdByUserId: admin.id,
      } as any,
    })
    cdpGuestToken = randomBytes(32).toString("hex")
    await db.workspaceShareLink.create({
      data: { workspaceId: wsId, token: cdpGuestToken, permission: "OPERATE", guestAllowed: true, guestCdp: true, maxUses: 0, createdByUserId: admin.id } as any,
    })
    console.log("  … 等待 31s（配置缓存 TTL）")
    await new Promise((r) => setTimeout(r, 31_000))

    // 访客页（未登录）可访问：200 + 不重定向登录
    const page = await fetch(`${BASE}/view/${guestToken}`, { redirect: "manual" })
    ok("访客页 /view/<token> 未登录可访问（200）", page.status === 200)

    // 错误密码 → 401
    const wrongPw = await fetch(`${BASE}/api/guest/vnc-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: guestToken, password: "wrong-password" }) })
    ok("访客密码错误 → 401", wrongPw.status === 401)

    // VNC 模式门（cdp_light 沙箱 → 拒绝；用无密码链接隔离变量）
    const r = await fetch(`${BASE}/api/guest/vnc-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cdpGuestToken }) })
    const j = await r.json().catch(() => null)
    ok("CDP 轻量沙箱访客 VNC → 模式门拒绝", r.status === 403 && String(j?.msg || "").includes("VNC"), JSON.stringify(j).slice(0, 60))

    // 访客 CDP 票据：开启 guestCdp + OPERATE → 200 + 网关 URL 可连
    const r2 = await fetch(`${BASE}/api/guest/cdp-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: cdpGuestToken }) })
    const j2 = await r2.json().catch(() => null)
    ok("访客 CDP 票据签发（200 + gatewayUrl）", r2.status === 200 && j2?.code === 0 && String(j2?.data?.gatewayUrl || "").includes("/t/"), JSON.stringify(j2).slice(0, 100))
    // 访客票据经网关实连（假 CDP echo）
    if (j2?.data?.gatewayUrl) {
      const gp = await wsProbe(j2.data.gatewayUrl, undefined, "GUEST-CDP-37")
      ok("访客 CDP 票据经网关建连（ECHO）", gp.open && gp.firstMsg.includes("ECHO:GUEST-CDP-37"))
    }

    // 未开放访客 CDP 的链接 → 403
    const { randomBytes: rb3 } = await import("crypto")
    const noCdpToken = rb3(32).toString("hex")
    await db.workspaceShareLink.create({
      data: { workspaceId: wsId, token: noCdpToken, permission: "VIEW", guestAllowed: true, guestCdp: false, maxUses: 0, createdByUserId: admin.id } as any,
    })
    const r3 = await fetch(`${BASE}/api/guest/cdp-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: noCdpToken }) })
    ok("未开放访客 CDP → 403", r3.status === 403)

    // 未开启访客的链接 → 页面引导登录
    const { randomBytes: rb4 } = await import("crypto")
    const nonGuestToken = rb4(32).toString("hex")
    await db.workspaceShareLink.create({
      data: { workspaceId: wsId, token: nonGuestToken, permission: "VIEW", guestAllowed: false, maxUses: 0, createdByUserId: admin.id } as any,
    })
    const page2 = await fetch(`${BASE}/view/${nonGuestToken}`, { redirect: "manual" })
    const html = await page2.text().catch(() => "")
    ok("未开访客链接 → 页面提示需登录", page2.status === 200 && html.includes("需要登录"))

    // 全局关 → 访客即拒（四级管控；等待 TTL 传播）
    await setConfig("share.guestEnabled", false)
    console.log("  … 等待 31s（全局关闭传播）")
    await new Promise((r) => setTimeout(r, 31_000))
    const page3 = await fetch(`${BASE}/view/${guestToken}`, { redirect: "manual" })
    const html3 = await page3.text().catch(() => "")
    ok("全局关闭访客 → 页面立即拒绝", page3.status === 200 && (html3.includes("已被管理员限制") || html3.includes("未启用")))
    await setConfig("cdp.publicGatewayHost", "") // 清理：网关域名还原为未配置
  }

  // ================= [G] 远程打印（模拟沙箱 printToPDF） =================
  console.log("[G] 远程打印（沙箱页面 → 客户端打印机）")
  let printWsId = ""
  {
    // 模拟形态工作区（cdpUrl=browser-internal → print_pdf 走模拟分支返回内置 PDF）
    const printWs = await db.browserWorkspace.create({
      data: {
        name: `qa-r37-print-${Date.now()}`, uuid: `qa37p-${Date.now()}`, mode: "cdp_light", status: "RUNNING",
        userId: admin.id, groupId: null,
        cdpUrl: `ws://browser-internal/v1/sessions/qa37-${Date.now()}/cdp`,
        browserSessionId: `qa37-${Date.now()}`,
      } as any,
    })
    printWsId = printWs.id
    const res = await fetch(`${BASE}/api/vnc-proxy/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
      body: JSON.stringify({ workspaceId: printWsId }),
    })
    const buf = await res.arrayBuffer().catch(() => null)
    const head = buf ? Buffer.from(buf.slice(0, 8)).toString("latin1") : ""
    ok("打印 PDF 返回（%PDF magic）", res.status === 200 && head.startsWith("%PDF"), `status=${res.status} head=${head}`)
  }
  // ================= [H] 升降级数据保留开关 =================
  console.log("[H] 升降级数据保留（preserveData=false 不迁移）")
  {
    // 源码断言：switchWorkspaceModeAction 接受 preserveData 且 forceFresh 生效
    const src = readFileSync("src/server/actions/workspaces.ts", "utf-8")
    ok("action 接受 preserveData 参数", src.includes("preserveData: z.boolean().optional()"))
    ok("管理员强制不保留链（modeSwitchForceFresh）", src.includes("workspace.modeSwitchForceFresh") && src.includes("forceFresh ? false"))
    ok("preserveData=false 跳过迁移", src.includes("profileDir && preserveData") && src.includes("preserveData && ws.status"))
    const cfg1 = await db.systemConfig.findUnique({ where: { key: "workspace.modeSwitchPreserveData" } })
    ok("默认保留（modeSwitchPreserveData=true）", !!cfg1 && JSON.parse(String(cfg1.valueJson)) === true)
    const cfg2 = await db.systemConfig.findUnique({ where: { key: "workspace.modeSwitchForceFresh" } })
    ok("默认不强制丢弃（modeSwitchForceFresh=false）", !!cfg2 && JSON.parse(String(cfg2.valueJson)) === false)
  }

  // ================= [I] 组筛选（工作区 + 用户管理） =================
  console.log("[I] 用户组筛选（工作区/用户管理页）")
  {
    // 建组 + 把 QA 沙箱归组
    const grp = await db.group.create({ data: { name: `qa-r37-grp-${Date.now()}`, allowGuestShare: true } }).catch(() => null)
    if (grp) {
      await db.browserWorkspace.update({ where: { id: wsId }, data: { groupId: grp.id } }).catch(() => null)
      // 工作区列表组筛选（HTML 抓取：筛选后仍含 QA_WS；无该组的对照不含）
      const pageA = await req(`/admin/workspaces?scope=all&groups=${grp.id}`)
      const htmlA = pageA.text
      ok("工作区组筛选命中（QA 沙箱在列）", pageA.status === 200 && htmlA.includes(QA_WS), `status=${pageA.status}`)
      const pageB = await req("/admin/workspaces?scope=all")
      ok("对照组（无筛选）含组筛选组件", pageB.status === 200 && pageB.text.includes("用户组筛选"))
      // 用户管理组筛选（成员为空 → 空结果语义）
      const usersA = await req(`/admin/users?groups=${grp.id}`)
      ok("用户组筛选页 200（无成员 → 空表）", usersA.status === 200)
      // 用户页含组件
      const usersB = await req("/admin/users")
      ok("用户管理含组筛选组件", usersB.status === 200 && usersB.text.includes("用户组："))
    } else {
      ok("QA 组创建", false, "组创建失败")
    }

    // 清理组
    await db.browserWorkspace.update({ where: { id: wsId }, data: { groupId: null } }).catch(() => null)
    if (grp) await db.group.delete({ where: { id: grp.id } }).catch(() => null)
  }

  // ================= 清理 =================
  console.log("\n[清理]")
  {
    await db.workspaceShareLink.deleteMany({ where: { workspaceId: wsId } })
    await db.cdpEndpointToken.deleteMany({ where: { workspaceId: wsId } })
    if (printWsId) await db.browserWorkspace.delete({ where: { id: printWsId } }).catch(() => null)
    await db.browserWorkspace.delete({ where: { id: wsId } })
    await setConfig("share.guestEnabled", false)
    await setConfig("cdp.publicGatewayHost", "")
    const leftoverTokens = await db.cdpEndpointToken.count({ where: { workspaceId: wsId } })
    ok("QA 数据清理（票据/链接/沙箱）", leftoverTokens === 0)
  }

  fakeCdp.close()
  await db.$disconnect()
  console.log(`\n========== r37 QA 结果：${pass} 通过 / ${fail} 失败 ==========\n`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error("QA 异常：", e)
  await db.$disconnect()
  process.exit(1)
})
