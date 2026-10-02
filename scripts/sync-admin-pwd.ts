// 管理员密码强制同步（QA 环境）：直接 bcrypt 更新 DB
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const db = new PrismaClient()
const newPwd = process.env.NEW_PWD || "Admin@2026r14"
const u = await db.user.update({
  where: { username: "admin" },
  data: { passwordHash: await bcrypt.hash(newPwd, 12), mustChangePassword: false, lockedUntil: null, failedLoginCount: 0 },
})
console.log("已同步 admin 密码 →", newPwd, "（锁定/失败计数已清零）")
await db.$disconnect()
