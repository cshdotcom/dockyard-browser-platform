// 三轮：真实配置生效链路 —— setConfigAction 同语义（先 config_drift 刷新内存缓存）→ 上传校验
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const BASE = "http://localhost:3000"
let passed = 0, failed = 0
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}
let cookie = ""
async function login(username: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/pre-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", username, password, remember: false }) })
  const json = await res.json()
  if (json.code !== 0) return false
  const jar: string[] = []
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  for (const c of csrfRes.headers.getSetCookie?.() || []) jar.push(c.split(";")[0])
  const csrfJson = await csrfRes.json()
  const cb = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ ticket: json.data.ticket, csrfToken: csrfJson.csrfToken, json: "true" }), redirect: "manual",
  })
  for (const c of cb.headers.getSetCookie?.() || []) { const kv = c.split(";")[0]; if (kv.startsWith("dockyard-session")) jar.push(kv) }
  cookie = [...new Set(jar)].join("; ")
  return cookie.includes("dockyard-session")
}
async function main() {
  console.log("== 三轮：配置生效链路（模拟 setConfig 后缓存刷新） ==")
  const adminOk = await login("admin", "Admin@2026")
  ok("admin 登录", adminOk)
  if (!adminOk) process.exit(1)
  // 1) DB 更新白名单（模拟保存）→ 2) config_drift 刷新服务端缓存（= setConfig 的 ensureCache 刷新同效）→ 3) 上传
  await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '"txt,pdf"' } })
  const drift = await fetch(`${BASE}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": "dockyard-cron-secret" }, body: JSON.stringify({ taskCode: "config_drift" }) })
  const driftJson = await drift.json()
  ok("config_drift 刷新缓存（漂移1项：allowedExtensions）", driftJson?.code === 0 && (driftJson?.msg || "").includes("1"), driftJson?.msg)
  const form = new FormData()
  form.append("files", new File([Buffer.from("hello")], "ok.txt", { type: "text/plain" }))
  form.append("files", new File([Buffer.from("bad")], "bad.exe", { type: "application/octet-stream" }))
  const ul = await fetch(`${BASE}/api/files/upload`, { method: "POST", headers: { cookie }, body: form })
  const ulJson = await ul.json()
  ok("上传：txt过 / exe白名单拒绝（配置真实生效）", ul.status === 200 && ulJson?.code === 0 && ulJson?.data?.uploaded?.length === 1 && ulJson?.data?.rejected?.[0]?.fileName === "bad.exe", JSON.stringify(ulJson?.data?.rejected))
  if (ulJson?.data?.uploaded?.[0]?.id) await db.fileMeta.delete({ where: { id: ulJson.data.uploaded[0].id } })
  await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '""' } })
  await fetch(`${BASE}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": "dockyard-cron-secret" }, body: JSON.stringify({ taskCode: "config_drift" }) })
  console.log(`\n== ✅ ${passed} / ❌ ${failed} ==`)
  await db.$disconnect()
  if (failed > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
