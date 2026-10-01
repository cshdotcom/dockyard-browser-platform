// ============================================================
// r11 断言测试：全策略面三级定向（用户/用户组/单沙箱）
// 覆盖：文件限制四层解析 / 网络开关沙箱覆盖 / 域名·端点 SANDBOX 规则
//       deny-wins 冲突抑制 / 沙箱归属越权防护 / Chromium 策略文件注入
// 运行：bun scripts/test-policy-scopes.ts
// ============================================================

import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

async function main() {
  console.log("== r11 策略三级定向断言 ==")

  // ---------- 环境准备 ----------
  const admin = await db.user.create({
    data: { username: `t-scope-admin-${Date.now()}`, email: `sa-${Date.now()}@t.local`, passwordHash: "x", role: "SUPER_ADMIN", emailVerified: true },
  })
  const demo = await db.user.create({
    data: { username: `t-scope-demo-${Date.now()}`, email: `sd-${Date.now()}@t.local`, passwordHash: "x", role: "USER", emailVerified: true },
  })
  const demo2 = await db.user.create({
    data: { username: `t-scope-demo2-${Date.now()}`, email: `sd2-${Date.now()}@t.local`, passwordHash: "x", role: "USER", emailVerified: true },
  })
  const parentGroup = await db.group.create({ data: { name: `t-parent-${Date.now()}` } })
  const childGroup = await db.group.create({ data: { name: `t-child-${Date.now()}`, parentId: parentGroup.id } })
  await db.groupUser.create({ data: { groupId: childGroup.id, userId: demo.id } })

  const ws = await db.browserWorkspace.create({
    data: { name: `t-ws-${Date.now()}`, mode: "novnc_full", status: "STOPPED", userId: demo.id },
  })
  const ws2 = await db.browserWorkspace.create({
    data: { name: `t-ws2-${Date.now()}`, mode: "novnc_full", status: "STOPPED", userId: demo2.id },
  })

  try {
    // ============ 1. 文件限制策略四层解析 ============
    console.log("\n[1] 文件限制策略（FilePolicyConfig 四层）")
    const { resolveFilePolicy } = await import("../src/lib/file-policy")

    // 1.1 无任何条目 → 系统默认
    let fp = await resolveFilePolicy(demo.id)
    check("无条目 → 系统默认（下载允许/上传允许/file://禁止）", fp.allowDownload === true && fp.allowUpload === true && fp.allowFileScheme === false && fp.source === "DEFAULT")

    // 1.2 全局条目
    await db.filePolicyConfig.create({
      data: { scopeType: "GLOBAL", scopeId: "", allowDownload: false, allowUpload: true, allowFileScheme: false },
    })
    fp = await resolveFilePolicy(demo.id)
    check("全局条目生效 → 禁下载", fp.allowDownload === false && fp.source === "GLOBAL")

    // 1.3 组级（沿继承链：子组成员 → 父组条目）
    await db.filePolicyConfig.create({
      data: { scopeType: "GROUP", scopeId: parentGroup.id, allowDownload: true, allowUpload: false, allowFileScheme: false },
    })
    fp = await resolveFilePolicy(demo.id)
    check("组级继承链生效（子组成员取父组条目）→ 组级放行下载禁上传", fp.allowDownload === true && fp.allowUpload === false && fp.source === "GROUP" && fp.sourceGroupId === parentGroup.id)

    // 1.4 用户级覆盖
    await db.filePolicyConfig.create({
      data: { scopeType: "USER", scopeId: demo.id, allowDownload: true, allowUpload: true, allowFileScheme: true },
    })
    fp = await resolveFilePolicy(demo.id)
    check("用户级覆盖组级 → file:// 放行", fp.allowFileScheme === true && fp.source === "USER")

    // 1.5 沙箱级覆盖用户级（最高优先）
    await db.filePolicyConfig.create({
      data: { scopeType: "SANDBOX", scopeId: ws.id, allowDownload: false, allowUpload: false, allowFileScheme: false },
    })
    fp = await resolveFilePolicy(demo.id, ws.id)
    check("沙箱级覆盖用户级（最高优先）→ 全禁", fp.allowDownload === false && fp.allowUpload === false && fp.allowFileScheme === false && fp.source === "SANDBOX")

    // 1.6 沙箱归属越权防护：demo 用 demo2 的沙箱 ID → SANDBOX 层不生效
    fp = await resolveFilePolicy(demo.id, ws2.id)
    check("沙箱归属校验：非所有者解析不并入 SANDBOX 层", fp.source !== "SANDBOX" && fp.source === "USER")

    // 1.7 他人沙箱自己的条目不影响 demo
    await db.filePolicyConfig.create({
      data: { scopeType: "SANDBOX", scopeId: ws2.id, allowDownload: false, allowUpload: false, allowFileScheme: true },
    })
    fp = await resolveFilePolicy(demo.id, ws.id)
    check("他人沙箱条目不串扰", fp.source === "SANDBOX" && fp.allowFileScheme === false)

    // ============ 2. 网络开关沙箱级覆盖 ============
    console.log("\n[2] 网络访问策略（沙箱级覆盖四层）")
    const { resolveNetworkPolicy } = await import("../src/lib/network-policy")

    // 2.1 用户级禁止
    await db.user.update({ where: { id: demo.id }, data: { allowInternalNetwork: false, allowSecureLocationAccess: false } })
    let np = await resolveNetworkPolicy(demo.id)
    check("用户级禁止内网", np.allowInternalNetwork === false && np.source === "USER")

    // 2.2 沙箱级覆盖为允许
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { policyAllowInternalNetwork: true, policyAllowSecureLocationAccess: true } })
    np = await resolveNetworkPolicy(demo.id, ws.id)
    check("沙箱级覆盖为允许内网（SANDBOX 最高优先）", np.allowInternalNetwork === true && np.source === "SANDBOX")

    // 2.3 半覆盖：仅一个字段非 null → 该字段生效，另一字段回退用户级
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { policyAllowInternalNetwork: false, policyAllowSecureLocationAccess: null } })
    np = await resolveNetworkPolicy(demo.id, ws.id)
    check("沙箱半覆盖：内网取沙箱 false，安全位置回退用户 false", np.allowInternalNetwork === false && np.allowSecureLocationAccess === false)

    // 2.4 归属校验：demo 用 demo2 的沙箱 → 覆盖不生效
    await db.browserWorkspace.update({ where: { id: ws2.id }, data: { policyAllowInternalNetwork: true, policyAllowSecureLocationAccess: true } })
    np = await resolveNetworkPolicy(demo.id, ws2.id)
    check("网络沙箱归属校验：非所有者不并入覆盖", np.source === "USER" && np.allowInternalNetwork === false)

    // ============ 3. 域名黑白名单 SANDBOX 作用域 + deny-wins ============
    console.log("\n[3] 域名黑白名单（SANDBOX 作用域 + deny-wins）")
    const { resolveDomainPolicyForUser } = await import("../src/lib/domain-policy")

    // 3.1 清场后：全局黑 + 沙箱黑叠加
    await db.domainRule.deleteMany({})
    await db.domainRule.create({ data: { pattern: "global-block.example", type: "BLACK", scopeType: "GLOBAL", enabled: true } })
    await db.domainRule.create({ data: { pattern: "sandbox-block.example", type: "BLACK", scopeType: "SANDBOX", workspaceId: ws.id, enabled: true } })
    await db.domainRule.create({ data: { pattern: "other-sandbox.example", type: "BLACK", scopeType: "SANDBOX", workspaceId: ws2.id, enabled: true } })

    let dp = await resolveDomainPolicyForUser(demo.id, ws.id)
    check("全局+沙箱黑名单叠加生效", dp.blackPatterns.includes("global-block.example") && dp.blackPatterns.includes("sandbox-block.example"))
    check("他人沙箱规则不串扰", !dp.blackPatterns.includes("other-sandbox.example"))
    check("规则来源标记 SANDBOX", dp.rules.some((r) => r.source === "SANDBOX" && r.sourceWorkspaceId === ws.id))

    // 3.2 deny-wins：全局黑 + 沙箱白同 pattern → 白名单例外被抑制
    await db.domainRule.create({ data: { pattern: "conflict.example", type: "BLACK", scopeType: "GLOBAL", enabled: true } })
    await db.domainRule.create({ data: { pattern: "conflict.example", type: "WHITE", scopeType: "SANDBOX", workspaceId: ws.id, enabled: true } })
    dp = await resolveDomainPolicyForUser(demo.id, ws.id)
    check("deny-wins：同封同放 → 封禁胜出（放行例外被抑制）", dp.blackPatterns.includes("conflict.example") && !dp.whitePatterns.includes("conflict.example"))

    // 3.3 纯白名单（无冲突）→ 白名单严格模式
    await db.domainRule.deleteMany({ where: { pattern: "conflict.example" } })
    await db.domainRule.create({ data: { pattern: "conflict.example", type: "WHITE", scopeType: "SANDBOX", workspaceId: ws.id, enabled: true } })
    dp = await resolveDomainPolicyForUser(demo.id, ws.id)
    check("无冲突白名单 → 白名单严格模式 + 该项放行", dp.mode === "WHITELIST" && dp.whitePatterns.includes("conflict.example"))

    // 3.4 无 workspaceId 解析 → SANDBOX 规则不生效
    dp = await resolveDomainPolicyForUser(demo.id)
    check("不传沙箱 ID → 仅全局/组/用户层", !dp.blackPatterns.includes("sandbox-block.example") && dp.blackPatterns.includes("global-block.example"))

    // ============ 4. 端点级 SANDBOX 作用域 ============
    console.log("\n[4] 端点级精确限制（SANDBOX 作用域）")
    const { resolveEndpointPolicyForUser } = await import("../src/lib/endpoint-policy")

    await db.networkEndpointRule.deleteMany({})
    await db.networkEndpointRule.create({ data: { pattern: "10.1.1.1:8080", type: "BLACK", scopeType: "SANDBOX", workspaceId: ws.id, enabled: true } })
    await db.networkEndpointRule.create({ data: { pattern: "10.2.2.2:9090", type: "BLACK", scopeType: "SANDBOX", workspaceId: ws2.id, enabled: true } })
    await db.networkEndpointRule.create({ data: { pattern: "10.3.3.3:7070", type: "BLACK", scopeType: "GLOBAL", enabled: true } })

    let ep = await resolveEndpointPolicyForUser(demo.id, ws.id)
    check("沙箱端点规则生效 + 全局叠加", ep.blackPatterns.includes("10.1.1.1:8080") && ep.blackPatterns.includes("10.3.3.3:7070"))
    check("他人沙箱端点规则不串扰", !ep.blackPatterns.includes("10.2.2.2:9090"))

    // 4.2 deny-wins 端点
    await db.networkEndpointRule.create({ data: { pattern: "10.4.4.4:443", type: "BLACK", scopeType: "GLOBAL", enabled: true } })
    await db.networkEndpointRule.create({ data: { pattern: "10.4.4.4:443", type: "WHITE", scopeType: "SANDBOX", workspaceId: ws.id, enabled: true } })
    ep = await resolveEndpointPolicyForUser(demo.id, ws.id)
    check("端点 deny-wins：封禁胜出", ep.blackPatterns.includes("10.4.4.4:443") && !ep.whitePatterns.includes("10.4.4.4:443"))

    // ============ 5. Chromium 托管策略文件注入（文件限制） ============
    console.log("\n[5] Chromium 托管策略注入（文件限制三维度）")
    const { buildChromiumManagedPolicy } = await import("../src/lib/network-policy")

    const mk = (file: { allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean }) =>
      buildChromiumManagedPolicy({
        policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
        domainPolicy: null,
        endpointPolicy: null,
        filePolicy: { ...file, source: "SANDBOX", resolvedAt: new Date().toISOString() },
      })

    let m = mk({ allowDownload: false, allowUpload: false, allowFileScheme: false })
    check("禁下载 → DownloadRestrictions=2", m.DownloadRestrictions === 2)
    check("禁上传 → AllowFileSelectionDialogs=false", m.AllowFileSelectionDialogs === false)
    check("禁 file:// → URLBlocklist 含 file://*", (m.URLBlocklist as string[]).includes("file://*"))

    m = mk({ allowDownload: true, allowUpload: true, allowFileScheme: true })
    check("全允许 → 无 DownloadRestrictions 键", !("DownloadRestrictions" in m))
    check("上传允许 → 无 AllowFileSelectionDialogs=false 键", !("AllowFileSelectionDialogs" in m))
    check("file:// 允许 → 不在 blocklist", !(m.URLBlocklist as string[]).includes("file://*"))

    // 5.2 缺省 filePolicy → 按系统默认注入（file:// 禁）
    const mDef = buildChromiumManagedPolicy({
      policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    })
    check("缺省策略 → file:// 仍默认禁止（纵深防御）", (mDef.URLBlocklist as string[]).includes("file://*") && !("DownloadRestrictions" in mDef) && !("AllowFileSelectionDialogs" in mDef))

    // ============ 6. 策略包 schema（部署中心沙箱目标 + 文件策略） ============
    console.log("\n[6] 部署中心 bundleSchema（fileRules + targetWorkspaceIds）")
    const { bundleSchema, deploySchema } = await import("../src/lib/policy-engine")
    const parsed = bundleSchema.parse({
      allowInternalNetwork: null,
      allowSecureLocationAccess: null,
      domainRules: null,
      ipRules: null,
      endpointRules: null,
      fileRules: { allowDownload: false, allowUpload: false, allowFileScheme: false },
    })
    check("fileRules 解析", parsed.fileRules?.allowDownload === false && parsed.fileRules?.allowUpload === false)

    const dp2 = deploySchema.parse({
      name: "t-batch",
      bundle: { allowInternalNetwork: true, allowSecureLocationAccess: null, domainRules: null, ipRules: null, endpointRules: null, fileRules: null },
      targetUserIds: [],
      targetGroupIds: [],
      targetWorkspaceIds: [ws.id],
    })
    check("targetWorkspaceIds 解析", (dp2.targetWorkspaceIds as string[]).length === 1 && dp2.targetWorkspaceIds[0] === ws.id)

    // ============ 结果 ============
    console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`)
  } finally {
    // ---------- 清理 ----------
    await db.domainRule.deleteMany({ where: { pattern: { in: ["global-block.example", "sandbox-block.example", "other-sandbox.example", "conflict.example"] } } })
    await db.networkEndpointRule.deleteMany({ where: { pattern: { startsWith: "10." } } })
    await db.filePolicyConfig.deleteMany({ where: { scopeId: { in: ["", demo.id, ws.id, ws2.id, parentGroup.id] } } })
    await db.groupUser.deleteMany({ where: { userId: demo.id } })
    await db.group.deleteMany({ where: { id: { in: [parentGroup.id, childGroup.id] } } })
    await db.browserWorkspace.deleteMany({ where: { id: { in: [ws.id, ws2.id] } } })
    await db.user.deleteMany({ where: { id: { in: [admin.id, demo.id, demo2.id] } } })
    await db.$disconnect()
  }
  if (failed > 0) process.exitCode = 1
}

main().catch(async (e) => {
  console.error("测试执行失败:", e)
  await db.$disconnect()
  process.exit(1)
})
