import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const admin = await db.user.findUnique({ where: { username: "admin" } })
// 直接创建 novnc_full 工作区（demo 模式：桥演示引擎，无 chromium 时自动降级）
let ws = await db.browserWorkspace.findFirst({ where: { userId: admin.id, mode: "novnc_full", deletedAt: null } })
if (!ws) {
  ws = await db.browserWorkspace.create({
    data: {
      name: "QA-r34 软键盘测试", uuid: `qa34vnc-${Date.now().toString(36)}`, userId: admin.id,
      mode: "novnc_full", status: "RUNNING", novncSessionId: `demo-${Date.now()}`,
    },
  })
}
console.log("WS:" + ws.id)
await db.$disconnect()
