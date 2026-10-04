/**
 * r29 冒烟：Master/Worker 节点注册与通信全链路
 * 覆盖：创建（超管鉴权+一次性凭证）/ 三要素启动校验 / 心跳鉴权与上报
 *      / 在线判定（30s 窗口）/ 坏 Key 拒绝 / 驱逐（永久失效+Worker 退出）
 */
import { PrismaClient } from "@prisma/client"
import { createHash } from "crypto"
import { spawn } from "child_process"

const db = new PrismaClient()
const MASTER = "http://localhost:3000"
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// admin 会话 cookie（pre-login ticket → NextAuth credentials 回调）
async function login(user: string, pass: string): Promise<string> {
  const pre = await fetch(`${MASTER}/api/auth/pre-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", username: user, password: pass }),
  }).then((r) => r.json()) as { code: number; data?: { ticket?: string } }
  if (pre.code !== 0 || !pre.data?.ticket) throw new Error(`pre-login 失败: ${JSON.stringify(pre).slice(0, 120)}`)

  const csrfRes = await fetch(`${MASTER}/api/auth/csrf`)
  const csrf = (await csrfRes.json()) as { csrfToken: string }
  const cookies = [csrfRes.headers.get("set-cookie")?.split(";")[0]].filter(Boolean).join("; ")

  const cb = await fetch(`${MASTER}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookies },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, ticket: pre.data.ticket, totp: "", trustDevice: "" }),
    redirect: "manual",
  })
  const sc = cb.headers.getSetCookie?.() || []
  const session = sc.find((c) => c.startsWith("dockyard-session=")) || sc.find((c) => c.startsWith("next-auth.session-token="))
  if (!session) throw new Error("会话 cookie 未获得")
  return session.split(";")[0]
}

async function main() {
  console.log("== r29 冒烟：Master/Worker 节点通信 ==")
  const cookie = await login("admin", "Admin@2026")
  check("管理员登录（ticket → 会话）", !!cookie)

  // 1. 创建节点（一次性凭证）
  const createRes = await fetch(`${MASTER}/api/master/worknode/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "QA-R29-Worker", region: "qa-region", note: "冒烟测试节点" }),
  }).then((r) => r.json()) as { code: number; data?: { nodeId: string; nodeUuid: string; apiKey: string; deploy: Record<string, string> } }
  check("创建节点（超管）", createRes.code === 0 && !!createRes.data?.apiKey)
  const { nodeId, nodeUuid, apiKey, deploy } = createRes.data!

  // 2. 库中仅存哈希（明文不可回溯）
  const row = await db.workNode.findUnique({ where: { nodeUuid } })
  check("库中存 SHA-256 哈希", row?.apiKeyHash === createHash("sha256").update(apiKey).digest("hex"))
  check("三环境变量清单返回", !!deploy.MASTER_API_URL && deploy.WORKER_NODE_UUID === nodeUuid && deploy.WORKER_API_KEY === apiKey)

  // 3. 非 SUPER_ADMIN 拒绝创建
  const demoCookie = await login("demo", "Demo@2026")
  const denied = await fetch(`${MASTER}/api/master/worknode/create`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: demoCookie },
    body: JSON.stringify({ name: "x" }),
  })
  check("非超管创建拒绝（403）", denied.status === 403)

  // 4. 心跳鉴权（坏 Key）
  const badHb = await fetch(`${MASTER}/api/master/worknode/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-node-uuid": nodeUuid, "x-node-key": "wak-" + "0".repeat(48) },
    body: JSON.stringify({ cpu: 10 }),
  })
  check("坏 API Key 心跳拒绝（403）", badHb.status === 403)

  // 5. 真实心跳（指标上报 + ONLINE）
  const hb = await fetch(`${MASTER}/api/master/worknode/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-node-uuid": nodeUuid, "x-node-key": apiKey },
    body: JSON.stringify({ cpu: 42.5, mem: 61.2, disk: 33.1, diskFreeMb: 123456, sandboxCount: 2, sandboxRunning: 2, version: "worker-1.0.0-r29", hostname: "qa-host" }),
  }).then((r) => r.json()) as { code: number; data?: { commands: unknown[] } }
  check("合法心跳上报成功", hb.code === 0 && Array.isArray(hb.data?.commands))
  const after = await db.workNode.findUnique({ where: { nodeUuid } })
  check("指标落库 + 状态 ONLINE", after?.status === "ONLINE" && after?.cpuUsage === 42.5 && after?.hostname === "qa-host")

  // 6. 列表（在线判定 30s 窗口）
  const list = await fetch(`${MASTER}/api/master/worknode/list`, { headers: { cookie } }).then((r) => r.json()) as { code: number; data?: { nodes: Array<{ nodeUuid: string; liveStatus: string; apiKeyHash?: string }> } }
  const listed = list.data?.nodes.find((n) => n.nodeUuid === nodeUuid)
  check("列表在线判定", listed?.liveStatus === "ONLINE")
  check("列表不泄露 API_KEY", !listed?.apiKeyHash && !JSON.stringify(listed || {}).includes(apiKey))

  // 7. Worker 进程：三要素校验（缺失退出 1）
  const wEnv = spawn("bun", ["run", "mini-services/worker/index.ts"], { env: { ...process.env, MASTER_API_URL: MASTER, WORKER_NODE_UUID: "", WORKER_API_KEY: "" } })
  const wExit = await new Promise<number>((res) => wEnv.on("exit", (c) => res(c ?? 1)))
  check("Worker 缺环境变量拒绝启动（exit 1）", wExit === 1)

  // 8. Worker 进程：合法凭证 → 心跳（3 秒后仍存活）→ 驱逐 → Worker 自动退出
  const w = spawn("bun", ["run", "mini-services/worker/index.ts"], {
    env: { ...process.env, MASTER_API_URL: MASTER, WORKER_NODE_UUID: nodeUuid, WORKER_API_KEY: apiKey, WORKER_HEARTBEAT_SEC: "2" },
  })
  await new Promise((r) => setTimeout(r, 3500))
  check("Worker 存活（心跳循环运行）", w.exitCode === null && !w.killed)
  const hb2 = await db.workNode.findUnique({ where: { nodeUuid } })
  check("Worker 真实心跳刷新（30s 内）", hb2?.lastHeartbeatAt && Date.now() - hb2.lastHeartbeatAt.getTime() < 5000)

  // 9. 驱逐 → Worker 心跳 403 → 自动退出
  const evict = await fetch(`${MASTER}/api/master/worknode/evict`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ nodeId, reason: "QA-R29 密钥泄露模拟驱逐" }),
  }).then((r) => r.json()) as { code: number }
  check("驱逐节点（超管）", evict.code === 0)
  const wExit2 = await new Promise<number>((res) => {
    w.on("exit", (c) => res(c ?? -1))
    setTimeout(() => res(-1), 8000)
  })
  check("驱逐后 Worker 自动退出（exit 2）", wExit2 === 2, `exit=${wExit2}`)
  try { w.kill("SIGKILL") } catch { /* noop */ }

  // 10. 驱逐后心跳永久 403
  const evictedHb = await fetch(`${MASTER}/api/master/worknode/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-node-uuid": nodeUuid, "x-node-key": apiKey },
    body: JSON.stringify({ cpu: 1 }),
  })
  check("驱逐后心跳永久拒绝（403）", evictedHb.status === 403)

  // 清理
  await db.workNode.delete({ where: { id: nodeId } })
  await db.auditLog.deleteMany({ where: { operationType: { in: ["WORKNODE_CREATE", "WORKNODE_EVICT", "WORKNODE_ONLINE", "WORKNODE_AUTH_FAIL"] }, resourceId: nodeId } })

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  await db.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
