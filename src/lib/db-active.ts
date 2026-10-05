// ============================================================
// db-active.json —— GUI 数据库配置的运行时存储（r38）
//
// 职责（读取器内联在 src/lib/db.ts —— 避免循环依赖；本模块负责写入/管理）：
//   · 存储 GUI（安装向导 / 后台数据库管理）配置的数据库连接
//   · 优先级：db-active.json > env DATABASE_PROVIDER/DATABASE_URL > 默认 sqlite
//   · 记录迁移血缘（prevProvider/prevUrl/rollbackUntil）供二次初始化回滚
//
// 写入安全：
//   · 原子写（tmp + rename）
//   · 写前备份 db-active.backup.json（单份滚动）—— 主文件损坏时可人工恢复
//   · provider 与 URL 协议严格匹配校验（防手改坏导致启动崩溃）
//
// 与 .env 的关系（用户双通道要求）：
//   · env 配置 = 静态部署通道（改 env 需重启；GUI 检测 env 类型变化 → 二次初始化横幅）
//   · db-active.json = GUI 运行时通道（热切换即时生效）
// ============================================================
import { mkdir, writeFile, rename, copyFile, unlink, readFile } from "fs/promises"
import { join, dirname } from "path"
import type { DbActiveConfig, DatabaseProviderMode } from "./db"

const STORAGE_DIR = () => process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage"
export const DB_ACTIVE_FILE = () => join(STORAGE_DIR(), "db-active.json")
const DB_ACTIVE_BACKUP = () => join(STORAGE_DIR(), "db-active.backup.json")

// ---------------- 校验 ----------------
export function isDatabaseProvider(v: unknown): v is DatabaseProviderMode {
  return v === "sqlite" || v === "postgres" || v === "mysql"
}

/** provider 与 URL 协议匹配（与 db.ts 内联版语义一致） */
export function providerUrlMatches(provider: DatabaseProviderMode, url: string): boolean {
  if (provider === "sqlite") return url.startsWith("file:") || url === "" || !url.includes("://")
  if (provider === "postgres") return /^postgres(ql)?:\/\//.test(url)
  if (provider === "mysql") return /^mysql:\/\//.test(url)
  return false
}

export function validateDbActiveConfig(v: unknown): { ok: boolean; errors: string[]; clean: DbActiveConfig | null } {
  const errors: string[] = []
  if (v == null || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, errors: ["配置必须为对象"], clean: null }
  }
  const o = v as Record<string, unknown>
  const provider = o.provider
  const url = o.url
  if (!isDatabaseProvider(provider)) errors.push(`provider 必须为 sqlite/postgres/mysql（当前：${String(provider)}）`)
  if (typeof url !== "string" || !url) errors.push("url 不能为空")
  else if (isDatabaseProvider(provider) && !providerUrlMatches(provider, url)) {
    errors.push(`url 协议与 provider 不匹配（${provider} 要求 ${provider === "postgres" ? "postgresql://" : provider === "mysql" ? "mysql://" : "file:"} 开头）`)
  }
  if (o.prevProvider != null && !isDatabaseProvider(o.prevProvider)) errors.push("prevProvider 非法")
  if (o.rollbackUntil != null && o.rollbackUntil !== "" && typeof o.rollbackUntil !== "string") errors.push("rollbackUntil 非法")
  if (errors.length > 0) return { ok: false, errors, clean: null }
  const clean: DbActiveConfig = {
    provider: provider as DatabaseProviderMode,
    url: url as string,
    prevProvider: (o.prevProvider as DatabaseProviderMode | null | undefined) ?? null,
    prevUrl: (o.prevUrl as string | null | undefined) ?? null,
    migratedAt: typeof o.migratedAt === "string" ? o.migratedAt : undefined,
    rollbackUntil: (o.rollbackUntil as string | null | undefined) ?? null,
    updatedBy: typeof o.updatedBy === "string" ? o.updatedBy : undefined,
    updatedAt: new Date().toISOString(),
    initSource: o.initSource === "setup" || o.initSource === "env" || o.initSource === "migrate" ? o.initSource : undefined,
  }
  return { ok: true, errors: [], clean }
}

// ---------------- 读取 ----------------
export async function readDbActive(): Promise<DbActiveConfig | null> {
  try {
    const raw = await readFile(DB_ACTIVE_FILE(), "utf8")
    const parsed = JSON.parse(raw)
    const { ok, clean } = validateDbActiveConfig(parsed)
    return ok ? clean : null
  } catch {
    return null
  }
}

// ---------------- 写入（原子 + 备份） ----------------
export async function writeDbActive(config: DbActiveConfig): Promise<void> {
  const dir = dirname(DB_ACTIVE_FILE())
  await mkdir(dir, { recursive: true })
  // 既有文件先备份（主文件损坏时 db.ts 静默回退 env —— 备份供人工恢复）
  try {
    await copyFile(DB_ACTIVE_FILE(), DB_ACTIVE_BACKUP())
  } catch {
    /* 首次写入无既有文件 */
  }
  const tmp = DB_ACTIVE_FILE() + ".tmp"
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
  await rename(tmp, DB_ACTIVE_FILE())
}

/** 删除 db-active.json（回滚到 env 通道时用） */
export async function clearDbActive(): Promise<void> {
  try {
    await unlink(DB_ACTIVE_FILE())
  } catch {
    /* 不存在即目标态 */
  }
}

// ---------------- URL 脱敏（日志/UI 展示） ----------------
/** mysql://user:pass@host:3306/db → mysql://user:***@host:3306/db */
export function maskDbUrl(url: string): string {
  return url.replace(/(\/\/[^:/@\s]+:)[^@]*(?=@)/, "$1***")
}

// ---------------- 构造帮助 ----------------
export function buildUrlFromParts(input: {
  provider: DatabaseProviderMode
  host?: string
  port?: number | string
  database?: string
  username?: string
  password?: string
  sqlitePath?: string
}): { url: string | null; errors: string[] } {
  const errors: string[] = []
  if (input.provider === "sqlite") {
    const p = (input.sqlitePath || "").trim()
    if (!p) return { url: null, errors: ["请填写 SQLite 数据库文件路径"] }
    if (!p.startsWith("/") && !p.startsWith("./") && !p.startsWith("../")) errors.push("SQLite 路径须为绝对路径或以 ./ 开头")
    return { url: `file:${p.startsWith("/") ? p : p}`, errors }
  }
  const host = (input.host || "").trim()
  const database = (input.database || "").trim()
  const username = (input.username || "").trim()
  if (!host) errors.push("请填写主机地址")
  if (!database) errors.push("请填写数据库名")
  if (!username) errors.push("请填写用户名")
  const port = input.port ? Number(input.port) : input.provider === "mysql" ? 3306 : 5432
  if (!Number.isFinite(port) || port < 1 || port > 65535) errors.push("端口非法")
  if (errors.length > 0) return { url: null, errors }
  const proto = input.provider === "mysql" ? "mysql" : "postgresql"
  const pass = input.password ? `:${encodeURIComponent(input.password)}` : ""
  return { url: `${proto}://${encodeURIComponent(username)}${pass}@${host}:${port}/${encodeURIComponent(database)}`, errors: [] }
}
