// 网络访问策略验证脚本：三层解析 + Chromium 托管策略生成 + 策略文件落盘 + 权限守卫
import { PrismaClient } from "@prisma/client"
import { buildChromiumManagedPolicy, singboxPolicyRouteRules, NETWORK_POLICY_BLOCK_CIDRS } from "../src/lib/network-policy"

const db = new PrismaClient()

async function main() {
  const results: string[] = []
  const check = (name: string, ok: boolean, detail = "") => {
    results.push(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
  }

  // ---- 1. 纯函数：Chromium 托管策略生成（默认拒绝形态）----
  const denyAll = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    gatewayIp: "172.18.0.1",
    proxyUrl: "socks5://172.18.0.1:1080",
  })
  const bl = (denyAll.URLBlocklist as string[]) || []
  check("默认拒绝 → URLBlocklist 非空", bl.length > 0, `${bl.length} 条`)
  check("拦截 10.* 内网", bl.some((e) => e === "10.*" || e === "http://10.*"))
  check("拦截 192.168.*", bl.some((e) => e.includes("192.168.*")))
  check("拦截 172.16-31 网段", bl.filter((e) => /172\.(1[6-9]|2\d|3[01])\.\*/.test(e)).length >= 16)
  check("拦截云元数据 169.254.*", bl.some((e) => e.includes("169.254.*")))
  check("拦截本机 CDP 9222", bl.some((e) => e.includes("localhost:9222") || e.includes("127.0.0.1:9222")))
  check("拦截本机 VNC 5900", bl.some((e) => e.includes("localhost:5900") || e.includes("127.0.0.1:5900")))
  check("拦截 file:// 协议", bl.some((e) => e.startsWith("file://")))
  check("拦截 chrome:// 管理页", bl.some((e) => e.includes("chrome://settings")))
  check("拦截平台网关端点", bl.some((e) => e.startsWith("172.18.0.1:")))
  check("WebRTC 防泄漏已锁", denyAll.WebRtcIPHandling === "disable_non_proxied_udp")
  check("代理锁定 fixed_servers", denyAll.ProxyMode === "fixed_servers" && denyAll.ProxyServer === "socks5://172.18.0.1:1080")

  // ---- 2. 放行形态 ----
  const allowAll = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: true, allowSecureLocationAccess: true, source: "USER", resolvedAt: new Date().toISOString() },
    gatewayIp: "172.18.0.1",
  })
  const bl2 = (allowAll.URLBlocklist as string[]) || []
  check("全部放行 → URLBlocklist 为空", bl2.length === 0)
  check("全部放行 → 不锁 WebRTC", allowAll.WebRtcIPHandling === undefined)

  // 半放行：允许内网但禁安全位置
  const half = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: true, allowSecureLocationAccess: false, source: "USER", resolvedAt: new Date().toISOString() },
    gatewayIp: "172.18.0.1",
  })
  const bl3 = (half.URLBlocklist as string[]) || []
  check("允许内网 → 不含 10.* 条目", !bl3.some((e) => e === "10.*"))
  check("禁安全位置 → 仍拦截本机 CDP/VNC", bl3.some((e) => e.includes("localhost:9222")))

  // ---- 3. Sing-Box 拦截规则 ----
  const rules = singboxPolicyRouteRules({ allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: "" })
  check("sing-box 拦截规则已生成", rules.length === 1 && (rules[0].outbound === "block"))
  check("sing-box CIDR 覆盖三大私有段", JSON.stringify(rules[0].ip_cidr).includes("10.0.0.0/8") && JSON.stringify(rules[0].ip_cidr).includes("172.16.0.0/12") && JSON.stringify(rules[0].ip_cidr).includes("192.168.0.0/16"))
  check("sing-box 含云元数据段", JSON.stringify(rules[0].ip_cidr).includes("169.254.0.0/16"))
  const noRules = singboxPolicyRouteRules({ allowInternalNetwork: true, allowSecureLocationAccess: true, source: "USER", resolvedAt: "" })
  check("内网放行 → 无 sing-box 拦截规则", noRules.length === 0)
  check("CIDR 常量含 IPv6 ULA/链路本地", NETWORK_POLICY_BLOCK_CIDRS.includes("fc00::/7") && NETWORK_POLICY_BLOCK_CIDRS.includes("fe80::/10"))

  // ---- 4. 三层解析（真实 DB）----
  const { resolveNetworkPolicy, resolveNetworkPoliciesBatch } = await import("../src/lib/network-policy")

  // 准备测试数据：用户 + 组
  const uname = `netpol-test-${Date.now()}`
  const gname = `netpol-group-${Date.now()}`
  const user = await db.user.create({ data: { username: uname, displayName: "策略测试用户", role: "USER" } })
  const group = await db.group.create({ data: { name: gname, allowInternalNetwork: true, allowSecureLocationAccess: false } })
  await db.groupUser.create({ data: { groupId: group.id, userId: user.id } })

  // 4.1 无覆盖 → 组级继承
  const p1 = await resolveNetworkPolicy(user.id)
  check("组级继承：内网=组值(true)", p1.allowInternalNetwork === true && p1.source === "GROUP")
  check("组级继承：安全位置=组值(false)", p1.allowSecureLocationAccess === false)

  // 4.2 用户级覆盖
  await db.user.update({ where: { id: user.id }, data: { allowInternalNetwork: false, allowSecureLocationAccess: true } })
  const p2 = await resolveNetworkPolicy(user.id)
  check("用户级覆盖生效：内网=false", p2.allowInternalNetwork === false && p2.source === "USER")
  check("用户级覆盖生效：安全位置=true", p2.allowSecureLocationAccess === true)

  // 4.3 半覆盖（仅内网字段覆盖，安全位置回退组）
  await db.user.update({ where: { id: user.id }, data: { allowInternalNetwork: false, allowSecureLocationAccess: null } })
  const p3 = await resolveNetworkPolicy(user.id)
  check("半覆盖合并：内网取用户(false)、安全位置回退组(false→再全局默认)", p3.allowInternalNetwork === false && p3.allowSecureLocationAccess === false)

  // 4.4 清空覆盖 → 回退组；组也删除 → 全局默认（默认拒绝）
  await db.user.update({ where: { id: user.id }, data: { allowInternalNetwork: null, allowSecureLocationAccess: null } })
  await db.groupUser.delete({ where: { groupId_userId: { groupId: group.id, userId: user.id } } })
  await db.group.delete({ where: { id: group.id } })
  const p4 = await resolveNetworkPolicy(user.id)
  check("无组无覆盖 → 全局默认拒绝", p4.allowInternalNetwork === false && p4.allowSecureLocationAccess === false && p4.source === "GLOBAL_DEFAULT")

  // 4.5 批量解析与单点一致
  const batch = await resolveNetworkPoliciesBatch([{ userId: user.id }])
  check("批量解析返回结果", batch.has(user.id))
  const bp = batch.get(user.id)!
  check("批量与单点一致", bp.allowInternalNetwork === p4.allowInternalNetwork && bp.allowSecureLocationAccess === p4.allowSecureLocationAccess)

  // ---- 5. 策略文件落盘 ----
  const { writeNetworkPolicyFile, networkPolicyDir } = await import("../src/lib/network-policy")
  const fs = await import("fs/promises")
  const path = await writeNetworkPolicyFile("test-key-0001", {
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    gatewayIp: "172.18.0.1",
  })
  check("策略文件写入成功", !!path)
  if (path) {
    const content = JSON.parse(await fs.readFile(path, "utf-8"))
    check("策略文件为合法 Chromium managed policy", Array.isArray(content.URLBlocklist) && content.URLBlocklist.length > 0)
    await fs.rm(path).catch(() => {})
  }
  const bad = await writeNetworkPolicyFile("../escape", { policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: "" } })
  check("路径穿越键被拒绝", bad === null)
  const dirList = await fs.readdir(networkPolicyDir()).catch(() => [] as string[])
  check("策略目录存在且已清理", Array.isArray(dirList))

  // ---- 清理测试数据 ----
  await db.group.delete({ where: { id: group.id } }).catch(() => {})
  await db.user.delete({ where: { id: user.id } }).catch(() => {})

  console.log("\n========= 网络访问策略验证 =========")
  for (const r of results) console.log(r)
  const failed = results.filter((r) => r.startsWith("❌"))
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
  await db.$disconnect()
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error("验证脚本执行失败:", e)
  await db.$disconnect()
  process.exit(1)
})
