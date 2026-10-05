// ============================================================
// Prisma 客户端（三 Provider 运行时切换：SQLite / PostgreSQL / MySQL）
//
// · 默认 SQLite（零依赖文件库）：@prisma/client（schema.prisma，url=env DATABASE_URL）
// · DATABASE_PROVIDER=postgres：@prisma/client-postgres（schema.postgres.prisma 派生）
// · DATABASE_PROVIDER=mysql：@prisma/client-mysql（schema.mysql.prisma 派生，r38）
//
// 【r38 运行时配置链（db-active.json 优先）】
//   1. storage/db-active.json —— GUI（安装向导/后台数据库管理）写入的运行时配置
//      （provider + url + 血缘/回滚信息；存在且合法时优先级最高）
//   2. env DATABASE_PROVIDER / DB_PROVIDER + DATABASE_URL
//   3. 默认 sqlite
//   —— 由此支持「图形界面配置数据库」与「env 配置数据库」双通道。
//
// 【r38 热切换（Proxy 转发）】
//   export const db 是一个 Proxy —— 每次属性访问转发到当前活跃客户端实例。
//   rebuildDbClient() 重建活跃实例（db-active.json / env 更新后调用），
//   所有 import { db } 的模块自动使用新实例（无需重启进程）。
//   二次初始化（数据库迁移）完成/回滚即通过此机制即时生效。
//
// 三份 schema 模型逐字一致（同步脚本派生），故此处以 sqlite client 的类型为
// 全应用统一类型；postgres/mysql 实例仅运行时选择，结构化类型完全兼容。
// PostgreSQL/MySQL 的自动初始化（db push + 种子 + 审计触发器）见 docker/start.sh
// 与 GUI 安装向导（/api/setup/database）。
// ============================================================
import { PrismaClient } from "@prisma/client"
import { createRequire as nodeCreateRequire } from "module"
import { runStartupDbMaintenance } from "./db-maintenance"

// [r38] 真实 Node require（绕过 Turbopack/webpack 模块系统 —— 打包器对动态
// require 报 "expression is too dynamic"；nodeCreateRequire 以项目根 package.json
// 为基点直接走文件系统解析，dev 与 prod standalone 双态可靠；目标包未生成时
// 抛 MODULE_NOT_FOUND → 转换为可操作指引）
const realRequire = nodeCreateRequire(
  (typeof process !== "undefined" && process.cwd() ? process.cwd() : ".") + "/package.json",
)

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export type DatabaseProviderMode = "sqlite" | "postgres" | "mysql"

// ---------------- db-active.json（GUI 运行时配置存储） ----------------
// 独立模块级读取（同步 fs）：见 src/lib/db-active.ts（本文件不 import 它，
// 避免其顶层依赖 db.ts 造成循环 —— 这里内联最小读取器）。
export interface DbActiveConfig {
  provider: DatabaseProviderMode
  url: string
  prevProvider?: DatabaseProviderMode | null
  prevUrl?: string | null
  /** 迁移完成时间（回滚窗口起点） */
  migratedAt?: string
  /** 回滚窗口截止（过期后旧库连接串清理） */
  rollbackUntil?: string | null
  updatedBy?: string
  updatedAt?: string
  /** 首次初始化来源：setup（GUI 向导）/ env（自动）/ migrate（二次迁移） */
  initSource?: "setup" | "env" | "migrate"
}

const DB_ACTIVE_FILE = () =>
  (process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage") + "/db-active.json"

/** Next 服务器进程判别（dev/standalone 均命中 NEXT_RUNTIME；seed/迁移脚本 import 本模块时为 false） */
function isNextServerProcess(): boolean {
  return typeof process.env.NEXT_RUNTIME === "string" || process.argv.some((a) => /\.next\/|next-server|next\b/i.test(a))
}

/** 同步读取 db-active.json（不存在/损坏 → null；绝不抛异常阻塞启动） */
function readDbActiveConfig(): DbActiveConfig | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs")
    const raw = fs.readFileSync(DB_ACTIVE_FILE(), "utf8")
    const parsed = JSON.parse(raw) as DbActiveConfig
    if (
      parsed &&
      (parsed.provider === "sqlite" || parsed.provider === "postgres" || parsed.provider === "mysql") &&
      typeof parsed.url === "string" &&
      parsed.url.length > 0
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** 校验 provider 与 URL 协议匹配（防 db-active.json 被改坏导致启动崩溃） */
function providerUrlMatches(provider: DatabaseProviderMode, url: string): boolean {
  if (provider === "sqlite") return url.startsWith("file:") || url === "" || !url.includes("://")
  if (provider === "postgres") return /^postgres(ql)?:\/\//.test(url)
  if (provider === "mysql") return /^mysql:\/\//.test(url)
  return false
}

// ---------------- provider 解析（db-active.json > env > URL 推断 > sqlite） ----------------
// DATABASE_PROVIDER（sqlite 默认 / postgres / mysql）；兼容历史别名 DB_PROVIDER；
// 未显式声明时按 DATABASE_URL 协议自动推断（mysql://→mysql、postgresql://→postgres）。
export function databaseProvider(): DatabaseProviderMode {
  const raw = (process.env.DATABASE_PROVIDER || process.env.DB_PROVIDER || "").trim().toLowerCase()
  if (raw === "postgres" || raw === "postgresql" || raw === "pg") return "postgres"
  if (raw === "mysql" || raw === "mariadb") return "mysql"
  if (raw === "sqlite") return "sqlite"
  // 未显式声明 → URL 协议推断
  const url = process.env.DATABASE_URL || ""
  if (/^mysql:\/\//.test(url)) return "mysql"
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres"
  return "sqlite"
}

/** db-active.json + env 解析后的生效数据库配置（含来源） */
export function effectiveDatabaseConfig(): {
  provider: DatabaseProviderMode
  url: string
  source: "db-active" | "env" | "default"
} {
  const active = readDbActiveConfig()
  if (active && providerUrlMatches(active.provider, active.url)) {
    return { provider: active.provider, url: active.url, source: "db-active" }
  }
  const provider = databaseProvider()
  const url = process.env.DATABASE_URL || ""
  if (providerUrlMatches(provider, url) && url) return { provider, url, source: "env" }
  return { provider: "sqlite", url: "file:./db/custom.db", source: url ? "default" : "default" }
}

// ---------------- 客户端工厂（三 Provider 统一） ----------------
/** 惰性加载独立生成的 provider 客户端包（realRequire 文件系统解析 —— r32「拼接防静态解析」的 r38 终版方案） */
function requireProviderClient(provider: "postgres" | "mysql"): new (opts: { log: ("query" | "error" | "warn")[] }) => unknown {
  const moduleName = provider === "postgres" ? "@prisma/client-postgres" : "@prisma/client-mysql"
  try {
    const mod = realRequire(moduleName) as {
      PrismaClient: new (opts: { log: ("query" | "error" | "warn")[] }) => unknown
    }
    if (!mod?.PrismaClient) throw new Error("PrismaClient 导出缺失")
    return mod.PrismaClient
  } catch (e) {
    throw new Error(
      `${provider} 客户端包 ${moduleName} 不可用（${e instanceof Error ? e.message : String(e)}）。` +
        `请先执行 prisma generate --schema prisma/schema.${provider === "postgres" ? "postgres" : "mysql"}.prisma 生成客户端（Docker 镜像构建时自动生成）。`,
    )
  }
}

/**
 * 构造指定 provider+url 的 Prisma 客户端（不写全局缓存 —— probe/迁移复用同一工厂）。
 * ⚠ Prisma 客户端构造时会校验 env("DATABASE_URL") 的协议必须与 schema provider 匹配
 *   （即使传入 datasources 覆盖也会校验）—— 故构造前确保 env 协议匹配。
 *   【r38 反污染】env 只在「协议不匹配」时才改写：同进程内独立构造的客户端
 *   （seed/脚本 —— 读 env 指向其它同协议库）不被静默改指向（datasources 才是真实连接目标）。
 */
export function createClientFor(provider: DatabaseProviderMode, url: string): PrismaClient {
  // 协议前置校验（给出可操作的错误信息，而非 Prisma 的晦涩 P1012）
  if (provider === "postgres" && !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(`postgres 模式的 DATABASE_URL 不是 postgresql:// 连接串（当前：${url ? url.slice(0, 16) + "…" : "未设置"}）；请配置如 postgresql://user:pass@host:5432/dockyard`)
  }
  if (provider === "mysql" && !/^mysql:\/\//.test(url)) {
    throw new Error(`mysql 模式的 DATABASE_URL 不是 mysql:// 连接串（当前：${url ? url.slice(0, 16) + "…" : "未设置"}）；请配置如 mysql://user:pass@host:3306/dockyard`)
  }
  // env 同步：仅当当前 env URL 协议与本 provider 不匹配时改写（防污染同进程其它客户端目标）
  if (process.env.DATABASE_PROVIDER !== provider) process.env.DATABASE_PROVIDER = provider
  if (!providerUrlMatches(provider, process.env.DATABASE_URL || "")) {
    process.env.DATABASE_URL = url
  }

  if (provider === "postgres" || provider === "mysql") {
    const ClientCtor = requireProviderClient(provider)
    return new (ClientCtor as unknown as new (opts: { datasources: { db: { url: string } }; log: ("query" | "error" | "warn")[] }) => PrismaClient)({
      datasources: { db: { url } },
      log: prismaLogLevels(),
    })
  }
  // SQLite：连接调优（WAL 下多读并行 + socket_timeout 防慢盘 P1008 误杀）
  const tuned = url.startsWith("file:") && !url.includes("connection_limit")
    ? `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&socket_timeout=20`
    : url
  return new PrismaClient({
    datasources: { db: { url: tuned } },
    log: prismaLogLevels(),
  })
}

function createPrismaClient(): PrismaClient {
  const { provider, url } = effectiveDatabaseConfig()
  return createClientFor(provider, url)
}

// ============================================================
// r30：查询日志水位治理 —— 生产默认只记 error/warn（详见历史注释）
// 需要逐条 SQL 排查时显式开启：环境变量 PRISMA_LOG_QUERY=1
// ============================================================
function prismaLogLevels(): ("query" | "error" | "warn")[] {
  return process.env.PRISMA_LOG_QUERY === "1" ? ["query", "error", "warn"] : ["error", "warn"]
}

// ============================================================
// r35：SQLite WAL 持久化切换 + 启动错误记录清理（详见历史注释，全部静默失败）
// ============================================================
function runSqliteMaintenance(client: PrismaClient) {
  void runStartupDbMaintenance(client).catch(() => {
    /* 维护失败静默 */
  })
}

// ============================================================
// r23：log.slowQueryMs 真实生效 —— 慢查询观测扩展（详见历史注释）
// ============================================================
const slowQueryDb = globalThis as unknown as { __dySlowQueryThresholdMs?: number; __dySlowQueryCheckedAt?: number }

function syncSlowQueryThreshold() {
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

// ============================================================
// r38：迁移维护模式（写阻塞）—— 迁移子进程活跃期间拒绝一切写操作
//   触发条件：storage/db-migration/state.json 的 phase ∈ {backup,schema,clear,copy,verify}
//   实现位置：慢查询 $extensions 拦截层（全应用唯一写路径汇聚点，零路由改动）
//   迁移子进程使用独立客户端（不经此包装）—— 不受阻塞影响
//   state 读取 2s TTL 缓存（写路径每 2 秒一次 fs stat，开销可忽略）
// ============================================================
const migDb = globalThis as unknown as {
  __dyMigBlock?: boolean
  __dyMigBlockCheckedAt?: number
}

const WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn",
  "delete", "deleteMany", "upsert", "executeRaw", "executeRawUnsafe", "queryRaw", "queryRawUnsafe",
])

function isMigrationBlockingWrites(): boolean {
  const now = Date.now()
  if (migDb.__dyMigBlockCheckedAt && now - migDb.__dyMigBlockCheckedAt < 2000) return !!migDb.__dyMigBlock
  migDb.__dyMigBlockCheckedAt = now
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs")
    const file = (process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage") + "/db-migration/state.json"
    const raw = fs.readFileSync(file, "utf8")
    const st = JSON.parse(raw) as { phase?: string }
    migDb.__dyMigBlock = ["backup", "schema", "clear", "copy", "verify", "queued"].includes(String(st?.phase))
  } catch {
    migDb.__dyMigBlock = false
  }
  return !!migDb.__dyMigBlock
}

/** 慢查询观测 $extends 包装（全部业务客户端统一走此包装；含迁移维护模式写拦截） */
function wrapSlowQuery(client: PrismaClient): PrismaClient {
  return (client as unknown as { $extends: (ext: unknown) => unknown }).$extends({
    query: {
      $allModels: {
        $allOperations: async ({ operation, model, query, args }: { operation: string; model: string | undefined; query: (args: unknown) => Promise<unknown>; args: unknown }) => {
          // 迁移维护模式：写操作拒绝（读取不受影响 —— 页面只读可用）
          if (WRITE_OPS.has(operation) && isMigrationBlockingWrites()) {
            throw new Error(
              "系统正在进行数据库迁移（二次初始化），写操作已临时暂停。迁移通常在数十秒内完成，请稍后重试。",
            )
          }
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
  }) as unknown as PrismaClient
}

// ============================================================
// r38：活跃客户端（热切换核心）
//   activeDb = { base, wrapped } —— wrapped = 慢查询观测版（业务实际使用）
//   export db = Proxy → 每次属性访问转发 activeDb.wrapped（热切换零引用失效）
// ============================================================
interface ActiveDb {
  base: PrismaClient
  wrapped: PrismaClient
  provider: DatabaseProviderMode
  url: string
}

const gActive = globalThis as unknown as { __dyActiveDb?: ActiveDb }

function buildActiveDb(): ActiveDb {
  const { provider, url } = effectiveDatabaseConfig()
  const base = gActive?.__dyActiveDb?.base ?? globalForPrisma.prisma ?? createPrismaClient()
  // 复用已有 base 的场景（首建）：维护任务只跑一次
  const fresh = !gActive?.__dyActiveDb && !globalForPrisma.prisma
  if (provider === "sqlite" && fresh) runSqliteMaintenance(base)
  const wrapped = wrapSlowQuery(base)
  return { base, wrapped, provider, url }
}

if (!gActive.__dyActiveDb) {
  gActive.__dyActiveDb = buildActiveDb()
  globalForPrisma.prisma = gActive.__dyActiveDb.base
  // r38：provider 钉住（pin）—— 首次成功构建后把当前生效配置写入 db-active.json。
  // 作用：env 数据库类型后续被运维改动时，生效链仍锚定在「有数据的库」上运行
  // （绝不自动切到空库导致 P2021 全站崩），由管理后台横幅引导二次初始化迁移。
  // 安全：①仅 Next 服务器进程写入（seed/迁移脚本 import 本模块不写 —— 防脚本目标
  //       库静默变成钉住值）；②仅 db-active.json 不存在时写；③迁移进行中不写。
  if (!readDbActiveConfig() && isNextServerProcess()) {
    try {
      const writePin = () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("fs") as typeof import("fs")
        const pin: DbActiveConfig = {
          provider: gActive.__dyActiveDb!.provider,
          url: gActive.__dyActiveDb!.url,
          initSource: "env",
          updatedAt: new Date().toISOString(),
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pathMod = require("path") as typeof import("path")
        fs.mkdirSync(pathMod.dirname(DB_ACTIVE_FILE()), { recursive: true })
        const tmp = DB_ACTIVE_FILE() + ".tmp"
        fs.writeFileSync(tmp, JSON.stringify(pin, null, 2) + "\n", { mode: 0o600 })
        fs.renameSync(tmp, DB_ACTIVE_FILE())
      }
      // 迁移态检查（迁移中 db-active 由子进程 finalize 写 —— 不抢写）
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs2 = require("fs") as typeof import("fs")
      let migrating = false
      try {
        const st = JSON.parse(fs2.readFileSync(DB_ACTIVE_FILE().replace("db-active.json", "db-migration/state.json"), "utf8")) as { phase?: string }
        migrating = ["backup", "schema", "clear", "copy", "verify", "queued"].includes(String(st?.phase))
      } catch {
        migrating = false
      }
      if (!migrating) writePin()
    } catch {
      /* pin 写入失败（只读卷等）—— 退化为 env 直读模式，无害 */
    }
  }
}

/** 当前活跃客户端信息（管理界面/迁移对账用 —— 不含敏感凭据） */
export function getActiveDbInfo(): { provider: DatabaseProviderMode; url: string } {
  const a = gActive.__dyActiveDb
  return { provider: a?.provider ?? "sqlite", url: a?.url ?? "" }
}

/**
 * 热重建客户端（db-active.json / env 变更后调用）。
 * 旧客户端延迟断开（3s 后 $disconnect —— 进行中的请求可完成）；
 * 新客户端立即接管全部后续访问（Proxy 转发天然生效）。
 */
export async function rebuildDbClient(opts?: { disconnectOldAfterMs?: number }): Promise<{ provider: DatabaseProviderMode; url: string }> {
  const old = gActive.__dyActiveDb
  const fresh = buildActiveDbForRebuild()
  gActive.__dyActiveDb = fresh
  globalForPrisma.prisma = fresh.base
  if (old && old.base !== fresh.base) {
    const waitMs = opts?.disconnectOldAfterMs ?? 3000
    setTimeout(() => {
      old.base.$disconnect().catch(() => {
        /* 旧连接断开失败忽略（超时自灭） */
      })
    }, waitMs)
  }
  return { provider: fresh.provider, url: fresh.url }
}

function buildActiveDbForRebuild(): ActiveDb {
  const { provider, url } = effectiveDatabaseConfig()
  const base = createClientFor(provider, url)
  if (provider === "sqlite") runSqliteMaintenance(base)
  return { base, wrapped: wrapSlowQuery(base), provider, url }
}

// 对外统一导出：Proxy 转发到当前活跃客户端（热切换零成本生效）
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const active = gActive.__dyActiveDb
    const client = active?.wrapped
    if (!client) return undefined
    const value = (client as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value
  },
})

// 慢查询观测版兼容导出（历史调用点零改动）
export const dbExtended = db

// ============================================================
// r38：数据库探测（无切换副作用 —— 供安装向导/迁移前的连接测试）
// ============================================================
export interface DbProbeResult {
  ok: boolean
  provider: DatabaseProviderMode
  version: string
  latencyMs: number
  hasSchema: boolean // 目标库是否已有 Dockyard 表结构
  hasData: boolean // 目标库是否已有业务数据（User 行数 > 0）
  userCount: number
  error?: string
}

export async function probeDatabase(provider: DatabaseProviderMode, url: string, timeoutMs = 8000): Promise<DbProbeResult> {
  let client: PrismaClient | null = null
  const started = Date.now()
  const fail = (error: string): DbProbeResult => ({
    ok: false, provider, version: "", latencyMs: Date.now() - started,
    hasSchema: false, hasData: false, userCount: 0, error,
  })
  try {
    // 探测前保存 env（createClientFor 会同步 env —— finally 必须恢复原始值，
    // 不能用 effectiveDatabaseConfig()：那会读到被本次探测污染的 env，形成自引用）
    const savedProvider = process.env.DATABASE_PROVIDER
    const savedUrl = process.env.DATABASE_URL
    try {
      return await probeWithClient(provider, url, timeoutMs, started)
    } finally {
      process.env.DATABASE_PROVIDER = savedProvider
      process.env.DATABASE_URL = savedUrl
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

async function probeWithClient(
  provider: DatabaseProviderMode,
  url: string,
  timeoutMs: number,
  started: number,
): Promise<DbProbeResult> {
  const fail = (error: string): DbProbeResult => ({
    ok: false, provider, version: "", latencyMs: Date.now() - started,
    hasSchema: false, hasData: false, userCount: 0, error,
  })
  let client: PrismaClient | null = null
  try {
    client = createClientFor(provider, url)
    // 版本探测（各 provider 的 SELECT 1 + 版本函数）
    const versionRow = (await Promise.race([
      client.$queryRawUnsafe(
        provider === "postgres" ? "SELECT version() AS v" : provider === "mysql" ? "SELECT VERSION() AS v" : "SELECT sqlite_version() AS v",
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error("连接超时")), timeoutMs)),
    ])) as Array<{ v?: string }>
    const version = String(versionRow?.[0]?.v ?? "").split(" ").slice(0, 2).join(" ")
    // 结构/数据探测（探测独立于主客户端 —— 表不存在等错误按无结构处理）
    let hasSchema = false
    let userCount = 0
    try {
      userCount = await client.user.count()
      hasSchema = true
    } catch {
      hasSchema = false
    }
    return {
      ok: true, provider, version, latencyMs: Date.now() - started,
      hasSchema, hasData: hasSchema && userCount > 0, userCount,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  } finally {
    if (client) void client.$disconnect().catch(() => {})
  }
}
