// 站内信 fan-out 隔离测试：复现 fanOutInboxNotices 全流程
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const ann = { id: "test-fanout-" + Date.now(), title: "测试标题", content: "## MD **内容** <b>HTML</b>", type: "GLOBAL", groupId: null, userId: null }

  // 1. 目标用户
  const users = await db.user.findMany({ where: { deletedAt: null, enabled: true, frozen: false }, select: { id: true } })
  console.log("目标用户数:", users.length)

  // 2. 幂等查询
  const link = `/announcements?focus=${ann.id}`
  const existing = await db.notice.findMany({ where: { type: "ANNOUNCEMENT", link }, select: { userId: true } })
  console.log("已存在:", existing.length)

  // 3. createMany
  try {
    const batch = users.slice(0, 3).map((u) => ({
      userId: u.id,
      title: `【公告】${ann.title}`,
      content: "摘要测试",
      type: "ANNOUNCEMENT",
      link,
    }))
    const r = await db.notice.createMany({ data: batch })
    console.log("createMany 结果:", r)
  } catch (e) {
    console.error("createMany 失败:", e instanceof Error ? e.message : e)
  }

  // 4. 清理
  await db.notice.deleteMany({ where: { type: "ANNOUNCEMENT", link } })
  console.log("已清理测试数据")
}

main().catch(console.error).finally(() => db.$disconnect())
