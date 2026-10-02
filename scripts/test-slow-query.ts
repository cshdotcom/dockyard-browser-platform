import { db } from "../src/lib/db"
import { ensureConfigLoaded, setConfig } from "../src/lib/config"
async function main() {
  await ensureConfigLoaded(true)
  await setConfig("log.slowQueryMs", 1, null)
  ;(globalThis as any).__dySlowQueryCheckedAt = 0
  await db.user.count()
  await db.browserWorkspace.findMany({ take: 1 })
  console.log("done — 应看到 [slow-query] 行")
  await setConfig("log.slowQueryMs", 1000, null)
  await db.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
