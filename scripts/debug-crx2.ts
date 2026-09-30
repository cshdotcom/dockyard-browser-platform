// 直接调用 resolveWorkspaceCrxPolicy 验证合并结果（与引擎同一路径）
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  const ws = await db.browserWorkspace.findFirst({ where: { deletedAt: null, status: "RUNNING" } })
  if (!ws) { console.log("no running workspace"); return }
  console.log("workspace:", ws.name)

  // 内联复刻 resolveWorkspaceCrxPolicy 的关键查询（定位差异）
  const layers: Array<{ scopeType: string; scopeId: string }> = []
  if (ws.crxInheritEnabled) {
    layers.push({ scopeType: "GLOBAL", scopeId: "" })
    const gu = await db.groupUser.findFirst({ where: { userId: ws.userId }, orderBy: { createdAt: "desc" } })
    if (gu) layers.push({ scopeType: "GROUP", scopeId: gu.groupId })
    layers.push({ scopeType: "USER", scopeId: ws.userId })
  }
  layers.push({ scopeType: "SANDBOX", scopeId: ws.id })

  for (const layer of layers) {
    const entries = await db.crxPolicyEntry.findMany({
      where: { scopeType: layer.scopeType, scopeId: layer.scopeId, deletedAt: null },
    })
    console.log(`layer ${layer.scopeType}(${layer.scopeId.slice(0, 10)}) → ${entries.length} entries`)
    for (const e of entries) {
      const lib = await db.crxPlugin.findUnique({ where: { crxId: e.crxId } })
      console.log(`   ${e.crxId.slice(0, 10)}… lib=${lib ? (lib.deletedAt ? "DELETED" : lib.enabled ? "enabled" : "disabled") : "MISSING"}`)
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
