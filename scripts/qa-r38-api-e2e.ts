// r38 API 层 E2E —— 登录 → 数据库管理 API（mismatch 检测/回滚/探测）全链实测
// 运行前提：dev server :3000 运行中 + db-active.json = mysql（迁移态）
import crypto from "node:crypto"

const BASE = "http://localhost:3000"
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

// ---- pre-login → ticket → next-auth signIn ----
async function login(username: string, password: string): Promise<{ cookie: string; ok: boolean; detail: string }> {
  const pre = await fetch(BASE + "/api/auth/pre-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", username, password }),
  })
  const preBody = await pre.json().catch(() => ({}))
  if (pre.status !== 200 || !preBody?.data?.ticket) {
    return { cookie: "", ok: false, detail: `pre-login 失败 ${pre.status}: ${JSON.stringify(preBody).slice(0, 150)}` }
  }
  const ticket = preBody.data.ticket as string
  const csrfRes = await fetch(BASE + "/api/auth/csrf", { cache: "no-store" })
  const csrf = (await csrfRes.json())?.csrfToken as string
  const csrfCookie = (csrfRes.headers.get("set-cookie") || "").split(";")[0]
  const body = new URLSearchParams({ ticket, csrfToken: csrf, json: "true" })
  const signInRes = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
    body: body.toString(),
    redirect: "manual",
  })
  const sessionCookies = (signInRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0])
  if (sessionCookies.length === 0) {
    return { cookie: "", ok: false, detail: `signIn 无会话 Cookie（status=${signInRes.status}）` }
  }
  return { cookie: sessionCookies.join("; "), ok: true, detail: `login ok (${sessionCookies.length} cookies)` }
}

async function main() {
  // ---- 1. 管理员登录（跑在 MySQL 迁移库上 —— 会话/账号均在 mysql）----
  const admin = await login("admin", "Admin@2026")
  check("管理员登录（MySQL 迁移库）", admin.ok, admin.detail)
  if (!admin.ok) {
    console.log(`\n[api-e2e] ${results.filter((r) => r[1]).length}/${results.length} 通过`)
    process.exit(1)
  }
  const H = { Cookie: admin.cookie, "Content-Type": "application/json" } // Cookie 可变（会话跨库失效重登录）

  // ---- 2. GET /api/admin/database：状态总览 ----
  // 【迁移边界会话竞态防护】若刚完成迁移（服务端 GET 触发对账热切到新库），
  // 登录会话可能因跨库失效（正确语义：会话存于库中）—— 401 时重登录一次再取。
  let st = await (await fetch(BASE + "/api/admin/database", { headers: H, cache: "no-store" })).json()
  if (st.code === 40100) {
    const reLogin = await login("admin", "Admin@2026")
    if (reLogin.ok) {
      H.Cookie = reLogin.cookie
      st = await (await fetch(BASE + "/api/admin/database", { headers: H, cache: "no-store" })).json()
    }
  }
  check("数据库状态 API", st.code === 0, `active=${st.data?.active?.provider} connectable=${st.data?.active?.connectable}`)
  check("运行库 = mysql（db-active）", st.data?.active?.provider === "mysql" && st.data?.active?.connectable === true, `${st.data?.active?.version} · ${st.data?.active?.latencyMs}ms · 用户 ${st.data?.active?.userCount}`)
  check("回滚可用（prev=sqlite 窗口内）", st.data?.rollback?.available === true && st.data?.rollback?.prevProvider === "sqlite", `窗口至 ${String(st.data?.rollback?.rollbackUntil).slice(0, 10)}`)
  check("mismatch 状态上报", typeof st.data?.mismatch?.detected === "boolean", `env=${st.data?.mismatch?.envProvider} active=${st.data?.mismatch?.activeProvider}`)
  check("迁移完成态上报", st.data?.migration?.phase === "done", `phase=${st.data?.migration?.phase} switched=${!!st.data?.migration?.switchedAt}`)

  // ---- 3. POST test：探测 PG 空库 ----
  const t1 = await (await fetch(BASE + "/api/admin/database", {
    method: "POST", headers: H,
    body: JSON.stringify({ action: "test", provider: "postgres", url: "postgresql://dockyard:DyPg2026pw@127.0.0.1:5433/dockyard" }),
  })).json()
  check("test 动作（PG 探测）", t1.code === 0 && t1.data?.probe?.ok === true && t1.data?.probe?.hasSchema === false, t1.data?.probe?.version ? `${t1.data.probe.version} ${t1.data.probe.latencyMs}ms` : JSON.stringify(t1).slice(0, 100))

  // ---- 4. POST test：坏连接（拒绝路径）----
  const t2 = await (await fetch(BASE + "/api/admin/database", {
    method: "POST", headers: H,
    body: JSON.stringify({ action: "test", provider: "mysql", url: "mysql://nobody:nope@127.0.0.1:3307/nope" }),
  })).json()
  check("test 动作（坏凭证失败上报）", t2.code === 0 && t2.data?.probe?.ok === false, String(t2.data?.probe?.error).slice(0, 60))

  // ---- 5. 未登录门禁 ----
  const noAuth = await (await fetch(BASE + "/api/admin/database", { cache: "no-store" })).json()
  check("未登录 401 门禁", noAuth.code === 40100, `code=${noAuth.code}`)

  // ---- 6. rollback：一键回滚到 sqlite ----
  const rb = await (await fetch(BASE + "/api/admin/database", {
    method: "POST", headers: H, body: JSON.stringify({ action: "rollback" }),
  })).json()
  check("rollback 动作（mysql → sqlite 热切换）", rb.code === 0 && rb.data?.provider === "sqlite", rb.msg || JSON.stringify(rb).slice(0, 100))

  // ---- 7. 回滚后：会话随库切换失效（正确语义 —— 会话存于库中）→ 重登录验证 ----
  const admin2 = await login("admin", "Admin@2026")
  check("回滚后重登录（sqlite 源数据）", admin2.ok, admin2.detail)
  const H2 = { Cookie: admin2.cookie, "Content-Type": "application/json" }
  const st2 = await (await fetch(BASE + "/api/admin/database", { headers: H2, cache: "no-store" })).json()
  check("回滚后运行库 = sqlite", st2.data?.active?.provider === "sqlite" && st2.data?.active?.connectable === true, `source=${st2.data?.active?.source}`)
  check("回滚后回滚链清空", st2.data?.rollback?.available === false, `prev=${st2.data?.rollback?.prevProvider}`)
  check("回滚后 sqlite 上会话可用（状态 API 复查）", st2.code === 0 && st2.data?.active?.userCount === 2, `users=${st2.data?.active?.userCount}`)

  // ---- 9. mismatch 场景构造：db-active 回写 mysql（模拟 env 类型变化）----
  // （直接用 rollback 已验证双向切换；此步验证 admin GET 的 reconcile 幂等）
  const st3 = await (await fetch(BASE + "/api/admin/database", { headers: H2, cache: "no-store" })).json()
  check("GET 对账幂等（无迁移态）", st3.code === 0 && st3.data?.migration?.phase === "done", `phase=${st3.data?.migration?.phase}`)

  // ---- 10. setup 向导状态（当前 sqlite 正常态）----
  const wiz = await (await fetch(BASE + "/api/setup/database", { cache: "no-store" })).json()
  check("向导状态 API（回滚后 sqlite）", wiz.code === 0 && wiz.data?.active?.provider === "sqlite" && wiz.data?.needsDbBinding === false, `source=${wiz.data?.active?.source}`)

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[api-e2e] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error("[api-e2e] FATAL:", e)
  process.exit(1)
})
