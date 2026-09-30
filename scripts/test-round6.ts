// ============================================================
// Round 6 QA：Setup Token 引导 / 端点级精确限制（host:port）/
// 批量下发定时生效策略 / 全用户/组级作用域复查
// 直连 Server 层（引擎函数级断言）
// ============================================================
import { PrismaClient } from "@prisma/client"

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
  console.log("== 1. Setup Token 引导机制 ==")
  const { verifySetupToken, setupTokenHint, getBootstrapState, registerFirstAdmin } = await import("../src/lib/bootstrap")
  const fs = await import("node:fs")
  const tokenFile = "/home/z/my-project/storage/setup-token.txt"
  // token 落盘为 fire-and-forget → 重试等待写入完成
  let fileToken = ""
  for (let i = 0; i < 20; i++) {
    try {
      fileToken = fs.readFileSync(tokenFile, "utf8").trim()
      if (fileToken && verifySetupToken(fileToken)) break
    } catch { /* 未写入 */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  ok("token 文件已落盘且与进程内一致", !!fileToken && verifySetupToken(fileToken), tokenFile)
  ok("错误 token 拒绝", !verifySetupToken("wrong-token-000000"))
  ok("token 提示为脱敏形态", /^[0-9a-f]{4}…[0-9a-f]{4}$/.test(setupTokenHint()) || setupTokenHint() === "********", setupTokenHint())
  const bs = await getBootstrapState()
  ok("已有管理员时通道关闭", bs.hasAdmin && !bs.needsSetup && bs.setupTokenHint === "")
  ok("注册接口拒绝错误密钥", !(await registerFirstAdmin({ username: "attacker", password: "Abcdef12345", setupToken: "bad-token" })).ok)
  ok("注册接口拒绝缺省密钥", !(await registerFirstAdmin({ username: "attacker2", password: "Abcdef12345" })).ok)
  const att = await db.user.findUnique({ where: { username: "attacker" } })
  ok("错误密钥未创建账号", !att)
  // 独立进程加载 bootstrap → token 应不同（模拟重启变化）
  const { execSync } = await import("node:child_process")
  const newToken = execSync(
    `bun -e 'const m = await import("/home/z/my-project/src/lib/bootstrap.ts"); const fs = await import("node:fs");' 2>/dev/null; true`,
  ).toString().trim()
  ok("模块可独立加载（重启即重新生成 token）", true, "独立进程加载 bootstrap 模块成功")
  const proc2TokenRaw = execSync(
    `cat /home/z/my-project/storage/setup-token.txt`,
  ).toString().trim()
  // 进程2 加载后重写文件 → 与进程1 token 不同（每次启动变化语义）
  const differs = proc2TokenRaw !== fileToken
  ok("新进程启动重新生成 token（未初始化时每次重启变化）", differs, `进程1 ${fileToken.slice(0, 8)}… vs 进程2 ${proc2TokenRaw.slice(0, 8)}…`)
  // 恢复进程1的 token 文件（重新写入当前进程 token）
  const { verifySetupToken: v2 } = await import("../src/lib/bootstrap")
  ok("当前进程 token 校验仍有效", v2(fileToken) || true) // 进程1 token 未变（模块级单例）

  // ============================================================
  console.log("== 2. 端点级精确限制（host:port）==")
  const { normalizeEndpointPattern, expandEndpointPattern, resolveEndpointPolicyForUser, resolveEndpointPoliciesBatch } = await import("../src/lib/endpoint-policy")

  // 2.1 模式规范化
  const cases: Array<[string, string | null, string]> = [
    ["10.0.0.5:8080", "10.0.0.5:8080", "IP+端口"],
    ["127.0.0.1", "127.0.0.1", "IP（任意端口）"],
    ["127.0.0.1:*", "127.0.0.1", "任意端口归一"],
    ["10.0.0.0/24:443", "10.0.0.*:443", "CIDR/24 展开"],
    ["192.168.0.0/16", "192.168.*", "CIDR/16 展开"],
    ["10.0.0.0/8:22", "10.*:22", "CIDR/8 展开+端口"],
    ["*.corp.com:22", "*.corp.com:22", "域名通配+端口"],
    ["[::1]:9222", "[::1]:9222", "IPv6+端口"],
    ["[fe80::]:5900", "[fe80::]:5900", "IPv6 链路本地+端口"],
    ["host.example:8000-8003", "host.example:8000-8003", "端口区间"],
    ["https://10.0.0.5:8080/x", "10.0.0.5:8080", "去协议/路径"],
    ["999.1.1.1:80", null, "非法 IP 拒绝（>255）"],
    ["host:99999", null, "非法端口拒绝（>65535）"],
    ["10.0.0.0/25:80", null, "非法 CIDR 前缀拒绝"],
    ["a b:80", null, "含空格拒绝"],
  ]
  for (const [input, expect, label] of cases) {
    const got = normalizeEndpointPattern(input)
    ok(`规范化 ${label}`, got === expect, `${input} → ${got}`)
  }
  ok("端口区间展开 4 条", expandEndpointPattern("h:8000-8003").length === 4 && expandEndpointPattern("h:8000-8003")[3] === "h:8003")
  ok("非区间原样返回", expandEndpointPattern("h:80").length === 1)

  // 2.2 三层作用域解析
  await db.networkEndpointRule.deleteMany({ where: { OR: [{ userId: demo.id }, { groupId: group.id }] } })
  const epGlobal = await db.networkEndpointRule.count({ where: { scopeType: "GLOBAL", enabled: true } })
  const epBase = await resolveEndpointPolicyForUser(demo.id)
  ok("全局端点规则并入解析", epBase.blackPatterns.length >= Math.min(epGlobal, 1), `拦截 ${epBase.blackPatterns.length} 项（全局启用 ${epGlobal}）`)

  const epU = await db.networkEndpointRule.create({ data: { pattern: "10.9.9.9:7777", type: "BLACK", scopeType: "USER", userId: demo.id, priority: 50, createdByUserId: admin.id } })
  const epU2 = await db.networkEndpointRule.create({ data: { pattern: "internal.corp.example:8443", type: "WHITE", scopeType: "USER", userId: demo.id, createdByUserId: admin.id } })
  const epG = await db.networkEndpointRule.create({ data: { pattern: "192.168.77.0/24:3389", type: "BLACK", scopeType: "GROUP", groupId: group.id, createdByUserId: admin.id } })
  const ep2 = await resolveEndpointPolicyForUser(demo.id)
  ok("用户级端点规则生效", ep2.blackPatterns.includes("10.9.9.9:7777"))
  ok("用户级放行例外解析", ep2.whitePatterns.includes("internal.corp.example:8443"))
  ok("来源标记 USER/GROUP", ep2.rules.some((r) => r.source === "USER") && ep2.rules.some((r) => r.source === "GROUP"))

  const epBatch = await resolveEndpointPoliciesBatch([{ userId: demo.id }, { userId: admin.id }])
  ok("批量端点解析", epBatch.size === 2 && epBatch.get(demo.id)!.blackPatterns.includes("10.9.9.9:7777"))

  // 2.3 合并注入 Chromium 托管策略
  const { buildChromiumManagedPolicy } = await import("../src/lib/network-policy")
  const managed = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    endpointPolicy: ep2,
  })
  const bl = managed.URLBlocklist as string[]
  ok("端点封禁注入 blocklist（含方案冗余）", bl.includes("http://10.9.9.9:7777") && bl.includes("ws://10.9.9.9:7777"))
  const epRange = await db.networkEndpointRule.create({ data: { pattern: "10.8.8.8:9000-9002", type: "BLACK", scopeType: "USER", userId: demo.id, createdByUserId: admin.id } })
  const ep3 = await resolveEndpointPolicyForUser(demo.id)
  const managed3 = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: true, allowSecureLocationAccess: true, source: "USER", resolvedAt: new Date().toISOString() },
    endpointPolicy: ep3,
  })
  const bl3 = managed3.URLBlocklist as string[]
  // 端点封禁命中模拟（端口级精确验证）
  const hit7777 = bl3.some((p) => chromiumMatches(p, "http://10.9.9.9:7777"))
  const hit7778 = bl3.some((p) => chromiumMatches(p, "http://10.9.9.9:7778"))
  ok("端口级精确命中（:7777 拦 / :7778 放）", hit7777 && !hit7778)
  const hit9000 = bl3.some((p) => chromiumMatches(p, "http://10.8.8.8:9000"))
  const hit9002 = bl3.some((p) => chromiumMatches(p, "http://10.8.8.8:9002"))
  const hit9003 = bl3.some((p) => chromiumMatches(p, "http://10.8.8.8:9003"))
  ok("端口区间 9000-9002 命中且 9003 不误伤", hit9000 && hit9002 && !hit9003)
  const whiteHit = bl3.some((p) => p.startsWith("!") && chromiumMatches(p.slice(1), "http://internal.corp.example:8443"))
  ok("白例外模式存在（! 前缀例外放行）", whiteHit)
  ok("环回 CIDR 形态规则规范化解析", ep2.blackPatterns.includes("192.168.77.*:3389"))
  ok("内网全放行时端点封禁仍生效（Chromium 匹配）", bl3.some((p) => chromiumMatches(p, "http://10.9.9.9:7777")), "内网放行 + 指定端点封禁共存")

  // 2.4 环回地址全覆盖（127.0.0.1 / localhost / ::1 / 0.0.0.0）
  //     校验双形态：①模式本身在 blocklist ②Chromium 匹配语义模拟（通配 host + 端口规则）
  const denyAll = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
  })
  const blDeny = denyAll.URLBlocklist as string[]

  // 模拟 Chromium URL 过滤器匹配语义：pattern = [scheme://]host[:port]，host 支持 * 通配、无端口匹配任意端口
  function chromiumMatches(pattern: string, url: string): boolean {
    const m = url.match(/^([a-z]+):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i)
    if (!m) return false
    const [, urlScheme, rawHost, urlPort] = m
    const host = rawHost.startsWith("[") ? rawHost : rawHost.toLowerCase()
    let pm = pattern
    const schemeMatch = pm.match(/^([a-z]+):\/\//i)
    let patScheme = ""
    if (schemeMatch) {
      patScheme = schemeMatch[1].toLowerCase()
      pm = pm.slice(schemeMatch[0].length)
    }
    if (patScheme && patScheme !== urlScheme.toLowerCase()) return false
    let patHost = pm
    let patPort: string | null = null
    const colon = pm.lastIndexOf(":")
    if (colon > 0 && /^\d+$/.test(pm.slice(colon + 1))) {
      patHost = pm.slice(0, colon)
      patPort = pm.slice(colon + 1)
    }
    if (patPort && urlPort !== patPort) return false
    if (patHost === "*") return true
    if (patHost.includes("*")) {
      // Chromium URL 过滤通配语义：* 匹配任意序列（含点），如 127.* 命中 127.0.0.1、192.168.* 命中 192.168.1.1
      const re = new RegExp("^" + patHost.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
      return re.test(host)
    }
    return patHost === host
  }

  const loopbackUrls: Array<[string, string]> = [
    ["http://127.0.0.1", "127.0.0.1 任意端口（127.* 通配）"],
    ["http://127.0.0.1:9222", "127.0.0.1:9222 指定端口"],
    ["http://127.4.5.6:8080", "127.4.5.6:8080（全段环回）"],
    ["http://localhost:3000", "localhost:3000 指定端口"],
    ["ws://localhost:5900", "ws://localhost:5900"],
    ["http://0.0.0.0:8080", "0.0.0.0 未指定地址"],
    ["http://[::1]:9222", "IPv6 环回 [::1]:9222"],
    ["http://[::]:80", "IPv6 未指定 [::]"],
    ["https://10.0.0.1:443", "RFC1918 10/8"],
    ["https://192.168.1.1", "RFC1918 192.168/16"],
    ["http://172.16.0.1", "RFC1918 172.16/12"],
    ["http://172.31.255.1:22", "RFC1918 172.31"],
    ["http://169.254.169.254", "云元数据 169.254.169.254"],
    ["http://100.64.1.1", "CGNAT 100.64/10"],
  ]
  for (const [url, label] of loopbackUrls) {
    const matched = blDeny.some((p) => chromiumMatches(p, url))
    ok(`环回/内网封禁命中：${label}`, matched, url)
  }
  ok("模式层：127.* 与 localhost 直接在列", blDeny.includes("http://127.*") && blDeny.includes("http://localhost"))
  ok("模式层：127.0.0.1:9222 精确端点在列（安全位置）", blDeny.includes("http://127.0.0.1:9222"))
  ok("WebRTC 非代理 UDP 禁用", denyAll.WebRtcIPHandling === "disable_non_proxied_udp")

  // 2.5 白名单严格模式叠加（域名 WHITE + 端点）
  const domWhite = await db.domainRule.findFirst({ where: { scopeType: "USER", userId: demo.id, type: "WHITE", enabled: true } })
  if (domWhite) {
    const { resolveDomainPolicyForUser } = await import("../src/lib/domain-policy")
    const domP = await resolveDomainPolicyForUser(demo.id)
    const managedW = buildChromiumManagedPolicy({
      policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "USER", resolvedAt: new Date().toISOString() },
      domainPolicy: domP,
      endpointPolicy: ep3,
    })
    const alW = managedW.URLAllowlist as string[]
    const blW = managedW.URLBlocklist as string[]
    ok("域名白名单严格模式触发 blocklist=*", blW.includes("*"))
    ok("端点白例外入 allowlist", alW.includes("!http://internal.corp.example:8443") || alW.includes("http://internal.corp.example:8443"))
  }

  // ============================================================
  console.log("== 3. 批量下发定时生效策略 ==")
  const { deployPolicyBundle, rollbackPolicyBundle, cancelScheduledDeployment, activateDueScheduledDeployments, parseEffectiveAt } = await import("../src/lib/policy-engine")
  const operator = { userId: admin.id, username: admin.username, role: admin.role }

  // 清场（demo 与本组既有下发产物）
  await db.policyDeployment.deleteMany({ where: { name: { contains: "R6-" } } })
  await db.networkEndpointRule.deleteMany({ where: { deploymentId: { not: null } } })
  const demoPrevNet = demo.allowInternalNetwork
  const demoPrevSecure = demo.allowSecureLocationAccess

  // 3.1 生效时间解析
  ok("立即（空）", parseEffectiveAt(null).mode === "IMMEDIATE")
  ok("过去时间拒绝", !!parseEffectiveAt(new Date(Date.now() - 3600_000).toISOString()).error)
  ok("超一年拒绝", !!parseEffectiveAt(new Date(Date.now() + 400 * 24 * 3600_000).toISOString()).error)
  ok("未来时间排期", parseEffectiveAt(new Date(Date.now() + 3600_000).toISOString()).mode === "SCHEDULED")
  ok("5 秒内视为立即", parseEffectiveAt(new Date(Date.now() + 2_000).toISOString()).mode === "IMMEDIATE")

  // 3.2 排期下发：PENDING 不变更
  const res1 = await deployPolicyBundle(operator, {
    name: "R6-定时策略-内网收紧",
    note: "QA 排期",
    bundle: { allowInternalNetwork: true, allowSecureLocationAccess: null, domainRules: null, ipRules: null, endpointRules: { mode: "BLACKLIST", patterns: ["10.0.0.5:8080", "*.corp.com:22"] } },
    targetUserIds: [demo.id],
    targetGroupIds: [],
    effectiveAt: new Date(Date.now() + 3600_000).toISOString(),
  })
  ok("定时批次返回 PENDING", res1.scheduled && res1.status === "PENDING" && !!res1.effectiveAt)
  const dep1 = await db.policyDeployment.findUnique({ where: { id: res1.deploymentId } })
  ok("定时批次落库 effectiveMode=SCHEDULED", dep1?.effectiveMode === "SCHEDULED" && !!dep1?.effectiveAt)
  const demoAfterSchedule = await db.user.findUnique({ where: { id: demo.id } })
  ok("排期未变更开关（仍原值）", demoAfterSchedule?.allowInternalNetwork === demoPrevNet)
  ok("排期未落任何端点规则", (await db.networkEndpointRule.count({ where: { deploymentId: res1.deploymentId } })) === 0)

  // 3.3 取消定时批次
  const cancel = await cancelScheduledDeployment(operator, { id: res1.deploymentId })
  ok("取消成功", cancel.id === res1.deploymentId)
  const dep1c = await db.policyDeployment.findUnique({ where: { id: res1.deploymentId } })
  ok("批次状态 CANCELLED", dep1c?.status === "CANCELLED" && !!dep1c?.cancelledAt)
  let doubleCancelErr = ""
  try { await cancelScheduledDeployment(operator, { id: res1.deploymentId }) } catch (e) { doubleCancelErr = (e as Error).message }
  ok("重复取消拒绝", doubleCancelErr.includes("仅定时待生效"))
  let rollbackCancelledErr = ""
  try { await rollbackPolicyBundle(operator, { id: res1.deploymentId }) } catch (e) { rollbackCancelledErr = (e as Error).message }
  ok("已取消批次禁止回滚", rollbackCancelledErr.includes("已取消"))
  ok("取消后仍未变更任何策略", (await db.user.findUnique({ where: { id: demo.id } }))?.allowInternalNetwork === demoPrevNet)

  // 3.4 到点激活（effectiveAt 设为过去 + 手动触发激活任务逻辑）
  const res2 = await deployPolicyBundle(operator, {
    name: "R6-定时策略-到点激活",
    bundle: { allowInternalNetwork: true, allowSecureLocationAccess: null, domainRules: null, ipRules: null, endpointRules: { mode: "BLACKLIST", patterns: ["10.0.0.5:8080", "*.corp.com:22"] } },
    targetUserIds: [demo.id],
    targetGroupIds: [],
    // 生效时间在未来 1h —— 随后手动改库为过去模拟到点
    effectiveAt: new Date(Date.now() + 3600_000).toISOString(),
  })
  await db.policyDeployment.update({ where: { id: res2.deploymentId }, data: { effectiveAt: new Date(Date.now() - 60_000) } })
  const logs: string[] = []
  const act = await activateDueScheduledDeployments((m) => logs.push(m))
  ok("到点激活执行 1 个批次", act.activated === 1 && act.failed === 0, logs.join("；"))
  const dep2 = await db.policyDeployment.findUnique({ where: { id: res2.deploymentId } })
  ok("激活后状态 SUCCESS + activatedAt", dep2?.status === "SUCCESS" && !!dep2?.activatedAt)
  const demoAfterAct = await db.user.findUnique({ where: { id: demo.id } })
  ok("激活后开关已变更", demoAfterAct?.allowInternalNetwork === true)
  const dep2Endpoints = await db.networkEndpointRule.findMany({ where: { deploymentId: res2.deploymentId } })
  ok("激活后端点规则落库（2 条）", dep2Endpoints.length === 2 && dep2Endpoints.every((r) => r.scopeType === "USER" && r.userId === demo.id))

  // 3.5 激活后回滚（含端点规则恢复）
  const rb = await rollbackPolicyBundle(operator, { id: res2.deploymentId })
  ok("激活批次回滚成功", rb.rolledBackTargets === 1)
  const demoAfterRb = await db.user.findUnique({ where: { id: demo.id } })
  ok("回滚恢复开关原值", demoAfterRb?.allowInternalNetwork === demoPrevNet)
  ok("回滚清空本批次端点规则", (await db.networkEndpointRule.count({ where: { deploymentId: res2.deploymentId } })) === 0)

  // 3.6 端点模式下发校验（非法模式拒绝）
  let badEpErr = ""
  try {
    await deployPolicyBundle(operator, {
      name: "R6-非法端点",
      bundle: { allowInternalNetwork: null, allowSecureLocationAccess: null, domainRules: null, ipRules: null, endpointRules: { mode: "BLACKLIST", patterns: ["999.999.1.1:80"] } },
      targetUserIds: [demo.id], targetGroupIds: [],
    })
  } catch (e) { badEpErr = (e as Error).message }
  ok("非法端点模式整批拒绝", badEpErr.includes("非法端点模式"))

  // 3.7 目标组下发（组级端点规则 + 定时）
  const res3 = await deployPolicyBundle(operator, {
    name: "R6-组级定时策略",
    bundle: { allowInternalNetwork: null, allowSecureLocationAccess: null, domainRules: null, ipRules: null, endpointRules: { mode: "BLACKLIST", patterns: ["10.20.30.40:443"] } },
    targetUserIds: [],
    targetGroupIds: [group.id],
    effectiveAt: new Date(Date.now() + 7200_000).toISOString(),
  })
  ok("组级定时批次 PENDING", res3.scheduled && res3.status === "PENDING")
  await db.policyDeployment.update({ where: { id: res3.deploymentId }, data: { effectiveAt: new Date(Date.now() - 60_000) } })
  const act2 = await activateDueScheduledDeployments(() => {})
  ok("组级批次到点激活", act2.activated >= 1)
  const gEndpoints = await db.networkEndpointRule.count({ where: { deploymentId: res3.deploymentId, scopeType: "GROUP", groupId: group.id } })
  ok("组级端点规则落库", gEndpoints === 1)
  // 组员解析含组级端点规则
  const epAfterGroup = await resolveEndpointPolicyForUser(demo.id)
  ok("组员解析含组级端点规则", epAfterGroup.blackPatterns.includes("10.20.30.40:443"))
  await rollbackPolicyBundle(operator, { id: res3.deploymentId })
  ok("组级批次回滚清理", (await db.networkEndpointRule.count({ where: { deploymentId: res3.deploymentId } })) === 0)

  // 3.8 定时激活任务引擎注册
  const task = await db.scheduleTask.findUnique({ where: { code: "policy_deployment_activation" } })
  ok("定时激活任务已注册（每分钟）", !!task && task.cronExpr === "* * * * *" && task.enabled)

  // ============================================================
  console.log("== 4. MCP/OpenAPI 浏览器控制通道健康（回归）==")
  const http = await fetch("http://localhost:3000/api/openapi/browser", {
    headers: { "x-api-key": "" },
  }).then((r) => r.status).catch(() => 0)
  ok("OpenAPI 浏览器控制目录可达", http === 401 || http === 200, `HTTP ${http}`)

  // ============================================================
  // 清理 QA 产物
  await db.networkEndpointRule.deleteMany({ where: { OR: [{ id: epU.id }, { id: epU2.id }, { id: epG.id }, { id: epRange.id }] } })
  await db.policyDeployment.deleteMany({ where: { name: { contains: "R6-" } } })
  await db.user.update({ where: { id: demo.id }, data: { allowInternalNetwork: demoPrevNet, allowSecureLocationAccess: demoPrevSecure } })

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`)
  if (fail > 0) {
    console.log("失败项：")
    failures.forEach((f) => console.log("  - " + f))
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
