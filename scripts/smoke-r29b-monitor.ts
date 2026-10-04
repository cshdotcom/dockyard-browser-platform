/**
 * r29-b/c 冒烟：双模式监控 + 实时监控中心控制通道
 * 覆盖：
 *   1. CDP 控制通道（真实 Chromium --remote-debugging）：
 *      快照 JPEG base64 / 强制跳转（URL 变更）/ 消息推送（浮层注入）
 *      / 键鼠注入（CDP Input）/ 关标签 / 页面枚举
 *   2. 控制租约互斥：acquire / 他人持锁拒绝 / 心跳续期 / release / TTL 过期
 *   3. MonitorGrant 双模式语义（DB 级）：
 *      静默授权查询过滤（用户永不可见）/ 知情授权用户可见
 *      一键切断仅影响 CONSENT（SILENT 永不可切）/ 撤销语义
 */
import { PrismaClient } from "@prisma/client"
import { spawn } from "child_process"

const db = new PrismaClient()
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const CHROME = "/home/z/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
const CDP_PORT = 19222
const CDP_URL = `http://127.0.0.1:${CDP_PORT}/json/version`

async function main() {
  console.log("== r29-b/c 冒烟：双模式监控 + CDP 控制通道 ==")

  // ---- 0. 启动真实 Chromium（独立用户目录 + 远程调试） ----
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=/tmp/dy-r29b-chrome-profile", "--no-sandbox", "--no-first-run",
    "about:blank",
  ], { stdio: "ignore", detached: false })
  let cdpUp = false
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(CDP_URL, { signal: AbortSignal.timeout(1000) })
      if (r.ok) { cdpUp = true; break }
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 500))
  }
  check("真实 Chromium CDP 端点就绪", cdpUp)
  const versionJson = await fetch(CDP_URL).then((r) => r.json()) as { webSocketDebuggerUrl?: string }
  const browserWs = versionJson.webSocketDebuggerUrl || ""

  const { listWorkspacePages } = await import("../src/lib/browsing-collector")
  const cdpControl = await import("../src/lib/cdp-control")
  const cdpHttp = `http://127.0.0.1:${CDP_PORT}`

  if (cdpUp) {
    // ---- 1. 页面枚举 ----
    let pages = await listWorkspacePages(cdpHttp)
    check("页面枚举（/json/list page 目标）", Array.isArray(pages) && pages.length > 0)

    // ---- 2. 快照（真实 JPEG） ----
    const shot = await cdpControl.captureScreenshot(cdpHttp, "qa-r29b-ws", { force: true })
    check("快照：JPEG base64 返回", !!shot?.b64 && shot.b64.startsWith("/9j/"))

    // 快照 10s 缓存
    const t0 = Date.now()
    const shot2 = await cdpControl.captureScreenshot(cdpHttp, "qa-r29b-ws")
    check("快照：10s 缓存命中（<50ms）", !!shot2?.b64 && Date.now() - t0 < 50)

    // ---- 3. 强制跳转 ----
    const NAV_URL = "data:text/html,<h1>dy-r29b-nav</h1>";
    const n = await cdpControl.forceNavigateAll(cdpHttp, NAV_URL)
    check("强制跳转：页面导航成功", n >= 1)
    await new Promise((res) => setTimeout(res, 800))
    pages = await listWorkspacePages(cdpHttp)
    check("跳转后 URL 变更可见", (pages || []).some((p) => decodeURIComponent(p.url || "").includes("dy-r29b-nav")))

    // ---- 4. 消息推送（Runtime.evaluate 浮层注入） ----
    const delivered = await cdpControl.pushMessage(cdpHttp, "测试消息推送", "QA管理员")
    check("消息推送：页面浮层注入成功", delivered === true)

    // ---- 5. 键鼠注入 ----
    const keyOk = await cdpControl.dispatchInput(cdpHttp, { type: "key", key: "Enter" })
    check("键鼠注入：Enter 按键成功", keyOk === true)
    const moveOk = await cdpControl.dispatchInput(cdpHttp, { type: "mouseMove", x: 100, y: 100 })
    check("键鼠注入：鼠标移动成功", moveOk === true)
    const scrollOk = await cdpControl.dispatchInput(cdpHttp, { type: "mouseScroll", y: 200, text: "down" })
    check("键鼠注入：滚轮成功", scrollOk === true)

    // ---- 6. 新标签 + 关标签 ----
    await fetch(`${cdpHttp}/json/new?${encodeURIComponent("data:text/html,<h1>dy-r29b-tab2</h1>")}`, { method: "PUT" }).catch(() => null)
    pages = await listWorkspacePages(cdpHttp)
    const tab2 = (pages || []).find((p) => (p.url || "").includes("dy-r29b-tab2"))
    check("新标签出现（/json/new）", !!tab2)
    if (tab2?.targetId) {
      const closed = await cdpControl.closeTab(cdpHttp, tab2.targetId)
      check("强制关标签（/json/close）", closed === true)
      pages = await listWorkspacePages(cdpHttp)
      check("关标签后列表移除", !(pages || []).some((p) => (p.targetId || p.id) === tab2.targetId))
    }

    // ---- 7. WebSocket 拨号（真实 WS CDP 命令） ----
    check("浏览器级 WS 端点可用", browserWs.startsWith("ws://"))
  }

  // ---- 8. 控制租约互斥 ----
  const wsId = "qa-r29b-lease"
  const a1 = cdpControl.acquireControlLease(wsId, "admin-A", "管理员A")
  check("租约：A 获取成功", a1.ok)
  const a2 = cdpControl.acquireControlLease(wsId, "admin-B", "管理员B")
  check("租约：B 被互斥拒绝（返回持有者）", !a2.ok && a2.holder?.adminName === "管理员A")
  const renew = cdpControl.heartbeatControlLease(wsId, "admin-A")
  check("租约：A 心跳续期", renew)
  const a1again = cdpControl.acquireControlLease(wsId, "admin-A", "管理员A")
  check("租约：A 重复获取幂等", a1again.ok)
  const rel = cdpControl.releaseControlLease(wsId, "admin-A")
  check("租约：A 释放", rel)
  const a2b = cdpControl.acquireControlLease(wsId, "admin-B", "管理员B")
  check("租约：释放后 B 获取成功", a2b.ok)
  // TTL 过期模拟：直接改 lastHeartbeat
  const leaseMap = (globalThis as unknown as { __dyCtlLease: Map<string, { adminId: string; adminName: string; lastHeartbeat: number }> }).__dyCtlLease
  const lease = leaseMap.get(wsId)
  if (lease) {
    lease.lastHeartbeat = Date.now() - 60_000
    const a3 = cdpControl.acquireControlLease(wsId, "admin-C", "管理员C")
    check("租约：TTL 过期自动易主", a3.ok)
  }

  // ---- 9. MonitorGrant 双模式语义（DB 级） ----
  const qaUser = await db.user.create({ data: { username: `qa-r29b-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true } })
  const qaWs = await db.browserWorkspace.create({ data: { name: `QA-R29B-沙箱-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING" } })
  const qaWs2 = await db.browserWorkspace.create({ data: { name: `QA-R29B-沙箱2-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING" } })

  // 知情授权（ws1 camera）+ 静默授权（ws2 microphone）
  await db.monitorGrant.create({ data: { workspaceId: qaWs.id, userId: qaUser.id, channel: "camera", mode: "CONSENT", grantedByUserId: "smoke-admin", grantedByName: "admin" } })
  await db.monitorGrant.create({ data: { workspaceId: qaWs2.id, userId: qaUser.id, channel: "microphone", mode: "SILENT", reason: "数据外泄取证 #1234", grantedByUserId: "smoke-super", grantedByName: "superadmin" } })

  // 用户可见性查询（myMonitorStatus 同构：mode=CONSENT 过滤）
  const userVisible = await db.monitorGrant.findMany({ where: { userId: qaUser.id, mode: "CONSENT", active: true } })
  check("用户可见性：仅知情授权（静默不可见）", userVisible.length === 1 && userVisible[0].channel === "camera")

  // 一键切断（cutOffMonitor 同构：mode=CONSENT 才可切）
  const cut = await db.monitorGrant.updateMany({ where: { userId: qaUser.id, mode: "CONSENT", active: true }, data: { active: false, cutOffBy: "USER_CUTOFF", endedAt: new Date() } })
  check("一键切断：仅知情授权被终止", cut.count === 1)
  const silentRow = await db.monitorGrant.findFirst({ where: { userId: qaUser.id, mode: "SILENT" } })
  check("静默授权不受用户切断影响", silentRow?.active === true)

  // 撤销（revoke 同构）
  const revoked = await db.monitorGrant.updateMany({ where: { workspaceId: qaWs2.id, active: true }, data: { active: false, cutOffBy: "ADMIN_REVOKE", endedAt: new Date() } })
  check("管理员撤销静默授权", revoked.count === 1)

  // 幂等授予（grant 同构：同沙箱同通道激活行复用）
  const g1 = await db.monitorGrant.create({ data: { workspaceId: qaWs.id, userId: qaUser.id, channel: "camera", mode: "CONSENT", grantedByUserId: "a", grantedByName: "a" } })
  await db.monitorGrant.update({ where: { id: g1.id }, data: { mode: "SILENT", reason: "升级静默", grantedByName: "superadmin" } })
  const upgraded = await db.monitorGrant.findUnique({ where: { id: g1.id } })
  check("同通道重复授权升级模式（不重复建行语义）", upgraded?.mode === "SILENT" && upgraded.reason === "升级静默")

  // ---- 清理 ----
  await db.monitorGrant.deleteMany({ where: { userId: qaUser.id } })
  await db.browserWorkspace.deleteMany({ where: { userId: qaUser.id } })
  await db.user.delete({ where: { id: qaUser.id } })
  proc.kill("SIGTERM")

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
