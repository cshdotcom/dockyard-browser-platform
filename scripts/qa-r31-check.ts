// r31 QA 检查：手动录屏行 + 会话映射
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const rows = await db.vncRecording.findMany({ where: { sessionId: { contains: "-man" } }, select: { sessionId: true, status: true, trigger: true, metadata: true } })
console.log(JSON.stringify(rows, null, 2))
const ws = await db.browserWorkspace.findFirst({ where: { name: "QA-r31-VNC工具栏" }, select: { id: true, novncSessionId: true, containerRef: true, status: true } })
console.log("ws=", JSON.stringify(ws))
await db.$disconnect()
