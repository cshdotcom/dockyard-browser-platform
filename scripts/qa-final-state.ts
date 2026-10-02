import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const [users, groups, ws, shares, ipbans, customTasks, qaTokens] = await Promise.all([
    db.user.count({ where: { deletedAt: null } }),
    db.group.count(),
    db.browserWorkspace.count(),
    db.workspaceShare.count(),
    db.ipBanRecord.count(),
    db.scheduleTask.count({ where: { isCustom: true } }),
    db.apiToken.count({ where: { name: { contains: "QA" } } }),
  ])
  console.log(`终态: users=${users} groups=${groups} workspaces=${ws} shares=${shares} ipbans=${ipbans} customTasks=${customTasks} qaTokens=${qaTokens}`)
  const demo = await db.user.findUnique({ where: { username: "demo" }, select: { force2faSetup: true, tokenPolicy: true } })
  console.log(`demo: force2faSetup=${demo?.force2faSetup} tokenPolicy=${JSON.stringify(demo?.tokenPolicy)}`)
  const ipBanCfg = await db.systemConfig.findUnique({ where: { key: "security.ipBanThreshold" } })
  const emailCfg = await db.systemConfig.findUnique({ where: { key: "alert.emailEnabled" } })
  console.log(`config: ipBanThreshold=${ipBanCfg?.valueJson} alert.emailEnabled=${emailCfg?.valueJson}`)
}
main().finally(() => db.$disconnect())
