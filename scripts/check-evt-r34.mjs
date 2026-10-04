import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const evt = await db.securityEvent.findMany({ where: { eventType: "LOGIN_FAILED", ip: "5.6.7.8" }, orderBy: { createdAt: "desc" }, take: 3 })
console.log(JSON.stringify(evt.map(e => ({ ip: e.ip, username: e.username, detail: e.detail, at: e.createdAt })), null, 1))
await db.$disconnect()
