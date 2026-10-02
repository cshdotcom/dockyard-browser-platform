import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const ws = await db.browserWorkspace.findFirst({ where: { name: "QA-共享测试工作区2" } })
  if (!ws) throw new Error("未找到")
  await db.browserWorkspace.update({ where: { id: ws.id }, data: { mode: "novnc_full" } })
  console.log(`[qa] ${ws.id} → novnc_full`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
