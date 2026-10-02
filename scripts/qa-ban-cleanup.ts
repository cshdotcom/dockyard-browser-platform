import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  await db.ipBanRecord.deleteMany({ where: { ip: { in: ["198.51.100.88", "198.51.100.77"] } } })
  await db.apiToken.deleteMany({ where: { name: "QA-2FA-APITEST" } })
  console.log("ban + token cleaned")
}
main().finally(() => db.$disconnect())
