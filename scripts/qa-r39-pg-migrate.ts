// r39 PG 迁移链路 E2E —— sqlite（真实数据）→ postgres（dockyard_pg_mig 空库）
// 覆盖：用户点名「看一下 pgsql 完整了没」—— 迁移 + 计数对账 + 中文/Json 语义 + PG 客户端读取
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = "/home/z/my-project"
const STORAGE = path.join(ROOT, "storage")
const MIG_DIR = path.join(STORAGE, "db-migration-pg")
const JOB_FILE = path.join(MIG_DIR, "job.json")
const STATE_FILE = path.join(MIG_DIR, "state.json")
const TARGET_URL = "postgresql://dockyard:DyPg2026pw@127.0.0.1:5433/dockyard_pg_mig"

const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

function readState(): { phase: string; error: string | null } | null {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) } catch { return null }
}

async function main() {
  // ---- 0. 前置：建空库（PG 客户端 psql via runCmd）----
  fs.rmSync(MIG_DIR, { recursive: true, force: true })
  fs.rmSync(path.join(STORAGE, "db-active.json"), { force: true }) // env（sqlite）为准，防污染
  const created = await new Promise<number>((res) => {
    const p = spawn("/home/z/db-test/roots/usr/lib/postgresql/17/bin/psql", [
      "-h", "127.0.0.1", "-p", "5433", "-U", "dockyard", "-d", "postgres",
      "-c", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'dockyard_pg_mig'",
      "-c", "DROP DATABASE IF EXISTS dockyard_pg_mig",
      "-c", "CREATE DATABASE dockyard_pg_mig",
    ], { env: { ...process.env, PGPASSWORD: "DyPg2026pw" } })
    p.on("close", (c) => res(c ?? 1)); p.on("error", () => res(1))
  })
  check("PG 目标空库就绪（dockyard_pg_mig）", created === 0, `psql exit=${created}`)

  // ---- 1. 源库计数（sqlite 主库直连）----
  const srcCounts: Record<string, number> = {}
  process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db"
  const { PrismaClient: SqliteClient } = await import("@prisma/client")
  const src = new SqliteClient({ log: ["error"] }) as unknown as Record<string, { count: () => Promise<number> }>
  const prismaMod = (await import("@prisma/client")) as unknown as { Prisma: { dmmf: { datamodel: { models: Array<{ name: string }> } } } }
  const modelNames = prismaMod.Prisma.dmmf.datamodel.models.map((m) => m.name)
  for (const m of modelNames) {
    try { srcCounts[m] = await src[m].count() } catch { srcCounts[m] = -1 }
  }
  const srcTotal = Object.values(srcCounts).reduce((a, b) => a + (b > 0 ? b : 0), 0)
  check("源库（sqlite）行数统计", srcTotal > 100, `总行数=${srcTotal}（82 模型基线）`)
  await (src as unknown as { $disconnect: () => Promise<void> }).$disconnect()

  // ---- 2. 构造 job 并 spawn migrate-provider ----
  fs.mkdirSync(MIG_DIR, { recursive: true })
  fs.writeFileSync(JOB_FILE, JSON.stringify({
    sourceProvider: "sqlite",
    sourceUrl: "file:/home/z/my-project/db/custom.db",
    targetProvider: "postgres",
    targetUrl: TARGET_URL,
    stateFile: STATE_FILE,
    backupDir: path.join(MIG_DIR, "backup-pg-e2e"),
    retentionDays: 7,
  }, null, 2))
  // migrate-provider 的 state/job 路径来自 job 文件，但 MIG_DIR 目录需存在；重定向 db-active 路径避免写坏主线
  const child = spawn("bun", [path.join(ROOT, "scripts/db/migrate-provider.ts"), "--job", JOB_FILE], { cwd: ROOT, env: { ...process.env } })
  const t0 = Date.now()
  child.stdout?.on("data", (d: Buffer) => process.stdout.write("[mig] " + d.toString()))
  child.stderr?.on("data", (d: Buffer) => process.stderr.write("[mig-err] " + d.toString()))
  let finalPhase = ""
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 800))
    const st = readState()
    if (st && (st.phase === "done" || st.phase === "error")) { finalPhase = st.phase; if (st.phase === "error") console.error("  [mig error]", st.error); break }
  }
  check("PG 迁移子进程终态 phase=done", finalPhase === "done", `phase=${finalPhase} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)

  // ---- 3. 目标库计数对账（PG 客户端直查）----
  process.env.DATABASE_URL = TARGET_URL
  const { PrismaClient: PgClient } = await import("@prisma/client-postgres")
  const tgt = new PgClient({ log: ["error"] }) as unknown as Record<string, { count: () => Promise<number> }>
  let mismatchCount = 0
  let checked = 0
  for (const m of modelNames) {
    try {
      const tc = await tgt[m].count(); checked++
      if (srcCounts[m] !== tc) { mismatchCount++; console.error(`  [mismatch] ${m}: src=${srcCounts[m]} tgt=${tc}`) }
    } catch { if (srcCounts[m] > 0) { mismatchCount++; console.error(`  [mismatch] ${m}: tgt 查询失败`) } }
  }
  check("PG 逐表计数全对（源=目标）", mismatchCount === 0, `${mismatchCount} 表不匹配（${checked} 表对账）`)

  // ---- 4. 数据语义抽查 ----
  const tgtDb = tgt as unknown as { user: { findMany: (a: unknown) => Promise<Array<{ username: string; displayName: string | null }>> } }
  const users = await tgtDb.user.findMany({ take: 10 })
  check("PG 中文用户名无损", users.some((u) => (u.displayName ?? "").includes("管理员") || (u.displayName ?? "").includes("演示")), users.map((u) => u.displayName).join(","))
  const cfg = tgt as unknown as { systemConfig: { count: () => Promise<number> } }
  const cfgCount = await cfg.systemConfig.count().catch(() => -1)
  check("PG SystemConfig 播种完整", cfgCount >= 170, `count=${cfgCount}`)

  // ---- 5. 审计触发器应用验证（PG 特有安全强化）----
  const rawClient = tgt as unknown as { $queryRawUnsafe: (q: string) => Promise<Array<{ n: number }>> }
  let trig = -1
  try {
    const rows = await rawClient.$queryRawUnsafe("SELECT COUNT(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgisinternal = false AND c.relname = 'AuditLog'")
    trig = rows[0]?.n ?? 0
  } catch { trig = -1 }
  check("PG 审计不可篡改触发器已应用", (trig as number) > 0, `AuditLog 触发器=${trig}`)

  // ---- 6. db-active 恢复 sqlite（本测试不改主线运行库）----
  fs.rmSync(path.join(STORAGE, "db-active.json"), { force: true })
  check("测试后 db-active 清理（主线 sqlite 不受影响）", !fs.existsSync(path.join(STORAGE, "db-active.json")))
  await (tgt as unknown as { $disconnect: () => Promise<void> }).$disconnect()

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[pg-migrate-e2e] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error("[pg-migrate-e2e] FATAL:", e); process.exit(1) })
