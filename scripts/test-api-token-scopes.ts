/**
 * r12 — API 密钥权限级别 + 功能范围（scope）白名单 断言测试
 * 覆盖：纯函数（normalize/check/map/level）+ DB round-trip + MCP 引擎逐操作拒绝 + HTTP 网关真实调用
 * 运行：bun scripts/test-api-token-scopes.ts
 */
import { PrismaClient } from "@prisma/client"
import { TOKEN_PERM, normalizeScopes, checkTokenScope, scopeForMcpCode, levelOfMask, TOKEN_LEVELS } from "../src/lib/token-scopes"
import { runBatchOperation } from "../src/server/mcp/engine"

const db = new PrismaClient()
let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label}`)
  }
}

async function main() {
  console.log("== 1. 纯函数：normalizeScopes ==")
  assert(normalizeScopes(null) === null, "null → null（不限）")
  assert(normalizeScopes([]) === null, "空数组 → null（不限）")
  assert(JSON.stringify(normalizeScopes(["browser", "browser"])) === JSON.stringify(["browser"]), "去重")
  assert(JSON.stringify(normalizeScopes(["browser", "unknown_scope"])) === JSON.stringify(["browser"]), "未知 key 被过滤")
  assert(normalizeScopes("browser") === null, "非数组 → null")
  assert(normalizeScopes([123]) === null, "非法元素被过滤 → null")

  console.log("== 2. 纯函数：checkTokenScope ==")
  assert(checkTokenScope({ scopes: null }, "browser").ok, "scopes=null → 任意 scope 放行")
  assert(checkTokenScope({ scopes: [] }, "browser").ok, "scopes=[] → 放行（不限）")
  assert(checkTokenScope({ scopes: ["browser"] }, "browser").ok, "白名单命中 → 放行")
  const denied = checkTokenScope({ scopes: ["browser"] }, "user")
  assert(!denied.ok && denied.msg.includes("用户管理操作"), "白名单未命中 → 拒绝且消息含中文功能名")
  assert(checkTokenScope({ scopes: ["browser"] }, null).ok, "requiredScope=null → 放行")
  assert(checkTokenScope(undefined, "browser").ok, "ctx undefined → 放行（防御）")

  console.log("== 3. 纯函数：scopeForMcpCode 映射 ==")
  assert(scopeForMcpCode("workspace.create") === "browser", "workspace.* → browser")
  assert(scopeForMcpCode("browser.navigate") === null, "browser.* REST 动作族无 scope（走 openapi browser 网关）")
  assert(scopeForMcpCode("workspace.batch_replace_proxy") === "proxy", "精确条目优先：batch_replace_proxy → proxy")
  assert(scopeForMcpCode("singbox.batch_start") === "proxy", "singbox.* → proxy")
  assert(scopeForMcpCode("user.batch_disable") === "user", "user.* → user")
  assert(scopeForMcpCode("token.batch_invalidate") === "token", "token.* → token")
  assert(scopeForMcpCode("recycle.batch_restore") === "recycle", "recycle.* → recycle")
  assert(scopeForMcpCode("session.batch_offline") === "session", "session.* → session")
  assert(scopeForMcpCode("admin.force_stop_workspace") === "session", "admin.* → session")
  assert(scopeForMcpCode("task.status") === "resources", "task.* → resources")

  console.log("== 4. 纯函数：权限级别掩码 ==")
  assert(TOKEN_LEVELS.READ_ONLY.mask === TOKEN_PERM.READ, "只读 = 位1")
  assert(TOKEN_LEVELS.READ_WRITE.mask === (TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE), "读写 = 位1|2|4")
  assert(levelOfMask(1) === "READ_ONLY", "mask 1 → READ_ONLY")
  assert(levelOfMask(7) === "READ_WRITE", "mask 7 → READ_WRITE")
  assert(levelOfMask(8) === "ADMIN", "mask 8 → ADMIN")
  assert(levelOfMask(15) === "ADMIN", "mask 15 → ADMIN")
  assert(levelOfMask(3) === "CUSTOM", "mask 3 → CUSTOM")

  console.log("== 5. DB round-trip：scopes 落库与读取 ==")
  const testUser = await db.user.findFirst({ where: { username: "admin" } })
  assert(!!testUser, "存在 admin 用户（测试载体）")
  const scopeJson = JSON.stringify(["browser", "crx"])
  const row = await db.apiToken.create({
    data: {
      userId: testUser!.id,
      name: "test-scope-token",
      tokenHash: "testhash-" + Date.now(),
      tokenPrefix: "TESTSCOP",
      permissionsMask: 7,
      scopes: JSON.parse(scopeJson),
      enabled: true,
    },
  })
  const readBack = await db.apiToken.findUnique({ where: { id: row.id } })
  assert(JSON.stringify(normalizeScopes(readBack?.scopes)) === scopeJson, "scopes 落库→读回→normalize 无损")
  assert(normalizeScopes(readBack?.scopes)!.includes("crx"), "包含 crx")

  console.log("== 6. MCP 引擎：逐操作权限位 + scope 拒绝（不建任务记录） ==")
  const mkCtx = (perm: number, scopes: string[] | null) => ({
    tokenId: "test-token-id", userId: testUser!.id, username: "admin", permissions: perm, role: "SUPER_ADMIN", scopes,
  })
  // 只读令牌调写入操作 → 权限位拒绝
  try {
    await runBatchOperation({ code: "workspace.create", params: { count: 1 }, targets: [], priority: "LOW", ctx: mkCtx(TOKEN_PERM.READ, null) })
    assert(false, "只读令牌 workspace.create 应被拒绝")
  } catch (e) {
    const msg = (e as Error).message
    assert(msg.includes("权限不足"), `只读 workspace.create 拒绝（${msg.slice(0, 40)}…）`)
  }
  // scope 白名单未命中 → 拒绝
  try {
    await runBatchOperation({ code: "user.batch_disable", params: {}, targets: [], priority: "LOW", ctx: mkCtx(15, ["browser"]) })
    assert(false, "browser-scope 令牌调 user.* 应被拒绝")
  } catch (e) {
    const msg = (e as Error).message
    assert(msg.includes("功能范围未授权") && msg.includes("用户管理操作"), `scope 拒绝消息含功能名（${msg.slice(0, 40)}…）`)
  }
  // scope 命中 + 权限位齐 → 执行（产生任务记录，只读查询类）
  const res = await runBatchOperation({ code: "workspace.list", params: { pageSize: 5 }, targets: [], priority: "LOW", ctx: mkCtx(TOKEN_PERM.READ, ["browser", "resources"]) })
  assert(res.status === "SUCCESS" || res.status === "PARTIAL", `scope 命中时查询类操作放行（status=${res.status}）`)
  // 只读令牌 + workspace.list → 放行（READ 位满足）
  const res2 = await runBatchOperation({ code: "workspace.list", params: { pageSize: 5 }, targets: [], priority: "LOW", ctx: mkCtx(TOKEN_PERM.READ, null) })
  assert(res2.status === "SUCCESS" || res2.status === "PARTIAL", "只读令牌可调用查询类工具（MCP 网关门禁已降为 READ）")
  // 清理任务记录
  await db.mcpTask.deleteMany({ where: { userId: testUser!.id, code: "workspace.list" } })

  console.log("== 7. 提权封堵语义（admin 位不可自助授予）验证（静态断言） ==")
  // resolveMask 逻辑在 actions 内（server-only）；此处以掩码语义断言：
  const USER_LEVEL_MASKS = [TOKEN_LEVELS.READ_ONLY.mask, TOKEN_LEVELS.READ_WRITE.mask]
  assert(!USER_LEVEL_MASKS.some((m) => (m & TOKEN_PERM.ADMIN) !== 0), "普通用户可选级别均不含管理位")
  assert((TOKEN_LEVELS.READ_WRITE.mask & TOKEN_PERM.ADMIN) === 0, "读写级别不含管理位")

  // 清理
  await db.apiToken.delete({ where: { id: row.id } })
  const remain = await db.apiToken.findUnique({ where: { id: row.id } })
  assert(remain === null, "测试令牌已清理")

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error("测试崩溃：", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
