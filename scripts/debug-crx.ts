// CRX 策略解析调试脚本
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const workspaces = await db.browserWorkspace.findMany({ where: { deletedAt: null, status: { in: ["RUNNING", "IDLE"] } }, select: { id: true, name: true, userId: true, groupId: true, crxInheritEnabled: true } })
  console.log("running workspaces:", workspaces.length)
  for (const ws of workspaces) {
    console.log(`\n=== ${ws.name} (${ws.id.slice(0, 8)}) inherit=${ws.crxInheritEnabled} group=${ws.groupId || "none"}`)
    // 模拟五级合并的 GLOBAL 层
    const entries = await db.crxPolicyEntry.findMany({ where: { scopeType: "GLOBAL", scopeId: "", deletedAt: null } })
    console.log("  GLOBAL entries:", entries.length)
    const gu = await db.groupUser.findFirst({ where: { userId: ws.userId } })
    console.log("  user group link:", gu ? gu.groupId.slice(0, 8) : "none")
    const user = await db.user.findUnique({ where: { id: ws.userId }, select: { username: true } })
    console.log("  owner:", user?.username)
    // 安装状态
    const st = await db.crxInstallStatus.count({ where: { workspaceId: ws.id } })
    console.log("  install statuses:", st)
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
