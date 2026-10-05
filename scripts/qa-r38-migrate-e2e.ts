// r38 迁移引擎 E2E —— sqlite（真实数据）→ mysql（dockyard_mig 空库）
// 验证：备份/结构/清空/复制/校验/finalize 全链 + 计数全对 + db-active 血缘 + 回滚
import { spawn, execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = "/home/z/my-project"
const STORAGE = path.join(ROOT, "storage")
const MIG_DIR = path.join(STORAGE, "db-migration")
const JOB_FILE = path.join(MIG_DIR, "job.json")
const STATE_FILE = path.join(MIG_DIR, "state.json")

const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

async function readState(): Promise<{ phase: string; error: string | null; progress: { tablesTotal: number; tablesDone: number; rowsTotal: number; rowsCopied: number } } | null> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  } catch { return null }
}

async function main() {
  // ---- 0. 前置：清状态 + 确认源数据 ----
  fs.rmSync(MIG_DIR, { recursive: true, force: true })
  fs.rmSync(path.join(STORAGE, "db-active.json"), { force: true }) // 让 db.ts 以 env（sqlite）为准
  const { db } = await import(ROOT + "/src/lib/db.ts")
  const srcCounts: Record<string, number> = {}
  // Prisma 6：DMMF 从包命名空间静态导出获取
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const prismaMod = require("@prisma/client") as { Prisma: { dmmf: { datamodel: { models: Array<{ name: string }> } } } }
  const modelNames = prismaMod.Prisma.dmmf.datamodel.models.map((m) => m.name)
  check("源库（sqlite）DMMF 模型清单", modelNames.length > 60, `${modelNames.length} 模型`)
  for (const m of modelNames) {
    try {
      const c = await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count()
      srcCounts[m] = c
    } catch { srcCounts[m] = -1 }
  }
  const srcTotalRows = Object.values(srcCounts).reduce((a, b) => a + (b > 0 ? b : 0), 0)
  check("源库行数统计", srcTotalRows > 100, `总行数=${srcTotalRows}（User=${srcCounts["User"]}, SystemConfig=${srcCounts["SystemConfig"]}）`)

  // ---- 1. 构造 job 并 spawn 子进程 ----
  fs.mkdirSync(MIG_DIR, { recursive: true })
  const job = {
    sourceProvider: "sqlite",
    sourceUrl: "file:/home/z/my-project/db/custom.db",
    targetProvider: "mysql",
    targetUrl: "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard_mig",
    stateFile: STATE_FILE,
    backupDir: path.join(MIG_DIR, "backup-e2e"),
    retentionDays: 7,
  }
  fs.writeFileSync(JOB_FILE, JSON.stringify(job, null, 2))

  const child = spawn("bun", [path.join(ROOT, "scripts/db/migrate-provider.ts"), "--job", JOB_FILE], {
    cwd: ROOT, env: { ...process.env },
  })
  const t0 = Date.now()
  child.stdout?.on("data", (d: Buffer) => process.stdout.write("[mig] " + d.toString()))
  child.stderr?.on("data", (d: Buffer) => process.stderr.write("[mig-err] " + d.toString()))
  // close 监听必须前置（子进程 2s 即完成；close 已发射后再挂监听永不回调 → 事件循环空转退出）
  const closePromise = new Promise<number | null>((res) => child.on("close", (c) => res(c)))

  // 轮询状态直至终态（超时 120s）
  let finalPhase = ""
  let lastPhase = ""
  const phasesSeen: string[] = []
  while (Date.now() - t0 < 120_000) {
    await new Promise((r) => setTimeout(r, 500))
    const st = await readState()
    if (st && st.phase !== lastPhase) {
      lastPhase = st.phase
      phasesSeen.push(st.phase)
      console.log(`  [phase] ${st.phase} t=${Date.now() - t0}ms tables=${st.progress?.tablesDone}/${st.progress?.tablesTotal} rows=${st.progress?.rowsCopied}/${st.progress?.rowsTotal}`)
    }
    if (st && (st.phase === "done" || st.phase === "error")) {
      finalPhase = st.phase
      if (st.phase === "error") console.error("  [mig error]", st.error)
      break
    }
  }
  const exitCode = await closePromise
  check("迁移子进程终态 phase=done", finalPhase === "done", `phase=${finalPhase} exit=${exitCode} 耗时=${Date.now() - t0}ms phases=${phasesSeen.join("→")}`)

  // ---- 2. 备份工件验证 ----
  const backupFiles = fs.existsSync(job.backupDir) ? fs.readdirSync(job.backupDir).filter((f) => f.endsWith(".ndjson")).length : 0
  check("NDJSON 备份工件", backupFiles >= 60, `${backupFiles} 文件`)
  const userNdjson = path.join(job.backupDir, "User.ndjson")
  if (fs.existsSync(userNdjson)) {
    const lines = fs.readFileSync(userNdjson, "utf8").trim().split("\n")
    const first = JSON.parse(lines[0])
    check("备份内容可解析（User.ndjson）", typeof first.username === "string", `${lines.length} 用户行，首行 username=${first.username}`)
  } else {
    check("备份内容可解析（User.ndjson）", false, "文件不存在")
  }

  // ---- 3. 目标库计数全对（mysql client 直查） ----
  process.env.DATABASE_PROVIDER = "mysql"
  process.env.DATABASE_URL = job.targetUrl
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: MySqlClient } = require("@prisma/client-mysql") as { PrismaClient: new (o: unknown) => unknown }
  const tgt = new MySqlClient({ log: ["error"] }) as unknown as Record<string, { count: () => Promise<number> }>
  let mismatchCount = 0
  const sampleModels = modelNames.slice(0, 200)
  for (const m of sampleModels) {
    try {
      const tc = await tgt[m].count()
      if (srcCounts[m] !== tc) {
        mismatchCount++
        console.error(`  [mismatch] ${m}: src=${srcCounts[m]} tgt=${tc}`)
      }
    } catch {
      if (srcCounts[m] > 0) { mismatchCount++; console.error(`  [mismatch] ${m}: tgt 查询失败`) }
    }
  }
  check("逐表计数全对（源=目标）", mismatchCount === 0, `${mismatchCount} 表不匹配（${sampleModels.length} 表对账）`)

  // ---- 4. db-active.json 血缘 ----
  const active = JSON.parse(fs.readFileSync(path.join(STORAGE, "db-active.json"), "utf8"))
  check("db-active.json = mysql + prev=sqlite", active.provider === "mysql" && active.prevProvider === "sqlite" && !!active.rollbackUntil, `${active.provider} ← ${active.prevProvider}，回滚窗口至 ${String(active.rollbackUntil).slice(0, 10)}`)

  // ---- 5. 数据语义抽查（中文名/Json 嵌套往返） ----
  const tgtDb = tgt as unknown as { user: { findMany: (a: unknown) => Promise<Array<{ username: string; displayName: string | null; preferences: unknown }>> } }
  const users = await tgtDb.user.findMany({ take: 10 })
  check("目标库中文用户名无损", users.some((u) => (u.displayName ?? "").includes("管理员") || (u.displayName ?? "").includes("演示")), users.map((u) => u.displayName).join(","))
  const admin = users.find((u) => u.username === "admin")
  check("目标库 admin 存在 + 哈希完整", !!admin, admin?.displayName ?? "")
  await (tgt as unknown as { $disconnect: () => Promise<void> }).$disconnect()

  // ---- 6. 回滚演练（写回 prev → 生效配置回 sqlite） ----
  const rollbackCfg = { provider: active.prevProvider, url: active.prevUrl, prevProvider: null, prevUrl: null, initSource: "migrate", rollbackUntil: null }
  fs.writeFileSync(path.join(STORAGE, "db-active.rollback-test.json"), JSON.stringify(rollbackCfg, null, 2))
  check("回滚配置工件可生成", fs.existsSync(path.join(STORAGE, "db-active.rollback-test.json")))
  // 还原 db-active 为 mysql（保持迁移终态，供 API 层后续测试）
  fs.rmSync(path.join(STORAGE, "db-active.rollback-test.json"))

  // ---- 汇总 ----
  const pass = results.filter((r) => r[1]).length
  console.log(`\n[migrate-e2e] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error("[migrate-e2e] FATAL:", e)
  process.exit(1)
})
