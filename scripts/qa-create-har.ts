// QA 辅助：为测试工作区造一条 HAR 记录（含标准 HAR 1.2 文档）+ 验证下载
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const ws = await db.browserWorkspace.findFirst({ where: { name: "QA 共享测试沙箱" } })
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  const doc = {
    log: {
      version: "1.2",
      creator: { name: "Dockyard CDP Gateway", version: "1.0" },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          time: 120,
          request: { method: "GET", url: "https://example.com/", httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: [], cookies: [], content: { size: 1256, mimeType: "text/html" }, redirectURL: "", headersSize: -1, bodySize: 1256 },
          cache: {},
          timings: { send: 10, wait: 100, receive: 10, blocked: 0, dns: -1, connect: -1, ssl: -1 },
        },
      ],
    },
  }
  const rec = await db.harRecord.create({
    data: { workspaceId: ws!.id, userId: admin!.id, harJson: JSON.stringify(doc), sizeBytes: JSON.stringify(doc).length },
  })
  console.log("HAR_RECORD_ID=" + rec.id)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
