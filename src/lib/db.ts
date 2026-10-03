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
    return new PostgresPrismaClient({ log: prismaLogLevels() }) as unknown as PrismaClient
  }
  return new PrismaClient({
    log: prismaLogLevels(),
  })
}

// ============================================================
// r30：查询日志水位治理 —— 生产默认只记 error/warn
// 旧行为 log:["query"] 会把每条 SQL 全量打印（30 项定时任务 + 全部页面请求，
// docker logs 与 storage/server.log 双通道疯狂刷屏；长期运行把数据卷写满，
// SQLite 写失败 → 服务崩溃 → guard 疯狂整轮重启 —— 用户实测"启动一直疯狂、
// 日志一直没有启动成功"的直接放大器）。
// 需要逐条 SQL 排查时显式开启：环境变量 PRISMA_LOG_QUERY=1
// （r23 慢查询观测 [slow-query] 不受影响，阈值来自 system_config.log.slowQueryMs）
// ============================================================
function prismaLogLevels(): ("query" | "error" | "warn")[] {
  return process.env.PRISMA_LOG_QUERY === "1" ? ["query", "error", "warn"] : ["error", "warn"]
}

const baseClient = globalForPrisma.prisma ?? createPrismaClient()

// ============================================================
// r23：log.slowQueryMs 真实生效 —— 慢查询观测扩展
// · 阈值读自内存配置缓存（system_config 的 log.slowQueryMs，默认 1000ms，0=关闭）
// · 缓存未加载/不可用时用默认值；阈值每 60s 从缓存同步一次（不逐查询读库）
// · 输出：console.warn（结构化前缀 [slow-query]），生产可据此定位慢模型/慢操作
// ============================================================
const slowQueryDb = globalThis as unknown as { __dySlowQueryThresholdMs?: number; __dySlowQueryCheckedAt?: number }

function syncSlowQueryThreshold() {
  // 直接读 config 模块内存缓存（非 async，不产生额外 DB 查询；缓存由 ensureConfigLoaded 维护）
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CONFIG_DEFAULTS } = require("./config") as { CONFIG_DEFAULTS: Record<string, { value: unknown }> }
    const g = globalThis as unknown as { __dockyardConfig?: Map<string, { value: unknown }> }
    const hit = g.__dockyardConfig?.get("log.slowQueryMs")
    const raw = hit ? Number(hit.value) : Number(CONFIG_DEFAULTS["log.slowQueryMs"]?.value ?? 1000)
    slowQueryDb.__dySlowQueryThresholdMs = Number.isFinite(raw) ? raw : 1000
  } catch {
    slowQueryDb.__dySlowQueryThresholdMs = 1000
  }
  slowQueryDb.__dySlowQueryCheckedAt = Date.now()
}

// 包装：全应用统一走慢查询观测版客户端（类型保持 PrismaClient 兼容，方法面完全一致）
const dbWithSlowQuery = (baseClient as unknown as any).$extends({
  query: {
    $allModels: {
      $allOperations: async ({ operation, model, query, args }: { operation: string; model: string | undefined; query: (args: unknown) => Promise<unknown>; args: unknown }) => {
        if (!slowQueryDb.__dySlowQueryCheckedAt || Date.now() - slowQueryDb.__dySlowQueryCheckedAt > 60_000) syncSlowQueryThreshold()
        const threshold = slowQueryDb.__dySlowQueryThresholdMs ?? 1000
        if (threshold <= 0) return query(args)
        const start = Date.now()
        try {
          return await query(args)
        } finally {
          const ms = Date.now() - start
          if (ms > threshold) {
            console.warn(`[slow-query] ${model ?? "?"}.${operation} took ${ms}ms (threshold ${threshold}ms)`)
          }
        }
      },
    },
  },
})

// 对外导出：慢查询观测版（cast 回 PrismaClient 类型 —— 全部既有调用点零改动）
export const dbExtended = dbWithSlowQuery

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = baseClient

// 对外统一导出（慢查询观测版 = 全部业务代码实际使用的客户端）
export const db = dbWithSlowQuery as unknown as PrismaClient
