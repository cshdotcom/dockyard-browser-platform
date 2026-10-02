// r13c QA 清理：移除测试工作区/共享关系/CRX 策略条目与测试插件
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const wss = await db.browserWorkspace.findMany({ where: { name: { startsWith: "QA-共享测试" } }, select: { id: true } })
  const ids = wss.map((w) => w.id)
  if (ids.length) {
    await db.workspaceShare.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspaceShareLink.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.browserWorkspace.deleteMany({ where: { id: { in: ids } } })
  }
  const r1 = await db.crxPolicyEntry.deleteMany({})
  const r2 = await db.crxInstallStatus.deleteMany({ where: { workspaceId: { in: ids } } })
  const r3 = await db.crxPlugin.deleteMany({ where: { crxId: "ddkjiahejlhfcafbddmgiahcphecmpfh" } })
  // 还原被否决开关与用户/组开关（QA 期间改动）
  await db.browserWorkspace.updateMany({ data: { shareDisabled: false } })
  await db.user.updateMany({ data: { shareAllowed: null } })
  await db.group.updateMany({ data: { allowShare: true } })
  console.log(`[qa-cleanup] 工作区×${ids.length} 共享×(随工作区) 策略条目×${r1.count} 安装状态×${r2.count} 插件×${r3.count}；开关已复位`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
