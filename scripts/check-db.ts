import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const users = await db.user.findMany({ select: { id: true, username: true, role: true, enabled: true, frozen: true, lockedUntil: true, twoFactorEnabled: true, deletedAt: true, passwordHash: true }, take: 20 })
  console.log("USERS:", JSON.stringify(users.map(u => ({ ...u, passwordHash: u.passwordHash?.slice(0, 7) + "..." })), null, 2))
  console.log("loginSessions:", await db.loginSession.count())
  console.log("systemConfigs:", await db.systemConfig.count())
  console.log("workspaces:", await db.browserWorkspace.count())
}
main().catch(e => { console.error("DB ERROR:", e.message); process.exit(1) }).finally(() => db.$disconnect())
