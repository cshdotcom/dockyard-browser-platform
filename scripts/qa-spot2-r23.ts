// 二轮抽检：封禁API通道（修正路由）/ 2FA UI 流 / 上传（admin 正常路径）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
const BASE = "http://localhost:3000"
let passed = 0, failed = 0
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}
let cookie = ""
async function login(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/auth/pre-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", username, password, remember: false }) })
  const json = await res.json().catch(() => null)
  if (!json || json.code !== 0) { console.log(`  [login ${username}]`, json?.msg); return false }
  const jar: string[] = []
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  for (const c of csrfRes.headers.getSetCookie?.() || []) jar.push(c.split(";")[0])
  const csrfJson = await csrfRes.json()
  const cb = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ ticket: json.data.ticket, csrfToken: csrfJson.csrfToken, json: "true" }),
    redirect: "manual",
  })
  for (const c of cb.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("dockyard-session") || kv.startsWith("next-auth")) jar.push(kv)
  }
  cookie = [...new Set(jar)].join("; ")
  return cookie.includes("dockyard-session")
}
async function main() {
  console.log("== 二轮抽检 ==")
  // 1. admin 登录（无失败计数 → 无验证码）
  const adminOk = await login("admin", "Admin@2026")
  ok("admin 登录（无验证码干扰）", adminOk)
  // 2. 文件上传全链路
  if (adminOk) {
    await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '"txt,pdf"' } })
    const form = new FormData()
    form.append("files", new File([Buffer.from("hello r23")], "qa2-r23.txt", { type: "text/plain" }))
    form.append("files", new File([Buffer.from("bad")], "qa2-r23.exe", { type: "application/octet-stream" }))
    const ul = await fetch(`${BASE}/api/files/upload`, { method: "POST", headers: { cookie }, body: form })
    const ulJson = await ul.json().catch(() => null)
    ok("上传：白名单 txt过/exe拒", ul.status === 200 && ulJson?.code === 0 && ulJson?.data?.uploaded?.length === 1 && ulJson?.data?.rejected?.length === 1, JSON.stringify(ulJson?.data?.rejected || ulJson?.msg))
    if (ulJson?.data?.uploaded?.[0]?.id) await db.fileMeta.delete({ where: { id: ulJson.data.uploaded[0].id } })
    await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '""' } })
  }
  // 3. 全局搜索（admin）
  if (adminOk) {
    const s2 = await fetch(`${BASE}/api/search?q=demo&types=user`, { headers: { cookie } })
    const j2 = await s2.json()
    ok("搜索 types=user 只回用户组", j2?.code === 0 && (j2?.data?.groups || []).every((g: { type: string }) => g.type === "user"), `types=${(j2?.data?.groups || []).map((g: { type: string }) => g.type).join(",")}`)
    const s3 = await fetch(`${BASE}/api/search?q=demo&from=2099-01-01`, { headers: { cookie } })
    const j3 = await s3.json()
    ok("搜索 from=未来 → 0", j3?.code === 0 && (j3?.data?.groups || []).length === 0)
  }
  console.log(`\n== ✅ ${passed} / ❌ ${failed} ==`)
  await db.$disconnect()
  if (failed > 0) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
