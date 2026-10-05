// r38 MySQL CRUD 冒烟测试 — @prisma/client-mysql 直连 MariaDB
// 验证：连接 / Json 字段 / 长文本 MediumText / 唯一约束 / 级联删除 / 中文
import { PrismaClient } from "@prisma/client-mysql"

const url = process.env.DATABASE_URL || "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard"
const db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] })

async function main() {
  const results: Array<[string, boolean, string]> = []
  const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail])

  // 1. 连接
  try {
    await db.$connect()
    check("连接 MariaDB", true)
  } catch (e: unknown) {
    check("连接 MariaDB", false, String(e))
    console.table(results)
    process.exit(1)
  }

  // 2. 清理旧测试数据
  await db.user.deleteMany({ where: { username: { startsWith: "mysqlsmoke" } } })
  await db.group.deleteMany({ where: { name: { startsWith: "mysqlsmoke" } } })

  // 3. 用户 CRUD（含 Json 字段 preferences/quota、中文、长 UA）
  const longUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 " + "X".repeat(2000)
  const user = await db.user.create({
    data: {
      username: "mysqlsmoke_user1",
      displayName: "冒烟测试用户·中文",
      email: "mysqlsmoke@example.com",
      passwordHash: "$2a$12$" + "h".repeat(53),
      role: "USER",
      preferences: { pageSize: 50, theme: "dark", columns: ["a", "b", "c"], nested: { deep: { value: [1, 2, 3] } } },
      quota: { sessions: 5, diskMb: 1024 },
      lastLoginIp: "192.168.1.100",
    },
  })
  check("create 用户（Json preferences 嵌套）", !!user.id)
  check("cuid 主键格式", /^[a-z0-9]{20,}$/.test(user.id), user.id)

  const fetched = await db.user.findUnique({ where: { username: "mysqlsmoke_user1" } })
  const pref = fetched?.preferences as { pageSize?: number; nested?: { deep?: { value?: number[] } } } | null
  check("读取 Json 字段往返", pref?.pageSize === 50 && Array.isArray(pref?.nested?.deep?.value) && pref.nested!.deep!.value!.length === 3, JSON.stringify(pref).slice(0, 80))

  // 4. 唯一约束
  let uniqueHit = false
  try {
    await db.user.create({ data: { username: "mysqlsmoke_user1", passwordHash: "x" } })
  } catch {
    uniqueHit = true
  }
  check("username 唯一约束生效", uniqueHit)

  // 5. 组 + 关联 + 级联
  const group = await db.group.create({ data: { name: "mysqlsmoke_group", hardwarePolicy: { camera: { enabled: true } } } })
  await db.groupUser.create({ data: { groupId: group.id, userId: user.id } })
  const link = await db.groupUser.findFirst({ where: { groupId: group.id } })
  check("组-用户关联", link?.userId === user.id)

  // 6. 审计（MediumText 长载荷）
  const audit = await db.auditLog.create({
    data: {
      operationType: "MYSQL_SMOKE",
      resourceType: "TEST",
      severity: "INFO",
      operatorName: "mysqlsmoke_user1",
      userAgent: longUa,
      beforeJson: JSON.stringify({ big: "y".repeat(100_000) }),
    },
  })
  const auditBack = await db.auditLog.findUnique({ where: { id: audit.id } })
  check("审计长 UA（>191 字符）无损", (auditBack?.userAgent?.length ?? 0) === longUa.length, `len=${auditBack?.userAgent?.length}`)
  check("审计 beforeJson 100KB MediumText 无损", (auditBack?.beforeJson?.length ?? 0) === JSON.stringify({ big: "y".repeat(100_000) }).length, `len=${auditBack?.beforeJson?.length}`)
  await db.auditLog.delete({ where: { id: audit.id } })

  // 7. 系统配置 upsert（种子核心路径）
  await db.systemConfig.upsert({
    where: { key: "mysqlsmoke.test" },
    update: { valueJson: '"updated"' },
    create: { key: "mysqlsmoke.test", valueJson: '"created"', category: "GENERAL", valueType: "string" },
  })
  await db.systemConfig.upsert({
    where: { key: "mysqlsmoke.test" },
    update: { valueJson: '"updated"' },
    create: { key: "mysqlsmoke.test", valueJson: '"created"', category: "GENERAL", valueType: "string" },
  })
  const cfg = await db.systemConfig.findUnique({ where: { key: "mysqlsmoke.test" } })
  check("upsert 幂等", cfg?.valueJson === '"updated"')

  // 8. 事务
  const txOk = await db.$transaction(async (tx) => {
    const u2 = await tx.user.create({ data: { username: "mysqlsmoke_user2", passwordHash: "x" } })
    await tx.user.delete({ where: { id: u2.id } })
    return true
  })
  check("事务 create+delete", txOk)

  // 9. 分页/排序/过滤
  const users = await db.user.findMany({
    where: { username: { startsWith: "mysqlsmoke" } },
    orderBy: { createdAt: "desc" },
    take: 10,
    skip: 0,
  })
  check("findMany 过滤/排序/分页", users.length >= 1)

  // 10. 更新 + 中文往返
  await db.user.update({ where: { username: "mysqlsmoke_user1" }, data: { displayName: "改名后的中文用户名·更新" } })
  const renamed = await db.user.findUnique({ where: { username: "mysqlsmoke_user1" } })
  check("中文更新无损", renamed?.displayName === "改名后的中文用户名·更新")

  // 11. count/aggregate
  const cnt = await db.user.count({ where: { username: { startsWith: "mysqlsmoke" } } })
  check("count 聚合", cnt === users.length, `cnt=${cnt}`)

  // 12. 级联清理
  await db.groupUser.deleteMany({ where: { groupId: group.id } })
  await db.group.delete({ where: { id: group.id } })
  await db.user.deleteMany({ where: { username: { startsWith: "mysqlsmoke" } } })
  const after = await db.user.count({ where: { username: { startsWith: "mysqlsmoke" } } })
  check("级联清理", after === 0)
  await db.systemConfig.deleteMany({ where: { key: { startsWith: "mysqlsmoke." } } })

  // ---- 汇总 ----
  let pass = 0
  for (const [name, ok, detail] of results) {
    if (ok) pass++
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  [" + detail + "]" : ""}`)
  }
  console.log(`\n[mysql-crud-smoke] ${pass}/${results.length} 通过`)
  await db.$disconnect()
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error("[mysql-crud-smoke] FATAL:", e)
  process.exit(1)
})
