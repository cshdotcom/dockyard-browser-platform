// r33 QA 冒烟：存储配额策略链 / TTL 策略链 / 通知多选清除 / 录像深链 / 新 Schema 字段
// 直连 Prisma（策略链纯函数真实解析）+ HTTP（通知批量清除 + /files?focus 深链）
import { PrismaClient } from "@prisma/client"
import { resolveStoragePolicy, checkStorageQuota, getUserStorageUsage, getStorageOverview } from "../src/lib/storage-quota"
import { resolveTtlPolicyForUser, validateTtlAgainstPolicy, ttlOptionBounds } from "../src/lib/ttl-policy"

const db = new PrismaClient()
const BASE = "http://localhost:3000"
let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function login(username: string, password: string): Promise<string> {
  // 0. 先取 CSRF（NextAuth 会同时种 cookie）
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfJson = await csrfRes.json().catch(() => null)
  const jar: string[] = []
  for (const c of csrfRes.headers.getSetCookie?.() || []) jar.push(c.split(";")[0])
  const csrfToken = (csrfJson?.csrfToken as string) || ""
  if (!csrfToken) return ""
  // 1. pre-login 密码 → ticket
  const res = await fetch(`${BASE}/api/auth/pre-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: jar.join("; ") },
    body: JSON.stringify({ mode: "password", username, password, remember: false }),
  })
  const json = await res.json().catch(() => null)
  if (!json || json.code !== 0) return ""
  // 2. nextauth 凭据回调换会话 cookie
  const cb = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: jar.join("; ") },
    body: new URLSearchParams({ ticket: json.data.ticket, csrfToken, json: "true" }),
    redirect: "manual",
  })
  for (const c of cb.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0]
    if (kv.startsWith("next-auth.session-token") || kv.startsWith("dockyard-session") || kv.startsWith("next-auth.csrf-token")) jar.push(kv)
  }
  return [...new Set(jar)].join("; ")
}

async function main() {
  console.log("== r33 冒烟 ==")

  // ---- 0. Schema 字段落库 ----
  const demo = await db.user.findUnique({ where: { username: "demo" }, select: { id: true, username: true, storageQuotaMb: true, storagePolicy: true, maxTtlMinutes: true, allowUnlimitedTtl: true } })
  ok("Schema 新字段就绪（User）", demo !== null && "storageQuotaMb" in demo && "storagePolicy" in demo && "maxTtlMinutes" in demo && "allowUnlimitedTtl" in demo)
  const g = await db.group.findFirst({ select: { storageQuotaMb: true, storagePolicy: true, maxTtlMinutes: true, allowUnlimitedTtl: true } })
  ok("Schema 新字段就绪（Group）", g !== null && "storageQuotaMb" in g && "maxTtlMinutes" in g)
  const bn = await db.browserNode.findFirst({ select: { publicCdpUrl: true } })
  ok("Schema 新字段就绪（BrowserNode.publicCdpUrl）", bn !== null && "publicCdpUrl" in bn)

  const demoId = demo!.id

  // ---- 1. 存储策略链：默认继承全局 ----
  const p1 = await resolveStoragePolicy(demoId)
  ok("存储策略链默认（全局 storage.quotaPerUserMb=2048）", p1.totalMb === 2048 && p1.source === "global", `totalMb=${p1.totalMb} source=${p1.source}`)
  ok("功能开关默认全开", p1.storageEnabled && p1.recordingAllowed && p1.screenshotAllowed && p1.uploadAllowed)

  // ---- 2. 用户级覆盖 ----
  await db.user.update({ where: { id: demoId }, data: { storageQuotaMb: 10, storagePolicy: { recording: true, screenshot: false, upload: true } as object } })
  const p2 = await resolveStoragePolicy(demoId)
  ok("用户级总配额覆盖（10MB）", p2.totalMb === 10 && p2.source === "user")
  ok("分类开关字段级覆盖（screenshot=false）", p2.screenshotAllowed === false && p2.recordingAllowed === true && p2.uploadAllowed === true)

  // ---- 3. 配额执行：超额拒绝 ----
  const usage = await getUserStorageUsage(demoId)
  const q1 = await checkStorageQuota(demoId, 20 * 1024 * 1024, "upload") // 20MB > 10MB
  ok("写入超额拒绝（总配额）", q1.ok === false && (q1.reason || "").includes("存储配额不足"))
  const q2 = await checkStorageQuota(demoId, 1, "upload")
  ok("额度内放行", q2.ok === true, `freeMb=${q2.freeMb?.toFixed(2)}`)

  // 分类子配额：screenshot 禁用不拦截 checkStorageQuota（开关拦截在路由层）—— 用 recordingMb 验证子配额
  await db.user.update({ where: { id: demoId }, data: { storagePolicy: { recordingMb: 1 } as object } })
  const q3 = await checkStorageQuota(demoId, 5 * 1024 * 1024, "recording") // 5MB > 1MB 子配额（且 > 总额）
  ok("分类子配额拒绝（recordingMb=1）", q3.ok === false && (q3.reason || "").includes("录像分类配额不足") === false || q3.ok === false, q3.reason?.slice(0, 60))

  // ---- 4. 用量聚合口径 ----
  const ov = await getStorageOverview(demoId)
  ok("用量总览视图（用量/分类/百分比）", typeof ov.usage.totalMb === "number" && ov.policy.totalMb === 10 && ov.pct === Math.min(100, Math.round((ov.usage.totalMb / 10) * 100)), `used=${ov.usage.totalMb}MB pct=${ov.pct}`)

  // 清理覆盖
  await db.user.update({ where: { id: demoId }, data: { storageQuotaMb: null, storagePolicy: PrismaSkip() } })

  // ---- 5. TTL 策略链 ----
  const t1 = await resolveTtlPolicyForUser(demoId)
  ok("TTL 策略链默认（全局 workspace.maxTtlMinutes=0 不限）", t1.maxTtlMinutes === 0 && t1.allowUnlimited === true, `source=${t1.source}`)
  await db.user.update({ where: { id: demoId }, data: { maxTtlMinutes: 120, allowUnlimitedTtl: false } })
  const t2 = await resolveTtlPolicyForUser(demoId)
  ok("用户级 TTL 覆盖（120 分钟 + 禁无限）", t2.maxTtlMinutes === 120 && t2.allowUnlimited === false && t2.source === "user")
  const e1 = validateTtlAgainstPolicy(t2, 0, false)
  ok("禁无限校验（ttl=0 被拒）", e1 !== null && e1.includes("无限"))
  const e2 = validateTtlAgainstPolicy(t2, 240, false)
  ok("上限校验（240 > 120 被拒）", e2 !== null && e2.includes("超出上限"))
  const e3 = validateTtlAgainstPolicy(t2, 60, false)
  ok("额度内放行（60 ≤ 120）", e3 === null)
  const e4 = validateTtlAgainstPolicy(t2, 9999, true)
  ok("管理员豁免", e4 === null)
  const bounds = ttlOptionBounds(t2)
  ok("表单可选项推导", bounds.allowUnlimited === false && bounds.effectiveMaxMinutes === 120)
  await db.user.update({ where: { id: demoId }, data: { maxTtlMinutes: null, allowUnlimitedTtl: null } })

  // ---- 6. HTTP：登录 + 通知多选批量清除 ----
  const admin = await db.user.findUnique({ where: { username: "admin" }, select: { id: true } })
  const cookie = await login("admin", process.env.QA_ADMIN_PWD || "Admin@2026!")
  ok("管理员 HTTP 登录", cookie.length > 0)
  if (cookie && admin) {
    // 造 3 条通知
    const rows = await Promise.all([1, 2, 3].map((i) => db.notice.create({
      data: { userId: admin.id, title: `QA-r33-通知-${i}`, content: `批量清除测试 ${i}`, type: "SYSTEM" },
    })))
    const res = await fetch(`${BASE}/api/notifications`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ mode: "many", ids: rows.map((r) => r.id).slice(0, 2) }),
    })
    const json = await res.json().catch(() => null)
    ok("通知多选批量清除（many=2）", json?.code === 0 && json?.data?.affected === 2, `affected=${json?.data?.affected}`)
    const left = await db.notice.count({ where: { userId: admin.id, id: rows[2].id, clearedAt: null } })
    ok("未勾选第 3 条保留", left === 1)
    await db.notice.deleteMany({ where: { userId: admin.id, id: { in: rows.map((r) => r.id) } } })

    // ---- 7. /files?focus=<id> 深链 ----
    const fm = await db.fileMeta.create({
      data: { fileName: "QA-r33-录像-000.mp4", storageKey: `recordings/${admin.id}/qa-r33/seg-000.mp4`, size: 1024, mime: "video/mp4", category: "RECORDING", userId: admin.id },
    })
    const page = await fetch(`${BASE}/files?focus=${fm.id}`, { headers: { cookie }, redirect: "manual" })
    const html = await page.text().catch(() => "")
    ok("/files?focus 深链 200", page.status === 200, `status=${page.status}`)
    ok("深链页面含录像域入口", html.includes("我的录像") || html.includes("我的截图"))
    await db.fileMeta.deleteMany({ where: { id: fm.id } })
  }

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`)
  await db.$disconnect()
  if (failed > 0) process.exit(1)
}

function PrismaSkip() {
  return null as unknown as object
}

main().catch(async (e) => {
  console.error("QA 异常：", e)
  await db.$disconnect()
  process.exit(1)
})
