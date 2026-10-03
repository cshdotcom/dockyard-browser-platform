// ============================================================
// 自定义任务执行体（r24-a）—— 定时任务「自定义执行内容完全放开」
//
// 三类参数化执行体（注册进 TASKS 引擎，由 paramsJson 携带执行内容）：
//   1. custom_shell   —— 平台内 Shell 脚本执行：
//        · 危险命令硬黑名单（不可绕过：rm -rf /、mkfs、dd 写裸设备、关机重启、
//          fork 炸弹、chmod 777 根路径、curl|sh 远程管道执行…）
//        · 进程组级超时击杀（detached + kill(-pgid)，杜绝僵尸子进程）
//        · 输出捕获（stdout+stderr 合流，16KB 上限，全文落执行日志 outputJson）
//        · 自定义环境变量注入 + cwd 白名单（仓库 / 存储卷 / /tmp）
//        · 配置总开关 tasks.allowShellExec（默认开；可由超管一键封死）
//   2. custom_chain   —— 可视化任务链：串联引擎注册表任务类型（最多 10 步），
//        每步可独立参数（仅对参数化类型生效）、失败策略（中止/继续）、
//        运行时逐步打点；禁止嵌套 custom_chain（防递归死循环）
//   3. custom_webhook —— HTTP Webhook 调用：方法/URL/请求头/请求体/期望状态码，
//        响应前 2KB 摘要入日志；SSRF 防护（默认禁内网回环/私网段，超管可放行）
//
// 安全边界：执行体运行于平台容器内（与后台同容器），以平台进程身份执行；
// 危险模式黑名单双重校验（保存时 + 执行前）；输出仅落任务日志，不落明文文件。
// ============================================================

import { spawn } from "child_process"
import dns from "dns"
import net from "net"
import { z } from "zod"

// 由引擎传入的扩展结果（failed / output 由 engine 落 ScheduleTaskLog）
export interface ExecResult {
  itemsProcessed: number
  summary: string
  failed?: boolean
  output?: string
}

// ============================================================
// 0. 通用校验
// ============================================================

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function assertSafeEnvName(name: string): void {
  if (!ENV_NAME_RE.test(name)) throw new Error(`环境变量名非法：${name}（仅字母数字下划线，且不以数字开头）`)
}

// ============================================================
// 1. Shell 执行体
// ============================================================

// 危险模式硬黑名单（保存时 + 执行前双重校验；正则命中即拒绝）
export const SHELL_DANGER_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+[^#\n]*\s\/(\s|$)/, why: "rm 直接作用于根路径" },
  { re: /\brm\s+[^#\n]*\s--no-preserve-root\b/, why: "rm 绕过根路径保护" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, why: "格式化文件系统" },
  { re: /\bdd\b[^#\n]*\bof=\/dev\//i, why: "dd 写入裸设备" },
  { re: /\b(shutdown|poweroff|halt|reboot)\b/, why: "关机/重启系统" },
  { re: /\b(init|telinit)\s+[06]\b/, why: "切换运行级别到停机/重启" },
  { re: /:\(\)\s*\{[^}]*\}\s*;\s*:/, why: "fork 炸弹" },
  { re: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, why: "chmod 777 根路径" },
  { re: /\bchown\s+-R?\s+[^#\n]*\s\/(\s|$)/, why: "递归改写根路径属主" },
  { re: />\s*\/dev\/(sd[a-z]|nvme|vd[a-z])/i, why: "重定向写入磁盘裸设备" },
  { re: /\b(curl|wget)\b[^#\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, why: "远程脚本管道直接执行（供应链风险）" },
  { re: /\b(curl|wget)\b[^#\n]*\|\s*(sudo\s+)?python3?\b/, why: "远程代码管道直接执行（供应链风险）" },
  { re: /\/etc\/(passwd|shadow|sudoers)\b[^#\n]*(>|<<)/, why: "改写系统账户/提权文件" },
  { re: /\bkill\s+-9\s+1\b/, why: "杀 PID 1（容器主进程）" },
  { re: /\bnsenter\b[^#\n]*--target\s+1\b/, why: "进入宿主命名空间" },
  { re: /\bdocker\b[^#\n]*(rm|kill|stop|prune)\b/, why: "跨容器破坏性 Docker 操作" },
  { re: /\/proc\/sys\/kernel\/[^#\n]*(>|<<)/, why: "改写内核运行时参数" },
]

export function checkShellDanger(script: string): { dangerous: boolean; why: string[] } {
  const hits: string[] = []
  for (const p of SHELL_DANGER_PATTERNS) {
    if (p.re.test(script)) hits.push(p.why)
  }
  return { dangerous: hits.length > 0, why: hits }
}

export const shellTaskParamsSchema = z.object({
  script: z.string().min(1, "脚本内容不能为空").max(16384, "脚本最长 16384 字符"),
  cwd: z.string().max(256).optional().default(""),
  env: z.record(z.string(), z.string().max(2048)).optional().default({}),
  shell: z.enum(["sh", "bash"]).optional().default("sh"),
})
export type ShellTaskParams = z.infer<typeof shellTaskParamsSchema>

// cwd 白名单前缀（容器内安全区）
export function safeCwdList(storagePath: string): string[] {
  const cands = [process.cwd(), storagePath.replace(/\/$/, ""), "/tmp"]
  return [...new Set(cands.filter((p) => p && p.startsWith("/")))]
}

export function validateShellCwd(cwd: string, storagePath: string): { ok: boolean; resolved: string; error?: string } {
  const list = safeCwdList(storagePath)
  if (!cwd) return { ok: true, resolved: process.cwd() }
  const target = cwd.startsWith("/") ? cwd : `${process.cwd()}/${cwd}`
  for (const base of list) {
    if (target === base || target.startsWith(`${base}/`)) return { ok: true, resolved: target }
  }
  return { ok: false, resolved: target, error: `工作目录必须在白名单内（${list.join(" / ")}）` }
}

const SHELL_OUTPUT_MAX = 16 * 1024 // 16KB
const SHELL_SCRIPT_TIMEOUT_CAP = 600 // 单脚本硬上限 10 分钟（任务 timeoutSec 再收紧）

export async function runShellExecutor(
  rawParams: unknown,
  log: (m: string) => void,
  taskTimeoutSec: number
): Promise<ExecResult> {
  const params = shellTaskParamsSchema.parse(rawParams ?? {})
  const { getConfigBool } = await import("@/lib/config")
  const { ENV } = await import("@/lib/env")

  // 配置总开关（可在配置中心一键封死 Shell 执行体）+ 执行前二次黑名单校验（防 DB 直改绕过保存校验）
  if (!(await getConfigBool("tasks.allowShellExec", true))) {
    throw new Error("Shell 执行体已被管理员禁用（配置 tasks.allowShellExec=false）")
  }
  const danger = checkShellDanger(params.script)
  if (danger.dangerous) throw new Error(`脚本命中危险模式，拒绝执行：${danger.why.join("；")}`)

  const cwdCheck = validateShellCwd(params.cwd || "", ENV.storageLocalPath)
  if (!cwdCheck.ok) throw new Error(cwdCheck.error || "工作目录非法")

  const envExtra: Record<string, string> = {}
  for (const [k, v] of Object.entries(params.env || {})) {
    assertSafeEnvName(k)
    envExtra[k] = v
  }

  const bin = params.shell === "bash" ? "/bin/bash" : "/bin/sh"
  const timeoutSec = Math.max(5, Math.min(taskTimeoutSec, SHELL_SCRIPT_TIMEOUT_CAP))
  log(`[shell] ${bin} -c 执行 · cwd=${cwdCheck.resolved} · 超时=${timeoutSec}s · env注入=${Object.keys(envExtra).length}项`)

  return await new Promise<ExecResult>((resolve) => {
    // detached + 进程组：超时时 kill(-pgid) 级联击杀整个子进程树（防 && 链残留）
    const childEnv = {
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME || "/root",
      LANG: process.env.LANG || "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV,
      DY_TASK_KIND: "custom_shell",
      ...envExtra,
    }
    const child = spawn(bin, ["-c", params.script], {
      cwd: cwdCheck.resolved,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"] as const,
    })

    let out = ""
    let truncated = false
    const capture = (chunk: Buffer) => {
      if (out.length < SHELL_OUTPUT_MAX) {
        const room = SHELL_OUTPUT_MAX - out.length
        out += chunk.subarray(0, room).toString("utf8")
        if (chunk.length > room) truncated = true
      } else {
        truncated = true
      }
    }
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)

    let killed = false
    const killer = setTimeout(() => {
      killed = true
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        try { child.kill("SIGKILL") } catch { /* already gone */ }
      }
    }, timeoutSec * 1000)

    const finish = (code: number, signal: string | null) => {
      clearTimeout(killer)
      const suffix = truncated ? "\n…（输出已达 16KB 上限截断）" : ""
      if (killed || signal === "SIGKILL") {
        log(`[shell] 执行超时被强制终止（>${timeoutSec}s）`)
        resolve({ itemsProcessed: 0, summary: `Shell 脚本超时被终止（>${timeoutSec}s）`, failed: true, output: out + suffix })
        return
      }
      const lines = out.split("\n").filter(Boolean)
      for (const line of lines.slice(0, 60)) log(`[shell] ${line}`)
      resolve({
        itemsProcessed: 1,
        summary: `Shell 脚本执行${code === 0 ? "完成" : "失败"}（exit=${code}${truncated ? " · 输出截断" : ""} · ${lines.length}行输出）`,
        failed: code !== 0,
        output: out + suffix,
      })
    }

    child.on("error", (e) => {
      clearTimeout(killer)
      log(`[shell] 启动失败：${e.message}`)
      resolve({ itemsProcessed: 0, summary: `Shell 启动失败：${e.message}`, failed: true })
    })
    child.on("close", (code, signal) => finish(code ?? -1, signal))
  })
}

// ============================================================
// 2. 任务链执行体
// ============================================================

export const chainStepSchema = z.object({
  taskType: z.string().min(1).max(64),
  label: z.string().max(64).optional().default(""),
  params: z.record(z.string(), z.unknown()).optional(),
  continueOnError: z.boolean().optional().default(false),
  timeoutSec: z.number().int().min(5).max(3600).optional(),
})
export const chainTaskParamsSchema = z.object({
  steps: z.array(chainStepSchema).min(1, "任务链至少需要 1 个步骤").max(10, "任务链最多 10 个步骤"),
  failFast: z.boolean().optional().default(true),
})
export type ChainTaskParams = z.infer<typeof chainTaskParamsSchema>

export async function runChainExecutor(
  rawParams: unknown,
  log: (m: string) => void,
  resolveTask: (taskType: string) => ((log: (m: string) => void, params?: unknown) => Promise<ExecResult>) | undefined
): Promise<ExecResult> {
  const params = chainTaskParamsSchema.parse(rawParams ?? {})
  const steps = params.steps
  let done = 0
  const failures: string[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const tag = `[chain ${i + 1}/${steps.length}]${step.label ? ` ${step.label}` : ""} → ${step.taskType}`

    // 防递归：任务链内禁止再嵌套任务链（一层展开即可组合出任意流程）
    if (step.taskType === "custom_chain") {
      throw new Error(`${tag}：任务链不允许嵌套 custom_chain（防递归死循环）`)
    }
    const fn = resolveTask(step.taskType)
    if (!fn) throw new Error(`${tag}：任务类型不存在（可能已被引擎移除）`)

    log(`${tag} 开始执行`)
    const stepTimeout = step.timeoutSec ?? 300
    try {
      const result = await Promise.race([
        Promise.resolve(fn(log, step.params)),
        new Promise<ExecResult>((_, reject) =>
          setTimeout(() => reject(new Error(`步骤超时（${stepTimeout}s）`)), stepTimeout * 1000)
        ),
      ])
      done++
      log(`${tag} 完成：${result.summary}`)
      if (result.failed) {
        failures.push(`${step.taskType}: ${result.summary}`)
        if (params.failFast && !step.continueOnError) {
          return { itemsProcessed: done, summary: `任务链在第 ${i + 1} 步中止（${failures.join("；")}），后续 ${steps.length - done} 步未执行`, failed: true }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      done++
      failures.push(`${step.taskType}: ${msg}`)
      log(`${tag} 失败：${msg}`)
      const abort = params.failFast && !step.continueOnError
      if (abort) {
        return { itemsProcessed: done, summary: `任务链在第 ${i + 1} 步中止（${failures.join("；")}），后续 ${steps.length - done} 步未执行`, failed: true }
      }
    }
  }

  if (failures.length > 0) {
    return { itemsProcessed: done, summary: `任务链完成（${done}/${steps.length} 步，失败 ${failures.length} 步：${failures.join("；")}）`, failed: true }
  }
  return { itemsProcessed: done, summary: `任务链全部完成（${done}/${steps.length} 步）` }
}

// ============================================================
// 3. Webhook 执行体
// ============================================================

export const webhookTaskParamsSchema = z.object({
  url: z.string().url("必须是合法 URL").max(2048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().default("GET"),
  headers: z.record(z.string(), z.string().max(4096)).optional().default({}),
  body: z.string().max(32768, "请求体最长 32KB").optional().default(""),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  timeoutSec: z.number().int().min(3).max(120).optional().default(30),
})
export type WebhookTaskParams = z.infer<typeof webhookTaskParamsSchema>

// SSRF 防护：默认拒绝回环/链路本地/私网/元数据端点（可由超管配置放行内网）
function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "metadata.google.internal") return true
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // IPv6 ULA
  if (h.endsWith(".internal") || h.endsWith(".local")) return true
  return false
}

async function ssrfGuard(url: string): Promise<void> {
  const { getConfigBool } = await import("@/lib/config")
  if (await getConfigBool("tasks.webhookAllowPrivate", false)) return // 超管显式放行内网
  const u = new URL(url)
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Webhook 仅支持 http/https（收到 ${u.protocol}）`)
  const host = u.hostname
  if (isPrivateAddress(host)) {
    throw new Error(`Webhook 目标命中内网/保留地址（${host}）；如需内网调用请由超管在配置中开启 tasks.webhookAllowPrivate`)
  }
  // 字面 IPv4 已拦；域名走临时解析校验（best-effort 1.5s 超时，解析失败放行至 fetch 层报网络错误）
  if (net.isIP(host) === 0) {
    try {
      const addrs = await new Promise<string[]>((resolve) => {
        const t = setTimeout(() => resolve([]), 1500)
        dns.resolve4(host, (err, a) => {
          clearTimeout(t)
          resolve(err ? [] : a)
        })
      })
      if (addrs.some((a) => isPrivateAddress(a))) {
        throw new Error(`Webhook 域名解析到内网地址（${host} → ${addrs.join(",")}）；如需内网调用请由超管放行`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Webhook")) throw e
      /* 解析失败（可能仅 IPv6）→ 放行 */
    }
  }
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/
const BLOCKED_HEADER_NAMES = new Set(["host", "content-length", "connection", "transfer-encoding"])

export async function runWebhookExecutor(rawParams: unknown, log: (m: string) => void): Promise<ExecResult> {
  const params = webhookTaskParamsSchema.parse(rawParams ?? {})
  await ssrfGuard(params.url)

  const headers: Record<string, string> = { "User-Agent": "Dockyard-TaskEngine/1.0" }
  for (const [k, v] of Object.entries(params.headers || {})) {
    if (!HEADER_NAME_RE.test(k)) throw new Error(`请求头名称非法：${k}`)
    if (BLOCKED_HEADER_NAMES.has(k.toLowerCase())) continue // 逐字头由 fetch 控制
    headers[k] = v
  }
  const method = params.method
  const hasBody = method !== "GET" && method !== "HEAD" && !!params.body
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json"
  }

  log(`[webhook] ${method} ${params.url} · 头${Object.keys(headers).length}项 · 超时${params.timeoutSec}s`)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), params.timeoutSec * 1000)
  try {
    const res = await fetch(params.url, { method, headers, body: hasBody ? params.body : undefined, signal: ctrl.signal, redirect: "manual", cache: "no-store" })
    const text = await res.text().catch(() => "")
    const snippet = text.slice(0, 2048)
    const ok = params.expectedStatus ? res.status === params.expectedStatus : res.status >= 200 && res.status < 300
    log(`[webhook] HTTP ${res.status}（${res.statusText}）· 响应 ${text.length} 字节`)
    if (snippet) log(`[webhook] 响应摘要：${snippet.replace(/\s+/g, " ").slice(0, 600)}`)
    return {
      itemsProcessed: 1,
      summary: `Webhook ${method} ${new URL(params.url).host} → HTTP ${res.status}${ok ? "（符合预期）" : "（不符合预期）"}`,
      failed: !ok,
      output: `HTTP ${res.status} ${res.statusText}\n${snippet}`,
    }
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? `请求超时（${params.timeoutSec}s）` : e instanceof Error ? e.message : String(e)
    log(`[webhook] 调用失败：${msg}`)
    return { itemsProcessed: 0, summary: `Webhook 调用失败：${msg}`, failed: true, output: msg }
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// 参数校验器（保存入口复用；引擎执行前 zod 二次校验）
// ============================================================

export type CustomParamKind = "shell" | "chain" | "webhook"

export const CUSTOM_EXEC_TASK_TYPES: Record<string, { kind: CustomParamKind; name: string; description: string }> = {
  custom_shell: { kind: "shell", name: "Shell 脚本执行", description: "完全自定义脚本内容（危险命令硬黑名单防护）" },
  custom_chain: { kind: "chain", name: "任务链编排", description: "串联引擎任务类型组成流程（最多10步，可视化编排）" },
  custom_webhook: { kind: "webhook", name: "Webhook 调用", description: "自定义 HTTP 回调（方法/头/体/期望状态码/SSRF防护）" },
}

export function validateCustomExecParams(
  taskType: string,
  params: unknown,
  storagePath: string
): { ok: boolean; error?: string; kind?: CustomParamKind } {
  const meta = CUSTOM_EXEC_TASK_TYPES[taskType]
  if (!meta) return { ok: true } // 非参数化类型：无参数校验
  try {
    if (meta.kind === "shell") {
      const p = shellTaskParamsSchema.parse(params ?? {})
      const danger = checkShellDanger(p.script)
      if (danger.dangerous) return { ok: false, error: `脚本命中危险模式：${danger.why.join("；")}`, kind: "shell" }
      const cwdCheck = validateShellCwd(p.cwd || "", storagePath)
      if (!cwdCheck.ok) return { ok: false, error: cwdCheck.error, kind: "shell" }
      for (const k of Object.keys(p.env || {})) assertSafeEnvName(k)
    } else if (meta.kind === "chain") {
      chainTaskParamsSchema.parse(params ?? {})
    } else {
      webhookTaskParamsSchema.parse(params ?? {})
    }
    return { ok: true, kind: meta.kind }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return { ok: false, error: e.issues.map((i) => `${i.path.join(".") || "参数"}: ${i.message}`).join("；"), kind: meta.kind }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), kind: meta.kind }
  }
}
