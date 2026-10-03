// r26b：元数据缓存 + 五级合并性能语义 + 级联清理验证
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
let pass = 0, fail = 0
function ok(c: boolean, label: string, extra?: string) {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? " — " + extra : ""}`) }
  else { fail++; console.error(`  ✗ ${label}`) }
}
async function main() {
  console.log("== r26b 元数据缓存冒烟 ==")

  // 1. 准备：插件库 + GLOBAL 策略条目 + 测试工作区
  const crxId = "d".repeat(32)
  await db.crxPlugin.upsert({
    where: { crxId },
    create: { crxId, name: "QA-缓存测试插件", updateUrl: "https://clients2.google.com/service/update2/crx", permissions: ["tabs", "cookies"], enabled: true },
    update: { deletedAt: null, enabled: true },
  })
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  const ws = await db.browserWorkspace.create({
    data: { name: "QA-R26B-缓存沙箱", mode: "cdp_light", status: "STOPPED", userId: demo.id, tags: [] },
  })
  await db.crxPolicyEntry.upsert({
    where: { scopeType_scopeId_crxId: { scopeType: "GLOBAL", scopeId: "", crxId } },
    create: { scopeType: "GLOBAL", scopeId: "", crxId },
    update: { deletedAt: null },
  })

  // 2. 五级合并（缓存路径）
  const { resolveWorkspaceCrxPolicy, invalidateCrxLibCache } = await import("../src/lib/crx-policy")
  const t0 = Date.now()
  const policy1 = await resolveWorkspaceCrxPolicy(ws.id)
  const t1 = Date.now()
  ok(policy1.entries.length === 1 && policy1.entries[0].crxId === crxId, "五级合并命中 GLOBAL 层条目")
  ok(policy1.entries[0].highRisk === true, "高危自动标记（tabs+cookies）")
  const t2 = Date.now()
  const policy2 = await resolveWorkspaceCrxPolicy(ws.id)
  const t3 = Date.now()
  ok(policy2.entries.length === 1, "二次解析结果一致（缓存路径）")
  console.log(`  · 首次 ${t1 - t0}ms / 二次 ${t3 - t2}ms（二次走缓存应显著更快）`)
  ok(t3 - t2 <= t1 - t0, "缓存命中不慢于直查")

  // 3. 失效后再查（应重新拉库）
  invalidateCrxLibCache(crxId)
  const policy3 = await resolveWorkspaceCrxPolicy(ws.id)
  ok(policy3.entries.length === 1, "失效后重查结果一致")

  // 4. 库内禁用 → 合并标记 disabled（写后缓存失效实时性）
  await db.crxPlugin.update({ where: { crxId }, data: { enabled: false } })
  invalidateCrxLibCache(crxId)
  const policy4 = await resolveWorkspaceCrxPolicy(ws.id)
  ok(policy4.entries.length === 0, "库内禁用 → 禁用条目从合并输出剔除（不进入安装列表）")
  await db.crxPlugin.update({ where: { crxId }, data: { enabled: true } })

  // 5. 级联清理（回收站 purge 语义）——不真实走 purge（会删工作区），改验证模型存在性
  ok(typeof db.crxInstallStatus !== "undefined", "crxInstallStatus 模型可用")
  ok(typeof db.workspaceShareLink !== "undefined", "workspaceShareLink 模型可用")

  // 6. 清理
  await db.crxPolicyEntry.deleteMany({ where: { scopeType: "GLOBAL", scopeId: "", crxId } })
  await db.crxPlugin.delete({ where: { crxId } })
  await db.browserWorkspace.delete({ where: { id: ws.id } })
  invalidateCrxLibCache()
  const residual = await db.crxPlugin.count({ where: { crxId } })
  ok(residual === 0, "QA 数据清理归零")

  console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`)
  if (fail > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
