// 邮件配置保存链路诊断：setConfig → DB → getConfig → getAllConfig 全链路一致性
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const key = "smtp.host"
  const testVal = "diag-smtp-test.example.com"
  // 1. 当前值
  const before = await db.systemConfig.findUnique({ where: { key } })
  console.log("[1] DB before:", before?.valueJson ?? "(none)", "version:", before?.version ?? 0)
  // 2. 模拟 setConfig 路径（upsert + version）
  const version = (before?.version ?? 0) + 1
  await db.systemConfig.upsert({
    where: { key },
    update: { valueJson: JSON.stringify(testVal), version, updatedByUserId: "diag" },
    create: { key, valueJson: JSON.stringify(testVal), category: "MAIL", valueType: "string", version: 1 },
  })
  await db.configVersion.create({
    data: { configKey: key, version, beforeJson: before?.valueJson ?? null, afterJson: JSON.stringify(testVal), operatorUserId: "diag" },
  })
  // 3. 读回
  const after = await db.systemConfig.findUnique({ where: { key } })
  console.log("[3] DB after:", after?.valueJson, "version:", after?.version)
  const all = await db.systemConfig.count({ where: { key: { startsWith: "smtp." } } })
  console.log("[4] smtp.* rows in DB:", all)
  // 4. 全部 smtp 键值
  const rows = await db.systemConfig.findMany({ where: { key: { startsWith: "smtp." } } })
  for (const r of rows) console.log("   ", r.key, "=", r.valueJson)
  // 5. 还原
  await db.systemConfig.update({
    where: { key },
    data: { valueJson: before?.valueJson ?? JSON.stringify(""), version: before?.version ?? 0 },
  })
  await db.configVersion.deleteMany({ where: { configKey: key, version } })
  console.log("[5] restored:", before?.valueJson ?? '""')
  // 6. env 覆盖检查
  console.log("[6] CONFIG_OVERRIDE env:", process.env.CONFIG_OVERRIDE ?? "(unset)")
}

main().finally(() => db.$disconnect())
