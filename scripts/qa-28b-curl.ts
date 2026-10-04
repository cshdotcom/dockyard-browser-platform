export {}

const BASE = "http://localhost:3000"

async function login(): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfJson = await csrfRes.json()
  const jar: string[] = []
  for (const c of csrfRes.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("next-auth.csrf-token")) jar.push(kv)
  }
  const pre = await fetch(`${BASE}/api/auth/pre-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ mode: "password", username: "admin", password: "Admin@2026", remember: false }),
  })
  const preJson = await pre.json()
  const cb = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ ticket: preJson.data.ticket, csrfToken: csrfJson.csrfToken, json: "true" }),
    redirect: "manual",
  })
  for (const c of cb.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("next-auth.session-token") || kv.startsWith("__Secure-next-auth.session-token") || kv.startsWith("dockyard-session")) jar.push(kv)
  }
  return jar.join("; ")
}

const cookie = await login()
let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? " " + extra : ""}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? " " + extra : ""}`) }
}

// ---- 页面可达性（含筛选参数） ----
for (const p of ["/admin/groups", "/admin/groups?enabled=false", "/admin/groups?enabled=true&keyword=运营", "/admin/groups?createdFrom=2020-01-01&createdTo=2099-12-31"]) {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie }, redirect: "manual" })
  ok(`GET ${p} → 200`, r.status === 200, `(实际 ${r.status})`)
}

// ---- CSV 导出 ----
const csv = await fetch(`${BASE}/api/export/groups?format=csv`, { headers: { cookie } })
const csvBytes = new Uint8Array(await csv.arrayBuffer())
const csvText = new TextDecoder("utf-8").decode(csvBytes)
ok("CSV 导出 200", csv.status === 200)
ok("RFC5987 中文文件名", (csv.headers.get("content-disposition") || "").includes("filename*=UTF-8''"))
ok("CSV BOM", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf)
ok("CSV 中文表头", csvText.startsWith("组名,描述,父组,启用,强制2FA,成员数,组管理员数,配额摘要,权限锁数,代理绑定数,标签,创建时间,组ID"))
console.log("  · CSV 全部内容（库中组数少）:\n" + csvText.split("\n").filter(Boolean).map((l) => "    " + l).join("\n"))

// CSV 按筛选导出（enabled=false：数据行启用列必须 false）
const csvF = await fetch(`${BASE}/api/export/groups?format=csv&enabled=false`, { headers: { cookie } })
const csvFText = new TextDecoder().decode(new Uint8Array(await csvF.arrayBuffer()))
const dataLines = csvFText.split("\n").filter((l) => l.trim() && !l.startsWith("组名,"))
ok("CSV 筛选导出 enabled=false 全为禁用组", dataLines.every((l) => l.includes(",false,")), `（${dataLines.length} 行）`)

// keyword 空结果（仅表头）
const csvK = await fetch(`${BASE}/api/export/groups?format=csv&keyword=不存在组xyz`, { headers: { cookie } })
const csvKText = new TextDecoder().decode(new Uint8Array(await csvK.arrayBuffer()))
ok("CSV keyword 筛选空结果仅表头", csvKText.trim().endsWith("组ID") && csvKText.split("\n").filter(Boolean).length === 1)

// JSON 导出兼容（默认 format）
const js = await fetch(`${BASE}/api/export/groups`, { headers: { cookie } })
const jsText = await js.text()
ok("JSON 导出兼容（默认）", js.status === 200 && jsText.includes("\"groups\":"), `total=${(jsText.match(/"total":(\d+)/) || [])[1]}`)

// ids 参数
const csvIds = await fetch(`${BASE}/api/export/groups?format=csv&ids=nonexistent-id-123`, { headers: { cookie } })
const csvIdsText = new TextDecoder().decode(new Uint8Array(await csvIds.arrayBuffer()))
ok("CSV ids 参数无效 id 仅表头", csvIdsText.split("\n").filter(Boolean).length === 1)

// ---- 无 cookie 鉴权拒绝（项目 apiHandler 统一 JSON 协议：HTTP 200 + code 40100，不 500） ----
const noAuthCsv = await fetch(`${BASE}/api/export/groups?format=csv`)
const noAuthCsvJson = await noAuthCsv.json().catch(() => null)
ok("无 cookie CSV → code 40100 拒绝", noAuthCsvJson?.code === 40100, `(${noAuthCsv.status} ${noAuthCsvJson?.code})`)
const noAuthJson = await fetch(`${BASE}/api/export/groups`)
const noAuthJsonBody = await noAuthJson.json().catch(() => null)
ok("无 cookie JSON → code 40100 拒绝", noAuthJsonBody?.code === 40100, `(${noAuthJson.status})`)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
