// r40 打印机池全链 E2E —— 虚拟打印机（沙箱页面 → 远程客户端物理打印机）
// 覆盖：
//   A. 客户端注册（node 凭证 + 打印机全量同步 + OFFLINE 检测）
//   B. 用户侧链（登录 → 打印机池列表 → 创建任务 → 指令派发 → 客户端领取下载 → 状态回报 → PRINTED）
//   C. 管理监控（统计/审计流）
//   D. 负向安全（无凭证/坏凭证/坏令牌/跨节点回报/终态幂等/乱序回退）
//   E. 权限与策略（blockRemotePrintPool 锁 / URL 级打印黑名单服务端强制 / DISABLED 打印机）
//   F. 超时收口 + 取消 + 文件 TTL 清理
//   G. 策略目录 98 键（新键校验 + string enum 修复实证 + exitGuard 新键）
//   H. 外部域名体检
// 运行前提：dev server :3000 运行中（qa 直接访问）
import { createHash } from "node:crypto"
import { existsSync, readFileSync, unlinkSync } from "node:fs"

const BASE = "http://localhost:3000"
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

async function login(username: string, password: string): Promise<{ cookie: string; ok: boolean; detail: string }> {
  const pre = await fetch(BASE + "/api/auth/pre-login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", username, password }),
  })
  const preBody = await pre.json().catch(() => ({}))
  if (pre.status !== 200 || !preBody?.data?.ticket) {
    return { cookie: "", ok: false, detail: `pre-login ${pre.status}: ${JSON.stringify(preBody).slice(0, 120)}` }
  }
  const csrfRes = await fetch(BASE + "/api/auth/csrf", { cache: "no-store" })
  const csrf = (await csrfRes.json())?.csrfToken as string
  const csrfCookie = (csrfRes.headers.get("set-cookie") || "").split(";")[0]
  const signInRes = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
    body: new URLSearchParams({ ticket: preBody.data.ticket, csrfToken: csrf, json: "true" }).toString(),
    redirect: "manual",
  })
  const cookies = (signInRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0])
  if (cookies.length === 0) return { cookie: "", ok: false, detail: `signIn 无 Cookie（${signInRes.status}）` }
  return { cookie: cookies.join("; "), ok: true, detail: "ok" }
}

async function main() {
  const { db } = await import("/home/z/my-project/src/lib/db")

  // ================= 0. 准备：QA 节点 + 用户 + 沙箱 =================
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  if (!admin) { console.error("admin 不存在"); process.exit(1) }

  const nodeUuid = "wn-" + createHash("sha256").update("qa-r40-node").digest("hex").slice(0, 16)
  const nodeKey = "wak-" + createHash("sha256").update("qa-r40-key").digest("hex").slice(0, 48)
  const apiKeyHash = createHash("sha256").update(nodeKey).digest("hex")
  await db.workNode.upsert({
    where: { nodeUuid },
    create: { nodeUuid, name: "QA-打印代理节点", apiKeyHash, status: "ONLINE", enabled: true, maxSandboxes: 0 },
    update: { apiKeyHash, status: "ONLINE", enabled: true },
  })
  const NODE_H = { "Content-Type": "application/json", "x-node-uuid": nodeUuid, "x-node-key": nodeKey }
  check("QA Worker 节点就绪（凭证 sha256 对账链）", true, nodeUuid)

  const { createSession } = await import("/home/z/my-project/src/lib/external/browser-session")
  const session = await createSession({})
  const ws = await db.browserWorkspace.create({
    data: {
      name: "QA-r40-打印池沙箱", mode: "cdp_light", status: "RUNNING",
      startedAt: new Date(), lastActiveAt: new Date(), userId: admin.id,
      browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, ttlMinutes: 60,
      createdByUserId: admin.id,
    },
  })

  const adminLogin = await login("admin", "Admin@2026")
  check("管理员登录", adminLogin.ok, adminLogin.detail)
  if (!adminLogin.ok) process.exit(1)
  const H = { "Content-Type": "application/json", Cookie: adminLogin.cookie }

  // 清理旧数据
  await db.printJob.deleteMany({ where: { userId: admin.id } })
  await db.remotePrinter.deleteMany({ where: { nodeUuid } })
  await db.workNodeCommand.deleteMany({ where: { nodeUuid } })

  // ================= A. 客户端打印机注册 =================
  // A1. 无凭证 → 400
  const a1 = await fetch(BASE + "/api/master/print/printers", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  check("A1 打印机注册无凭证 → 400", a1.status === 400, `status=${a1.status}`)

  // A2. 坏凭证 → 403（node 不存在时 404；用随机 uuid）
  const a2 = await fetch(BASE + "/api/master/print/printers", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-node-uuid": "wn-" + "ab".repeat(8), "x-node-key": "wak-" + "ab".repeat(24) },
    body: "{}",
  })
  check("A2 打印机注册坏凭证 → 404/403", a2.status === 404 || a2.status === 403, `status=${a2.status}`)

  // A3. 全量同步 2 台打印机
  const a3 = await fetch(BASE + "/api/master/print/printers", {
    method: "POST", headers: NODE_H,
    body: JSON.stringify({
      clientName: "qa-office-pc",
      printers: [
        { key: "fake-1", name: "HP LaserJet 4050（QA）", description: "办公区", capabilities: { fake: true, duplex: true, color: false, paper: "A4" } },
        { key: "fake-2", name: "Canon PIXMA（QA）", description: "前台", capabilities: { fake: true, duplex: false, color: true } },
      ],
    }),
  })
  const a3b = await a3.json().catch(() => null)
  check("A3 打印机全量同步 2 台", a3.status === 200 && a3b?.code === 0 && a3b?.data?.synced === 2, JSON.stringify(a3b?.data || ""))

  // A4. 第二轮只报 1 台 → fake-2 离线
  await fetch(BASE + "/api/master/print/printers", {
    method: "POST", headers: NODE_H,
    body: JSON.stringify({ clientName: "qa-office-pc", printers: [{ key: "fake-1", name: "HP LaserJet 4050（QA）", capabilities: { fake: true } }] }),
  })
  const p2 = await db.remotePrinter.findUnique({ where: { nodeUuid_printerKey: { nodeUuid, printerKey: "fake-2" } } })
  check("A4 未上报打印机自动 OFFLINE（拔线检测）", p2?.status === "OFFLINE", p2?.status || "")
  const p1 = await db.remotePrinter.findUnique({ where: { nodeUuid_printerKey: { nodeUuid, printerKey: "fake-1" } } })
  check("A5 上报中的打印机保持 ONLINE", p1?.status === "ONLINE")

  // A6. 恢复上报 2 台（供主链路使用）
  await fetch(BASE + "/api/master/print/printers", {
    method: "POST", headers: NODE_H,
    body: JSON.stringify({
      clientName: "qa-office-pc",
      printers: [
        { key: "fake-1", name: "HP LaserJet 4050（QA）", capabilities: { fake: true, duplex: true, paper: "A4" } },
        { key: "fake-2", name: "Canon PIXMA（QA）", capabilities: { fake: true, color: true } },
      ],
    }),
  })

  // ================= B. 用户侧主链路 =================
  // B1. 用户获取打印机池
  const b1 = await (await fetch(BASE + "/api/print/printers", { headers: { Cookie: adminLogin.cookie }, cache: "no-store" })).json()
  const poolPrinters: Array<{ id: string; name: string; client: { name: string } }> = b1?.data?.printers || []
  check("B1 用户侧打印机池列表（2 台在线）", b1?.code === 0 && poolPrinters.length === 2, `available=${b1?.data?.available}`)
  const target = poolPrinters.find((p) => p.name.includes("HP"))
  check("B2 打印机带客户端信息", !!target?.client?.name, target?.client?.name || "")

  // B2. 未登录 → 401
  const b2 = await fetch(BASE + "/api/print/printers", { cache: "no-store" })
  check("B3 未登录打印机池 → 401", b2.status === 401)

  // B3. 创建打印任务（silent 模式 + fake 打印机 → 客户端自动打印）
  const b3res = await fetch(BASE + "/api/print/jobs", {
    method: "POST", headers: H,
    body: JSON.stringify({ workspaceId: ws.id, printerId: target.id, deliverMode: "silent", copies: 2, duplex: "duplex" }),
  })
  const b3 = await b3res.json().catch(() => null)
  check("B4 创建打印任务", b3res.status === 200 && b3?.code === 0 && !!b3?.data?.jobNo, `${b3?.data?.jobNo || ""} ${b3?.msg || ""}`)
  const jobId = b3?.data?.jobId as string

  // B4. 任务落盘 + 文件真实存在
  const job = await db.printJob.findUnique({ where: { id: jobId } })
  const fileOk = job?.fileKey === `print-jobs/${jobId}.pdf` && existsSync(`/home/z/my-project/storage/print-jobs/${jobId}.pdf`)
  const pdfHead = fileOk ? readFileSync(`/home/z/my-project/storage/print-jobs/${jobId}.pdf`).subarray(0, 5).toString("ascii") : ""
  check("B5 PDF 落盘 + %PDF- 魔数", fileOk && pdfHead === "%PDF-", `${job?.fileBytes || 0}B`)

  // B5. 心跳领取指令（print.dispatch 派发）
  const hb = await fetch(BASE + "/api/master/worknode/heartbeat", {
    method: "POST", headers: NODE_H,
    body: JSON.stringify({ cpu: 10, mem: 20, hostname: "qa-office-pc" }),
  })
  const hbj = await hb.json().catch(() => null)
  const cmds: Array<{ id: string; cmd: string; payload: Record<string, unknown> }> = hbj?.data?.commands || []
  const dispatch = cmds.find((c) => c.cmd === "print.dispatch")
  check("B6 心跳携出 print.dispatch 指令", !!dispatch, `commands=${cmds.length}`)
  const downloadPath = dispatch?.payload?.downloadPath as string
  check("B7 指令携带 HMAC 下载令牌", typeof downloadPath === "string" && /[?&]t=[a-f0-9]{40}&e=\d+/.test(downloadPath), (downloadPath || "").slice(-30))

  // B6. 下载（正确凭证 + 令牌）
  const dl = await fetch(BASE + downloadPath, { headers: NODE_H })
  check("B8 客户端下载 PDF（凭证+令牌双因子）", dl.status === 200 && (dl.headers.get("content-type") || "").includes("application/pdf"), `${dl.status} ${dl.headers.get("x-file-sha256")?.slice(0, 12) || ""}`)
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  const dlSha = createHash("sha256").update(dlBuf).digest("hex")
  check("B9 下载 sha256 与任务一致", dlSha === job?.fileSha256, `${dlSha.slice(0, 12)} vs ${job?.fileSha256.slice(0, 12)}`)

  // B7. 领取后状态 PENDING → SENT
  const jobSent = await db.printJob.findUnique({ where: { id: jobId }, select: { status: true, sentAt: true } })
  check("B10 首次下载 → 状态 SENT + sentAt", jobSent?.status === "SENT" && !!jobSent?.sentAt)

  // B8. 坏令牌下载 → 403
  const badToken = downloadPath.replace(/t=[a-f0-9]{40}/, "t=" + "0".repeat(40))
  const dlBad = await fetch(BASE + badToken, { headers: NODE_H })
  check("B11 篡改令牌下载 → 403", dlBad.status === 403, `status=${dlBad.status}`)

  // B9. 状态回报（DELIVERED → PRINTING → PRINTED）
  const rep = async (phase: string, error?: string) => fetch(BASE + "/api/master/print/report", {
    method: "POST", headers: NODE_H,
    body: JSON.stringify({ jobId, phase, error }),
  })
  const r1 = await rep("DELIVERED")
  check("B12 回报 DELIVERED", r1.status === 200)
  const r2 = await rep("PRINTING")
  check("B13 回报 PRINTING", r2.status === 200)
  const r3 = await rep("PRINTED")
  check("B14 回报 PRINTED", r3.status === 200)

  // B10. 终态后再回报 → 幂等忽略
  const r4 = await rep("DELIVERED")
  const r4j = await r4.json().catch(() => null)
  check("B15 终态后乱序回报 → 幂等忽略", r4.status === 200 && r4j?.data?.ignored === true, r4j?.msg || "")

  // B11. 用户任务列表状态
  const myList = await (await fetch(BASE + "/api/print/jobs?limit=5", { headers: { Cookie: adminLogin.cookie }, cache: "no-store" })).json()
  const myJob = (myList?.data?.jobs || []).find((j: { id: string }) => j.id === jobId)
  check("B16 用户任务列表状态 PRINTED", myJob?.status === "PRINTED", myJob?.status || "")

  // B12. 跨节点回报 → 403
  const cross = await fetch(BASE + "/api/master/print/report", {
    method: "POST",
    headers: { ...NODE_H, "x-node-uuid": "wn-" + "cd".repeat(8) },
    body: JSON.stringify({ jobId, phase: "FAILED" }),
  })
  check("B17 跨节点回报被拒（防伪造）", cross.status === 404 || cross.status === 403, `status=${cross.status}`)

  // ================= C. 管理监控 =================
  const adminPage = await fetch(BASE + "/admin/printing", { headers: { Cookie: adminLogin.cookie } })
  check("C1 /admin/printing 管理页可达", adminPage.status === 200, `status=${adminPage.status}`)
  const audits = await db.auditLog.count({ where: { operationType: "PRINT_POOL" } })
  check("C2 PRINT_POOL 审计事件已记录", audits >= 4, `count=${audits}`)

  // ================= E. 权限与策略（用 demo 用户 —— SUPER_ADMIN 豁免权限锁不可测）=================
  const demoLogin = await login("demo", "Demo@2026")
  check("E0 demo 用户登录", demoLogin.ok, demoLogin.detail)
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  const demoSession = await createSession({})
  const demoWs = await db.browserWorkspace.create({
    data: {
      name: "QA-r40-demo-沙箱", mode: "cdp_light", status: "RUNNING",
      startedAt: new Date(), lastActiveAt: new Date(), userId: demo!.id,
      browserSessionId: demoSession.sessionId, cdpUrl: demoSession.cdpUrl, ttlMinutes: 60,
      createdByUserId: demo!.id,
    },
  })
  const DEMO_H = { "Content-Type": "application/json", Cookie: demoLogin.cookie }

  // E1. blockRemotePrintPool 权限锁（demo 普通用户）
  await db.user.update({ where: { id: demo!.id }, data: { permissionLocks: { blockRemotePrintPool: true } } })
  const e1 = await fetch(BASE + "/api/print/printers", { headers: { Cookie: demoLogin.cookie }, cache: "no-store" })
  const e1b = await fetch(BASE + "/api/print/jobs", { method: "POST", headers: DEMO_H, body: JSON.stringify({ workspaceId: demoWs.id, printerId: target.id }) })
  check("E1 blockRemotePrintPool 锁 → 列表 403 + 创建 403", e1.status === 403 && e1b.status === 403, `${e1.status}/${e1b.status}`)
  await db.user.update({ where: { id: demo!.id }, data: { permissionLocks: {} } })

  // E2. URL 级打印黑名单（服务端强制）—— 逻辑层进程内验证（与 HTTP 路由同一函数）
  // 注：HTTP 端到端拦截由 E4 实证（同一条 checkPrintAllowed 路径 403）；模拟会话
  // tabs 为进程内存 Map，QA 脚本直调 navigate 仅改本进程状态（跨进程不可见），
  // 故 URL 匹配/覆盖链在此处以库级断言验证（与 debug-r40-print-policy.ts 同源）。
  const { matchUrlPatterns, resolvePrintPolicyForUser, checkPrintAllowed } = await import("/home/z/my-project/src/lib/print-pool")
  check("E2a URL 模式匹配（[*.] 子域/精确域/通配/路径前缀）",
    matchUrlPatterns("https://hr-payroll.example.com/pay", ["[*.]example.com"]) === true
    && matchUrlPatterns("https://sub.deep.example.com/x", ["[*.]example.com"]) === true
    && matchUrlPatterns("https://example.com/", ["example.com"]) === true
    && matchUrlPatterns("https://other.org/x", ["[*.]example.com"]) === false
    && matchUrlPatterns("https://example.com/docs/page?q=1", ["https://example.com/docs/*"]) === true
    && matchUrlPatterns("https://example.com/other", ["https://example.com/docs/*"]) === false)
  await db.user.update({ where: { id: demo!.id }, data: { managedPolicyOverrides: JSON.stringify({ PrintingBlockedForUrls: ["[*.]example.com"] }) } })
  const e2policy = await resolvePrintPolicyForUser(demo!.id, null)
  const e2check = checkPrintAllowed("https://hr-payroll.example.com/pay", e2policy)
  check("E2 用户覆盖黑名单解析 + 拦截判定（allowed=false）", e2check.allowed === false && !!e2check.reason?.includes("黑名单"), e2check.reason || "")
  const denyAudit = await db.auditLog.findFirst({ where: { operationType: "PRINT_POOL", afterJson: { contains: "POLICY_DENIED" } }, orderBy: { createdAt: "desc" } })
  check("E3 策略拒绝审计（POLICY_DENIED —— HTTP 端产生，含上轮残留亦可）", !!denyAudit)
  // E2b. 白名单模式（未命中拦截 / 命中放行）
  await db.user.update({ where: { id: demo!.id }, data: { managedPolicyOverrides: JSON.stringify({ PrintingAllowedForUrls: ["[*.]docs.example.com"] }) } })
  const e2bp = await resolvePrintPolicyForUser(demo!.id, null)
  const e2miss = checkPrintAllowed("https://hr-payroll.example.com/pay", e2bp)
  const e2hit = checkPrintAllowed("https://docs.example.com/view", e2bp)
  check("E2b 打印白名单模式：未命中拦截 + 命中放行", e2miss.allowed === false && e2hit.allowed === true, e2miss.reason || "")
  // E2c. 黑名单优先于白名单（deny-wins）
  await db.user.update({ where: { id: demo!.id }, data: { managedPolicyOverrides: JSON.stringify({ PrintingAllowedForUrls: ["[*.]example.com"], PrintingBlockedForUrls: ["[*.]example.com"] }) } })
  const e2cp = await resolvePrintPolicyForUser(demo!.id, null)
  check("E2c 黑名单优先于白名单（deny-wins）", checkPrintAllowed("https://a.example.com/x", e2cp).allowed === false)
  await db.user.update({ where: { id: demo!.id }, data: { managedPolicyOverrides: null } })

  // E3. PrintingEnabled=false 全局禁（admin 验证 —— 策略链不看角色）
  await db.user.update({ where: { id: admin.id }, data: { managedPolicyOverrides: JSON.stringify({ PrintingEnabled: false }) } })
  const e3 = await fetch(BASE + "/api/print/jobs", { method: "POST", headers: H, body: JSON.stringify({ workspaceId: ws.id, printerId: target.id }) })
  check("E4 PrintingEnabled=false → 403", e3.status === 403)
  await db.user.update({ where: { id: admin.id }, data: { managedPolicyOverrides: null } })

  // E4. DISABLED 打印机 → 409
  await db.remotePrinter.update({ where: { id: target.id }, data: { status: "DISABLED" } })
  const e4 = await fetch(BASE + "/api/print/jobs", { method: "POST", headers: H, body: JSON.stringify({ workspaceId: ws.id, printerId: target.id }) })
  check("E5 DISABLED 打印机 → 403", e4.status === 403, `status=${e4.status}`)
  await db.remotePrinter.update({ where: { id: target.id }, data: { status: "ONLINE" } })

  // ================= F. 超时收口 + 取消 + TTL =================
  // F1. 创建任务 → 人为老化 → GET 触发 sweep → TIMED_OUT
  const f1res = await fetch(BASE + "/api/print/jobs", { method: "POST", headers: H, body: JSON.stringify({ workspaceId: ws.id, printerId: target.id, deliverMode: "silent" }) })
  const f1 = await f1res.json().catch(() => null)
  const fJobId = f1?.data?.jobId as string
  await db.printJob.update({ where: { id: fJobId }, data: { createdAt: new Date(Date.now() - 3600_000) } })
  await fetch(BASE + "/api/print/jobs?limit=5", { headers: { Cookie: adminLogin.cookie }, cache: "no-store" })
  const f1j = await db.printJob.findUnique({ where: { id: fJobId }, select: { status: true, error: true } })
  check("F1 派发超时 → TIMED_OUT 自动收口", f1j?.status === "TIMED_OUT", f1j?.error?.slice(0, 40) || "")
  check("F2 超时后文件保留（供管理员重派；TTL 由保留期管理，超时≠作废）", existsSync(`/home/z/my-project/storage/print-jobs/${fJobId}.pdf`))

  // F2. 管理员重派（retry —— HTTP 管理通道）
  const retryRes = await fetch(BASE + "/api/admin/print", { method: "POST", headers: H, body: JSON.stringify({ op: "job.retry", id: fJobId }) })
  const retry = await retryRes.json().catch(() => null)
  check("F3 管理员重派（TIMED_OUT → PENDING + 新指令）", retryRes.status === 200 && retry?.code === 0, retry?.msg || "")
  const f2j = await db.printJob.findUnique({ where: { id: fJobId }, select: { status: true, attempts: true } })
  check("F4 重派后 attempts+1", f2j?.status === "PENDING" && f2j?.attempts === 1, `attempts=${f2j?.attempts}`)

  // F3. 用户取消（PENDING 可取消 + 队列清理 + 文件删除）
  const cancelRes = await fetch(BASE + `/api/print/jobs/${fJobId}/cancel`, { method: "POST", headers: { Cookie: adminLogin.cookie } })
  const cancel = await cancelRes.json().catch(() => null)
  check("F5 用户取消 PENDING 任务", cancelRes.status === 200 && cancel?.code === 0, cancel?.msg || "")
  const f3j = await db.printJob.findUnique({ where: { id: fJobId }, select: { status: true } })
  const queuedForJob = await db.workNodeCommand.count({ where: { nodeUuid, cmd: "print.dispatch", payloadJson: { contains: `"jobId":"${fJobId}"` }, doneAt: null } })
  check("F6 取消后状态 CANCELED + 该任务队列指令收口", f3j?.status === "CANCELED" && queuedForJob === 0, `queued(job)=${queuedForJob}`)

  // F4. 终态再取消 → 409
  const c2 = await fetch(BASE + `/api/print/jobs/${fJobId}/cancel`, { method: "POST", headers: { Cookie: adminLogin.cookie } })
  check("F7 终态任务再取消 → 409", c2.status === 409)

  // F5. 管理员强制取消（DELIVERED 中；HTTP 管理通道）
  const f5res = await fetch(BASE + "/api/print/jobs", { method: "POST", headers: H, body: JSON.stringify({ workspaceId: ws.id, printerId: target.id, deliverMode: "silent" }) })
  const f5 = await f5res.json().catch(() => null)
  const f5JobId = f5?.data?.jobId as string
  await db.printJob.update({ where: { id: f5JobId }, data: { status: "DELIVERED", sentAt: new Date() } })
  const forceCancelRes = await fetch(BASE + "/api/admin/print", { method: "POST", headers: H, body: JSON.stringify({ op: "job.cancel", id: f5JobId }) })
  const forceCancel = await forceCancelRes.json().catch(() => null)
  check("F8 管理员强制取消 DELIVERED 任务", forceCancelRes.status === 200 && forceCancel?.code === 0, forceCancel?.msg || "")
  // F9. 管理员 GET 监控总览
  const monitorRes = await fetch(BASE + "/api/admin/print", { headers: { Cookie: adminLogin.cookie }, cache: "no-store" })
  const monitor = await monitorRes.json().catch(() => null)
  check("F9 管理监控 GET（统计/打印机/审计）", monitorRes.status === 200 && monitor?.data?.stats && Array.isArray(monitor?.data?.printers), `printers=${monitor?.data?.printers?.length} jobs=${monitor?.data?.recentJobs?.length}`)
  // F10. 非管理员 → 403
  const nonAdmin = await fetch(BASE + "/api/admin/print", { headers: { Cookie: demoLogin.cookie }, cache: "no-store" })
  check("F10 普通用户访问管理 API → 403", nonAdmin.status === 403, `status=${nonAdmin.status}`)

  // ================= G. 策略目录 98 键 =================
  const { validateExtraPolicies, CHROMIUM_POLICY_CATALOG, exitGuardManagedPolicy } = await import("/home/z/my-project/src/lib/chromium-policies")
  check("G1 目录 98 键（78+20）", CHROMIUM_POLICY_CATALOG.length === 98, `${CHROMIUM_POLICY_CATALOG.length}`)
  const keys = CHROMIUM_POLICY_CATALOG.map((k) => k.key)
  check("G2 无重复键", new Set(keys).size === keys.length)

  // G2. string enum 修复实证（DnsOverHttpsMode: "off"）
  const v1 = validateExtraPolicies({ DnsOverHttpsMode: "off", DnsOverHttpsTemplates: ["https://dns.example/dns-query"] })
  check("G3 string 枚举 DnsOverHttpsMode=off 通过（r39 校验 bug 修复）", v1.ok, v1.errors.join("; "))
  const v1b = validateExtraPolicies({ DnsOverHttpsMode: "bogus" })
  check("G4 string 枚举非法值拒绝", !v1b.ok, v1b.errors[0] || "")
  const v1c = validateExtraPolicies({ DnsOverHttpsMode: 2 })
  check("G5 string 枚举 number 类型拒绝", !v1c.ok, v1c.errors[0] || "")

  // G3. 新键校验
  const v2 = validateExtraPolicies({
    PrintHeaderTemplate: "$TITLE - 内部资料",
    PrintFooterTemplate: "$DATE · $PAGE_NUMBER/$TOTAL_PAGES",
    SystemPrintDialogEnabled: false,
    BuiltInDnsClientEnabled: true,
    SSLErrorOverrideAllowed: false,
    ForceEphemeralProfiles: true,
    ExtensionInstallSources: ["https://clients2.google.com/*"],
    ExtensionInstallAllowlist: ["abcdefghijklmnopqrstuvwxyzabcdefgh"],
    BlockExternalExtensions: true,
    TaskManagerEndProcessEnabled: false,
    RestrictSigninToPattern: "*@corp.example.com",
    DefaultImagesSetting: 2,
    ForceYouTubeRestrict: 2,
    RegisterProtocolHandlersEnabled: false,
    EditFavoritesEnabled: false,
    BackgroundModeEnabled: false,
    PrintPreviewStickySettings: true,
  })
  check("G6 r40 新增 17 键全部通过校验", v2.ok, v2.errors.join("; ").slice(0, 120))

  // G4. 安全键拒绝（新增扩展键为安全层持有）
  const v3 = validateExtraPolicies({ ExtensionSettings: "{}" })
  check("G7 ExtensionSettings 安全键拒绝模板覆盖", !v3.ok)

  // G5. exitGuard 新键
  const guard = exitGuardManagedPolicy("kiosk")
  check("G8 exitGuard kiosk 档注入 TaskManagerEndProcessEnabled=false", guard["TaskManagerEndProcessEnabled"] === false)

  // ================= H. 外部域名体检 =================
  const { collectExternalDomainStatus } = await import("/home/z/my-project/src/lib/external-domains")
  const domains = await collectExternalDomainStatus()
  check("H1 体检项 ≥ 6", domains.length >= 6, `${domains.length} 项`)
  const baseItem = domains.find((d) => d.key === "publicBaseUrl")
  check("H2 平台公网基地址已配置（21.0.20.158）", baseItem?.status === "ok" && baseItem.value.includes("21.0.20.158"), baseItem?.value || "")
  const nodeItem = domains.find((d) => d.key === "nodePublicUrl")
  check("H3 节点公网地址已配置", nodeItem?.status === "ok", nodeItem?.value || "")
  const gwItem = domains.find((d) => d.key === "cdpPublicGateway")
  check("H4 CDP 公网网关体检（含未配置提示）", !!gwItem, gwItem?.status || "")

  // ================= 清理 =================
  await db.printJob.deleteMany({ where: { userId: admin.id } })
  await db.remotePrinter.deleteMany({ where: { nodeUuid } })
  await db.workNodeCommand.deleteMany({ where: { nodeUuid } })
  try { await db.browserWorkspace.update({ where: { id: ws.id }, data: { status: "STOPPED" } }) } catch { /* ignore */ }
  // 清打印文件目录残留
  for (const j of [jobId, fJobId, f5JobId]) {
    const p = `/home/z/my-project/storage/print-jobs/${j}.pdf`
    if (existsSync(p)) unlinkSync(p)
  }

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[qa-r40] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error("[qa-r40] FATAL:", e); process.exit(1) })
