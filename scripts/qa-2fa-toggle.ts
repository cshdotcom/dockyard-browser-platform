import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const mode = process.argv[2] || "on"
  await db.user.update({ where: { username: "demo" }, data: { force2faSetup: mode === "on", twoFactorEnabled: false } })
  console.log(`demo force2faSetup=${mode === "on"}`)
}
main().finally(() => db.$disconnect())
