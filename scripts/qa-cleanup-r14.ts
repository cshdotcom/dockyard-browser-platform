// r14 QA 数据清理：QA-22c 工作区/测试通知/策略字段复位
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // 工作区（QA-22c 两个）
  const ws = await db.browserWorkspace.deleteMany({ where: { name: { startsWith: "QA-22c" } } })
  console.log("workspaces deleted:", ws.count)
  // 测试通知
  const n = await db.notice.deleteMany({ where: { title: { startsWith: "QA-r14" } } })
  console.log("notices deleted:", n.count)
  // 策略字段复位（组/用户/全局）
  await db.group.updateMany({ data: { idleTimeoutMinutes: null, idleTimeoutLocked: false } })
  await db.user.updateMany({ data: { idleTimeoutMinutes: null, idleTimeoutLocked: false } })
  console.log("group/user idle policy reset to null/false")
  // 共享/链接残留检查
  const s = await db.workspaceShare.count()
  const sl = await db.workspaceShareLink.count()
  const a = await db.announcement.count()
  console.log(`shares=${s} shareLinks=${sl} announcements=${a}`)
  // 工作区终态
  const w = await db.browserWorkspace.count()
  console.log("workspaces remaining:", w)
}

main().finally(() => db.$disconnect())
