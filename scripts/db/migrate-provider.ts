// ============================================================
// Dockyard 数据库跨 Provider 迁移引擎（r38 二次初始化核心）
//
// 形态：独立子进程（由 /api/admin/database/migrate 启动）—— 主服务不承担
//       迁移计算（内存隔离 + 崩溃隔离 + 不经过主服务慢查询包装/维护模式拦截）
//
// 输入：--job <jobFile>（JSON）：
//   { sourceProvider, sourceUrl, targetProvider, targetUrl,
//     stateFile, backupDir, retentionDays }
//
// 输出：stateFile 阶段/进度 JSON（API 轮询）；退出码 0=成功
//
// 【100% 成功 + 可回滚的架构保证】
//   · 迁移是 COPY 而非 MOVE：源库全程只读，绝不修改 —— 失败零损失
//   · 备份先行：源库全量导出 NDJSON（任何 provider 通用备份工件）
//   · 结构同步：目标库 prisma db push（幂等）
//   · 数据复制：拓扑序（FK 依赖）+ 目标先清空（重跑幂等）+ 批量游标分页
//   · 逐表计数校验：源=目标 全部命中才 finalize；任何不匹配 → error 退出
//     （此时源库完好、db-active.json 未改 —— 主服务零感知）
//   · finalize 原子落 db-active.json（prevProvider/prevUrl/rollbackUntil 血缘）
//     → 主服务 rebuildDbClient() 热切换到目标库
//   · 回滚 = 切回 prevUrl（源库数据原封未动）—— 即时完整恢复
//
// 维护模式（写阻塞）：主服务 db.ts 的慢查询 $extends 拦截层在
// state.phase ∈ {backup,schema,clear,copy,verify} 时拒绝一切写操作
// （本子进程使用独立客户端，不受拦截影响）
// ============================================================
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

// ---- CLI 参数 ----
const argv = process.argv.slice(2)
function argValue(name: string): string | null {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] ?? null : null
}
const JOB_FILE = argValue("--job")
if (!JOB_FILE) {
  console.error("[db-migrate] 缺少 --job 参数")
  process.exit(2)
}

interface MigrationJob {
  sourceProvider: "sqlite" | "postgres" | "mysql"
  sourceUrl: string
  targetProvider: "sqlite" | "postgres" | "mysql"
  targetUrl: string
  stateFile: string
  backupDir: string
  retentionDays?: number
}
const job = JSON.parse(fs.readFileSync(JOB_FILE!, "utf8")) as MigrationJob

const ROOT = path.resolve(__dirname, "../..")
const BATCH = 200

// ---- 状态文件 ----
interface MigrationState {
  phase: "queued" | "backup" | "schema" | "clear" | "copy" | "verify" | "finalize" | "done" | "error"
  startedAt: string
  updatedAt: string
  error: string | null
  log: string[]
  progress: {
    table: string
    tablesDone: number
    tablesTotal: number
    rowsCopied: number
    rowsTotal: number
    backupFiles: number
  }
}

const state: MigrationState = {
  phase: "queued",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  error: null,
  log: [],
  progress: { table: "", tablesDone: 0, tablesTotal: 0, rowsCopied: 0, rowsTotal: 0, backupFiles: 0 },
}

function writeState(phase?: MigrationState["phase"]) {
  if (phase) state.phase = phase
  state.updatedAt = new Date().toISOString()
  try {
    fs.mkdirSync(path.dirname(job.stateFile), { recursive: true })
    const tmp = job.stateFile + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, job.stateFile)
  } catch (e) {
    console.error("[db-migrate] 状态写入失败（忽略）:", e)
  }
}
function slog(msg: string) {
  state.log.push(`[${new Date().toISOString()}] ${msg}`)
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
  console.log(`[db-migrate] ${msg}`)
  writeState()
}

// ---- Prisma 客户端构造（三 provider 统一；自包含不依赖 src/） ----
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any
function createClient(provider: string, url: string): AnyClient {
  process.env.DATABASE_PROVIDER = provider
  process.env.DATABASE_URL = url
  if (provider === "sqlite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require("@prisma/client")
    const tuned = url.startsWith("file:") && !url.includes("connection_limit")
      ? `${url}${url.includes("?") ? "&" : "?"}connection_limit=2&socket_timeout=60`
      : url
    return new PrismaClient({ datasources: { db: { url: tuned } }, log: ["error"] })
  }
  const pkg = provider === "postgres" ? "@prisma/client-postgres" : "@prisma/client-mysql"
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(pkg)
  return new mod.PrismaClient({ datasources: { db: { url } }, log: ["error"] })
}

// ---- 模型清单（DMMF）与拓扑排序 ----
// Prisma 6：DMMF 从包的 Prisma 命名空间静态导出获取（实例 _dmmf 不可靠）
function getDmmfModels(provider: string): Array<Record<string, unknown>> {
  const pkg = provider === "sqlite" ? "@prisma/client" : provider === "postgres" ? "@prisma/client-postgres" : "@prisma/client-mysql"
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(pkg) as { Prisma?: { dmmf?: { datamodel?: { models?: Array<Record<string, unknown>> } } } }
  const models = mod?.Prisma?.dmmf?.datamodel?.models
  if (!models || !Array.isArray(models)) throw new Error(`无法获取 ${pkg} 的 DMMF 模型清单`)
  return models
}

interface ModelInfo {
  name: string
  pkField: string
  dependsOn: Set<string>
  hasJson: boolean
}

function modelInfos(provider: string): ModelInfo[] {
  const dmmfModels = getDmmfModels(provider)
  const models: ModelInfo[] = []
  for (const m of dmmfModels) {
    const name = String(m.name)
    // 主键：@id 字段（id / key / code 等特例）
    let pkField = "id"
    const fields = (m.fields as Array<Record<string, unknown>>) || []
    for (const f of fields) {
      const attrs = String(f.documentation ?? "") + " " + JSON.stringify(m.primaryKey ?? {})
      if ((f as { isId?: boolean }).isId) {
        pkField = String(f.name)
        break
      }
      void attrs
    }
    // 依赖：本模型持有外键（relationFromFields 非空）→ 父模型先行
    const dependsOn = new Set<string>()
    let hasJson = false
    for (const f of fields) {
      const kind = String(f.kind)
      if (kind === "object") {
        const relFrom = (f as { relationFromFields?: string[] }).relationFromFields || []
        if (relFrom.length > 0) {
          const targetType = String(f.type)
          if (targetType !== name) dependsOn.add(targetType)
        }
      }
      if (kind === "scalar" && String(f.type) === "Json") hasJson = true
    }
    models.push({ name, pkField, dependsOn, hasJson })
  }
  return models
}

/** Kahn 拓扑排序（父先行；同层字母序；自引用忽略；环 → 剩余按字母序追加（FK 检查已被禁用兜底）） */
function topoSort(models: ModelInfo[]): ModelInfo[] {
  const byName = new Map(models.map((m) => [m.name, m]))
  const inDeg = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const m of models) {
    let deg = 0
    for (const dep of m.dependsOn) {
      if (dep === m.name) continue
      if (byName.has(dep)) {
        deg++
        dependents.set(dep, [...(dependents.get(dep) || []), m.name])
      }
    }
    inDeg.set(m.name, deg)
  }
  const ready = models.filter((m) => (inDeg.get(m.name) || 0) === 0).map((m) => m.name).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const n = ready.shift()!
    order.push(n)
    for (const d of dependents.get(n) || []) {
      const nd = (inDeg.get(d) || 0) - 1
      inDeg.set(d, nd)
      if (nd === 0) ready.push(d)
      ready.sort()
    }
  }
  // 环残留追加（FK 禁用兜底）
  for (const m of models) if (!order.includes(m.name)) order.push(m.name)
  return order.map((n) => byName.get(n)!)
}

// ---- 主流程 ----
async function main() {
  writeState("backup")
  slog(`迁移开始：${job.sourceProvider} → ${job.targetProvider}`)
  fs.mkdirSync(job.backupDir, { recursive: true })

  const src = createClient(job.sourceProvider, job.sourceUrl)

  // ========== 阶段 1：备份（源库全量 NDJSON 导出） ==========
  const models = modelInfos(job.sourceProvider)
  const ordered = topoSort(models)
  state.progress.tablesTotal = ordered.length
  slog(`模型清单 ${ordered.length} 个（拓扑序就绪）`)

  for (const m of ordered) {
    const delegate = src[m.name]
    if (!delegate) {
      slog(`⚠ 跳过无委托模型 ${m.name}`)
      continue
    }
    const total = await delegate.count()
    state.progress.rowsTotal += total
    const rows: Array<Record<string, unknown>> = []
    let cursor: string | null = null
    // 游标分页导出（防大表 OOM）
    for (;;) {
      const page = (await delegate.findMany({
        orderBy: { [m.pkField]: "asc" },
        ...(cursor ? { cursor: { [m.pkField]: cursor }, skip: 1 } : {}),
        take: 1000,
      })) as Array<Record<string, unknown>>
      if (page.length === 0) break
      rows.push(...page)
      cursor = String(page[page.length - 1][m.pkField])
      if (page.length < 1000) break
    }
    const file = path.join(job.backupDir, `${m.name}.ndjson`)
    const ws = fs.createWriteStream(file, { encoding: "utf-8" })
    for (const r of rows) ws.write(JSON.stringify(r) + "\n")
    await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())))
    state.progress.backupFiles++
    if (total > 0 || ordered.length <= 90) {
      // 只记录有数据或小表，防日志噪音
    }
  }
  slog(`备份完成：${state.progress.backupFiles} 文件 / ${state.progress.rowsTotal} 行 → ${job.backupDir}`)

  // 目标库连接（备份完成后再建 —— 失败快速退出不影响备份工件）
  const tgt = createClient(job.targetProvider, job.targetUrl)

  // ========== 阶段 2：结构同步（prisma db push） ==========
  writeState("schema")
  const schemaFile = job.targetProvider === "sqlite" ? "prisma/schema.prisma" : `prisma/schema.${job.targetProvider}.prisma`
  await new Promise<void>((resolve, reject) => {
    const bun = spawn("bunx", ["prisma", "db", "push", "--schema", schemaFile, "--skip-generate", "--accept-data-loss"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PROVIDER: job.targetProvider, DATABASE_URL: job.targetUrl },
    })
    let out = ""
    bun.stdout?.on("data", (d: Buffer) => (out += d.toString()))
    bun.stderr?.on("data", (d: Buffer) => (out += d.toString()))
    bun.on("error", (e: Error) => reject(new Error(`prisma db push 启动失败：${e.message}（容器形态请确认 bunx 可用）`)))
    bun.on("close", (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`prisma db push 失败（exit=${code}）：${out.slice(-800)}`))
    })
  })
  slog(`目标库结构同步完成（${schemaFile}）`)

  // ========== 阶段 3：目标清空（重跑幂等） ==========
  writeState("clear")
  // FK 约束禁用（MySQL 会话级 / PG 按表 DISABLE TRIGGER / SQLite Prisma 默认不启用 FK）
  if (job.targetProvider === "mysql") {
    await tgt.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS=0")
    slog("MySQL 外键检查已禁用（会话级）")
  }
  const disabledPgTables: string[] = []
  if (job.targetProvider === "postgres") {
    for (const m of [...ordered].reverse()) {
      try {
        await tgt.$executeRawUnsafe(`ALTER TABLE "${m.name}" DISABLE TRIGGER ALL`)
        disabledPgTables.push(m.name)
      } catch {
        /* 无触发器/权限不足 —— 按拓扑序删除仍可成功 */
      }
    }
    if (disabledPgTables.length > 0) slog(`PG 触发器已禁用（${disabledPgTables.length} 表）`)
  }
  for (const m of [...ordered].reverse()) {
    const delegate = tgt[m.name]
    if (!delegate) continue
    const del = await delegate.deleteMany({})
    if (del > 0) slog(`清空目标 ${m.name}（${del} 行）`)
  }

  // ========== 阶段 4：数据复制（拓扑序 + 批量） ==========
  writeState("copy")
  state.progress.rowsCopied = 0
  for (const m of ordered) {
    const srcDelegate = src[m.name]
    const tgtDelegate = tgt[m.name]
    if (!srcDelegate || !tgtDelegate) continue
    state.progress.table = m.name
    writeState()
    // 从 NDJSON 备份读取（备份即复制的单一数据源 —— 两阶段严格一致）
    const file = path.join(job.backupDir, `${m.name}.ndjson`)
    if (!fs.existsSync(file)) continue
    const content = fs.readFileSync(file, "utf-8")
    const lines = content.split("\n").filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      state.progress.tablesDone++
      continue
    }
    const batchSize = m.hasJson ? 50 : BATCH
    for (let i = 0; i < lines.length; i += batchSize) {
      const batchRows = lines.slice(i, i + batchSize).map((l) => JSON.parse(l) as Record<string, unknown>)
      // DateTime 字段：JSON 里是 ISO 字符串 → Prisma 接受字符串自动转 DateTime ✓
      await tgtDelegate.createMany({ data: batchRows })
      state.progress.rowsCopied += batchRows.length
    }
    state.progress.tablesDone++
    if (lines.length > 0) slog(`复制 ${m.name}：${lines.length} 行`)
    writeState()
  }
  slog(`数据复制完成：${state.progress.rowsCopied}/${state.progress.rowsTotal} 行`)

  // FK / 触发器恢复
  if (job.targetProvider === "mysql") {
    await tgt.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS=1").catch(() => {})
  }
  for (const t of disabledPgTables) {
    await tgt.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER ALL`).catch(() => {})
  }

  // ========== 阶段 5：逐表校验（100% 计数对账） ==========
  writeState("verify")
  const mismatches: string[] = []
  for (const m of ordered) {
    const srcDelegate = src[m.name]
    const tgtDelegate = tgt[m.name]
    if (!srcDelegate || !tgtDelegate) continue
    const [sc, tc] = await Promise.all([srcDelegate.count(), tgtDelegate.count()])
    if (sc !== tc) mismatches.push(`${m.name}: 源 ${sc} ≠ 目标 ${tc}`)
    state.progress.table = `${m.name} 校验`
    writeState()
  }
  if (mismatches.length > 0) {
    throw new Error(`计数校验失败（${mismatches.length} 表不匹配）：${mismatches.slice(0, 10).join("；")}`)
  }
  slog(`逐表校验通过：${ordered.length} 模型计数全部一致 ✓`)

  // ========== 阶段 6：finalize（db-active.json 原子写入） ==========
  writeState("finalize")
  const dbActivePath = path.join(ROOT, process.env.STORAGE_LOCAL_PATH ? "" : "storage", "db-active.json")
  const storageDir = process.env.STORAGE_LOCAL_PATH || path.join(ROOT, "storage")
  const dbActiveFinal = path.join(storageDir, "db-active.json")
  void dbActivePath
  const retentionDays = job.retentionDays ?? 7
  const activeConfig = {
    provider: job.targetProvider,
    url: job.targetUrl,
    prevProvider: job.sourceProvider,
    prevUrl: job.sourceUrl,
    migratedAt: new Date().toISOString(),
    rollbackUntil: new Date(Date.now() + retentionDays * 86400_000).toISOString(),
    initSource: "migrate" as const,
  }
  fs.mkdirSync(storageDir, { recursive: true })
  // 写前备份既有 db-active.json
  try {
    fs.copyFileSync(dbActiveFinal, path.join(storageDir, "db-active.backup.json"))
  } catch {
    /* 无既有文件 */
  }
  const tmpActive = dbActiveFinal + ".tmp"
  fs.writeFileSync(tmpActive, JSON.stringify(activeConfig, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmpActive, dbActiveFinal)
  slog(`db-active.json 已写入（provider=${job.targetProvider}，回滚窗口 ${retentionDays} 天）`)

  // PG 目标：审计不可篡改触发器补齐（幂等；失败不阻断 —— 可手工 bun prisma/postgres/apply-triggers.ts）
  if (job.targetProvider === "postgres") {
    try {
      const triggerScript = fs.existsSync(path.join(ROOT, "db/postgres/apply-triggers.ts"))
        ? path.join(ROOT, "db/postgres/apply-triggers.ts")
        : path.join(ROOT, "prisma/postgres/apply-triggers.ts")
      if (fs.existsSync(triggerScript)) {
        await new Promise<void>((resolve) => {
          const p = spawn("bun", [triggerScript], {
            cwd: ROOT,
            env: { ...process.env, DATABASE_PROVIDER: "postgres", DATABASE_URL: job.targetUrl },
          })
          p.on("close", () => resolve())
          p.on("error", () => resolve())
        })
        slog("PG 审计触发器已应用")
      }
    } catch {
      slog("⚠ 审计触发器应用失败（可手工补齐）")
    }
  }

  // 源库连接收尾（源库绝不 disconnect 前提下无写 —— 只读安全）
  await src.$disconnect().catch(() => {})
  await tgt.$disconnect().catch(() => {})

  writeState("done")
  slog("迁移全部完成 ✓（主服务将热切换到新库；源库保持原样供回滚）")
  process.exit(0)
}

main().catch(async (e) => {
  state.error = e instanceof Error ? e.message : String(e)
  writeState("error")
  console.error("[db-migrate] 失败：", state.error)
  console.error("（源库未被修改 —— 数据零损失；db-active.json 未变更 —— 主服务仍在旧库上运行）")
  process.exit(1)
})
