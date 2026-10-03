// ============================================================
// r24-b 数据迁移：SteelNode → BrowserNode（自研声明去 Steel 化）
// 幂等：表/列/索引已改名时跳过；SQLite 3.25+ RENAME TABLE/COLUMN 支持。
// 玻璃数据完整保留（存量节点行不动）；运行后再 prisma generate + db push。
// ============================================================
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function tableExists(name: string): Promise<boolean> {
  const r = (await db.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name
  )) as { name: string }[]
  return r.length > 0
}

async function columnExists(table: string, col: string): Promise<boolean> {
  const r = (await db.$queryRawUnsafe(`PRAGMA table_info(${table})`)) as { name: string }[]
  return r.some((c) => c.name === col)
}

async function indexExists(name: string): Promise<boolean> {
  const r = (await db.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`, name
  )) as { name: string }[]
  return r.length > 0
}

async function trySql(sql: string, label: string): Promise<void> {
  try {
    await db.$executeRawUnsafe(sql)
    console.log(`✓ ${label}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/duplicate column name|already exists/i.test(msg)) {
      console.log(`= ${label}（已存在，跳过）`)
    } else {
      throw new Error(`${label} 失败：${msg}`)
    }
  }
}

async function main() {
  // 1. 表改名 SteelNode → BrowserNode
  if ((await tableExists("SteelNode")) && !(await tableExists("BrowserNode"))) {
    await trySql(`ALTER TABLE "SteelNode" RENAME TO "BrowserNode"`, "表改名 SteelNode → BrowserNode")
  } else {
    console.log("= 表 BrowserNode 已存在（跳过表改名）")
  }

  // 2. BrowserWorkspace 列改名（仅 SQLite 侧手工迁移；PG 部署由 db push 全新建表）
  if (await tableExists("BrowserWorkspace")) {
    if (await columnExists("BrowserWorkspace", "steelNodeId")) {
      await trySql(`ALTER TABLE "BrowserWorkspace" RENAME COLUMN "steelNodeId" TO "browserNodeId"`, "列改名 steelNodeId → browserNodeId")
    } else {
      console.log("= 列 browserNodeId 已存在（跳过）")
    }
    if (await columnExists("BrowserWorkspace", "steelSessionId")) {
      await trySql(`ALTER TABLE "BrowserWorkspace" RENAME COLUMN "steelSessionId" TO "browserSessionId"`, "列改名 steelSessionId → browserSessionId")
    } else {
      console.log("= 列 browserSessionId 已存在（跳过）")
    }
  }

  // 3. 索引重建（SQLite 不支持 ALTER INDEX：DROP + CREATE 与 Prisma 默认命名对齐，防 db push 漂移重建）
  if (await indexExists("SteelNode_status_idx")) {
    await trySql(`DROP INDEX IF EXISTS "SteelNode_status_idx"`, "删除旧索引 SteelNode_status_idx")
    await trySql(`CREATE INDEX IF NOT EXISTS "BrowserNode_status_idx" ON "BrowserNode" (status)`, "创建新索引 BrowserNode_status_idx")
  } else {
    console.log("= 旧索引 SteelNode_status_idx 不存在（跳过）")
  }

  // 4. 终态校验
  const nodes = (await db.$queryRawUnsafe(`SELECT COUNT(*) as c FROM BrowserNode`)) as { c: bigint }[]
  console.log(`终态：BrowserNode 行数 = ${nodes[0]?.c ?? 0}`)
  const cols = (await db.$queryRawUnsafe(`PRAGMA table_info(BrowserWorkspace)`)) as { name: string }[]
  const hasBrowserCols = cols.some((c) => c.name === "browserNodeId") && cols.some((c) => c.name === "browserSessionId")
  console.log(`终态：BrowserWorkspace 新列就位 = ${hasBrowserCols}`)
  if (!hasBrowserCols) throw new Error("BrowserWorkspace 列迁移未完成")
  console.log("MIGRATION PASS")
}

main()
  .catch((e) => {
    console.error("MIGRATION FAIL:", e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
