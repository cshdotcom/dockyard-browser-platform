import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const admin = await db.user.findUnique({ where: { username: "admin" } })
let ws = await db.browserWorkspace.findFirst({ where: { userId: admin.id, deletedAt: null } })
if (!ws) {
  ws = await db.browserWorkspace.create({
    data: {
      name: "QA-r34 时间轴测试沙箱", uuid: `qa-r34-${Date.now().toString(36)}`, userId: admin.id,
      mode: "cdp_light", status: "STOPPED", cdpUrl: "http://127.0.0.1:9222",
    },
  })
  console.log("created:", ws.id)
} else {
  console.log("existing:", ws.id, ws.name)
}
// 造时间轴数据：浏览历史 + 审计
await db.browseHistoryEntry.create({
  data: { workspaceId: ws.id, userId: admin.id, url: "https://example.com/qa-r34", title: "QA r34 浏览页", domain: "example.com", visitAt: new Date(), dwellMs: 45000 },
}).catch(e => console.log("hist err:", e.message))
await db.auditLog.create({
  data: { operationType: "FILE_UPLOAD", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name, operatorUserId: admin.id, operatorName: "admin", severity: "INFO", afterJson: "上传 长文件名测试.txt 17B" },
}).catch(e => console.log("audit err:", e.message))
console.log("WS:" + ws.id)
await db.$disconnect()
