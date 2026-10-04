import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const admin = await db.user.findUnique({ where: { username: "admin" } })
const n = await db.notice.create({ data: { userId: admin.id, title: "QA-r34 站内信测试", content: "这是一条测试通知，验证消息记录页显示。", type: "SECURITY" } })
console.log("notice:", n.id)
await db.$disconnect()
