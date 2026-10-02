// 密码哈希验证：确认 DB 中 admin 的 passwordHash 对应哪个密码
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const db = new PrismaClient()
const candidates = ["Admin@2026", "Admin123456!", "Admin@2026r14", "admin", "Admin@2026!"]

const user = await db.user.findFirst({ where: { username: "admin" } })
console.log("admin found:", !!user, "hash:", user?.passwordHash?.slice(0, 20), "...")

for (const p of candidates) {
  const ok = await bcrypt.compare(p, user?.passwordHash || "")
  console.log(`  ${p.padEnd(20)} → ${ok ? "✓ MATCH" : "✗"}`)
}
await db.$disconnect()
