// r27 浏览器实测数据清理
import { PrismaClient } from "@prisma/client"
import { rmSync } from "fs"
const db = new PrismaClient()
async function main() {
  const rows = await db.vncRecording.findMany({ where: { workspaceName: "QA-R27UI-回放演示" } })
  for (const r of rows) {
    const dir = r.sessionId ? `storage/recordings/${r.userId}/${r.sessionId}` : null
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  const wsIds = [...new Set(rows.map((r) => r.workspaceId))]
  await db.recycleBin.deleteMany({ where: { resourceType: "RECORDING", resourceId: { in: rows.map((r) => r.id) } } })
  await db.vncRecording.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
  await db.auditLog.deleteMany({ where: { resourceType: "RECORDING" } })
  await db.browserWorkspace.deleteMany({ where: { id: { in: wsIds } } })
  console.log("清理：录像", rows.length, "工作区", wsIds.length, "剩余", await db.vncRecording.count())
  await db.$disconnect()
}
main()
