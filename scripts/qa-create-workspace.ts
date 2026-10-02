// QA 辅助：为 demo 用户创建一个测试工作区（模拟形态，不启动容器）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  if (!demo) throw new Error("demo 不存在")
  const count = await db.browserWorkspace.count({ where: { userId: demo.id, deletedAt: null } })
  if (count > 0) {
    console.log("demo 已有工作区，跳过")
    return
  }
  const ws = await db.browserWorkspace.create({
    data: {
      uuid: `qa-ws-${Date.now().toString(36)}`,
      name: "QA 共享测试沙箱",
      mode: "novnc_full",
      status: "STOPPED",
      userId: demo.id,
      tags: [],
    },
  })
  console.log("已创建工作区:", ws.id, ws.name)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
