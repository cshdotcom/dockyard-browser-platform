// r31 QA 清理：工作区/分享链接/录像行/收藏偏好/测试文件 全部归零
import { PrismaClient } from "@prisma/client"
import { rm } from "fs/promises"
import { join } from "path"

const db = new PrismaClient()
const admin = await db.user.findUnique({ where: { username: "admin" } })

// 1. QA 工作区（演示通道 + 冒烟残留）
const wsList = await db.browserWorkspace.findMany({ where: { name: { contains: "QA-r31" } }, select: { id: true, novncSessionId: true, userId: true } })
for (const w of wsList) {
  await db.vncRecording.deleteMany({ where: { workspaceId: w.id } })
  await db.browserWorkspace.delete({ where: { id: w.id } }).catch(() => null)
}
console.log("工作区清理:", wsList.length)

// 2. 录像残留（-man 会话）
const recRows = await db.vncRecording.findMany({ where: { sessionId: { contains: "-man" } }, select: { sessionId: true, userId: true } })
for (const r of recRows) {
  await rm(join(process.cwd(), "storage", "recordings", r.userId, r.sessionId), { recursive: true, force: true }).catch(() => null)
  await db.vncRecording.deleteMany({ where: { sessionId: r.sessionId } })
}
console.log("录像残留清理:", recRows.length)

// 3. 分享链接（QA 分享目录下创建的）
const shares = await db.fileShareLink.findMany({ where: { fileName: { in: ["子目录", "说明.md"] } }, select: { id: true, token: true } })
await db.fileShareLink.deleteMany({ where: { id: { in: shares.map((s) => s.id) } } })
console.log("分享链接清理:", shares.length)

// 4. 文件分享审计（QA 期间产生的 FILE_SHARE_* 事件保留为正常审计；分享行已清）

// 5. 收藏夹偏好清理（QA 收藏的目录指向将删除的路径）
const prefs = (admin?.preferences || {}) as Record<string, unknown>
if (prefs.fileExplorer) {
  delete prefs.fileExplorer
  await db.user.update({ where: { id: admin!.id }, data: { preferences: prefs as never } })
  console.log("收藏/标签偏好清理: ok")
}

// 6. 测试文件
await rm(join(process.cwd(), "storage", "home", admin!.id, "QA-r31-分享目录"), { recursive: true, force: true }).catch(() => null)
// 空的 -man 录像目录（演示通道启动失败时创建的孤儿目录）
await rm(join(process.cwd(), "storage", "recordings", admin!.id, "vnc-8f9a6e6172b9-man"), { recursive: true, force: true }).catch(() => null)
console.log("测试文件清理: ok")

// 终态断言
const finalWs = await db.browserWorkspace.count({ where: { name: { contains: "QA-r31" } } })
const finalShares = await db.fileShareLink.count({ where: { fileName: { in: ["子目录", "说明.md"] } } })
const finalRec = await db.vncRecording.count({ where: { sessionId: { contains: "-man" } } })
console.log(JSON.stringify({ finalWs, finalShares, finalRec }))
await db.$disconnect()
