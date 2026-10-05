import { createHmac, timingSafeEqual, randomBytes } from "crypto"
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, statSync } from "fs"
import { join } from "path"
import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { writeAudit } from "@/lib/audit"
import { getConfig, getConfigBool, getConfigNumber } from "@/lib/config"

// ============================================================
// r40：远程打印机池核心库（虚拟打印机 —— 沙箱页面 → 远程客户端物理打印机）
//
// 链路：用户在会话面板选择远程打印机 → 服务端渲染 PDF（CDP printToPDF）
//   → URL 级打印策略校验（PrintingEnabled / Allowed/BlockedForUrls 服务端强制）
//   → 文件落盘 storage/print-jobs/<jobId>.pdf → PrintJob 入库（PENDING）
//   → WorkNodeCommand 指令 print.dispatch 派发（心跳携出）
//   → 客户端下载（HMAC 一次性令牌）→ dialog（打印界面）/silent（lp 直打）
//   → 阶段状态回报（DELIVERED/PRINTING/PRINTED/FAILED）→ 用户/管理员全程可见
// ============================================================

export const PRINT_JOB_STATUSES = [
  "PENDING", "SENT", "DELIVERED", "PRINTING", "PRINTED", "FAILED", "CANCELED", "TIMED_OUT",
] as const
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number]

export const PRINT_DELIVER_MODES = ["dialog", "silent"] as const
export type PrintDeliverMode = (typeof PRINT_DELIVER_MODES)[number]

// 状态机：只允许单向前进（回报乱序/重放防护）
const STATUS_ORDER: Record<string, number> = {
  PENDING: 0, SENT: 1, DELIVERED: 2, PRINTING: 3, PRINTED: 4, FAILED: 4, CANCELED: 4, TIMED_OUT: 4,
}

// ---- 文件存储 ----
export function printJobsDir(): string {
  return join(ENV.storageLocalPath, "print-jobs")
}
export function printJobFilePath(jobId: string): string {
  return join(printJobsDir(), `${jobId}.pdf`)
}

export function savePrintJobFile(jobId: string, buf: Buffer): void {
  const dir = printJobsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(printJobFilePath(jobId), buf)
}

export function readPrintJobFile(jobId: string): Buffer | null {
  try {
    const p = printJobFilePath(jobId)
    if (!existsSync(p)) return null
    return readFileSync(p)
  } catch { return null }
}

export function deletePrintJobFile(jobId: string): void {
  try { unlinkSync(printJobFilePath(jobId)) } catch { /* 文件不存在/已清理 */ }
}

// ---- 展示号 PJ-<base36 时间戳><随机> ----
export function newPrintJobNo(): string {
  return `PJ-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`
}

// ---- 下载令牌：HMAC(authSecret, jobId:nodeUuid:exp)，10 分钟有效，node 凭证双因子 ----
export function signPrintDownloadToken(jobId: string, nodeUuid: string, ttlSec = 600): { t: string; e: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const t = createHmac("sha256", ENV.authSecret).update(`print:${jobId}:${nodeUuid}:${exp}`).digest("hex").slice(0, 40)
  return { t, e: exp }
}

export function verifyPrintDownloadToken(jobId: string, nodeUuid: string, t: string, e: number): boolean {
  if (!/^[a-f0-9]{40}$/.test(t) || !Number.isFinite(e)) return false
  if (e < Math.floor(Date.now() / 1000)) return false
  const expect = createHmac("sha256", ENV.authSecret).update(`print:${jobId}:${nodeUuid}:${e}`).digest("hex").slice(0, 40)
  try {
    return timingSafeEqual(Buffer.from(expect, "hex"), Buffer.from(t, "hex"))
  } catch { return false }
}

// ============================================================
// Chromium URL 模式匹配（服务端强制版）
// 支持子集：[*.]host（任意子域）、host（精确域 + 全部子域匹配子域条目）、
// scheme://host/path*（URL 前缀模式）、*（全部）、纯 path 段匹配
// 与 Chromium URLFilter 语义对齐（大小写不敏感；端口与默认端口等价）
// ============================================================
export function matchUrlPatterns(rawUrl: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false
  let u: URL
  try {
    u = new URL(rawUrl)
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") return false
  } catch { return false }
  const host = u.hostname.toLowerCase()
  const port = u.port || (u.protocol === "https:" ? "443" : "80")
  const pathAndQuery = `${u.pathname}${u.search}`.toLowerCase()

  for (const raw of patterns) {
    const pat = String(raw || "").trim().toLowerCase()
    if (!pat) continue
    if (pat === "*") return true

    // [*.]host —— 任意子域（含自身）
    const m = /^\[\*\.\]([a-z0-9.-]+)$/.exec(pat)
    if (m) {
      if (host === m[1] || host.endsWith(`.${m[1]}`)) return true
      continue
    }
    // 纯 host（Chromium 语义：该域 + 其全部子域 + 任意 scheme）
    if (/^[a-z0-9.-]+$/.test(pat) && pat.includes(".")) {
      if (host === pat || host.endsWith(`.${pat}`)) return true
      continue
    }
    // 完整 URL 模式 scheme://host[:port]/path*
    if (pat.includes("://")) {
      try {
        const p = new URL(pat.endsWith("*") ? pat.slice(0, -1) : pat)
        const pHost = p.hostname.toLowerCase()
        const hostHit = pHost.startsWith("[*.]")
          ? host === pHost.slice(4) || host.endsWith(`.${pHost.slice(4)}`)
          : host === pHost
        if (!hostHit) continue
        const pPort = p.port || (p.protocol === "https:" ? "443" : "80")
        if (pPort !== "*" && pPort !== port) continue
        const pPath = `${p.pathname}${p.search}`.toLowerCase()
        if (pat.endsWith("*")) {
          if (pathAndQuery.startsWith(pPath)) return true
        } else if (pathAndQuery === pPath) return true
      } catch { /* 坏模式跳过 */ }
      continue
    }
    // 纯 path 模式（无 host 段）：任意 host 下路径匹配
    if (pat.startsWith("/") && pat.length > 1) {
      const p = pat.endsWith("*") ? pat.slice(0, -1) : pat
      if (pat.endsWith("*") ? pathAndQuery.startsWith(p) : pathAndQuery === pat) return true
    }
  }
  return false
}

// ============================================================
// 用户生效打印策略（服务端强制链：用户 > 组 > 工作区模板）
// 与 resolveUserPolicyOverrides（workspaces.ts 注入链）同优先级语义；
// 这里独立解析打印三键，用于 POST /api/print/jobs 创建时强制校验
// ============================================================
export interface EffectivePrintPolicy {
  printingEnabled: boolean
  allowedForUrls: string[]
  blockedForUrls: string[]
  source: "USER" | "GROUP" | "TEMPLATE" | "DEFAULT"
}

export async function resolvePrintPolicyForUser(userId: string, workspaceId?: string | null): Promise<EffectivePrintPolicy> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { managedPolicyOverrides: true } })
  const groupRows = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  const groups = groupRows.length > 0
    ? await db.group.findMany({ where: { id: { in: groupRows.map((g) => g.groupId) }, enabled: true }, select: { managedPolicyOverrides: true } })
    : []

  // 工作区模板（最低优先）
  let templatePolicies: Record<string, unknown> = {}
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({ where: { id: workspaceId }, select: { templateId: true } })
    if (ws?.templateId) {
      const tpl = await db.browserTemplate.findFirst({ where: { id: ws.templateId, deletedAt: null }, select: { configJson: true } })
      if (tpl) {
        try {
          const cfg = JSON.parse(tpl.configJson || "{}") as { policyJson?: Record<string, unknown> }
          templatePolicies = cfg.policyJson || {}
        } catch { templatePolicies = {} }
      }
    }
  }

  // 合并：模板 → 组（多组按序覆盖）→ 用户
  const merged: Record<string, unknown> = { ...templatePolicies }
  for (const g of groups) {
    if (!g.managedPolicyOverrides) continue
    try { Object.assign(merged, JSON.parse(g.managedPolicyOverrides)) } catch { /* 组级损坏忽略 */ }
  }
  if (user?.managedPolicyOverrides) {
    try { Object.assign(merged, JSON.parse(user.managedPolicyOverrides)) } catch { /* 用户级损坏忽略 */ }
  }

  const asList = (v: unknown): string[] => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 200) : []
  return {
    printingEnabled: merged["PrintingEnabled"] !== false, // 未配置 = 允许（与目录默认一致）
    allowedForUrls: asList(merged["PrintingAllowedForUrls"]),
    blockedForUrls: asList(merged["PrintingBlockedForUrls"]),
    source: "DEFAULT",
  }
}

// 校验：URL 级打印管控（黑名单优先 > 白名单模式）
export function checkPrintAllowed(sourceUrl: string, policy: EffectivePrintPolicy): { allowed: boolean; reason?: string } {
  if (!policy.printingEnabled) return { allowed: false, reason: "企业策略已全局禁用打印（PrintingEnabled=false）" }
  if (!sourceUrl || sourceUrl === "about:blank") return { allowed: true }
  if (policy.blockedForUrls.length > 0 && matchUrlPatterns(sourceUrl, policy.blockedForUrls)) {
    return { allowed: false, reason: `该站点已被打印黑名单策略拦截（PrintingBlockedForUrls）` }
  }
  if (policy.allowedForUrls.length > 0 && !matchUrlPatterns(sourceUrl, policy.allowedForUrls)) {
    return { allowed: false, reason: "打印白名单策略已启用，该站点不在允许列表内（PrintingAllowedForUrls）" }
  }
  return { allowed: true }
}

// ============================================================
// 超时收口 + 文件 TTL 清理（查询路径顺带触发，无独立定时器）
// ============================================================
export async function sweepPrintJobs(): Promise<{ timedOut: number }> {
  const dispatchTimeoutSec = await getConfigNumber("print.dispatchTimeoutSec", 180)
  const deliverTimeoutSec = await getConfigNumber("print.deliverTimeoutSec", 600)
  const now = Date.now()

  // PENDING 超 3 分钟未派发（客户端离线/队列积压）→ TIMED_OUT
  const stuckPending = await db.printJob.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now - dispatchTimeoutSec * 1000) } },
    select: { id: true, jobNo: true, userId: true },
    take: 50,
  })
  // SENT/DELIVERED/PRINTING 超交付时限无进展 → TIMED_OUT
  const stuckInFlight = await db.printJob.findMany({
    where: { status: { in: ["SENT", "DELIVERED", "PRINTING"] }, sentAt: { lt: new Date(now - deliverTimeoutSec * 1000) } },
    select: { id: true, jobNo: true, userId: true },
    take: 50,
  })

  const all = [...stuckPending, ...stuckInFlight]
  for (const j of all) {
    // 取消仍在队列的未执行指令（防迟到的客户端领到已超时任务）
    await db.workNodeCommand.updateMany({
      where: { cmd: "print.dispatch", payloadJson: { contains: `"jobId":"${j.id}"` }, doneAt: null },
      data: { doneAt: new Date(), resultJson: JSON.stringify({ ok: false, error: "job timed out" }) },
    }).catch(() => null)
    await db.printJob.update({
      where: { id: j.id },
      data: { status: "TIMED_OUT", finishedAt: new Date(), error: `交付超时（客户端 ${deliverTimeoutSec / 60} 分钟内未完成）` },
    }).catch(() => null)
    // 注意：文件保留（管理员可重派；TTL 由 sweepPrintJobFiles 按保留期清理 —— 超时 ≠ 文件作废）
    await writeAudit({
      operationType: "PRINT_POOL", resourceType: "PRINT_JOB", resourceId: j.id, resourceName: j.jobNo,
      after: { phase: "TIMED_OUT", auto: true },
      severity: "WARN",
    }).catch(() => null)
  }
  return { timedOut: all.length }
}

export async function sweepPrintJobFiles(): Promise<{ cleaned: number }> {
  const ttlHours = await getConfigNumber("print.fileTtlHours", 24)
  const cutoff = Date.now() - ttlHours * 3600_000
  // 终态任务 → 文件可清（记录保留）
  const done = await db.printJob.findMany({
    where: { status: { in: ["PRINTED", "FAILED", "CANCELED", "TIMED_OUT"] }, createdAt: { lt: new Date(cutoff) } },
    select: { id: true, fileKey: true },
    take: 100,
  })
  let cleaned = 0
  for (const j of done) {
    if (!j.fileKey) continue
    const p = printJobFilePath(j.id)
    try {
      if (existsSync(p) && statSync(p).mtimeMs < cutoff) { unlinkSync(p); cleaned++ }
    } catch { /* 清理容错 */ }
    await db.printJob.update({ where: { id: j.id }, data: { fileKey: "" } }).catch(() => null)
  }
  return { cleaned }
}

// ---- 打印机池可用性（用户列表 / 创建校验共用）----
export async function poolEnabled(): Promise<boolean> {
  return getConfigBool("printing.poolEnabled", true)
}
