// ============================================================
// 本轮增量冒烟测试：域名黑白名单作用域 / 批量策略下发与回滚 /
// MCP+OpenAPI 浏览器全量控制 / 管理员引导
// 直连 Server 层 + HTTP MCP/OpenAPI 双通道
// ============================================================
import { PrismaClient } from "@prisma/client"
import { createHash } from "node:crypto"

const db = new PrismaClient()

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

async function main() {
  console.log("== 0. 环境准备 ==")
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  ok("种子账号存在", !!admin && !!demo)
  if (!admin || !demo) process.exit(1)

  const group = await db.group.findFirst({ where: { deletedAt: null } })
  ok("默认用户组存在", !!group)
  if (!group) process.exit(1)

  // ============================================================
  console.log("== 1. 域名黑白名单（作用域三层解析）==")
  const { resolveDomainPolicyForUser, resolveDomainPoliciesBatch } = await import("../src/lib/domain-policy")

  // 清场
  await db.domainRule.deleteMany({ where: { OR: [{ userId: demo.id }, { groupId: group.id }] } })

  // 1.1 全局规则
  const globalCount = await db.domainRule.count({ where: { scopeType: "GLOBAL", enabled: true } })
  const basePolicy = await resolveDomainPolicyForUser(demo.id)
  ok("全局规则并入解析", basePolicy.blackPatterns.length >= Math.min(globalCount, 1), `黑名单 ${basePolicy.blackPatterns.length} 条（全局启用 ${globalCount}）`)
  ok("默认黑名单模式", basePolicy.mode === "BLACKLIST")

  // 1.2 用户级规则（含白名单触发严格模式）
  const uRule1 = await db.domainRule.create({ data: { pattern: "evil.example", type: "BLACK", scopeType: "USER", userId: demo.id, createdByUserId: admin.id } })
  const uRule2 = await db.domainRule.create({ data: { pattern: "*.trusted.example", type: "WHITE", scopeType: "USER", userId: demo.id, createdByUserId: admin.id } })
  const p2 = await resolveDomainPolicyForUser(demo.id)
  ok("用户级规则生效", p2.blackPatterns.includes("evil.example") && p2.whitePatterns.includes("*.trusted.example"))
  ok("白名单严格模式激活", p2.mode === "WHITELIST")
  ok("来源标记为 USER", p2.rules.filter((r) => r.source === "USER").length >= 2)

  // 1.3 组级规则（其他用户经组生效）
  const gRule = await db.domainRule.create({ data: { pattern: "group-block.example", type: "BLACK", scopeType: "GROUP", groupId: group.id, createdByUserId: admin.id } })
  const pAdmin = await resolveDomainPolicyForUser(admin.id)
  ok("组级规则对组成员生效", pAdmin.blackPatterns.includes("group-block.example"))

  // 1.4 批量解析
  const batch = await resolveDomainPoliciesBatch([demo.id, admin.id])
  ok("批量解析两组结果", batch.size === 2 && batch.get(demo.id)!.mode === "WHITELIST" && batch.get(admin.id)!.blackPatterns.includes("group-block.example"))

  // 1.5 Chromium 托管策略生成（白名单模式语义）
  const { buildChromiumManagedPolicy } = await import("../src/lib/network-policy")
  const managed = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    domainPolicy: p2,
  })
  const blocklist = managed.URLBlocklist as string[]
  const allowlist = managed.URLAllowlist as string[]
  ok("白名单模式 blocklist 含全量阻断 *", blocklist.includes("*"))
  ok("白名单模式 allowlist 含放行域名", allowlist.some((a) => a.includes("trusted.example")))
  ok("内网封禁模式包含 RFC1918", blocklist.includes("http://10.*") && blocklist.includes("http://192.168.*"))

  // 1.6 黑名单模式 + 白名单例外
  const managed2 = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: true, allowSecureLocationAccess: true, source: "USER", resolvedAt: new Date().toISOString() },
    domainPolicy: { ...p2, mode: "BLACKLIST" as const },
  })
  ok("黑名单例外语法 !", (managed2.URLBlocklist as string[]).some((b) => b.startsWith("!") && b.includes("trusted.example")))
  ok("内网放行时无 RFC1918 拦截", !(managed2.URLBlocklist as string[]).includes("http://10.*"))

  // 清理 1.x
  await db.domainRule.deleteMany({ where: { id: { in: [uRule1.id, uRule2.id, gRule.id] } } })

  // 清理历史残留（上次运行中断时可能遗留）
  await db.policyDeployment.deleteMany({ where: { name: { contains: "冒烟测试" } } })
  await db.domainRule.deleteMany({ where: { deploymentId: { not: null } } })
  await db.riskListRule.deleteMany({ where: { deploymentId: { not: null } } })
  await db.browserWorkspace.deleteMany({ where: { name: { startsWith: "smoke-browser-" } } })

  // ============================================================
  console.log("== 2. 批量策略下发中心（下发/快照/回滚）==")
  const { deployPolicyBundle, rollbackPolicyBundle } = await import("../src/lib/policy-engine")
  const adminOperator = { userId: admin.id, username: admin.username, role: admin.role }
  const deployPolicyAction = (input: unknown) => deployPolicyBundle(adminOperator, input)
  const rollbackDeploymentAction = (input: unknown) => rollbackPolicyBundle(adminOperator, input)

  // 2.1 下发前状态快照基线
  const demoBefore = await db.user.findUnique({ where: { id: demo.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
  const groupBefore = await db.group.findUnique({ where: { id: group.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })

  const deployRes = await deployPolicyAction({
    name: "冒烟测试批次A",
    note: "round5 smoke",
    bundle: {
      allowInternalNetwork: true,
      allowSecureLocationAccess: false,
      domainRules: { mode: "WHITELIST", patterns: ["*.company.example", "docs.company.example"] },
      ipRules: { mode: "BLACKLIST", values: ["203.0.113.0/24"] },
    },
    targetUserIds: [demo.id],
    targetGroupIds: [group.id],
  })
  ok("下发任务成功", deployRes.deploymentId !== undefined && deployRes.status === "SUCCESS")
  ok("2 个目标全部成功", deployRes.totalTargets === 2 && deployRes.successTargets === 2)
  ok("影响面统计 > 0", (deployRes.affectedUsers ?? 0) >= 2)

  const demoAfter = await db.user.findUnique({ where: { id: demo.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
  const groupAfter = await db.group.findUnique({ where: { id: group.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
  ok("用户级开关已覆盖", demoAfter?.allowInternalNetwork === true && demoAfter?.allowSecureLocationAccess === false)
  ok("组级开关已覆盖", groupAfter?.allowInternalNetwork === true && groupAfter?.allowSecureLocationAccess === false)

  const scopedRules = await db.domainRule.findMany({ where: { OR: [{ scopeType: "USER", userId: demo.id }, { scopeType: "GROUP", groupId: group.id }] } })
  ok("作用域域名规则批量落库", scopedRules.length === 4, `${scopedRules.length} 条（用户2+组2）`)
  ok("规则打批次标记", scopedRules.every((r) => !!r.deploymentId))

  const scopedIps = await db.riskListRule.findMany({ where: { OR: [{ scopeType: "USER", userId: demo.id }, { scopeType: "GROUP", groupId: group.id }] } })
  ok("作用域 IP 规则批量落库", scopedIps.length === 2 && scopedIps.every((r) => r.type === "IP_BLACK"))

  // 2.2 下发批次查询（直查库）
  const depRows = await db.policyDeployment.findMany({ where: { name: "冒烟测试批次A" } })
  ok("批次落库可查", depRows.length === 1 && depRows[0].status === "SUCCESS" && !!depRows[0].snapshotJson)
  const tplCount = await db.policyTemplate.count({ where: { builtin: true, deletedAt: null } })
  ok("内置策略模板 3 个", tplCount === 3)

  // 2.3 顺序回滚保护：先下发批次 B（相同目标），回滚 A 应被拒绝
  const deployB = await deployPolicyAction({
    name: "冒烟测试批次B",
    bundle: { allowInternalNetwork: false, allowSecureLocationAccess: null, domainRules: null, ipRules: null },
    targetUserIds: [demo.id],
    targetGroupIds: [],
  })
  ok("批次 B 下发成功", deployB.deploymentId !== undefined)
  const rollbackBlocked = await rollbackDeploymentAction({ id: deployRes.deploymentId }).catch((e: unknown) => e)
  ok("顺序回滚保护拦截", (rollbackBlocked instanceof Error) && rollbackBlocked.message.includes("更晚下发"), rollbackBlocked instanceof Error ? rollbackBlocked.message.slice(0, 60) : "")

  // 2.4 回滚 B → 回滚 A → 校验恢复
  await rollbackDeploymentAction({ id: deployB.deploymentId })
  const rollbackA = await rollbackDeploymentAction({ id: deployRes.deploymentId })
  ok("批次 A 回滚成功", rollbackA.rolledBackTargets === 2)

  const demoRestored = await db.user.findUnique({ where: { id: demo.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
  const groupRestored = await db.group.findUnique({ where: { id: group.id }, select: { allowInternalNetwork: true, allowSecureLocationAccess: true } })
  ok("用户开关已恢复", demoRestored?.allowInternalNetwork === demoBefore?.allowInternalNetwork && demoRestored?.allowSecureLocationAccess === demoBefore?.allowSecureLocationAccess)
  ok("组开关已恢复", groupRestored?.allowInternalNetwork === groupBefore?.allowInternalNetwork && groupRestored?.allowSecureLocationAccess === groupBefore?.allowSecureLocationAccess)
  const remainingRules = await db.domainRule.count({ where: { OR: [{ scopeType: "USER", userId: demo.id }, { scopeType: "GROUP", groupId: group.id }] } })
  ok("作用域规则已清空（恢复至下发前）", remainingRules === 0, `剩余 ${remainingRules}`)
  const remainingIps = await db.riskListRule.count({ where: { OR: [{ scopeType: "USER", userId: demo.id }, { scopeType: "GROUP", groupId: group.id }] } })
  ok("作用域 IP 规则已清空", remainingIps === 0)

  // 2.5 空策略包拒绝
  const emptyRes = await deployPolicyAction({
    name: "空批次", bundle: { allowInternalNetwork: null, allowSecureLocationAccess: null, domainRules: null, ipRules: null },
    targetUserIds: [demo.id], targetGroupIds: [],
  }).catch((e: unknown) => e)
  ok("空策略包被拒绝", emptyRes instanceof Error)

  // 2.6 非法域名模式拒绝
  const badRes = await deployPolicyAction({
    name: "非法域名", bundle: { allowInternalNetwork: null, allowSecureLocationAccess: null, domainRules: { mode: "BLACKLIST", patterns: ["bad domain!"] }, ipRules: null },
    targetUserIds: [demo.id], targetGroupIds: [],
  }).catch((e: unknown) => e)
  ok("非法域名模式被拒绝", badRes instanceof Error && badRes.message.includes("非法域名"))

  // 2.7 空白名单拒绝
  const emptyWhite = await deployPolicyAction({
    name: "空白名单", bundle: { allowInternalNetwork: null, allowSecureLocationAccess: null, domainRules: { mode: "WHITELIST", patterns: [] }, ipRules: null },
    targetUserIds: [demo.id], targetGroupIds: [],
  }).catch((e: unknown) => e)
  ok("空白名单被拒绝", emptyWhite instanceof Error && emptyWhite.message.includes("白名单模式下名单不能为空"))

  // 2.8 审计落库
  const audits = await db.auditLog.count({ where: { operationType: "POLICY_DEPLOY", createdAt: { gte: new Date(Date.now() - 5 * 60_000) } } })
  ok("策略下发审计已落库", audits >= 2, `${audits} 条`)

  // ============================================================
  console.log("== 3. 浏览器全量控制层（直连执行）==")
  const { executeBrowserAction, BROWSER_ACTIONS, listBrowserActions } = await import("../src/lib/external/cdp-control")

  ok("动作注册表 ≥ 30", BROWSER_ACTIONS.length >= 30, `${BROWSER_ACTIONS.length} 个`)
  const catalog = listBrowserActions()
  ok("目录输出一致", catalog.length === BROWSER_ACTIONS.length)

  // 建一个 cdp_light 工作区（demo 名下）——直接走 steel 库 + db（脚本无请求作用域）
  const { createSession } = await import("../src/lib/external/steel")
  const steelSession = await createSession({ ttlMinutes: 30 })
  const wsRow = await db.browserWorkspace.create({
    data: {
      name: `smoke-browser-${Date.now().toString(36)}`,
      mode: "cdp_light",
      status: "RUNNING",
      userId: demo.id,
      groupId: group.id,
      ttlMinutes: 30,
      idleTimeoutMinutes: 30,
      steelSessionId: steelSession.sessionId,
      cdpUrl: steelSession.cdpUrl,
      steelNodeId: null,
      createdByUserId: demo.id,
    },
  })
  const wsId = wsRow.id
  ok("工作区创建成功", !!wsId && !!steelSession.cdpUrl, `sim=${steelSession.simulated}`)

  const ctx = { userId: demo.id, username: demo.username, isAdmin: false, via: "MCP" as const }

  // 3.1 归属强制：admin 无关用户?（admin 拥有 ADMIN 视为放行——用普通用户视角测另一用户工作区）
  const otherCtx = { userId: admin.id, username: admin.username, isAdmin: false, via: "MCP" as const }
  const denied = await executeBrowserAction({ action: "status", workspaceIdOrUuid: wsId, ctx: otherCtx, params: {} }).catch((e) => e.message)
  ok("跨用户控制被拒绝", typeof denied === "string" && denied.includes("无权控制"), String(denied).slice(0, 50))

  // 3.2 status
  const statusRes = await executeBrowserAction({ action: "status", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("status 返回模拟模式", (statusRes.data as { mode?: string })?.mode === "SIMULATED" && statusRes.durationMs >= 0)

  // 3.3 navigate + 拦截
  const nav = await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "https://example.com/hello" } })
  ok("navigate 成功", (nav.data as { navigated?: boolean })?.navigated === true)
  const badProto = await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "file:///etc/passwd" } }).catch((e) => e.message)
  ok("file:// 协议被安全策略拒绝", badProto.includes("已被安全策略禁止"))

  // 3.4 block_urls + 拦截导航
  await executeBrowserAction({ action: "block_urls", workspaceIdOrUuid: wsId, ctx, params: { patterns: ["blocked.example"] } })
  const blockedNav = await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "https://blocked.example/x" } })
  ok("运行时黑名单拦截导航", (blockedNav.data as { blocked?: boolean })?.blocked === true)

  // 3.5 白名单严格模式
  await executeBrowserAction({ action: "allow_urls", workspaceIdOrUuid: wsId, ctx, params: { patterns: ["allow.example"] } })
  const allowNav = await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "https://allow.example/ok" } })
  ok("白名单内放行", (allowNav.data as { blocked?: boolean })?.blocked === false)
  const denyNav = await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "https://other.example/nope" } })
  ok("白名单外拦截", (denyNav.data as { blocked?: boolean })?.blocked === true)
  await executeBrowserAction({ action: "clear_url_filters", workspaceIdOrUuid: wsId, ctx, params: {} })

  // 3.6 screenshot（真实 PNG base64）
  const shot = await executeBrowserAction({ action: "screenshot", workspaceIdOrUuid: wsId, ctx, params: {} })
  const shotData = shot.data as { dataBase64?: string; format?: string }
  ok("screenshot 返回 PNG", shotData?.format === "png" && (shotData?.dataBase64?.length ?? 0) > 1000, `base64 ${Math.round((shotData?.dataBase64?.length ?? 0) / 1024)}KB`)

  // 3.7 scrape 三模式
  const scrapeText = await executeBrowserAction({ action: "scrape", workspaceIdOrUuid: wsId, ctx, params: { mode: "text" } })
  ok("scrape text", typeof (scrapeText.data as { content?: string })?.content === "string" && ((scrapeText.data as { content?: string }).content ?? "").length > 0)
  const scrapeLinks = await executeBrowserAction({ action: "scrape", workspaceIdOrUuid: wsId, ctx, params: { mode: "links" } })
  ok("scrape links", Array.isArray((scrapeLinks.data as { links?: unknown[] })?.links))

  // 3.8 evaluate 白名单安全求值
  const evalTitle = await executeBrowserAction({ action: "evaluate", workspaceIdOrUuid: wsId, ctx, params: { expression: "document.title" } })
  ok("evaluate document.title", typeof (evalTitle.data as { result?: unknown })?.result === "string")
  const evalArith = await executeBrowserAction({ action: "evaluate", workspaceIdOrUuid: wsId, ctx, params: { expression: "6*7" } })
  ok("evaluate 算术表达式", (evalArith.data as { result?: unknown })?.result === 42)
  const evalDanger = await executeBrowserAction({ action: "evaluate", workspaceIdOrUuid: wsId, ctx, params: { expression: "process.exit(1)" } })
  ok("任意代码模拟环境不执行（返回说明）", (evalDanger.data as { note?: string })?.note?.includes("白名单") === true)

  // 3.9 输入：click / type / press_key / scroll / hover
  const click = await executeBrowserAction({ action: "click", workspaceIdOrUuid: wsId, ctx, params: { selector: "#submit-btn" } })
  ok("click 选择器命中", (click.data as { clicked?: boolean })?.clicked === true && (click.data as { node?: string })?.node === "button")
  const clickMiss = await executeBrowserAction({ action: "click", workspaceIdOrUuid: wsId, ctx, params: { selector: "#not-exist" } }).catch((e) => e.message)
  ok("click 未命中报错", clickMiss.includes("选择器未命中"))
  const type = await executeBrowserAction({ action: "type", workspaceIdOrUuid: wsId, ctx, params: { selector: "#search-input", text: "中文输入测试" } })
  ok("type 中文输入", (type.data as { typed?: number })?.typed === "中文输入测试".length)
  const key = await executeBrowserAction({ action: "press_key", workspaceIdOrUuid: wsId, ctx, params: { key: "Enter" } })
  ok("press_key Enter", (key.data as { keyCode?: number })?.keyCode === 13)
  const scroll = await executeBrowserAction({ action: "scroll", workspaceIdOrUuid: wsId, ctx, params: { dy: 500 } })
  ok("scroll", (scroll.data as { scrolled?: boolean })?.scrolled === true)
  const hover = await executeBrowserAction({ action: "hover", workspaceIdOrUuid: wsId, ctx, params: { selector: "a" } })
  ok("hover", (hover.data as { hovered?: boolean })?.hovered === true)

  // 3.10 标签页管理
  const tab1 = await executeBrowserAction({ action: "new_tab", workspaceIdOrUuid: wsId, ctx, params: { url: "https://example.com/tab2" } })
  const tab1Id = (tab1.data as { targetId?: string })?.targetId
  ok("new_tab", !!tab1Id)
  const tabs = await executeBrowserAction({ action: "get_tabs", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("get_tabs ≥ 2", ((tabs.data as { tabs?: unknown[] })?.tabs?.length ?? 0) >= 2)
  const act = await executeBrowserAction({ action: "activate_tab", workspaceIdOrUuid: wsId, ctx, params: { targetId: tab1Id } })
  ok("activate_tab", (act.data as { activated?: string })?.activated === tab1Id)
  const close = await executeBrowserAction({ action: "close_tab", workspaceIdOrUuid: wsId, ctx, params: { targetId: tab1Id } })
  ok("close_tab", (close.data as { closed?: string })?.closed === tab1Id)

  // 3.11 历史 back/forward/reload
  await executeBrowserAction({ action: "navigate", workspaceIdOrUuid: wsId, ctx, params: { url: "https://example.com/page2" } })
  const back = await executeBrowserAction({ action: "back", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("back 返回上一页", !(back.data as { url?: string })?.url?.includes("page2") && !!(back.data as { url?: string })?.url, (back.data as { url?: string })?.url)
  const fwd = await executeBrowserAction({ action: "forward", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("forward", (fwd.data as { url?: string })?.url?.includes("page2") === true)
  const reload = await executeBrowserAction({ action: "reload", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("reload", (reload.data as { reloaded?: boolean })?.reloaded === true)

  // 3.12 cookies / throttle / UA / viewport / geolocation / headers / wait_for / logs / dom_snapshot
  await executeBrowserAction({ action: "set_cookies", workspaceIdOrUuid: wsId, ctx, params: { cookies: [{ name: "session", value: "abc123", domain: "example.com" }] } })
  const cookies = await executeBrowserAction({ action: "get_cookies", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("set/get cookies（值脱敏）", ((cookies.data as { cookies?: Array<{ name?: string; value?: string }> })?.cookies?.some((c) => c.name === "session" && (c.value?.includes("…") || c.value === "***")) === true))

  const throttle = await executeBrowserAction({ action: "throttle", workspaceIdOrUuid: wsId, ctx, params: { downKbps: 512.001, upKbps: 256.001, latencyMs: 120.001, offline: false } })
  ok("throttle 0.001 精度", JSON.stringify((throttle.data as { throttle?: unknown })?.throttle).includes("512.001"))
  const ua = await executeBrowserAction({ action: "set_user_agent", workspaceIdOrUuid: wsId, ctx, params: { userAgent: "Mozilla/5.0 (TestUA) Chrome/126.0.0.0" } })
  ok("set_user_agent", (ua.data as { userAgent?: string })?.userAgent?.includes("TestUA") === true)
  const vp = await executeBrowserAction({ action: "set_viewport", workspaceIdOrUuid: wsId, ctx, params: { width: 1920, height: 1080 } })
  ok("set_viewport", (vp.data as { width?: number })?.width === 1920)
  const geo = await executeBrowserAction({ action: "set_geolocation", workspaceIdOrUuid: wsId, ctx, params: { latitude: 31.23, longitude: 121.47 } })
  ok("set_geolocation", (geo.data as { latitude?: number })?.latitude === 31.23)
  const geoBad = await executeBrowserAction({ action: "set_geolocation", workspaceIdOrUuid: wsId, ctx, params: { latitude: 999, longitude: 0 } }).catch((e) => e.message)
  ok("经纬度越界拒绝", geoBad.includes("经纬度超界"))
  const headers = await executeBrowserAction({ action: "set_extra_headers", workspaceIdOrUuid: wsId, ctx, params: { headers: { "X-Dockyard": "smoke" } } })
  ok("set_extra_headers", (headers.data as { headers?: unknown }) !== undefined)
  const hdrBad = await executeBrowserAction({ action: "set_extra_headers", workspaceIdOrUuid: wsId, ctx, params: { headers: { Host: "evil" } } }).catch((e) => e.message)
  ok("保留头 Host 拒绝覆盖", hdrBad.includes("保留头"))
  const waitOk = await executeBrowserAction({ action: "wait_for", workspaceIdOrUuid: wsId, ctx, params: { selector: "h1", timeoutMs: 2000 } })
  ok("wait_for 选择器立即命中", (waitOk.data as { matched?: boolean })?.matched === true)
  const logs = await executeBrowserAction({ action: "get_logs", workspaceIdOrUuid: wsId, ctx, params: { kind: "network", tail: 10 } })
  ok("get_logs 网络日志", ((logs.data as { entries?: unknown[] })?.entries?.length ?? 0) > 0)
  const dom = await executeBrowserAction({ action: "dom_snapshot", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("dom_snapshot 节点输出", ((dom.data as { nodes?: unknown[] })?.nodes?.length ?? 0) > 0)
  const dbg = await executeBrowserAction({ action: "debug_info", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("debug_info", (dbg.data as { mode?: string })?.mode === "SIMULATED")
  const urlNow = await executeBrowserAction({ action: "get_url", workspaceIdOrUuid: wsId, ctx, params: {} })
  ok("get_url", typeof (urlNow.data as { url?: string })?.url === "string")

  // 3.13 审计与活跃时间
  const ctrlAudits = await db.auditLog.count({ where: { operationType: "BROWSER_CONTROL", resourceId: wsId } })
  ok("浏览器控制全量审计", ctrlAudits >= 25, `${ctrlAudits} 条`)
  const wsAfter = await db.browserWorkspace.findUnique({ where: { id: wsId }, select: { cdpCallCount: true, updatedAt: true } })
  ok("工作区活跃计数已更新", (wsAfter?.cdpCallCount ?? 0) >= 25 && Date.now() - (wsAfter?.updatedAt?.getTime() ?? 0) < 120_000, `cdpCallCount=${wsAfter?.cdpCallCount}`)

  // ============================================================
  console.log("== 4. HTTP 通道（MCP + OpenAPI 浏览器控制）==")
  // 为 demo 造 API Token（全权限）
  const apiKey = "dk-smoke-" + createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 24)
  await db.apiToken.create({
    data: {
      userId: demo.id,
      name: "round5-smoke",
      tokenHash: createHash("sha256").update(apiKey).digest("hex"),
      tokenPrefix: apiKey.slice(0, 8),
      permissionsMask: 1 | 2 | 4 | 8,
      enabled: true,
      createdByUserId: demo.id,
    },
  })

  const base = "http://127.0.0.1:3000"
  // 4.1 MCP tools/list 包含 browser.*
  const toolsList = await (await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })).json()
  const tools = (toolsList?.result?.data?.tools ?? []) as Array<{ name: string }>
  const browserTools = tools.filter((t) => t.name.startsWith("browser."))
  ok("MCP tools/list 含 browser.* 全集", browserTools.length >= 30, `${browserTools.length} 个`)

  // 4.2 MCP browser.navigate（批量任务通道）
  const mcpNav = await (await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ code: "browser.navigate", params: { url: "https://mcp.example.com/round5" }, targets: [wsId] }),
  })).json()
  ok("MCP browser.navigate 成功", mcpNav?.code === 0 && mcpNav?.data?.successItems === 1, mcpNav?.msg)

  // 4.3 task.status 回查结果载荷
  const taskUuid = mcpNav?.data?.taskUuid
  const taskDetail = await (await fetch(`${base}/api/mcp?view=task&uuid=${taskUuid}`, {
    headers: { "x-api-key": apiKey },
  })).json()
  const taskData = taskDetail?.data
  ok("task.status 含 result.data 载荷", taskData?.result?.data?.data?.navigated === true)

  // 4.4 OpenAPI REST 网关
  const restStatus = await (await fetch(`${base}/api/openapi/browser/status`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: wsId, params: {} }),
  })).json()
  ok("OpenAPI REST status 成功", restStatus?.code === 0 && restStatus?.data?.mode === "SIMULATED")

  const restShot = await (await fetch(`${base}/api/openapi/browser/screenshot`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: wsId, params: {} }),
  })).json()
  ok("OpenAPI REST screenshot", restShot?.code === 0 && (restShot?.data?.data?.dataBase64?.length ?? 0) > 1000)

  const restUnknown = await fetch(`${base}/api/openapi/browser/nonexistent_action`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: wsId, params: {} }),
  })
  ok("未知动作 404", restUnknown.status === 404)

  const restNoAuth = await fetch(`${base}/api/openapi/browser/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: wsId, params: {} }),
  })
  ok("无 APIKey 401", restNoAuth.status === 401)

  // 4.5 目录与文档
  const catalogHttp = await (await fetch(`${base}/api/openapi/browser`)).json()
  ok("动作目录公开可读", catalogHttp?.code === 0 && (catalogHttp?.data?.actions?.length ?? 0) >= 30)
  const doc = await (await fetch(`${base}/api/openapi/doc`)).json()
  ok("OpenAPI 文档含 Browser Control 端点组", Object.keys(doc?.paths ?? {}).some((p) => p.startsWith("/api/openapi/browser/")))
  ok("文档 x-browser-actions 扩展", (doc?.["x-browser-actions"]?.length ?? 0) >= 30)

  // 4.6 MCP 权限位拦截（READ-only token 不能 EXECUTE）
  const readKey = "dk-read-" + createHash("sha256").update(String(Date.now() + 1)).digest("hex").slice(0, 24)
  await db.apiToken.create({
    data: {
      userId: demo.id, name: "round5-read", tokenHash: createHash("sha256").update(readKey).digest("hex"),
      tokenPrefix: readKey.slice(0, 8), permissionsMask: 1, enabled: true, createdByUserId: demo.id,
    },
  })
  const deniedExec = await (await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "x-api-key": readKey, "Content-Type": "application/json" },
    body: JSON.stringify({ code: "browser.navigate", params: { url: "https://x.example.com" }, targets: [wsId] }),
  })).json()
  ok("READ-only Token 执行被拒", deniedExec?.code !== 0, deniedExec?.msg)

  // ============================================================
  console.log("== 5. 管理员引导 ==")
  const { getBootstrapState, registerFirstAdmin } = await import("../src/lib/bootstrap")

  // 5.1 现有管理员存在 → needsSetup false
  const bs = await getBootstrapState()
  ok("已有管理员 → 引导关闭", bs.hasAdmin === true && bs.needsSetup === false)

  // 5.2 已有管理员时 registerFirstAdmin 拒绝
  const regDenied = await registerFirstAdmin({ username: "hacker", password: "Abc123456789" })
  ok("已有管理员时注册被拒绝", regDenied.ok === false && regDenied.message.includes("已存在"))

  // 5.3 弱密码拒绝（临时清空库不可行——用函数直接验证）
  const weak = await registerFirstAdmin({ username: "weakpw", password: "abc" })
  ok("弱密码被拒绝", weak.ok === false)

  // 5.4 HTTP：/setup 页面跳转（已有管理员 → 307 到 /login）
  const setupRes = await fetch(`${base}/setup`, { redirect: "manual" })
  ok("/setup 已初始化时重定向登录", setupRes.status === 307 || setupRes.status === 302, `HTTP ${setupRes.status}`)

  // 5.5 登录页渲染
  const loginRes = await fetch(`${base}/login`)
  ok("登录页 200", loginRes.status === 200)

  // ============================================================
  // 清理
  await db.apiToken.deleteMany({ where: { name: { in: ["round5-smoke", "round5-read"] } } })
  if (wsId) await db.browserWorkspace.delete({ where: { id: wsId } })
  await db.policyDeployment.deleteMany({ where: { name: { in: ["冒烟测试批次A", "冒烟测试批次B", "空批次", "非法域名", "空白名单"] } } })
  await db.domainRule.deleteMany({ where: { deploymentId: { not: null } } })
  await db.riskListRule.deleteMany({ where: { deploymentId: { not: null } } })

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`)
  if (failures.length > 0) {
    console.log("失败项：")
    for (const f of failures) console.log("  ✗ " + f)
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error("冒烟测试崩溃：", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
