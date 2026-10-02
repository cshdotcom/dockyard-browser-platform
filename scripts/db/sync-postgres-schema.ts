// ============================================================
// PostgreSQL schema 同步器（r14）
//
// 用途：从 prisma/schema.prisma（SQLite 主 schema）派生 prisma/schema.postgres.prisma
//   —— 两份数据源共用同一套模型定义，避免手工双维护漂移。
// 运行：bun scripts/db/sync-postgres-schema.ts（schema 变更后执行一次）
// 产物：prisma/schema.postgres.prisma（provider = "postgresql"，其余模型逐字保留）
//
// 部署语义（见 docker/start.sh「数据库结构初始化」段）：
//   · 默认 SQLite（零依赖文件库，DATABASE_URL=file:...）
//   · DB_PROVIDER=postgres + DATABASE_URL=postgresql://... → 启动时自动
//     使用本 schema 执行 prisma db push + 种子 + 审计触发器（全自动初始化，
//     无需人工导入；db/postgres/schema.sql 供需要手工预建库的场景使用）
// ============================================================

import fs from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "../..")
const SRC = path.join(ROOT, "prisma/schema.prisma")
const DST = path.join(ROOT, "prisma/schema.postgres.prisma")

const src = fs.readFileSync(SRC, "utf8")

// datasource 块内 provider sqlite → postgresql（其余 datasource 内容原样保留）
if (!/provider\s*=\s*"sqlite"/.test(src)) {
  console.error("[sync-postgres-schema] 源 schema 的 datasource provider 不是 sqlite —— 请人工检查")
  process.exit(1)
}
const out = src.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"sqlite"/s,
  '$1"postgresql"',
)
if (!/provider\s*=\s*"postgresql"/.test(out)) {
  console.error("[sync-postgres-schema] provider 替换失败")
  process.exit(1)
}

// [22-d] generator 块注入独立 output：postgres 客户端生成到 node_modules/@prisma/client-postgres
//（与默认 @prisma/client（sqlite）并存 → 运行时按 DATABASE_PROVIDER 选择实例，见 src/lib/db.ts）
let withOutput = out
if (/generator\s+client\s*\{[^}]*\}/s.test(withOutput) && !/output\s*=/.test(withOutput)) {
  withOutput = withOutput.replace(
    /(generator\s+client\s*\{[^}]*?)\}/s,
    `$1\n  // [22-d] 独立产物目录：node_modules/@prisma/client-postgres（与 sqlite 默认 client 并存）\n  output   = "../node_modules/@prisma/client-postgres"\n}`,
  )
} else if (!/output\s*=/.test(withOutput)) {
  console.error("[sync-postgres-schema] 未找到 generator 块 —— 请人工检查")
  process.exit(1)
}

// 头部注释追加 PG 部署说明
const banner = `// [r14] 本文件由 scripts/db/sync-postgres-schema.ts 从 schema.prisma 自动派生 —— 请勿手工编辑模型
// （模型变更请改 schema.prisma 后重新执行同步脚本；本文件仅 datasource provider 不同）
`
fs.writeFileSync(DST, banner + withOutput, "utf8")
console.log(`[sync-postgres-schema] 已生成 ${path.relative(ROOT, DST)}（provider=postgresql，模型与 SQLite 主 schema 一致）`)
