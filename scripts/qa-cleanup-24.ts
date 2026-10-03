// QA24 数据清理（幂等，可重复执行）
// 1. 删除 QA24 测试工作区（IME测试/VNC输入法）及其共享/链接/回收站残留
// 2. 删除 QA24 自定义任务（Shell冒烟/链编排）及其执行日志
// 3. 清理相关审计日志（TASK 资源 custom:* + WORKSPACE_CREATE + IME_CHANGE）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

// 工作区清理
const wsList = await db.browserWorkspace.findMany({ where: { name: { contains: "QA24" } }, select: { id: true, name: true, novncSessionId: true, containerRef: true } })
for (const ws of wsList) {
  await db.workspaceShare.deleteMany({ where: { workspaceId: ws.id } })
  await db.workspaceShareLink.deleteMany({ where: { workspaceId: ws.id } })
  // RecycleBin 无 workspaceId 字段（resourceId=工作区 id）
  await db.recycleBin.deleteMany({ where: { resourceId: ws.id } })
  await db.browserWorkspace.deleteMany({ where: { id: ws.id } })
  console.log(`✓ 删除工作区 ${ws.name}`)
}

// 自定义任务清理
const tasks = await db.scheduleTask.findMany({ where: { name: { contains: "QA24" } }, select: { code: true, name: true } })
for (const t of tasks) {
  await db.scheduleTaskLog.deleteMany({ where: { taskCode: t.code } })
  await db.scheduleTask.deleteMany({ where: { code: t.code } })
  console.log(`✓ 删除任务 ${t.name}（${t.code}）`)
}

// 审计清理（QA24 产物：TASK 资源 + WORKSPACE_CREATE + IME_CHANGE + TASK_EXECUTE 等）
const delAudits = await db.auditLog.deleteMany({
  where: {
    OR: [
      { AND: [{ resourceType: "TASK" }, { resourceId: { startsWith: "custom:" } }] },
      { AND: [{ operationType: "WORKSPACE_CREATE" }, { resourceName: { contains: "QA24" } }] },
      { AND: [{ operationType: "IME_CHANGE" }, { resourceName: { contains: "QA24" } }] },
      { AND: [{ operationType: "TASK_CUSTOM_CREATE" }, { resourceName: { contains: "QA24" } }] },
    ],
  },
})
console.log(`✓ 清理审计 ${delAudits.count} 条`)

// 终态断言
const wsLeft = await db.browserWorkspace.count({ where: { name: { contains: "QA24" } } })
const taskLeft = await db.scheduleTask.count({ where: { name: { contains: "QA24" } } })
const customLeft = await db.scheduleTask.count({ where: { isCustom: true } })
console.log(`终态：QA24工作区=${wsLeft} QA24任务=${taskLeft} 自定义任务总数=${customLeft}`)
if (wsLeft !== 0 || taskLeft !== 0) { console.log("CLEANUP FAIL"); process.exit(1) }
console.log("CLEANUP PASS")
await db.$disconnect()
