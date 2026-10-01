/**
 * r12 — HTTP 层真实调用验证：API-Key 网关（级别 + scope 双重拒绝）
 * 运行前提：dev/standalone 服务已在 :3000
 */
import { PrismaClient } from "@prisma/client"
import { createHash } from "crypto"

const db = new PrismaClient()
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const BASE = "http://127.0.0.1:3000"

let pass = 0
let fail = 0
function assert(cond: boolean, label: string, extra = "") {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label} ${extra}`)
  }
}

async function callMcp(key: string, code: string) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ code, params: { pageSize: 3 }, targets: [], priority: "LOW" }),
  })
  const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string }
  return { status: res.status, code: json.code, msg: json.msg }
}

async function main() {
  const admin = await db.user.findFirst({ where: { username: "admin" } })
  if (!admin) throw new Error("admin 用户不存在")
  const normal = await db.user.create({ data: { username: "scope-test-user", passwordHash: "x", role: "USER", enabled: true } })

  // 只读 + browser scope 令牌
  const roKey = "dy_" + "ro".repeat(32)
  // 读写（7）+ 仅 browser scope
  const rwKey = "dy_" + "rw".repeat(32)
  // 管理级（15）+ 仅 browser scope —— 用于验证 scope 在管理位齐全时仍强制拦截
  const admKey = "dy_" + "ad".repeat(32)
  await db.apiToken.create({ data: { userId: normal.id, name: "http-ro", tokenHash: sha256(roKey), tokenPrefix: roKey.slice(0, 8), permissionsMask: 1, scopes: ["browser"] } })
  await db.apiToken.create({ data: { userId: normal.id, name: "http-rw", tokenHash: sha256(rwKey), tokenPrefix: rwKey.slice(0, 8), permissionsMask: 7, scopes: ["browser"] } })
  await db.apiToken.create({ data: { userId: admin.id, name: "http-adm", tokenHash: sha256(admKey), tokenPrefix: admKey.slice(0, 8), permissionsMask: 15, scopes: ["browser"] } })

  console.log("== HTTP：MCP 网关（x-api-key） ==")
  // 1. 只读令牌 → 查询类工具放行
  const r1 = await callMcp(roKey, "workspace.list")
  assert(r1.code === 0, `只读令牌 workspace.list 放行（status=${r1.status}）`, JSON.stringify(r1))
  // 2. 只读令牌 → 写入类拒绝（权限位）
  const r2 = await callMcp(roKey, "workspace.create")
  assert(r2.status === 403 && (r2.msg || "").includes("权限不足"), `只读令牌 workspace.create 被拒（${r2.msg}）`)
  // 3. 读写令牌 scope=browser → workspace.create 放行（模拟模式创建后即删）
  const r3 = await callMcp(rwKey, "workspace.create")
  assert(r3.code === 0, `读写+browser scope 令牌 workspace.create 放行（${JSON.stringify(r3).slice(0, 80)}）`)
  // 4. 管理级令牌 scope=browser → user.* 拒绝（scope）——权限位齐全仍被功能范围拦截
  const r4 = await callMcp(admKey, "user.batch_disable")
  assert(r4.status === 403 && (r4.msg || "").includes("功能范围未授权"), `管理级+browser scope 令牌 user.* 被 scope 拒绝（${r4.msg}）`)
  // 5. 无效密钥 → 401
  const r5 = await callMcp("dy_invalid_key", "workspace.list")
  assert(r5.status === 401, "无效密钥 401")
  // 6. tools/list（JSON-RPC）按 scope 过滤
  const res6 = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "x-api-key": roKey, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  const j6 = (await res6.json()) as { result?: { data?: { tools?: { name: string }[] } } }
  const tools = j6.result?.data?.tools || []
  const hasWorkspaceList = tools.some((t) => t.name === "workspace.list")
  const hasUserDisable = tools.some((t) => t.name === "user.batch_disable")
  assert(hasWorkspaceList && !hasUserDisable, `tools/list 只列授权工具（共${tools.length}个，含workspace.list=${hasWorkspaceList}，不含user.batch_disable=${!hasUserDisable}）`)

  // 7. OpenAPI REST 网关 scope：resources（只读令牌 scope=browser → resources 拒绝）
  const res7 = await fetch(`${BASE}/api/openapi/resources?resource=workspaces`, { headers: { "x-api-key": roKey } })
  const j7 = (await res7.json().catch(() => ({}))) as { msg?: string }
  assert(res7.status === 403 && (j7.msg || "").includes("功能范围未授权"), `openapi/resources scope 拒绝（${j7.msg}）`)
  // 8. OpenAPI browser 目录（公开）
  const res8 = await fetch(`${BASE}/api/openapi/browser`)
  assert(res8.status === 200, "openapi/browser 动作目录公开可访问")
  // 9. OpenAPI doc 含 x-token-scopes
  const res9 = await fetch(`${BASE}/api/openapi/doc`)
  const j9 = (await res9.json()) as { "x-token-scopes"?: { key: string }[]; "x-token-levels"?: Record<string, string> }
  assert((j9["x-token-scopes"] || []).length === 8 && !!j9["x-token-levels"]?.READ_ONLY, "OpenAPI 文档输出 scope/级别元数据")

  // 清理
  await db.apiToken.deleteMany({ where: { userId: normal.id } })
  await db.apiToken.deleteMany({ where: { userId: admin.id, name: "http-adm" } })
  const ws = await db.browserWorkspace.findMany({ where: { userId: normal.id }, select: { id: true } })
  for (const w of ws) await db.browserWorkspace.delete({ where: { id: w.id } })
  await db.mcpTask.deleteMany({ where: { userId: normal.id } })
  await db.user.delete({ where: { id: normal.id } })
  const remain = await db.apiToken.count({ where: { userId: normal.id } })
  assert(remain === 0, "测试数据已全部清理")

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error("崩溃：", e); process.exit(1) }).finally(() => db.$disconnect())
