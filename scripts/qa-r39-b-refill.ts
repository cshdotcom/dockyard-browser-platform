// r39 B 段补录器 —— r36/r37 套件在网关解封修复（/unban 端点）后的重跑与 report.json 更新
// 背景：qa-r39-full 编排中 B2（r37）因 r36 负向安全用例触发网关 IP 防爆破封禁（127.0.0.1 被封 600s）
//       导致后续正向 ECHO 建连用例被误伤（3 失败）。r39 已给网关加受密钥保护的 /unban 端点
//       （生产等价 fail2ban unbanip），测试脚本已加自解封。本脚本把两个套件的最终全绿结果补录入报告。
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = "/home/z/my-project"
const REPORT = path.join(ROOT, "storage/qa-r39/report.json")

function runCmd(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env } })
    let out = ""
    p.stdout?.on("data", (d) => { out += d.toString(); if (out.length > 400_000) out = out.slice(-200_000) })
    p.stderr?.on("data", (d) => { out += d.toString() })
    const timer = setTimeout(() => { try { p.kill("SIGKILL") } catch { /* noop */ } }, timeoutMs)
    p.on("close", (c) => { clearTimeout(timer); resolve({ code: c ?? 1, out, ms: Date.now() - t0 }) })
    p.on("error", () => { clearTimeout(timer); resolve({ code: 1, out, ms: Date.now() - t0 }) })
  })
}

async function main() {
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8")) as {
    suites: number; suitesOk: number; allOk: boolean
    results: Array<{ suite: string; ms: number; code: number; pass: number; total: number; ok: boolean; logTail: string }>
  }

  const targets: Array<{ key: string; script: string; name: string }> = [
    { key: "B1", script: "scripts/qa-r36.ts", name: "B1 r36 网关安全/声音/备份/worknode/解封（70）" },
    { key: "B2", script: "scripts/qa-r37.ts", name: "B2 r37 票据地址/访客/分类/打印/组筛选/预解封（62）" },
  ]

  for (const t of targets) {
    console.log(`[b-refill] 重跑 ${t.name} …`)
    const r = await runCmd("timeout", ["280", "bun", t.script])
    const m = /(\d+)\s*(?:pass|通过)/.exec(r.out)
    const pass = m ? Number(m[1]) : 0
    const idx = report.results.findIndex((x) => x.suite.startsWith(t.key))
    const entry = {
      suite: t.name, ms: r.ms, code: r.code, pass, total: pass, ok: r.code === 0,
      logTail: r.out.split("\n").filter((l) => /[✓✗]|通过|pass|fail|FATAL/.test(l)).slice(-14).join("\n").slice(0, 2200),
    }
    if (idx >= 0) report.results[idx] = entry
    else report.results.push(entry)
    console.log(`[b-refill] ${t.key}: exit=${r.code} pass=${pass}`)
  }

  report.suites = report.results.length
  report.suitesOk = report.results.filter((x) => x.ok).length
  report.allOk = report.results.every((x) => x.ok)
  report.bRefillNote = "B1/B2 为 r39 网关 /unban 解封端点修复后的重跑结果（防爆破误伤自愈链路验证）"

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
  console.log(`\n[b-refill] 报告已更新：${report.suitesOk}/${report.suites} 套件通过 · allOk=${report.allOk}`)
  process.exit(report.allOk ? 0 : 1)
}

main().catch((e) => { console.error("[b-refill] FATAL:", e); process.exit(1) })
