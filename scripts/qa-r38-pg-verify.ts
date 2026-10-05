// r38 PG 迁移结果验证（postgres dockyard_mig 计数 + 中文 + Json）
async function main() {
  const { PrismaClient } = await import("@prisma/client-postgres")
  const pg = new PrismaClient({ log: ["error"] })
  const userCount = await pg.user.count()
  const cfgCount = await pg.systemConfig.count()
  const groupCount = await pg.group.count()
  const taskCount = await pg.scheduleTask.count()
  const admin = await pg.user.findUnique({ where: { username: "admin" } })
  const audit = await pg.auditLog.count()
  const ok = userCount === 2 && cfgCount === 180 && groupCount === 1 && taskCount === 30 && !!admin
  console.log(`[pg-verify] users=${userCount} configs=${cfgCount} groups=${groupCount} tasks=${taskCount} audits=${audit} admin=${admin?.displayName}`)
  console.log(`[pg-verify] admin preferences(Json) = ${JSON.stringify(admin?.preferences ?? null).slice(0, 80)}`)
  await pg.$disconnect()
  console.log(`[pg-verify] ${ok ? "PASS ✓" : "FAIL ✗"}`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
