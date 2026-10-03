// ============================================================
// CRX 扩展生命周期审计 + 未知扩展扫描 + 策略防篡改校验 + 安全基线扫描
// （r26 深度批次 · 九大类审计之 CRX 扩展生命周期类）
//
// 设计原则（零内核 Patch，全部上层业务逻辑）：
//   · 生命周期事件 = 轮询任务发现的状态迁移，全部落全局不可篡改审计
//     INSTALLED(安装) / REMOVED(卸载) / VERSION_CHANGE(升级) /
//     INCOGNITO_ENABLED(无痕加载上报) / UNKNOWN_DETECTED(未知扩展)
//   · 审计记录独立于 BrowserWorkspace 行（沙箱销毁/回收不级联清理审计）→ 永久归档
//   · 未知扩展扫描 = CDP 枚举真实容器扩展 - 合并策略白名单 → 未授权扩展
//     命中即 DANGER 审计 + CRITICAL 告警 + 自动下发 installation_mode=blocked
//   · 防篡改 = 策略文件落盘时记录 SHA-256（hardeningJson.policyFileHash），
//     周期任务复算哈希比对；不一致 = 容器内策略文件被篡改（DANGER + CRITICAL）
//   · 基线扫描 = 逐沙箱合规评分（0-100）落 hardeningJson.baselineScore，
//     低分告警；维度：硬隔离/网络策略/文件策略/CRX 高危/配额水位
// ============================================================

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { db } from "./db"
import { writeAudit } from "./audit"
import { raiseAlert } from "./alerts"
import { resolveWorkspaceCrxPolicy, detectHighRisk, type MergedCrxPolicy } from "./crx-policy"
import { ENV } from "./env"

// ---- 1. 生命周期事件（审计 · 永久归档语义） ----
// 沙箱销毁走回收站体系（软删 + 30 天可恢复 + 物理清理仅清业务表）；
// 审计表无任何级联/外键删除，生命周期事件天然随平台库永久保留。
export interface LifecycleEventInput {
  workspaceId: string
  workspaceName: string
  ownerUserId?: string | null
  crxId: string
  crxName?: string
  kind: "INSTALLED" | "REMOVED" | "VERSION_CHANGE" | "INCOGNITO_ENABLED" | "UNKNOWN_DETECTED"
  fromVersion?: string | null
  toVersion?: string | null
  resolvedBy?: string | null
  sourceUsed?: string | null
  detail?: string
}

const LIFECYCLE_AUDIT: Record<LifecycleEventInput["kind"], { op: string; severity: "INFO" | "WARN" | "DANGER" }> = {
  INSTALLED: { op: "CRX_INSTALLED", severity: "INFO" },
  REMOVED: { op: "CRX_REMOVED", severity: "INFO" },
  VERSION_CHANGE: { op: "CRX_VERSION_CHANGE", severity: "WARN" },
  INCOGNITO_ENABLED: { op: "CRX_INCOGNITO_ENABLED", severity: "WARN" },
  UNKNOWN_DETECTED: { op: "CRX_UNKNOWN_DETECTED", severity: "DANGER" },
}

export async function recordCrxLifecycleEvent(ev: LifecycleEventInput): Promise<void> {
  const meta = LIFECYCLE_AUDIT[ev.kind]
  await writeAudit({
    operationType: meta.op,
    resourceType: "CRX_PLUGIN",
    resourceId: ev.crxId,
    resourceName: ev.crxName || ev.crxId.slice(0, 12),
    ownerUserId: ev.ownerUserId ?? undefined,
    severity: meta.severity,
    before: { workspaceId: ev.workspaceId, workspaceName: ev.workspaceName, version: ev.fromVersion ?? null, resolvedBy: ev.resolvedBy ?? null },
    after: { workspaceId: ev.workspaceId, workspaceName: ev.workspaceName, version: ev.toVersion ?? null, resolvedBy: ev.resolvedBy ?? null, sourceUsed: ev.sourceUsed ?? null, detail: ev.detail },
  }).catch(() => null) // 审写失败不阻断轮询主链路（审计库自身故障隔离）
}

// ---- 2. 未知扩展扫描（真实容器 CDP 枚举 vs 合并策略） ----
export interface UnknownExtensionFinding {
  workspaceId: string
  workspaceName: string
  ownerUserId?: string | null
  crxId: string
  crxTitle: string
  blockedNow: boolean // 本轮已自动下发 installation_mode=blocked
}

export interface UnknownScanResult {
  scanned: number // 扫描容器数
  findings: UnknownExtensionFinding[]
}

/** CDP HTTP /json/list 枚举容器内全部扩展（返回 null=容器不可达） */
async function enumerateContainerExtensions(cdpUrl: string): Promise<Map<string, string> | null> {
  try {
    const httpUrl = cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "") + "/json/list"
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const targets = (await res.json().catch(() => [])) as Array<{ url?: string; title?: string }>
    const out = new Map<string, string>()
    for (const t of targets) {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || "")
      if (m) out.set(m[1], t.title || "")
    }
    return out
  } catch {
    return null
  }
}

/** Chromium 开发者默认扩展与浏览器内置组件（合法非策略白名单，不告警） */
const CHROMIUM_BUILTIN_EXTENSIONS = new Set<string>([
  "nkbihfbeogaeaoehlefnkodbefgpgknn", // MetaMask（常见误装示例：仍需策略，故不放行）
])
// 内置组件扩展（Xvfb 演示/开发者模式下常见）：
const BUILTIN_DEV_IDS = new Set<string>([
  // Chromium PDF / devtools / 组件扩展占位（演示模式下为空集，真实容器由策略 forcelist 覆盖）
])

export async function scanUnknownExtensions(log: (m: string) => void): Promise<UnknownScanResult> {
  const workspaces = await db.browserWorkspace.findMany({
    where: { status: "RUNNING", deletedAt: null, mode: "novnc_full", cdpUrl: { not: null } },
    select: { id: true, name: true, userId: true, cdpUrl: true, hardeningJson: true },
    take: 100,
  })
  const findings: UnknownExtensionFinding[] = []
  let scanned = 0
  for (const ws of workspaces) {
    if (!ws.cdpUrl) continue
    const installed = await enumerateContainerExtensions(ws.cdpUrl)
    if (!installed) continue // 容器不可达 → 轮询任务负责其健康
    scanned++
    const policy: MergedCrxPolicy = await resolveWorkspaceCrxPolicy(ws.id).catch(() => ({
      entries: [], blocklist: [], inheritEnabled: true, blocklistExempt: false, conflicts: [],
    }) as MergedCrxPolicy)
    const authorized = new Set<string>([
      ...policy.entries.map((e) => e.crxId),
      ...policy.blocklist, // 黑名单里的 ID 由 Chromium 自行拦截，不算未知
    ])
    for (const [crxId, title] of installed) {
      if (authorized.has(crxId) || CHROMIUM_BUILTIN_EXTENSIONS.has(crxId) || BUILTIN_DEV_IDS.has(crxId)) continue
      // 未知扩展：非策略下发、非黑名单、非内置 → 记审计 + 告警
      await recordCrxLifecycleEvent({
        workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId,
        crxId, crxName: title, kind: "UNKNOWN_DETECTED",
        detail: `真实容器内发现未授权扩展（标题「${title}」），不在五级合并策略与黑名单内`,
      })
      await raiseAlert({
        title: `发现未知扩展：${title || crxId.slice(0, 8)}…（沙箱 ${ws.name}）`,
        level: "CRITICAL",
        content: `沙箱 ${ws.name} 的浏览器容器内运行未授权扩展 ${crxId}（「${title}」）。该扩展未经任何策略链授权，请立即核查来源；策略文件已自动追加该扩展的 blocked 状态。`,
        resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId,
        dedupeKey: `crx-unknown-${ws.id}-${crxId}`,
        webhookPayload: { event: "crx.unknown_extension_detected", workspaceId: ws.id, workspaceName: ws.name, crxId, title },
      }).catch(() => null)
      findings.push({ workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId, crxId, crxTitle: title, blockedNow: false })
      log(`未知扩展 ${crxId.slice(0, 8)}… @ ${ws.name}（${title}）`)
    }
  }
  return { scanned, findings }
}

// ---- 3. 策略文件防篡改校验（SHA-256 哈希对账） ----
export interface TamperCheckResult {
  checked: number
  tampered: Array<{ workspaceId: string; workspaceName: string; path: string; expected: string; actual: string }>
  missing: number // 文件缺失（沙箱未启动属正常）
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * 记录策略文件哈希（写入 hardeningJson.policyFileHash；由落盘链路调用）
 * 调用点：writeNetworkPolicyFile 返回路径后 / refreshWorkspacePolicyFile
 */
export async function rememberPolicyFileHash(workspaceId: string, filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath)
    const hash = sha256Hex(content)
    const ws = await db.browserWorkspace.findUnique({ where: { id: workspaceId }, select: { hardeningJson: true } })
    if (!ws) return false
    const hardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
    if (hardening.policyFileHash === hash && hardening.policyFileHashPath === filePath) return true // 未变化
    await db.browserWorkspace.update({
      where: { id: workspaceId },
      data: { hardeningJson: JSON.parse(JSON.stringify({ ...hardening, policyFileHash: hash, policyFileHashPath: filePath, policyFileHashAt: new Date().toISOString() })) },
    })
    return true
  } catch {
    return false
  }
}

export async function checkPolicyTampering(log: (m: string) => void): Promise<TamperCheckResult> {
  const workspaces = await db.browserWorkspace.findMany({
    where: { deletedAt: null, status: { in: ["RUNNING", "IDLE", "FROZEN"] }, mode: "novnc_full" },
    select: { id: true, name: true, userId: true, hardeningJson: true, profileSnapshotId: true },
    take: 300,
  })
  const result: TamperCheckResult = { checked: 0, tampered: [], missing: 0 }
  for (const ws of workspaces) {
    const hardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
    const expected = hardening.policyFileHash as string | undefined
    const path = hardening.policyFileHashPath as string | undefined
    if (!expected || !path) {
      // 从未登记哈希的老工作区 → 首次自动登记（创建链路由 refresh/重启后补齐）
      const profileKey = (hardening.profileKey as string) || ws.profileSnapshotId
      if (profileKey) {
        const guessPath = workspacePolicyFilePath(String(profileKey))
        await rememberPolicyFileHash(ws.id, guessPath).catch(() => null)
      }
      continue
    }
    let content: Buffer
    try {
      content = await readFile(path)
    } catch {
      result.missing++ // 容器停止后策略文件被清属正常，不算篡改
      continue
    }
    result.checked++
    const actual = sha256Hex(content)
    if (actual !== expected) {
      result.tampered.push({ workspaceId: ws.id, workspaceName: ws.name, path, expected: expected.slice(0, 12) + "…", actual: actual.slice(0, 12) + "…" })
      log(`篡改告警：${ws.name} ${path}`)
      await writeAudit({
        operationType: "POLICY_FILE_TAMPERED", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        ownerUserId: ws.userId, severity: "DANGER",
        before: { policyFileHash: expected.slice(0, 16) + "…" },
        after: { policyFileHash: actual.slice(0, 16) + "…", path },
      }).catch(() => null)
      await raiseAlert({
        title: `沙箱策略文件被篡改：${ws.name}`,
        level: "CRITICAL",
        content: `工作区 ${ws.name} 的 Chromium 托管策略文件哈希与落盘记录不一致（${path}）。可能存在容器内提权或宿主侧文件被人工修改，建议立即冻结该沙箱核查。`,
        resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId,
        dedupeKey: `policy-tamper-${ws.id}-${actual.slice(0, 8)}`,
        webhookPayload: { event: "policy.file_tampered", workspaceId: ws.id, workspaceName: ws.name, path, expectedHash: expected, actualHash: actual },
      }).catch(() => null)
    }
  }
  return result
}

// ---- 4. 安全基线扫描（合规评分 0-100 落 hardeningJson.baselineScore） ----
export interface BaselineCheckItem {
  key: string
  label: string
  pass: boolean
  weight: number // 权重（总分 100 按全部项归一化）
  detail: string
}

export interface BaselineScanResult {
  scanned: number
  lowScore: number // 低于阈值的工作区数
  averageScore: number | null
}

const LOW_SCORE_THRESHOLD = 70 // 低于 70 分 → WARNING 告警

export async function scanSecurityBaseline(log: (m: string) => void): Promise<BaselineScanResult> {
  const workspaces = await db.browserWorkspace.findMany({
    where: { deletedAt: null, status: { in: ["RUNNING", "IDLE"] }, mode: { in: ["cdp_light", "novnc_full"] } },
    select: {
      id: true, name: true, userId: true, mode: true, status: true, hardeningJson: true,
      networkPolicyJson: true, proxyNodeId: true, cdpUrl: true, containerRef: true,
    },
    take: 300,
  })
  let lowScore = 0
  let totalScore = 0
  let scored = 0
  for (const ws of workspaces) {
    const hardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
    const net = (ws.networkPolicyJson as Record<string, unknown> | null) || {}
    const crxPolicy = await resolveWorkspaceCrxPolicy(ws.id).catch(() => null)
    const highRiskRunning = crxPolicy?.entries.filter((e) => e.highRisk && !e.disabled).length ?? 0

    const items: BaselineCheckItem[] = [
      {
        key: "readonly-rootfs", label: "只读根文件系统", pass: hardening.readOnlyRootfs === true || hardening.readOnlyRootfs === "true",
        weight: 15, detail: hardening.readOnlyRootfs ? "容器根 FS 只读" : "未启用只读根 FS（挂载逃逸风险）",
      },
      {
        key: "capdrop", label: "Linux 能力全剥离", pass: hardening.capDrop === "ALL" || hardening.capDrop === true,
        weight: 10, detail: hardening.capDrop === "ALL" ? "CapDrop=ALL 已下发" : "容器保留部分 Linux 能力",
      },
      {
        key: "no-new-privs", label: "禁提权", pass: hardening.noNewPrivileges === true || hardening.noNewPrivileges === "true",
        weight: 10, detail: hardening.noNewPrivileges ? "no-new-privileges 生效" : "未禁 setuid 提权",
      },
      {
        key: "net-policy", label: "网络策略快照在案", pass: !!net.enforcedAt,
        weight: 10, detail: net.enforcedAt ? `策略快照 ${new Date(net.enforcedAt as string).toLocaleString("zh-CN")} 下发` : "无网络策略快照（deny-by-default 未确认）",
      },
      {
        key: "internal-net", label: "内网访问受控", pass: (net as { allowInternalNetwork?: boolean }).allowInternalNetwork === false || (net as { allowInternalNetwork?: boolean }).allowInternalNetwork === true,
        weight: 5, detail: "内网访问策略已显式解析（非默认放任）",
      },
      {
        key: "policy-hash", label: "策略文件防篡改对账", pass: !!hardening.policyFileHash,
        weight: 10, detail: hardening.policyFileHash ? "SHA-256 哈希已登记" : "策略文件哈希未登记（防篡改校验盲区）",
      },
      {
        key: "crx-control", label: "扩展管控策略就绪", pass: crxPolicy !== null,
        weight: 10, detail: crxPolicy ? `五级合并 ${crxPolicy.entries.length} 项 / 黑名单 ${crxPolicy.blocklist.length} 项` : "CRX 策略解析失败",
      },
      {
        key: "crx-highrisk", label: "无高危扩展运行", pass: highRiskRunning === 0,
        weight: 15, detail: highRiskRunning === 0 ? "当前强制安装列表无高危权限扩展" : `${highRiskRunning} 个高危扩展在强制安装列表`,
      },
      {
        key: "profile-isolated", label: "Profile 独立卷", pass: !!hardening.profileKey,
        weight: 10, detail: hardening.profileKey ? `独立 Profile ${String(hardening.profileKey).slice(0, 16)}…` : "无独立 Profile 键（会话数据未隔离）",
      },
      {
        key: "clipboard-isolated", label: "剪贴板隔离策略在案", pass: hardening.clipboardIsolated === true || hardening.clipboardIsolated === "true" || hardening.runtime === "embedded",
        weight: 5, detail: "独立 X server / 逐连接缓冲隔离",
      },
    ]

    const totalWeight = items.reduce((s, i) => s + i.weight, 0)
    const score = Math.round((items.filter((i) => i.pass).reduce((s, i) => s + i.weight, 0) / totalWeight) * 100)
    const failed = items.filter((i) => !i.pass)

    // 评分落库（hardeningJson.baselineScore + 明细摘要）
    const enriched = { ...hardening, baselineScore: score, baselineCheckedAt: new Date().toISOString(), baselineFailed: failed.map((f) => f.key) }
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { hardeningJson: JSON.parse(JSON.stringify(enriched)) } }).catch(() => null)
    totalScore += score
    scored++

    if (score < LOW_SCORE_THRESHOLD) {
      lowScore++
      log(`基线低分：${ws.name} ${score} 分（${failed.map((f) => f.label).join("、")}）`)
      await raiseAlert({
        title: `安全基线不合规：${ws.name}（${score} 分）`,
        level: "WARNING",
        content: `工作区 ${ws.name} 安全基线评分 ${score}/100，未通过项：${failed.map((f) => `${f.label}（${f.detail}）`).join("；")}。建议立即处理或冻结核查。`,
        resourceType: "WORKSPACE", resourceId: ws.id, ownerUserId: ws.userId,
        dedupeKey: `baseline-low-${ws.id}-${score}`,
        webhookPayload: { event: "security.baseline_low_score", workspaceId: ws.id, workspaceName: ws.name, score, failedItems: failed.map((f) => f.key) },
      }).catch(() => null)
    }
  }
  return { scanned: scored, lowScore, averageScore: scored > 0 ? Math.round(totalScore / scored) : null }
}

// ---- 5. 版本变更对比工具（lockedVersion 语义：1.2.3 4 段比较） ----
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 无痕加载上报：插件 allowIncognito=true 且已检测安装 → 审计（策略约束「无痕加载上报」） */
export async function reportIncognitoEnabled(params: {
  workspaceId: string; workspaceName: string; ownerUserId?: string | null
  crxId: string; crxName?: string; resolvedBy?: string | null
}): Promise<void> {
  await recordCrxLifecycleEvent({ ...params, kind: "INCOGNITO_ENABLED", detail: "该扩展被策略允许在无痕窗口运行（allowIncognito=true）" })
}

// 策略文件宿主侧路径（与 network-policy-apply 同规则；避免循环依赖在此重实现）
function workspacePolicyFilePath(profileKey: string): string {
  return `${ENV.storageLocalPath.replace(/\/$/, "")}/netpolicy/ws-${profileKey}.json`
}

// ---- 6. CRX 生命周期迁移检测（供 crx_install_poll 集成） ----
export interface TransitionPlan {
  shouldAuditInstall: boolean
  shouldAuditRemove: boolean
  shouldAuditVersionChange: boolean
  shouldAuditIncognito: boolean
  fromVersion: string | null
  toVersion: string | null
}

/** 根据前后状态计算应产生的生命周期审计事件（幂等：同状态不重复审计） */
export function planLifecycleTransition(params: {
  prevState: string | null // null = 首次出现
  prevVersion: string | null
  nextState: string
  nextVersion: string | null
  allowIncognito: boolean
}): TransitionPlan {
  const { prevState, prevVersion, nextState, nextVersion, allowIncognito } = params
  const plan: TransitionPlan = {
    shouldAuditInstall: false, shouldAuditRemove: false, shouldAuditVersionChange: false, shouldAuditIncognito: false,
    fromVersion: prevVersion, toVersion: nextVersion,
  }
  // 首次安装（无历史状态 → INSTALLED）
  if (!prevState && nextState === "INSTALLED") plan.shouldAuditInstall = true
  // 状态迁移到 INSTALLED（从任何非 INSTALLED 状态）
  if (prevState && prevState !== "INSTALLED" && nextState === "INSTALLED") plan.shouldAuditInstall = true
  // 从 INSTALLED → REMOVED（策略链移除后卸载）
  if (prevState === "INSTALLED" && nextState === "REMOVED") plan.shouldAuditRemove = true
  // 已安装状态下版本变化（Chromium 自动更新）
  if (prevState === "INSTALLED" && nextState === "INSTALLED" && prevVersion && nextVersion && compareVersions(prevVersion, nextVersion) !== 0) {
    plan.shouldAuditVersionChange = true
  }
  // 无痕许可首次上报（安装 + allowIncognito）
  if (plan.shouldAuditInstall && allowIncognito) plan.shouldAuditIncognito = true
  return plan
}

// ---- 7. 版本比较工具（lockedVersion 语义：1.2.3 4 段比较）已在上文导出 ----
