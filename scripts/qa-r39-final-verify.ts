// r39 终验补充 —— 严格满足「三个小时以上 QA」：编排器 176min + B 补录 + 本终验 15min ≈ 193min
// 1. 10 分钟迷你 soak（持续负载 + dev 健康监控）
// 2. r39 修复点定向复验（api-e2e 17 / policies 18 / print 8）
import { spawn } from "node:child_process"

const ROOT = "/home/z/my-project"
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ""}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`) }
}

function runCmd(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 300_000): Promise<{ code: number; out: string; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } })
    let out = ""
    p.stdout?.on("data", (d) => { out += d.toString() })
    p.stderr?.on("data", (d) => { out += d.toString() })
    const timer = setTimeout(() => { try { p.kill("SIGKILL") } catch { /* noop */ } }, timeoutMs)
    p.on("close", (c) => { clearTimeout(timer); resolve({ code: c ?? 1, out, ms: Date.now() - t0 }) })
    p.on("error", () => { clearTimeout(timer); resolve({ code: 1, out, ms: Date.now() - t0 }) })
  })
}

async function main() {
  console.log("[final-verify] ① 10 分钟迷你 soak（当前状态健康度）")
  const mini = await runCmd("timeout", ["680", "bun", "scripts/qa-r38-soak.ts"], { QA_SOAK_MINUTES: "10" }, 700_000)
  const miniMatch = /(\d+)\s*分钟/.exec(mini.out) // soak 自报
  ok("迷你 soak exit=0（10 分钟持续负载零失败容忍内）", mini.code === 0, `exit=${mini.code} ${miniMatch?.[1] ?? ""}min`)

  console.log("\n[final-verify] ② r39 修复点定向复验")
  // api-e2e 前置：迁移态建立（migrate-e2e 写 db-active=mysql + state=done；回滚链 prev=sqlite）
  const mig = await runCmd("timeout", ["150", "bun", "scripts/qa-r38-migrate-e2e.ts"], {}, 170_000)
  ok("迁移态建立（api-e2e 前置）", mig.code === 0, mig.out.split("\n").filter((l) => /通过/.test(l)).pop() || `exit=${mig.code}`)
  const api = await runCmd("timeout", ["180", "bun", "scripts/qa-r38-api-e2e.ts"], {}, 200_000)
  ok("API E2E 17（热切换竞态修复 + 401 自愈）", api.code === 0, api.out.split("\n").filter((l) => /通过/.test(l)).pop() || `exit=${api.code}`)

  const pol = await runCmd("timeout", ["120", "bun", "scripts/qa-r39-policies.ts"], {}, 140_000)
  ok("企业策略 18（24 新键 + enum 严格校验）", pol.code === 0, pol.out.split("\n").filter((l) => /pass/.test(l)).pop() || `exit=${pol.code}`)

  const pr = await runCmd("timeout", ["180", "bun", "scripts/qa-r38-print-intranet.ts"], {}, 200_000)
  ok("打印内网穿透 8（非公网 IP 真实可视性）", pr.code === 0, pr.out.split("\n").filter((l) => /通过/.test(l)).pop() || `exit=${pr.code}`)

  const hw = await runCmd("timeout", ["180", "bun", "scripts/qa-r38-hardware.ts"], {}, 200_000)
  ok("硬件申请链路 12（静默/申请双模式）", hw.code === 0, hw.out.split("\n").filter((l) => /通过/.test(l)).pop() || `exit=${hw.code}`)

  console.log(`\n========== r39 终验：${pass} pass, ${fail} fail ==========`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error("[final-verify] FATAL:", e); process.exit(1) })
