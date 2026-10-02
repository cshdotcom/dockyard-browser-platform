// QA 辅助：校验 demo 密码 hash 与重置
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const u = await db.user.findUnique({ where: { username: "demo" } })
  if (!u) throw new Error("demo 不存在")
  console.log("hash 前 12 位:", u.passwordHash?.slice(0, 12), "长度:", u.passwordHash?.length)
  console.log("compare(旧):", await bcrypt.compare("Demo@2026r14", u.passwordHash!))
  // 重新同步（bcrypt rounds 12，与 pre-login verifyPassword(bcrypt.compare) 完全一致）
  const hash = await bcrypt.hash("Demo@2026r14", 12)
  await db.user.update({ where: { id: u.id }, data: { passwordHash: hash } })
  console.log("重新同步后 compare:", await bcrypt.compare("Demo@2026r14", hash))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
