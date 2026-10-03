// QA r26：OpenAPI lifecycle 事件数据准备
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const { recordCrxLifecycleEvent } = await import("../src/lib/crx-lifecycle")
  await recordCrxLifecycleEvent({ workspaceId: "ws-openapi-test", workspaceName: "OpenAPI测试", crxId: "e".repeat(32), crxName: "测试扩展", kind: "INSTALLED", toVersion: "1.0.0" })
  await recordCrxLifecycleEvent({ workspaceId: "ws-openapi-test", workspaceName: "OpenAPI测试", crxId: "e".repeat(32), crxName: "测试扩展", kind: "REMOVED", fromVersion: "1.0.0" })
  const n = await db.auditLog.count({ where: { resourceId: "e".repeat(32) } })
  console.log("事件写入:", n, "条")
}
main().finally(() => db.$disconnect())
