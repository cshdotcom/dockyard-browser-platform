// r40 真实 Worker 打印代理端到端实测
// 流程：起 mini-services/worker（fake 打印机模式）→ 自动上报打印机池
//   → 创建打印任务 → 心跳领取指令 → 下载校验 → 自动模拟打印 → 状态 PRINTED
//   → 验证 worker health 端点（printOnly/lastPrinterSync）
// 这是"客户端打印代理"部署形态的真实运行验证（非直调库函数）
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

const BASE = "http://localhost:3000"
const results: Array<[string, boolean, string]> = []
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

async function login(username: string, password: string): Promise<string> {
  const pre = await fetch(BASE + "/api/auth/pre-login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", username, password }),
  })
  const preBody = await pre.json()
  const csrfRes = await fetch(BASE + "/api/auth/csrf", { cache: "no-store" })
  const csrf = (await csrfRes.json())?.csrfToken
  const csrfCookie = (csrfRes.headers.get("set-cookie") || "").split(";")[0]
  const signInRes = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
    body: new URLSearchParams({ ticket: preBody.data.ticket, csrfToken: csrf, json: "true" }).toString(),
    redirect: "manual",
  })
  return (signInRes.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { db } = await import("/home/z/my-project/src/lib/db")
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  const nodeUuid = "wn-" + createHash("sha256").update("qa-r40-node").digest("hex").slice(0, 16)
  const nodeKey = "wak-" + createHash("sha256").update("qa-r40-key").digest("hex").slice(0, 48)
  const apiKeyHash = createHash("sha256").update(nodeKey).digest("hex")

  // 1. 起 Worker（fake 打印机模式 + 快心跳 5s 加速测试）
  const worker = spawn("bun", ["mini-services/worker/index.ts"], {
    cwd: "/home/z/my-project",
    env: {
      ...process.env,
      MASTER_API_URL: BASE,
      WORKER_NODE_UUID: nodeUuid,
      WORKER_API_KEY: nodeKey,
      WORKER_FAKE_PRINTERS: "HP LaserJet 4050 Live;Canon PIXMA Live",
      WORKER_HEARTBEAT_SEC: "5",
      WORKER_PRINTER_SYNC_SEC: "20",
      WORKER_HEALTH_PORT: "3008",
      WORKER_PRINT_CLIENT_TAG: "qa-live-agent",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let workerLog = ""
  worker.stdout.on("data", (d) => { const s = d.toString(); workerLog += s; console.log("  [worker] " + s.trim().split("\n").join("\n  [worker] ")) })
  worker.stderr.on("data", (d) => { workerLog += d.toString() })

  try {
    // 2. 等打印机上报（启动 3s 延迟 + 上报）
    let printers: { id: string; name: string }[] = []
    for (let i = 0; i < 15; i++) {
      await sleep(2000)
      printers = await db.remotePrinter.findMany({ where: { nodeUuid, status: "ONLINE" }, select: { id: true, name: true } })
      if (printers.length >= 2) break
    }
    check("W1 真实 Worker 自动上报 2 台打印机", printers.length >= 2, printers.map((p) => p.name).join(" / "))
    const hp = printers.find((p) => p.name.includes("HP")) || printers[0]

    // 3. worker health 端点
    const health = await (await fetch("http://localhost:3008/health")).json().catch(() => null)
    check("W2 Worker health 端点（printOnly/lastPrinterSync）", !!health?.ok && "lastPrinterSync" in health && health.printOnly === false, `v=${health?.version} sync=${String(health?.lastPrinterSync).slice(0, 19)}`)

    // 4. 创建打印任务（silent → fake 打印机自动打印）
    const cookie = await login("admin", "Admin@2026")
    const { createSession } = await import("/home/z/my-project/src/lib/external/browser-session")
    const session = await createSession({})
    const wsRow = await db.browserWorkspace.create({
      data: {
        name: "QA-r40-live-沙箱", mode: "cdp_light", status: "RUNNING",
        startedAt: new Date(), lastActiveAt: new Date(), userId: admin!.id,
        browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, ttlMinutes: 60,
        createdByUserId: admin!.id,
      },
    })
    check("W3 测试沙箱就绪", !!wsRow.id)
    const wsId = wsRow.id
    const createRes = await fetch(BASE + "/api/print/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ workspaceId: wsId, printerId: hp.id, deliverMode: "silent", copies: 2, duplex: "duplex" }),
    })
    const created = await createRes.json().catch(() => null)
    check("W4 创建打印任务", createRes.status === 200 && created?.code === 0, `${created?.data?.jobNo || ""}`)
    const jobId = created?.data?.jobId as string

    // 5. 等待 worker 心跳领取 + 自动打印（fake 1.2s 模拟）
    let finalStatus = ""
    let finalError = ""
    for (let i = 0; i < 24; i++) {
      await sleep(2500)
      const j = await db.printJob.findUnique({ where: { id: jobId }, select: { status: true, error: true } })
      finalStatus = j?.status || ""
      finalError = j?.error || ""
      if (["PRINTED", "FAILED", "TIMED_OUT", "CANCELED"].includes(finalStatus)) break
    }
    check("W5 Worker 领取 → 下载校验 → 自动打印 → PRINTED", finalStatus === "PRINTED", `status=${finalStatus} err=${finalError.slice(0, 60)}`)

    // 6. worker 日志实证（下载 + 模拟打印完成日志）
    check("W6 Worker 日志含下载与打印事件", workerLog.includes("sha256") || workerLog.includes("模拟打印完成") || workerLog.includes("已提交打印"), workerLog.split("\n").filter((l) => l.includes("print-agent") || l.includes("print.dispatch")).slice(-2).join(" | ").slice(0, 120))

    // 7. 指令回执（worker 心跳回传 results → WorkNodeCommand doneAt）
    let cmdDone = false
    for (let i = 0; i < 10; i++) {
      await sleep(3000)
      const cmd = await db.workNodeCommand.findFirst({
        where: { nodeUuid, cmd: "print.dispatch", payloadJson: { contains: `"jobId":"${jobId}"` } },
        orderBy: { createdAt: "desc" },
      })
      if (cmd?.doneAt) { cmdDone = true; break }
    }
    check("W7 指令回执闭环（results 回传 → doneAt）", cmdDone)

    // 8. dialog 模式验证（无图形环境 → 自动降级 lp 失败 或 fake 直接模拟）
    // fake 打印机在 dialog 模式也走自动模拟（isFake 分支）
    const dRes = await fetch(BASE + "/api/print/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ workspaceId: wsId, printerId: hp.id, deliverMode: "dialog" }),
    })
    const dCreated = await dRes.json().catch(() => null)
    const dJobId = dCreated?.data?.jobId as string
    let dStatus = ""
    for (let i = 0; i < 24; i++) {
      await sleep(2500)
      const j = await db.printJob.findUnique({ where: { id: dJobId }, select: { status: true } })
      dStatus = j?.status || ""
      if (["PRINTED", "FAILED", "TIMED_OUT", "CANCELED"].includes(dStatus)) break
    }
    check("W8 dialog 模式（fake 打印机 → 引导页 + 自动模拟打印）", dStatus === "PRINTED", `status=${dStatus}`)

    // 清理本测试任务
    await db.printJob.deleteMany({ where: { id: { in: [jobId, dJobId] } } })
    try { await db.browserWorkspace.update({ where: { id: wsId }, data: { status: "STOPPED" } }) } catch { /* ignore */ }
  } finally {
    worker.kill("SIGTERM")
    await sleep(1500)
  }

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[qa-r40-worker-live] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error("[qa-r40-worker-live] FATAL:", e); process.exit(1) })
