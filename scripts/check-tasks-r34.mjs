import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
try {
  const counts = { hist: await db.browseHistoryEntry.count(), bk: await db.bookmarkEntry.count(), wsRunning: await db.browserWorkspace.count({ where: { status: "RUNNING" } }) }
  console.log("counts:", JSON.stringify(counts))
  const lastTask = await db.scheduleTask.findMany({ where: { code: "browsing_collect" }, select: { lastExecuteAt: true, lastStatus: true, lastResult: true } })
  console.log("browsing_collect:", JSON.stringify(lastTask))
} catch (e) {
  console.log("ERR", e.message)
} finally {
  await db.$disconnect()
}
