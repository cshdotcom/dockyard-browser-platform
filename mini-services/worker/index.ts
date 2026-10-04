#!/usr/bin/env bun
// ============================================================
// Dockyard Worker 纯净工作节点（r29）
// 定位：纯执行节点 —— 无业务数据库 / 无后台管理 / 无自主决策权限
// ⚠️ 启动强制校验三环境变量（缺任意一项直接退出进程、拒绝启动）
// ============================================================

import { createServer } from "http"
import { execFile } from "child_process"
import { readFileSync } from "fs"
import { handleFileCommand } from "./file-commands"

const MASTER_API_URL = process.env.MASTER_API_URL || ""
const WORKER_NODE_UUID = process.env.WORKER_NODE_UUID || ""
const WORKER_API_KEY = process.env.WORKER_API_KEY || ""

// r36：指令执行结果回传队列（内存环；随下次心跳上报主控 → WorkNodeCommand.doneAt）
const pendingResults: Array<{ cmdId: string; ok: boolean; error?: string; data?: unknown }> = []

const missing: string[] = []
if (!MASTER_API_URL) missing.push("MASTER_API_URL")
if (!WORKER_NODE_UUID) missing.push("WORKER_NODE_UUID")
if (!WORKER_API_KEY) missing.push("WORKER_API_KEY")
if (missing.length > 0) {
  console.error(`[worker] FATAL: 缺少必需环境变量 ${missing.join(" / ")} —— 拒绝启动`)
  process.exit(1)
}
if (!/^wn-[a-f0-9]{16}$/.test(WORKER_NODE_UUID)) {
  console.error("[worker] FATAL: WORKER_NODE_UUID 格式非法")
  process.exit(1)
}

const HEARTBEAT_SEC = Number(process.env.WORKER_HEARTBEAT_SEC || 10)
const VERSION = "worker-1.2.0-r36"

async function collectMetrics(): Promise<Record<string, number | string>> {
  const os = await import("os")
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const load = os.loadavg()[0]
  const cpuCount = os.cpus().length
  const cpuUsage = Math.min(100, (load / cpuCount) * 100)

  const disk = await new Promise<{ usedPct: number; freeMb: number }>((res) => {
    execFile("df", ["-P", process.cwd()], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) { res({ usedPct: 0, freeMb: 0 }); return }
      const line = stdout.trim().split("\n")[1]
      if (!line) { res({ usedPct: 0, freeMb: 0 }); return }
      const parts = line.split(/\s+/)
      const used = Number(parts[2]) || 0
      const avail = Number(parts[3]) || 0
      const total = used + avail
      res({ usedPct: total > 0 ? (used / total) * 100 : 0, freeMb: Math.round(avail / 1024) })
    })
  })

  const sandboxCount = await new Promise<number>((res) => {
    execFile("sh", ["-c", "ps -eo args | grep -c '[d]y-browser-' || true"], { timeout: 3000 }, (err, stdout) => {
      res(Number(String(stdout || "").trim()) || 0)
    })
  })

  return {
    cpu: Math.round(cpuUsage * 10) / 10,
    mem: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
    disk: Math.round(disk.usedPct * 10) / 10,
    diskFreeMb: disk.freeMb,
    sandboxCount,
    sandboxRunning: sandboxCount,
    version: VERSION,
    hostname: os.hostname(),
  }
}

let evicted = false
async function heartbeat() {
  const metrics = await collectMetrics()
  try {
    const res = await fetch(`${MASTER_API_URL}/api/master/worknode/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-node-uuid": WORKER_NODE_UUID,
        "x-node-key": WORKER_API_KEY,
      },
      // r36：携带上轮指令执行结果（主控更新 WorkNodeCommand 状态/备份副本状态）
      body: JSON.stringify({ ...metrics, results: pendingResults.splice(0, 64) }),
      signal: AbortSignal.timeout(5000),
    })
    const json = await res.json().catch(() => null) as { code?: number; msg?: string; data?: { commands?: Array<{ id?: string; cmd: string; payload?: unknown }> } } | null

    if (res.status === 403) {
      console.error(`[worker] 主控拒绝心跳（${json?.msg || "403"}）—— 节点已失效，Worker 退出`)
      evicted = true
      process.exit(2)
    }
    if (res.status === 404) {
      console.error("[worker] 主控已删除本节点 —— Worker 退出")
      evicted = true
      process.exit(3)
    }
    if (json?.code === 0) {
      const commands = json.data?.commands || []
      // r36：顺序执行（backup.replica.begin/append/finish 依赖顺序；执行完才发下轮心跳取新指令）→ 结果回传队列→ 下次心跳携出
      for (const cmd of commands) {
        const r = await executeCommand(cmd.cmd, cmd.payload)
        if (cmd.id) pendingResults.push({ cmdId: cmd.id, ok: r.ok, error: r.error, data: r.data })
      }
    } else {
      console.warn(`[worker] 心跳异常响应：${json?.msg || res.status}`)
    }
  } catch (e) {
    console.warn(`[worker] 心跳失败（主控不可达）：${(e as Error).message}`)
  }
}

async function executeCommand(cmd: string, payload: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  console.log(`[worker] 执行主控指令：${cmd}`)
  if (cmd.startsWith("file.") || cmd.startsWith("backup.replica.")) {
    const r = await handleFileCommand(cmd, payload)
    console.log(`[worker] 文件指令结果：${cmd} → ${r.ok ? "OK" : `FAIL ${r.error}`}`)
    return r
  }
  switch (cmd) {
    case "ping":
      console.log("[worker] pong")
      return { ok: true }
    default:
      console.log(`[worker] 未知指令 ${cmd}（忽略；Worker 不执行未注册指令）`)
      return { ok: false, error: `未知指令 ${cmd}` }
  }
}

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT || 3007)
const started = Date.now()
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      ok: true, service: "dockyard-worker", nodeUuid: WORKER_NODE_UUID, version: VERSION,
      master: MASTER_API_URL, evicted, uptimeSec: Math.floor((Date.now() - started) / 1000),
    }))
    return
  }
  res.writeHead(404).end("not found")
})
httpServer.listen(HEALTH_PORT, () => {
  console.log(`[worker] Dockyard Worker 启动（node=${WORKER_NODE_UUID} master=${MASTER_API_URL} health=:${HEALTH_PORT}）`)
  console.log(`[worker] 心跳周期 ${HEARTBEAT_SEC}s；纯执行节点：无数据库、无管理端、无自主决策`)
})

void heartbeat()
setInterval(() => {
  if (!evicted) void heartbeat()
}, HEARTBEAT_SEC * 1000)

process.on("SIGTERM", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
process.on("SIGINT", () => { httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500) })
