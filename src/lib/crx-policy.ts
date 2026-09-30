// ============================================================
// CRX 扩展管控核心引擎（企业浏览器后台 · 零内核 Patch）
// 全部依赖 Chromium 原生 Managed Preferences：
//   · ExtensionInstallForcelist  ["<crxId>;<update_url>"]  每插件独立源
//   · ExtensionInstallBlocklist  ["<crxId>"]               CRX 黑名单
//   · ExtensionSettings { <crxId>: { installation_mode, update_url, blocked_permissions } }
// 约束：后台不存 CRX 二进制，只维护扩展 ID + update_url 元数据
//
// 五级策略优先级（高→低）：
//   沙箱单插件独立配置 > 用户单插件配置 > 用户组策略 > 全局策略 > CRX 插件库默认配置
// 继承规则：沙箱关闭 crxInheritEnabled 后强制安装列表不继承上层，但黑名单仍继承
//          （超管可为单个沙箱开 crxBlocklistExempt 豁免黑名单）
// 校验：同一 CRX-ID 禁止同时存在于强制安装列表与黑名单（保存时拦截）；
//      update_url / 版本号格式校验；单沙箱强制安装数量上限
// ============================================================

import { db } from "./db"

// 高危权限关键词（manifest 权限命中即自动标记高危）
const HIGH_RISK_PERMISSIONS = [
  "all_urls", "<all_urls>", "*://*/*", "clipboardRead", "clipboardWrite",
  "downloads", "downloads.open", "tabs", "cookies", "history",
  "camera", "microphone", "desktopCapture", "pageCapture", "nativeMessaging",
  "debugger", "proxy", "privacy", "management", "webRequestBlocking",
]

export function detectHighRisk(permissions: string[]): { highRisk: boolean; reasons: string[] } {
  const lower = permissions.map((p) => p.toLowerCase())
  const reasons: string[] = []
  for (const h of HIGH_RISK_PERMISSIONS) {
    if (lower.includes(h.toLowerCase())) reasons.push(h)
  }
  return { highRisk: reasons.length > 0, reasons: Array.from(new Set(reasons)) }
}

// ---- 校验：CRX-ID / update_url / 版本号格式 ----
export function isValidCrxId(id: string): boolean {
  return /^[a-p]{32}$/.test(id) // Chrome 商店扩展 ID：32 位 a-p
}

export function isValidUpdateUrl(url: string): boolean {
  if (!/^https?:\/\//.test(url) && !/^http:\/\/[a-zA-Z0-9._:-]+(:\d+)?\//.test(url)) return false
  try {
    const u = new URL(url)
    return !!u.hostname && u.hostname.length <= 200
  } catch {
    return false
  }
}

export function isValidVersion(v: string): boolean {
  return /^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) // Chromium 版本：1-4 段数字
}

// ---- 合并结果结构 ----
export interface MergedCrxEntry {
  crxId: string
  updateUrl: string // 合并后生效主源
  backupUpdateUrl: string | null
  lockedVersion: string | null
  allowIncognito: boolean
  allowUserDisable: boolean
  highRisk: boolean
  disabled: boolean // 插件库已禁用 → 不进入强制安装
  resolvedBy: "SANDBOX" | "USER" | "GROUP" | "GLOBAL" | "LIBRARY"
}

export interface MergedCrxPolicy {
  entries: MergedCrxEntry[] // 强制安装列表（含逐插件源/版本/无痕/可禁用）
  blocklist: string[] // 强制禁止安装（黑名单，跨继承始终生效）
  inheritEnabled: boolean // 沙箱是否继承上层
  blocklistExempt: boolean // 沙箱是否豁免黑名单（超管）
  conflicts: string[] // 合并期间发现的冲突（forcelist × blocklist 交集，过滤并上报）
}

// 单沙箱强制安装扩展数量上限（超过给警告，不硬失败）
export const MAX_FORCED_EXTENSIONS_PER_SANDBOX = 50

// ---- 五级合并（读取路径：库默认 < 全局 < 用户组 < 用户 < 沙箱 < 沙箱单插件覆盖） ----
export async function resolveWorkspaceCrxPolicy(workspaceId: string): Promise<MergedCrxPolicy> {
  const ws = await db.browserWorkspace.findUnique({
    where: { id: workspaceId },
    select: { userId: true, groupId: true, crxInheritEnabled: true, crxBlocklistExempt: true },
  })
  if (!ws) return { entries: [], blocklist: [], inheritEnabled: true, blocklistExempt: false, conflicts: [] }
  // 用户组解析：工作区显式 groupId 优先；否则取用户所属组（GroupUser 联接，取最近加入的一条）
  let groupIds: string[] = []
  if (ws.groupId) groupIds.push(ws.groupId)
  else {
    const gu = await db.groupUser.findFirst({ where: { userId: ws.userId }, orderBy: { createdAt: "desc" }, select: { groupId: true } })
    if (gu) groupIds.push(gu.groupId)
  }

  // 收集黑名单（GLOBAL + 组 + 用户 + 沙箱全部叠加；黑名单不随继承开关失效）
  const blockEntries = await db.crxBlocklistEntry.findMany({
    where: {
      OR: [
        { scopeType: "GLOBAL" },
        { scopeType: "GROUP", scopeId: { in: groupIds } },
        { scopeType: "USER", scopeId: ws.userId },
        { scopeType: "SANDBOX", scopeId: workspaceId },
      ],
    },
    select: { crxId: true, scopeType: true },
  })
  const blockSet = new Set(blockEntries.map((b) => b.crxId))

  // 层级叠加顺序（低→高）：GLOBAL → GROUP → USER → SANDBOX（沙箱继承关闭则仅 SANDBOX 层）
  // 约定：GLOBAL 层 scopeId 恒为空串（""，SQLite 唯一约束对 NULL 不生效，统一空串保证幂等）
  const layers: { scopeType: "GLOBAL" | "GROUP" | "USER" | "SANDBOX"; scopeId: string }[] = []
  if (ws.crxInheritEnabled) {
    layers.push({ scopeType: "GLOBAL", scopeId: "" })
    for (const gid of groupIds) layers.push({ scopeType: "GROUP", scopeId: gid })
    layers.push({ scopeType: "USER", scopeId: ws.userId })
  }
  layers.push({ scopeType: "SANDBOX", scopeId: workspaceId })

  const merged = new Map<string, MergedCrxEntry>()
  const resolvedBy = new Map<string, MergedCrxEntry["resolvedBy"]>()

  for (const layer of layers) {
    const entries = await db.crxPolicyEntry.findMany({
      where: { scopeType: layer.scopeType, scopeId: layer.scopeId, deletedAt: null },
    })
    for (const e of entries) {
      const lib = await db.crxPlugin.findUnique({ where: { crxId: e.crxId } })
      // 库内不存在或已软删 → 上层错误配置，跳过（审计告警由轮询任务负责）
      if (!lib || lib.deletedAt) continue
      const libPermissions = Array.isArray(lib.permissions) ? (lib.permissions as string[]) : []
      const hr = detectHighRisk(libPermissions)
      const base: MergedCrxEntry | undefined = merged.get(e.crxId)
      const next: MergedCrxEntry = {
        crxId: e.crxId,
        updateUrl: e.updateUrl || base?.updateUrl || lib.updateUrl,
        backupUpdateUrl: e.backupUpdateUrl !== null && e.backupUpdateUrl !== undefined ? e.backupUpdateUrl : base?.backupUpdateUrl ?? lib.backupUpdateUrl,
        lockedVersion: e.lockedVersion || base?.lockedVersion || lib.lockedVersion,
        allowIncognito: e.allowIncognito !== null && e.allowIncognito !== undefined ? e.allowIncognito : base?.allowIncognito ?? lib.allowIncognito,
        allowUserDisable: e.allowUserDisable !== null && e.allowUserDisable !== undefined ? e.allowUserDisable : base?.allowUserDisable ?? lib.allowUserDisable,
        highRisk: lib.highRisk || hr.highRisk,
        disabled: !lib.enabled, // 库内禁用：继承链上保留记录但标记不安装
        resolvedBy: layer.scopeType,
      }
      merged.set(e.crxId, next)
      resolvedBy.set(e.crxId, layer.scopeType)
    }
  }

  // 沙箱单插件独立配置（SANDBOX 单插件粒度 = 最高优先级，覆盖上面 SANDBOX 层的通用值）
  // 实现形态：CrxPolicyEntry scopeType=SANDBOX 即为单插件粒度（每个 crxId 一条），天然覆盖。

  // 黑名单过滤 + 冲突检测
  const conflicts: string[] = []
  const entries: MergedCrxEntry[] = []
  for (const [crxId, e] of merged) {
    if (blockSet.has(crxId)) {
      if (ws.crxBlocklistExempt) {
        conflicts.push(`CRX ${crxId} 命中黑名单但沙箱已获超管豁免（继续安装）`)
        entries.push(e) // 豁免：继续安装
      } else {
        conflicts.push(`CRX ${crxId} 同时存在于强制安装与黑名单 → 已从安装列表移除`)
      }
      continue
    }
    if (e.disabled) continue // 库内禁用不安装
    entries.push(e)
  }

  return {
    entries,
    blocklist: ws.crxBlocklistExempt ? [] : Array.from(blockSet),
    inheritEnabled: ws.crxInheritEnabled,
    blocklistExempt: ws.crxBlocklistExempt,
    conflicts: Array.from(new Set(conflicts)),
  }
}

// ---- Managed Preferences 生成（真实 Chromium 策略结构） ----
export function buildCrxManagedPolicy(policy: MergedCrxPolicy): Record<string, unknown> {
  // ExtensionInstallForcelist：每插件独立 update_url（"<id>;<url>"）
  const forcelist = policy.entries.map((e) => `${e.crxId};${e.updateUrl}`)
  // ExtensionSettings：installation_mode + per-plugin 细粒度
  //   allowUserDisable=false → force_installed（用户不可禁用/卸载）
  //   allowUserDisable=true  → normal_installed（强制安装但用户可禁用）
  //   高危插件默认封禁敏愈权限（blocked_permissions 提示性收紧）
  const settings: Record<string, unknown> = {}
  for (const e of policy.entries) {
    const conf: Record<string, unknown> = {
      installation_mode: e.allowUserDisable ? "normal_installed" : "force_installed",
      update_url: e.updateUrl,
      minimum_version_required: e.lockedVersion || undefined,
    }
    if (e.allowIncognito) conf.incognito = true
    if (e.highRisk) {
      conf.blocked_permissions = ["nativeMessaging", "debugger", "clipboardWrite", "history"]
    }
    settings[e.crxId] = conf
  }
  const managed: Record<string, unknown> = {}
  if (forcelist.length > 0) managed.ExtensionInstallForcelist = forcelist
  if (policy.blocklist.length > 0) managed.ExtensionInstallBlocklist = policy.blocklist
  if (Object.keys(settings).length > 0) managed.ExtensionSettings = settings
  // 禁止用户拖拽本地 CRX 安装 / 解压加载未打包扩展（企业默认安全基线）
  managed.ExtensionInstallSources = []
  managed.ExtensionAllowedInstallSources = []
  managed.ExtensionInstallSignaturesRequired = true
  return managed
}

// ---- 前置配置校验（保存时拦截）----
export interface CrxConfigCheck {
  ok: boolean
  message?: string
}

export async function checkForceBlocklistConflict(params: {
  scopeType: string
  scopeId: string | null
  crxId: string
}): Promise<CrxConfigCheck> {
  // 同一 CRX-ID 在同作用域同时存在于强制安装与黑名单 → 拒绝保存
  const inBlock = await db.crxBlocklistEntry.findFirst({
    where: { scopeType: params.scopeType, scopeId: params.scopeId, crxId: params.crxId },
  })
  if (inBlock) return { ok: false, message: `CRX ${params.crxId} 已在本作用域黑名单中，禁止同时加入强制安装列表` }
  const inForce = await db.crxPolicyEntry.findFirst({
    where: { scopeType: params.scopeType, scopeId: params.scopeId, crxId: params.crxId, deletedAt: null },
  })
  // 黑名单保存入口也复用此校验（方向对称）
  return { ok: true, ...(inForce ? { message: `注意：CRX ${params.crxId} 同时在本作用域强制安装列表中` } : {}) }
}

// 单沙箱强制安装数量上限校验
export async function checkSandboxForcelistLimit(workspaceId: string, adding: number): Promise<CrxConfigCheck> {
  const policy = await resolveWorkspaceCrxPolicy(workspaceId)
  const total = policy.entries.length + adding
  if (total > MAX_FORCED_EXTENSIONS_PER_SANDBOX) {
    return { ok: false, message: `单沙箱强制安装扩展已达上限（${MAX_FORCED_EXTENSIONS_PER_SANDBOX}，当前合并后 ${total}），请先精简插件列表` }
  }
  return { ok: true }
}
