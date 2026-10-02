import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  // 手动种一条封禁记录（模拟已触发）
  await db.ipBanRecord.upsert({
    where: { ip: "198.51.100.88" },
    update: { bannedUntil: new Date(Date.now() + 120_000), source: "API_KEY", failCount: 12, reason: "QA模拟封禁" },
    create: { ip: "198.51.100.88", source: "API_KEY", failCount: 12, bannedUntil: new Date(Date.now() + 120_000), reason: "QA模拟封禁" },
  })
  console.log("ban seeded 198.51.100.88")
}
main().finally(() => db.$disconnect())
