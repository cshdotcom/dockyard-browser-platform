// r23 主代理核心链路抽检：2FA后端强制 / IP封禁 / 文件上传 / 全局搜索 / cron到期 / host_probe真实指标
// 通过 HTTP + Cookie 会话直连 dev 服务器，断言全链路真实行为
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
const BASE = "http://localhost:3000"
const CRON_SECRET = process.env.CRON_SECRET || "dev-cron-secret-please-change"

let cookie = ""
let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function login(username: string, password: string): Promise<boolean> {
  // pre-login 密码登录 → ticket → 回调换会话 cookie
  const res = await fetch(`${BASE}/api/auth/pre-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", username, password, remember: false }),
  })
  const json = await res.json().catch(() => null)
  if (!json || json.code !== 0) {
    console.log(`  [login ${username}] pre-login 失败:`, json?.msg || res.status)
    return false
  }
  const setCookies = res.headers.getSetCookie?.() || []
  const csrf = setCookies.find((c) => c.startsWith("next-auth.csrf-token="))?.split(";")[0]
  const jar: string[] = []
  if (csrf) jar.push(csrf)
  // nextauth 回调
  const cb = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(jar.length ? { cookie: jar.join("; ") } : {}) },
    body: new URLSearchParams({ ticket: json.data.ticket, csrfToken: decodeURIComponent(csrf?.split("=")[1] || ""), json: "true" }),
    redirect: "manual",
  })
  for (const c of cb.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("next-auth.session-token") || kv.startsWith("dockyard-session") || kv.startsWith("next-auth.csrf-token")) jar.push(kv)
  }
  cookie = [...new Set(jar)].join("; ")
  return cookie.includes("dockyard-session")
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init?.headers || {}), cookie }, redirect: "manual" })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  console.log("== r23 主代理核心链路抽检 ==")

  // ---- 1. IP 封禁（登录连续失败 → 封禁 → 正确密码也被拒） ----
  console.log("\n[1] IP 自动封禁（阈值调至3快速验证）")
  await db.systemConfig.update({ where: { key: "security.ipBanEnabled" }, data: { valueJson: "true" } })
  await db.systemConfig.update({ where: { key: "security.ipBanThreshold" }, data: { valueJson: "3" } })
  await db.systemConfig.update({ where: { key: "security.ipBanMinutes" }, data: { valueJson: "2" } })
  ;(globalThis as any).__dockyardConfig = undefined
  const testIp = "198.51.100.77"
  await db.ipBanRecord.deleteMany({ where: { ip: testIp } })
  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE}/api/auth/pre-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
      body: JSON.stringify({ mode: "password", username: "admin", password: "WrongPassword!123" }),
    })
  }
  const banRow = await db.ipBanRecord.findUnique({ where: { ip: testIp } })
  ok("连续失败3次触发封禁落库", !!banRow?.bannedUntil && banRow.bannedUntil > new Date(), `failCount=${banRow?.failCount}`)
  const bannedLogin = await fetch(`${BASE}/api/auth/pre-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": testIp },
    body: JSON.stringify({ mode: "password", username: "admin", password: "Admin@2026" }),
  })
  const bannedJson = await bannedLogin.json()
  ok("封禁期间正确密码也被拒(46002)", bannedJson.code === 46002, bannedJson.msg)
  // API-Key 通道同样被封
  const bannedKey = await fetch(`${BASE}/api/mcp/status`, { headers: { "x-api-key": "dyk-invalid-key-test", "x-forwarded-for": testIp } })
  ok("封禁期间无效Key API 调用被拒(403)", bannedKey.status === 403)
  // 清理 + 恢复阈值
  await db.ipBanRecord.deleteMany({ where: { ip: testIp } })
  await db.systemConfig.update({ where: { key: "security.ipBanThreshold" }, data: { valueJson: "10" } })
  await db.systemConfig.update({ where: { key: "security.ipBanMinutes" }, data: { valueJson: "30" } })
  ;(globalThis as any).__dockyardConfig = undefined

  // ---- 2. 2FA 后端强制（demo 命中强制策略 → 写操作真拒绝） ----
  console.log("\n[2] 2FA 后端门控（requireWritableMode 真拦截）")
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  if (demo) {
    const prev2fa = demo.force2faSetup
    await db.user.update({ where: { id: demo.id }, data: { force2faSetup: true, twoFactorEnabled: false } })
    const loggedIn = await login("demo", "Demo@2026")
    ok("demo 登录成功（FORCE_SETUP 票据通道）", loggedIn)
    if (loggedIn) {
      // 写操作应被拒（创建工作区）
      const createRes = await api("/api/openapi/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "QA-2FA-BLOCKED", mode: "cdp_light" }),
      })
      ok("写操作被 2FA 门控拒绝", createRes.json?.code === 40300 || createRes.json?.msg?.includes("2FA") || createRes.json?.msg?.includes("双因素"), JSON.stringify(createRes.json).slice(0, 120))
      // 读操作（列表查询走页面正常）—— API 读不拦但页面层拦截；此处验证搜索 API 可用（读）
      const searchRes = await api("/api/search?q=demo")
      ok("读 API（搜索）不受 2FA 门控影响", searchRes.json?.code === 0)
    }
    await db.user.update({ where: { id: demo.id }, data: { force2faSetup: prev2fa } })
  } else {
    console.log("  ⚠️ demo 用户不存在，跳过")
  }

  // ---- 3. 文件上传（404 修复 + storage 配置生效） ----
  console.log("\n[3] 文件上传路由 + storage.* 配置")
  const adminOk = await login("admin", "Admin@2026")
  ok("admin 登录", adminOk)
  if (adminOk) {
    // 设白名单 + 保留期
    await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '"txt,pdf"' } })
    await db.systemConfig.update({ where: { key: "storage.retentionDays" }, data: { valueJson: "7" } })
    ;(globalThis as any).__dockyardConfig = undefined
    const form = new FormData()
    form.append("files", new File([Buffer.from("hello r23")], "qa-r23.txt", { type: "text/plain" }))
    form.append("files", new File([Buffer.from("bad")], "qa-r23.exe", { type: "application/octet-stream" }))
    const ul = await fetch(`${BASE}/api/files/upload`, { method: "POST", headers: { cookie }, body: form })
    const ulJson = await ul.json().catch(() => null)
    ok("上传 200 且白名单生效（txt 过 / exe 拒）", ul.status === 200 && ulJson?.code === 0 && ulJson?.data?.uploaded?.length === 1 && ulJson?.data?.rejected?.length === 1, JSON.stringify(ulJson?.data?.rejected))
    if (ulJson?.data?.uploaded?.[0]?.id) {
      const meta = await db.fileMeta.findUnique({ where: { id: ulJson.data.uploaded[0].id } })
      ok("retentionDays=7 写入 expireAt", !!meta?.expireAt && (meta.expireAt.getTime() - Date.now()) < 7.05 * 86400_000)
      await db.fileMeta.delete({ where: { id: ulJson.data.uploaded[0].id } })
    }
    await db.systemConfig.update({ where: { key: "storage.allowedExtensions" }, data: { valueJson: '""' } })
    ;(globalThis as any).__dockyardConfig = undefined
  }

  // ---- 4. 全局搜索（类型/日期/权限） ----
  console.log("\n[4] 全局搜索增强")
  if (adminOk) {
    const s1 = await api("/api/search?q=demo")
    ok("关键词搜索返回分组", s1.json?.code === 0 && Array.isArray(s1.json?.data?.groups))
    const s2 = await api("/api/search?q=demo&types=user")
    const onlyUser = (s2.json?.data?.groups || []).every((g: { type: string }) => g.type === "user")
    ok("types=user 只返回用户组", s2.json?.code === 0 && onlyUser, `groups=${(s2.json?.data?.groups || []).map((g: { type: string; group: string }) => g.type).join(",")}`)
    const s3 = await api("/api/search?q=demo&from=2099-01-01")
    ok("from=未来 → 0 结果", s3.json?.code === 0 && (s3.json?.data?.groups || []).length === 0)
  }

  // ---- 5. cron 到期触发 + host_probe 真实指标 ----
  console.log("\n[5] cron 到期调度 + 真实资源采集")
  const cronRes = await fetch(`${BASE}/api/cron?task=host_probe`, { headers: { "x-cron-secret": CRON_SECRET } })
  const cronJson = await cronRes.json().catch(() => null)
  ok("手动指定任务执行 OK", cronJson?.code === 0, cronJson?.data?.results?.[0]?.message?.slice(0, 80))
  const host = await db.hostNode.findFirst()
  ok("HostNode 已写入真实指标（CPU/内存/磁盘）", !!host && host.cpuUsedPct >= 0 && host.memUsedMb > 0 && host.diskUsedPct > 0, `CPU=${host?.cpuUsedPct}% MEM=${host?.memUsedMb}/${host?.memTotalMb}MB DISK=${host?.diskUsedPct}%`)
  // 到期判定：GET task=all 只执行到期任务（非强制）
  const dueRes = await fetch(`${BASE}/api/cron?task=all`, { headers: { "x-cron-secret": CRON_SECRET } })
  const dueJson = await dueRes.json().catch(() => null)
  ok("到期判定接口（due 列表结构）", dueJson?.code === 0 && Array.isArray(dueJson?.data?.due), `due=${(dueJson?.data?.due || []).length} executed=${dueJson?.data?.executed}`)
  const secRes = await fetch(`${BASE}/api/cron`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET }, body: JSON.stringify({ taskCode: "config_drift" }) })
  const secJson = await secRes.json().catch(() => null)
  ok("POST 手动执行 config_drift", secJson?.code === 0, secJson?.msg?.slice(0, 60))

  console.log(`\n== 抽检结束：✅ ${passed} / ❌ ${failed} ==`)
  await db.$disconnect()
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
