// r38 db.ts Proxy 热切换客户端运行时验证
// 验证：Proxy 转发 CRUD / $transaction / $queryRaw / $extends 兼容 / 配置链
import { db, databaseProvider, effectiveDatabaseConfig, probeDatabase, rebuildDbClient, createClientFor } from "../src/lib/db"

async function main() {
  const results: Array<[string, boolean, string]> = []
  const check = (n: string, ok: boolean, d = "") => results.push([n, ok, d])

  // 1. 配置链
  const eff = effectiveDatabaseConfig()
  check(`配置链 source=${eff.source} provider=${eff.provider}`, eff.provider === "sqlite" || eff.provider === "postgres" || eff.provider === "mysql")

  // 2. Proxy CRUD
  const before = await db.user.count()
  check("Proxy db.user.count()", typeof before === "number", `count=${before}`)

  // 3. $queryRaw
  const raw = await db.$queryRawUnsafe("SELECT 1 AS one")
  check("Proxy $queryRawUnsafe", Array.isArray(raw) && Number((raw as Array<{ one: number }>)[0]?.one) === 1)

  // 4. create / findUnique / update / delete 经 Proxy
  const u = await db.user.create({ data: { username: "proxytest_tmp", passwordHash: "x", displayName: "代理测试" } })
  const found = await db.user.findUnique({ where: { id: u.id } })
  check("Proxy create/findUnique", found?.username === "proxytest_tmp")
  await db.user.update({ where: { id: u.id }, data: { displayName: "代理改名" } })
  const upd = await db.user.findUnique({ where: { id: u.id } })
  check("Proxy update", upd?.displayName === "代理改名")
  await db.user.delete({ where: { id: u.id } })
  check("Proxy delete", (await db.user.count({ where: { username: "proxytest_tmp" } })) === 0)

  // 5. $transaction
  const txRes = await db.$transaction(async (tx) => {
    const t = await tx.user.create({ data: { username: "txtest_tmp", passwordHash: "x" } })
    await tx.user.delete({ where: { id: t.id } })
    return "ok"
  })
  check("Proxy $transaction 交互式", txRes === "ok")

  // 6. SystemConfig（key 主键模型 —— 迁移分页需要）
  await db.systemConfig.upsert({
    where: { key: "proxytest.key" },
    update: {},
    create: { key: "proxytest.key", valueJson: "1", category: "GENERAL", valueType: "number" },
  })
  const cfg = await db.systemConfig.findUnique({ where: { key: "proxytest.key" } })
  check("Proxy SystemConfig（非 id 主键）", !!cfg)
  await db.systemConfig.delete({ where: { key: "proxytest.key" } })

  // 7. probe MySQL（真实实例）
  const probeMy = await probeDatabase("mysql", "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard")
  check("probe MySQL（结构+数据就绪）", probeMy.ok && probeMy.hasSchema && probeMy.hasData, probeMy.error || `${probeMy.version} users=${probeMy.userCount} ${probeMy.latencyMs}ms`)

  // 8. probe PG（真实实例）
  const probePg = await probeDatabase("postgres", "postgresql://dockyard:DyPg2026pw@127.0.0.1:5433/dockyard")
  check("probe PostgreSQL（空库）", probePg.ok && !probePg.hasSchema, probePg.error || `${probePg.version} ${probePg.latencyMs}ms`)

  // 9. probe 环境恢复（探测后生效配置回到 sqlite）
  const after = effectiveDatabaseConfig()
  check("probe 后配置无污染", after.provider === eff.provider && after.source === eff.source)

  // 10. rebuildDbClient 幂等（sqlite → sqlite 重建）
  const rb = await rebuildDbClient({ disconnectOldAfterMs: 100 })
  check("rebuildDbClient 重建", rb.provider === eff.provider)
  const cnt2 = await db.user.count()
  check("重建后 CRUD 正常", typeof cnt2 === "number", `count=${cnt2}`)

  // 11. databaseProvider() URL 推断
  const savedP = process.env.DATABASE_PROVIDER
  const savedU = process.env.DATABASE_URL
  process.env.DATABASE_PROVIDER = ""
  process.env.DATABASE_URL = "mysql://x:y@h:3306/d"
  check("URL 推断 mysql", databaseProvider() === "mysql")
  process.env.DATABASE_URL = "postgresql://x:y@h:5432/d"
  check("URL 推断 postgres", databaseProvider() === "postgres")
  process.env.DATABASE_URL = "file:./x.db"
  check("URL 推断 sqlite", databaseProvider() === "sqlite")
  process.env.DATABASE_PROVIDER = savedP
  process.env.DATABASE_URL = savedU

  // ---- 汇总 ----
  let pass = 0
  for (const [n, ok, d] of results) {
    if (ok) pass++
    console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`)
  }
  console.log(`\n[db-proxy-smoke] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error("[db-proxy-smoke] FATAL:", e)
  process.exit(1)
})
