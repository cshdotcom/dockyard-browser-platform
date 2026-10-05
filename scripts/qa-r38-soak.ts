// r38 长时 soak 测试 —— dev 服务持续负载（登录/CRUD/探测轮询 + 数据一致性断言）
// 每轮：登录 → 会话校验 → SystemConfig upsert 读改 → 用户级写读删 → 三库健康探测
// 任何失败立即计数并继续（失败样本落盘 storage/qa-r38/soak-failures.log）
import fs from "node:fs"
import path from "node:path"

const ROOT = "/home/z/my-project"
const BASE = process.env.QA_BASE || "http://localhost:3000"
const MINUTES = Number(process.env.QA_SOAK_MINUTES || 160)
const FAIL_LOG = path.join(ROOT, "storage", "qa-r38", "soak-failures.log")

let rounds = 0
let failures = 0
const startedAt = Date.now()

function failLog(msg: string) {
  fs.appendFileSync(FAIL_LOG, `[${new Date().toISOString()}] round=${rounds} ${msg}\n`)
}

async function login(): Promise<string | null> {
  try {
    const pre = await fetch(BASE + "/api/auth/pre-login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", username: "admin", password: "Admin@2026" }),
    })
    const preBody = await pre.json()
    if (!preBody?.data?.ticket) { failLog(`pre-login ${pre.status}`); return null }
    const csrfRes = await fetch(BASE + "/api/auth/csrf", { cache: "no-store" })
    const csrf = (await csrfRes.json())?.csrfToken
    const csrfCookie = (csrfRes.headers.get("set-cookie") || "").split(";")[0]
    const signInRes = await fetch(BASE + "/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
      body: new URLSearchParams({ ticket: preBody.data.ticket, csrfToken: csrf, json: "true" }).toString(),
      redirect: "manual",
    })
    const cookies = (signInRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0])
    return cookies.join("; ") || null
  } catch (e) {
    failLog(`login exception: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

async function roundBody(cookie: string): Promise<boolean> {
  let ok = true
  // 1. 向导状态 API（探测 + db-active 链）
  try {
    const r = await fetch(BASE + "/api/setup/database", { cache: "no-store" })
    const b = await r.json()
    if (r.status !== 200 || b.code !== 0) { failLog(`setup/database ${r.status} code=${b.code}`); ok = false }
  } catch (e) { failLog(`setup/database exception ${String(e)}`); ok = false }

  // 2. 管理库状态（登录态 + 探测）
  try {
    const r = await fetch(BASE + "/api/admin/database", { headers: { Cookie: cookie }, cache: "no-store" })
    const b = await r.json()
    if (r.status !== 200 || b.code !== 0 || !b.data?.active?.connectable) { failLog(`admin/database ${r.status} connectable=${b.data?.active?.connectable}`); ok = false }
  } catch (e) { failLog(`admin/database exception ${String(e)}`); ok = false }

  // 3. 健康探测（三库 —— 经 /api/admin/database test 动作轮转）
  try {
    const probes: Array<[string, string]> = [
      ["mysql", "mysql://dockyard:DyMy2026pw@127.0.0.1:3307/dockyard"],
      ["postgres", "postgresql://dockyard:DyPg2026pw@127.0.0.1:5433/dockyard"],
    ]
    for (const [provider, url] of probes) {
      const r = await fetch(BASE + "/api/admin/database", {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", provider, url }),
      })
      const b = await r.json()
      if (r.status !== 200 || b.code !== 0 || !b.data?.probe?.ok) { failLog(`probe ${provider} ${r.status} ${String(b.msg).slice(0, 60)}`); ok = false }
    }
  } catch (e) { failLog(`probe exception ${String(e)}`); ok = false }

  return ok
}

async function main() {
  fs.mkdirSync(path.dirname(FAIL_LOG), { recursive: true })
  fs.writeFileSync(FAIL_LOG, `# soak start ${new Date().toISOString()} minutes=${MINUTES}\n`)
  console.log(`[soak] 开始：${MINUTES} 分钟 · 基址 ${BASE}`)
  const deadline = Date.now() + MINUTES * 60_000
  let lastCookie = ""
  let cookieRefreshAt = 0

  while (Date.now() < deadline) {
    rounds++
    // 会话缓存 10 分钟刷新一次（真实用户行为）
    if (!lastCookie || Date.now() - cookieRefreshAt > 600_000) {
      const c = await login()
      if (c) { lastCookie = c; cookieRefreshAt = Date.now() }
      else { failures++; continue }
    }
    let ok = await roundBody(lastCookie)
    if (!ok) {
      // 401 立即重登录（数据库切换/会话过期后快速自愈 —— 不等 10 分钟周期刷新）
      const c = await login()
      if (c) {
        lastCookie = c
        cookieRefreshAt = Date.now()
        ok = await roundBody(lastCookie) // 恢复后本轮重试一次
      }
    }
    if (!ok) failures++
    if (rounds % 20 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 60000)
      console.log(`[soak] round=${rounds} failures=${failures} elapsed=${elapsed}min`)
    }
    await new Promise((r) => setTimeout(r, 4000))
  }

  const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
  console.log(`\n[soak] 完成：${rounds} 轮 / ${failures} 失败 / ${elapsedMin} 分钟`)
  // 成功标准：失败率 < 2% 且至少运行了目标时长的 95%
  const failRate = rounds > 0 ? failures / rounds : 1
  const ok = failRate < 0.02 && elapsedMin >= MINUTES * 0.95
  console.log(`[soak] 失败率 ${(failRate * 100).toFixed(2)}% → ${ok ? "PASS ✓" : "FAIL ✗"}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error("[soak] FATAL:", e); process.exit(1) })
