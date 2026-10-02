// r13c QA：种子测试共享数据（工作区 + 共享关系 + 用户组开关状态）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  if (!demo || !admin) throw new Error("缺少 demo/admin 账号")
  if (demo.shareAllowed !== null) throw new Error("demo.shareAllowed 应为 null（继承组）")

  // 种一个 demo 的工作区
  const ws = await db.browserWorkspace.create({
    data: {
      name: "QA-共享测试工作区",
      mode: "cdp_light",
      status: "STOPPED",
      userId: demo.id,
      tags: ["qa", "share-test"],
    },
  })
  // demo → admin 共享（可操作 + 24h 过期）
  await db.workspaceShare.create({
    data: { workspaceId: ws.id, targetUserId: admin.id, permission: "OPERATE", createdByUserId: demo.id, expireAt: new Date(Date.now() + 24 * 3600_000) },
  })
  // 再建一个被撤销的历史共享（审计态）
  const ws2 = await db.browserWorkspace.create({
    data: { name: "QA-共享测试工作区2", mode: "novnc_full", status: "STOPPED", userId: demo.id, tags: ["qa"] },
  })
  await db.workspaceShare.create({
    data: { workspaceId: ws2.id, targetUserId: admin.id, permission: "VIEW", createdByUserId: demo.id, revokedAt: new Date() },
  })
  console.log(`[qa-seed] 工作区1=${ws.id}（生效共享） 工作区2=${ws2.id}（已撤销共享）`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
