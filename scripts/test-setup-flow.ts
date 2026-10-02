// 首管理员注册 + 登录 + NoVNC 工作区创建端到端验证（r14）
// 验证链路：prlimit 修复后的真实沙箱创建 → CDP 端点 → 运行状态
const BASE = "http://127.0.0.1:3000"

async function j(path: string, init?: RequestInit) {
  const r = await fetch(BASE + path, init)
  const ct = r.headers.get("content-type") || ""
  if (ct.includes("application/json")) return { status: r.status, body: await r.json(), headers: r.headers }
  return { status: r.status, body: await r.text(), headers: r.headers }
}

async function main() {
  // 1. 首管理员注册（经 pre-login API? —— 实际为 server action；此处直接经 /setup 表单逻辑的底层库调用不可行，
  //    改用 HTTP：先查是否已有管理员）
  const login = await j("/login")
  console.log("login page:", login.status)

  // 注册首管理员需要 server action —— 经 Next.js server action 协议调用较复杂。
  // 改用 Agent Browser 完成 UI 流程（见后续步骤）。此脚本仅验证服务健康。
  const health = await j("/api/metrics")
  console.log("metrics:", health.status)
}

main().catch((e) => {
  console.error("FAIL:", e)
  process.exit(1)
})
