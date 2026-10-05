// ============================================================
// r40：Worker 打印机池客户端模块（纯执行，无自主决策）
//
// 三职责：
//   1. discoverPrinters()   —— 本机打印机发现（CUPS lpstat；无 CUPS 时
//                              WORKER_FAKE_PRINTERS 模拟 —— 测试/无打印头环境）
//   2. syncPrinters()       —— 全量上报主控（60s 周期；OFFLINE 检测在主控侧）
//   3. handlePrintDispatch()—— print.dispatch 指令执行：
//        下载（sha256 校验）→ report DELIVERED → 交付打印 → report 阶段状态
//   交付双模式：
//     · silent（lp 直打，全自动化）：lp -d <printer> [-n copies] [sides] → PRINTED/FAILED
//     · dialog（打印界面）：文件落 ~/dockyard-print/ 并 xdg-open 系统关联程序
//       打开（多数 PDF 查看器一键打印）→ 状态 DELIVERED（客户端确认人环节）
// ============================================================

import { execFile } from "child_process"
import { createHash } from "crypto"
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const MASTER_API_URL = process.env.MASTER_API_URL || ""
const WORKER_NODE_UUID = process.env.WORKER_NODE_UUID || ""
const WORKER_API_KEY = process.env.WORKER_API_KEY || ""

// 打印文件投递目录（dialog 模式用户可在此找到 PDF）
export function printSpoolDir(): string {
  const d = process.env.WORKER_PRINT_SPOOL_DIR || join(homedir(), "dockyard-print")
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

// 简单日志（追加文件 + stdout）
function plog(msg: string): void {
  const line = `[print-agent] ${new Date().toISOString()} ${msg}`
  console.log(line)
  try { appendFileSync(join(printSpoolDir(), "print-agent.log"), line + "\n") } catch { /* 日志容错 */ }
}

function sh(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      res({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: String(stdout || ""), err: String(stderr || "") })
    })
  })
}

// ---- 1) 本机打印机发现（CUPS；失败→fake 模式）----
export interface DiscoveredPrinter {
  key: string
  name: string
  description: string
  capabilities: Record<string, unknown>
}

export async function discoverPrinters(): Promise<{ printers: DiscoveredPrinter[]; fake: boolean }> {
  // 显式 fake 配置（测试环境/无打印头机器）
  const fakeList = (process.env.WORKER_FAKE_PRINTERS || "").split(";").map((s) => s.trim()).filter(Boolean)
  const r = await sh("lpstat", ["-p", "-d"], 4000)
  const cupsOk = r.code === 0 && r.out.trim().length > 0

  if (!cupsOk) {
    if (fakeList.length === 0) return { printers: [], fake: false } // 真的没有打印机
    return {
      printers: fakeList.map((name, i) => ({
        key: `fake-${i + 1}`,
        name,
        description: `模拟打印机（WORKER_FAKE_PRINTERS）`,
        capabilities: { fake: true, duplex: true, color: i % 2 === 0, paper: ["A4", "Letter"] },
      })),
      fake: true,
    }
  }

  // 解析 "printer <name> is idle. enabled since ..." + "system default destination: <name>"
  const printers: DiscoveredPrinter[] = []
  const defaultMatch = /system default destination:\s*(\S+)/.exec(r.out)
  const defaultPrinter = defaultMatch?.[1] || ""
  for (const line of r.out.split("\n")) {
    const m = /^printer\s+(\S+)\s+is\s+(\w+)/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    const state = m[2]
    if (state === "disabled") continue
    // 尝试拉取 PPD 能力（纸张/双面；失败给默认）
    const info = await sh("lpoptions", ["-p", key, "-l"], 3000)
    const caps: Record<string, unknown> = { state, isDefault: key === defaultPrinter }
    if (info.code === 0 && info.out) {
      const duplex = /^Duplex.*\*none/m.test(info.out) === false ? /Duplex/.test(info.out) : false
      const pageSize = /^\s*PageSize\s*[^\n]*?\*(\S+)/m.exec(info.out)?.[1] || "A4"
      caps.duplex = duplex
      caps.paper = pageSize
    }
    printers.push({ key, name: key, description: `CUPS 队列（${state}${key === defaultPrinter ? "，默认" : ""}）`, capabilities: caps })
  }
  return { printers, fake: false }
}

// ---- 2) 上报主控（全量同步）----
export async function syncPrinters(hostname: string): Promise<{ ok: boolean; synced?: number; error?: string }> {
  try {
    const { printers } = await discoverPrinters()
    const res = await fetch(`${MASTER_API_URL}/api/master/print/printers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-node-uuid": WORKER_NODE_UUID, "x-node-key": WORKER_API_KEY },
      body: JSON.stringify({
        clientName: hostname,
        printers: printers.map((p) => ({ key: p.key, name: p.name, description: p.description, capabilities: p.capabilities })),
      }),
      signal: AbortSignal.timeout(8000),
    })
    const j = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { synced?: number } } | null
    if (res.ok && j?.code === 0) return { ok: true, synced: j.data?.synced ?? 0 }
    return { ok: false, error: j?.msg || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---- 3) print.dispatch 指令执行 ----
interface PrintDispatchPayload {
  jobId: string
  jobNo: string
  fileName: string
  bytes: number
  sha256: string
  downloadPath: string
  deliverMode: "dialog" | "silent"
  copies: number
  duplex: string
  landscape: boolean
  printerKey: string
  printerName: string
  requestedBy: string
  sourceUrl: string
}

async function report(jobId: string, phase: "DELIVERED" | "PRINTING" | "PRINTED" | "FAILED", error?: string): Promise<void> {
  try {
    await fetch(`${MASTER_API_URL}/api/master/print/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-node-uuid": WORKER_NODE_UUID, "x-node-key": WORKER_API_KEY },
      body: JSON.stringify({ jobId, phase, error: error?.slice(0, 400), clientInfo: process.env.WORKER_PRINT_CLIENT_TAG || "" }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    plog(`report ${phase} 失败（网络）：${(e as Error).message} —— 将由指令回执兜底`)
  }
}

async function downloadFile(job: PrintDispatchPayload): Promise<{ buf: Buffer; target: string } | { error: string }> {
  try {
    const res = await fetch(`${MASTER_API_URL}${job.downloadPath}`, {
      headers: { "x-node-uuid": WORKER_NODE_UUID, "x-node-key": WORKER_API_KEY },
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { msg?: string } | null
      return { error: `下载失败（HTTP ${res.status}${j?.msg ? `：${j.msg}` : ""}）` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    // sha256 完整性校验（主控 X-File-Sha256 + payload 声明双对账）
    const local = createHash("sha256").update(buf).digest("hex")
    const headerSha = res.headers.get("x-file-sha256") || job.sha256
    if (local !== headerSha) return { error: `sha256 校验失败（local=${local.slice(0, 12)} expect=${headerSha.slice(0, 12)}）` }
    if (job.bytes > 0 && buf.length !== job.bytes) return { error: `大小不符（${buf.length} != ${job.bytes}）` }
    const target = join(printSpoolDir(), job.fileName)
    writeFileSync(target, buf)
    return { buf, target }
  } catch (e) {
    return { error: `下载异常：${(e as Error).message}` }
  }
}

export async function handlePrintDispatch(payload: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const job = (payload || {}) as PrintDispatchPayload
  if (!job.jobId || !job.downloadPath) return { ok: false, error: "print.dispatch payload 缺少 jobId/downloadPath" }
  plog(`领取打印任务 ${job.jobNo}（${job.printerName} × ${job.copies} 份，模式 ${job.deliverMode}，发起人 ${job.requestedBy}）`)

  // 下载 + 校验 + 落盘
  const dl = await downloadFile(job)
  if ("error" in dl) {
    await report(job.jobId, "FAILED", dl.error)
    return { ok: false, error: dl.error }
  }
  await report(job.jobId, "DELIVERED")
  plog(`文件已投递客户端（${dl.target}，${dl.buf.length} 字节，sha256 ✓）`)

  const { printers } = await discoverPrinters()
  const targetPrinter = printers.find((p) => p.key === job.printerKey)
  const isFake = targetPrinter?.capabilities?.fake === true || job.printerKey.startsWith("fake-")

  // ---- silent 模式（直打）或 fake 打印机：自动打印 ----
  if (job.deliverMode === "silent" || isFake) {
    if (isFake) {
      // 模拟打印：1.2 秒后 PRINTED（测试链路完整性）
      await report(job.jobId, "PRINTING")
      await new Promise((r) => setTimeout(r, 1200))
      await report(job.jobId, "PRINTED")
      plog(`模拟打印完成 ${job.jobNo}（fake 打印机 ${job.printerKey}）`)
      return { ok: true, data: { phase: "PRINTED", simulated: true } }
    }
    await report(job.jobId, "PRINTING")
    const args = ["-d", job.printerKey, "-n", String(Math.max(1, job.copies || 1))]
    if (job.duplex === "duplex") args.push("-o", "sides=two-sided-long-edge")
    if (job.duplex === "simplex") args.push("-o", "sides=one-sided")
    if (job.landscape) args.push("-o", "landscape")
    const r = await sh("lp", [...args, dl.target], 30_000)
    if (r.code !== 0) {
      const err = `lp 打印失败：${r.err || r.out || "未知错误"}`
      await report(job.jobId, "FAILED", err)
      return { ok: false, error: err }
    }
    await report(job.jobId, "PRINTED")
    plog(`已提交打印 ${job.jobNo} → ${job.printerKey}（lp 回执：${r.out.trim().split("\n")[0] || "ok"}）`)
    return { ok: true, data: { phase: "PRINTED" } }
  }

  // ---- dialog 模式：打开系统打印界面（关联程序 + 打印引导文件）----
  // 生成"一键打印引导"页面（打开即提示用户按 Ctrl+P；同时 xdg-open 原始 PDF）
  const guide = join(printSpoolDir(), `__guide-${job.jobNo}.html`)
  writeFileSync(guide, `<!doctype html><meta charset="utf-8"><title>打印任务 ${job.jobNo}</title>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px">
<h2>🖨️ 打印任务已送达</h2>
<p>任务号 <b>${job.jobNo}</b> · 打印机 <b>${job.printerName}</b> · ${job.copies} 份${job.duplex !== "default" ? ` · ${job.duplex === "duplex" ? "双面" : "单面"}` : ""}</p>
<p>发起人：${job.requestedBy} · 源页面：${(job.sourceUrl || "").slice(0, 120)}</p>
<p><b>PDF 文件已保存到：</b><code>${dl.target}</code></p>
<p>点击下方按钮打开 PDF 并打印（或按 Ctrl+P）：</p>
<script>
  window.printHint = 1
  location.replace("file://${dl.target}")
</script>
<p style="margin-top:40px;color:#888">此引导文件由 Dockyard 打印代理生成，可安全删除。</p>
</body>`)
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open"
  const r1 = await sh(openCmd, [guide], 8000)
  const r2 = await sh(openCmd, [dl.target], 8000)
  if (r1.code !== 0 && r2.code !== 0) {
    // 图形环境不可用（无 DISPLAY）→ 自动降级直打
    plog("图形环境不可用（dialog 打开失败）→ 降级 lp 直打")
    const args = ["-d", job.printerKey, "-n", String(Math.max(1, job.copies || 1))]
    const r3 = await sh("lp", [...args, dl.target], 30_000)
    if (r3.code !== 0) {
      const err = `dialog 打开失败且 lp 降级失败：${r3.err || r3.out}`
      await report(job.jobId, "FAILED", err)
      return { ok: false, error: err }
    }
    await report(job.jobId, "PRINTED")
    return { ok: true, data: { phase: "PRINTED", fallback: "silent" } }
  }
  // 已打开打印界面：任务留在 DELIVERED（用户在界面中确认打印）
  // 指令回执 ok=true（投递成功）；后续人工打印确认由 print-agent 状态上报或超时收口兜底
  plog(`打印界面已打开 ${job.jobNo}（等待用户在界面中确认打印）`)
  return { ok: true, data: { phase: "DELIVERED", openedDialog: true, file: dl.target } }
}

// ---- 指令路由入口（worker executeCommand 调用）----
export async function handlePrintCommand(cmd: string, payload: unknown): Promise<{ ok: boolean; error?: string; data?: unknown } | null> {
  if (cmd !== "print.dispatch") return null // 非打印指令 → 交回 worker 主路由
  try {
    return await handlePrintDispatch(payload)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
