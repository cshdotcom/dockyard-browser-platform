// r38 三数据库矩阵测试 —— sqlite / mysql / postgres 各自独立 CRUD 全链
// （连接 → 建结构（如需）→ 写入 → 读出 → 更新 → 删除 → 计数对账）
import fs from "node:fs"

const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

async function crudRound(provider: "sqlite" | "mysql" | "postgres", url: string): Promise<void> {
  // 独立客户端（不走 db.ts —— 矩阵直连验证各引擎原生链路）
  let client: { $disconnect(): Promise<void>; [k: string]: unknown } | null = null
  try {
    if (provider === "sqlite") {
      const { PrismaClient } = await import("@prisma/client")
      client = new PrismaClient({ datasources: { db: { url } }, log: ["error"] }) as unknown as typeof client
    } else {
      const pkg = provider === "mysql" ? "@prisma/client-mysql" : "@prisma/client-postgres"
      const mod = (await import(pkg)) as { PrismaClient: new (o: unknown) => unknown }
      client = new mod.PrismaClient({ datasources: { db: { url } }, log: ["error"] }) as unknown as typeof client
    }
    const u = client!.user as unknown as {
      create(a: unknown): Promise<{ id: string }>
      findUnique(a: unknown): Promise<{ displayName: string | null; preferences: unknown } | null>
      update(a: unknown): Promise<{ displayName: string }>
      delete(a: unknown): Promise<{ id: string }>
      count(a: unknown): Promise<number>
    }
    const uname = `matrix_${provider}_${Date.now()}`
    const created = await u.create({ data: { username: uname, displayName: `矩阵-${provider}`, passwordHash: "x", preferences: { engine: provider, nums: [1, 2, 3] } } })
    check(`${provider} 连接+写入`, !!created.id, created.id.slice(0, 10))
    const found = await u.findUnique({ where: { username: uname } })
    check(`${provider} 读出+Json 往返`, found?.displayName === `矩阵-${provider}` && (found?.preferences as { engine?: string })?.engine === provider)
    const upd = await u.update({ where: { username: uname }, data: { displayName: `矩阵-${provider}-改` } })
    check(`${provider} 更新`, upd.displayName === `矩阵-${provider}-改`)
    await u.delete({ where: { username: uname } })
    const cnt = await u.count({ where: { username: uname } })
    check(`${provider} 删除+计数对账`, cnt === 0)
  } catch (e) {
    check(`${provider} CRUD 全链`, false, e instanceof Error ? e.message.slice(0, 100) : String(e))
  } finally {
    await client?.$disconnect().catch(() => {})
  }
}

async function main() {
  const SQLITE_URL = "file:" + ROOT0 + "/db/matrix-test.db"
  const MYSQL_URL = "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard_mig"
  const PG_URL = "postgresql://dockyard:DyPg2026pw@127.0.0.1:5433/dockyard_mig"

  // sqlite 矩阵库（独立文件，先 push 结构）
  fs.rmSync(ROOT0 + "/db/matrix-test.db", { force: true })
  const push = await run("bunx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { DATABASE_URL: SQLITE_URL })
  check("sqlite 结构推送（独立矩阵库）", push.code === 0)

  await crudRound("sqlite", SQLITE_URL)
  await crudRound("mysql", MYSQL_URL)
  await crudRound("postgres", PG_URL)

  // 清理 sqlite 矩阵库
  fs.rmSync(ROOT0 + "/db/matrix-test.db", { force: true })

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[db-matrix] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

const ROOT0 = "/home/z/my-project"

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const { spawn } = require("node:child_process") as typeof import("node:child_process")
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT0, env: { ...process.env, ...env } })
    let out = ""
    p.stdout?.on("data", (d: Buffer) => (out += d.toString()))
    p.stderr?.on("data", (d: Buffer) => (out += d.toString()))
    p.on("error", (e) => res({ code: -1, out: String(e) }))
    p.on("close", (code) => res({ code, out }))
  })
}

main().catch((e) => { console.error("[db-matrix] FATAL:", e); process.exit(1) })
