import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
// 清理 r34 QA 数据
const ws = await db.browserWorkspace.findMany({ where: { name: { startsWith: "QA-r34" } } })
for (const w of ws) {
  await db.browseHistoryEntry.deleteMany({ where: { workspaceId: w.id } })
  await db.workspaceShare.deleteMany({ where: { workspaceId: w.id } })
  await db.workspaceShareLink.deleteMany({ where: { workspaceId: w.id } })
}
await db.auditLog.deleteMany({ where: { resourceId: { in: ws.map(w => w.id) } } })
await db.browserWorkspace.deleteMany({ where: { id: { in: ws.map(w => w.id) } } })
await db.notice.deleteMany({ where: { title: { startsWith: "QA-r34" } } })
await db.emailVerificationCode.deleteMany({ where: { email: { startsWith: "qa-r34" } } })
// 清理上传的测试文件
import { rm, readdir } from "fs/promises"
const { join } = await import("path")
const admin = await db.user.findUnique({ where: { username: "admin" } })
const homeDir = `storage/home/${admin.id}`
try {
  for (const f of await readdir(homeDir)) {
    if (f.includes("非常长的文件名") || f === "r34-batch-second.txt") await rm(join(homeDir, f))
  }
} catch { /* noop */ }
await db.fileMeta.deleteMany({ where: { fileName: { startsWith: "r34-batch" } } })
await db.fileMeta.deleteMany({ where: { fileName: { contains: "非常长的文件名" } } })
const final = {
  ws: await db.browserWorkspace.count({ where: { name: { startsWith: "QA-r34" } } }),
  notice: await db.notice.count({ where: { title: { startsWith: "QA-r34" } } }),
  files: await db.fileMeta.count(),
}
console.log("cleanup final:", JSON.stringify(final))
await db.$disconnect()
