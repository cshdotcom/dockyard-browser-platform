import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const w = await db.browserWorkspace.findFirst({ where: { name: "QA-共享测试工作区" } })
  console.log(w!.id)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
