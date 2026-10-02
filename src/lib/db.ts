// ============================================================
// Prisma 客户端（双 Provider 运行时切换）
//
// · 默认 SQLite（零依赖文件库）：@prisma/client（schema.prisma，url=env DATABASE_URL）
// · DATABASE_PROVIDER=postgres：@prisma/client-postgres（prisma/schema.postgres.prisma
//   由 scripts/db/sync-postgres-schema.ts 从主 schema 派生，generator output 指向
//   node_modules/@prisma/client-postgres —— 与 sqlite client 并存，模型同源零漂移）
//
// 两份 schema 模型逐字一致（同步脚本派生），故此处以 sqlite client 的类型为
// 全应用统一类型；postgres 实例仅运行时按环境变量选择，结构化类型完全兼容。
// PostgreSQL 部署的自动初始化（db push + 种子 + 审计触发器）见 docker/start.sh。
// ============================================================
import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export type DatabaseProviderMode = "sqlite" | "postgres"

// DATABASE_PROVIDER（sqlite 默认 / postgres 启用 PG）；兼容历史别名 DB_PROVIDER
export function databaseProvider(): DatabaseProviderMode {
  const raw = (process.env.DATABASE_PROVIDER || process.env.DB_PROVIDER || "sqlite").trim().toLowerCase()
  return raw === "postgres" || raw === "postgresql" || raw === "pg" ? "postgres" : "sqlite"
}

function createPrismaClient(): PrismaClient {
  if (databaseProvider() === "postgres") {
    const url = process.env.DATABASE_URL || ""
    if (!/^postgres(ql)?:\/\//.test(url)) {
      throw new Error(
        `DATABASE_PROVIDER=postgres 但 DATABASE_URL 不是 postgresql:// 连接串（${url ? `当前值以 ${url.slice(0, 12)} 开头` : "未设置 DATABASE_URL"}）；请配置如 postgresql://user:pass@host:5432/dockyard`,
      )
    }
    // 惰性 require：独立生成的 postgres 客户端包（serverExternalPackages 保持外部化，
    // 查询引擎 .so.node 运行时从 node_modules 解析，避免打包器改写 __dirname 引擎路径）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PostgresPrismaClient } = require("@prisma/client-postgres") as {
      PrismaClient: new (opts: { log: string[] }) => unknown
    }
    return new PostgresPrismaClient({ log: ["query"] }) as unknown as PrismaClient
  }
  return new PrismaClient({
    log: ["query"],
  })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db
