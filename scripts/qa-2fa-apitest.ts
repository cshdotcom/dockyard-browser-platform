// 2FA 门控下 API-Key 通道不受影响验证：为 demo 直接造一枚有效 Key（明文一次），调 MCP
import { PrismaClient } from "@prisma/client"
import { createHash } from "crypto"
const db = new PrismaClient()
const plain = "dyk_qa_2fa_" + Date.now().toString(36)
async function main() {
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  const t = await db.apiToken.create({
    data: {
      userId: demo!.id, name: "QA-2FA-APITEST",
      tokenHash: createHash("sha256").update(plain).digest("hex"),
      tokenPrefix: plain.slice(0, 8),
      permissionsMask: 1, // READ
      enabled: true,
    },
  })
  console.log("TOKEN_ID=" + t.id)
  console.log("PLAIN=" + plain)
}
main().finally(() => db.$disconnect())
