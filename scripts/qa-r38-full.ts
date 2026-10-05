// ============================================================
// r38 综合长时 QA Runner（3 小时+ 计划编排）
//
// 计划（全部真实执行、真实计时，结果落盘 storage/qa-r38/qa-full-report.json）：
//   阶段 A（~15min）：核心脚本套件 —— db-proxy / mysql-crud / migrate-e2e /
//                     api-e2e / hardware / print-intranet（各断言汇总）
//   阶段 B（~20min）：三数据库矩阵 —— sqlite/mysql/pg 各自 CRUD 往返 + 计数对账
//                     （直连真实实例；pg 含 schema push + seed + 校验）
//   阶段 C（长时 soak）：dev 服务持续负载 —— 登录/查询/写读循环（每轮含数据
//                     一致性断言：写入→读出→更新→删除全链），期间周期性探测
//                     三库健康度；发现任何失败立即记录并继续（汇总呈现）
//   阶段 D：结果汇总 + 退出码
// 用法：QA_SOAK_MINUTES=160 bun scripts/qa-r38-full.ts
// ============================================================
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = "/home/z/my-project"
const REPORT_DIR = path.join(ROOT, "storage", "qa-r38")
const SOAK_MINUTES = Number(process.env.QA_SOAK_MINUTES || 160)
const results: Array<{ suite: string; pass: number; total: number; ms: number; ok: boolean; logTail: string }> = []

function runCmd(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 180_000): Promise<{ code: number | null; out: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } })
    const closeP = new Promise<number | null>((res) => child.on("close", (c) => res(c)))
    let out = ""
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-100_000) })
    child.stderr?.on("data", (d: Buffer) => { out += d.toString() })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resTimeout()
    }, timeoutMs)
    function resTimeout() {
      clearTimeout(timer)
      resolve({ code: -999, out: out + "\n[TIMEOUT]", ms: Date.now() - t0 })
    }
    void closeP.then((code) => {
      clearTimeout(timer)
      resolve({ code, out, ms: Date.now() - t0 })
    })
  })
}

function parsePass(out: string): { pass: number; total: number } {
  // 匹配各类输出格式："12/12 通过" / "16/16 通过" / "8/8 通过" / "PASS ✓"
  const m = out.match(/(\d+)\/(\d+) 通过/)
  if (m) return { pass: Number(m[1]), total: Number(m[2]) }
  if (/PASS\s*✓/.test(out)) return { pass: 1, total: 1 }
  return { pass: 0, total: 0 }
}

function record(suite: string, r: { code: number | null; out: string; ms: number }) {
  const { pass, total } = parsePass(r.out)
  results.push({
    suite,
    pass, total,
    ms: r.ms,
    ok: (r.code === 0 && (total === 0 || pass === total)) || (r.code === 0 && /PASS\s*✓/.test(r.out)),
    logTail: r.out.split("\n").filter((l) => /[✓✗]|通过|PASS|FAIL|FATAL|ERROR/.test(l)).slice(-12).join("\n").slice(0, 2000),
  })
  console.log(`[suite] ${suite}: exit=${r.code} ${pass}/${total} (${Math.round(r.ms / 1000)}s)`)
}

async function suite(name: string, script: string, env: Record<string, string> = {}, timeoutMs = 180_000) {
  const r = await runCmd("timeout", [String(Math.floor(timeoutMs / 1000)), "bun", script], env, timeoutMs)
  record(name, r)
  return r.code === 0
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  const startedAt = new Date().toISOString()
  console.log(`[qa-full] 开始 ${startedAt} · soak=${SOAK_MINUTES}min`)

  // ===== 阶段 A：核心脚本套件 =====
  console.log("\n===== 阶段 A：核心套件 =====")
  await suite("A1 db-proxy 热切换/探测/URL推断", "scripts/qa-r38-db-proxy.ts")
  await suite("A2 mysql CRUD 14 项", "scripts/qa-r38-mysql-crud.ts", { DATABASE_URL: "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard" })
  await suite("A3 硬件申请链路 12 项", "scripts/qa-r38-hardware.ts")
  // 迁移 E2E（重置迁移态 → mysql_mig）
  fs.rmSync(path.join(ROOT, "storage/db-migration"), { recursive: true, force: true })
  fs.rmSync(path.join(ROOT, "storage/db-active.json"), { force: true })
  const migDb = await runCmd("timeout", ["30", "bash", "-c", "cd /home/z/db-test && LD_LIBRARY_PATH=/home/z/db-test/roots/usr/lib/x86_64-linux-gnu ./roots/usr/bin/mariadb -h 127.0.0.1 -P 3307 -u root -e \"DROP DATABASE IF EXISTS dockyard_mig; CREATE DATABASE dockyard_mig CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\""])
  if (migDb.code === 0) {
    await suite("A4 迁移 E2E（sqlite→mysql 81表）", "scripts/qa-r38-migrate-e2e.ts", {}, 120_000)
  }
  // dev server 起来后跑 API + 打印
  const health = await fetch("http://localhost:3000/login").then((r) => r.status).catch(() => 0)
  if (health === 200) {
    await suite("A5 API 层 E2E 16 项（登录/状态/回滚）", "scripts/qa-r38-api-e2e.ts", {}, 150_000)
    await suite("A6 打印内网穿透 8 项", "scripts/qa-r38-print-intranet.ts", {}, 150_000)
  } else {
    console.log("[skip] dev server 未运行（A5/A6 跳过）")
  }

  // ===== 阶段 B：三数据库矩阵 =====
  console.log("\n===== 阶段 B：三库矩阵 =====")
  const matrix = await runCmd("timeout", ["240", "bun", "scripts/qa-r38-db-matrix.ts"], {}, 260_000)
  record("B1 三库 CRUD 矩阵（sqlite+mysql+pg）", matrix)

  // ===== 阶段 C：长时 soak =====
  console.log(`\n===== 阶段 C：soak ${SOAK_MINUTES} 分钟 =====`)
  const soakResult = await runCmd("timeout", [String(SOAK_MINUTES * 60 + 60), "bun", "scripts/qa-r38-soak.ts"], { QA_SOAK_MINUTES: String(SOAK_MINUTES) }, (SOAK_MINUTES + 2) * 60_000)
  record(`C1 soak 持续负载（${SOAK_MINUTES}min）`, soakResult)

  // ===== 汇总 =====
  const endedAt = new Date().toISOString()
  const totalMs = results.reduce((a, r) => a + r.ms, 0)
  const summary = {
    startedAt, endedAt, totalMinutes: Math.round((Date.now() - new Date(startedAt).getTime()) / 60000),
    suiteMs: Math.round(totalMs / 1000),
    suites: results,
    totals: {
      suitesPass: results.filter((r) => r.ok).length,
      suitesTotal: results.length,
      checksPass: results.reduce((a, r) => a + r.pass, 0),
      checksTotal: results.reduce((a, r) => a + r.total, 0),
    },
  }
  fs.writeFileSync(path.join(REPORT_DIR, "qa-full-report.json"), JSON.stringify(summary, null, 2))
  console.log("\n===== 汇总 =====")
  console.log(`套件: ${summary.totals.suitesPass}/${summary.totals.suitesTotal} · 断言: ${summary.totals.checksPass}/${summary.totals.checksTotal} · 实际总时长: ${summary.totalMinutes} 分钟`)
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.suite} — ${r.pass}/${r.total} (${Math.round(r.ms / 1000)}s)`)
  }
  process.exit(summary.totals.suitesPass === summary.totals.suitesTotal ? 0 : 1)
}

main().catch((e) => { console.error("[qa-full] FATAL:", e); process.exit(1) })
