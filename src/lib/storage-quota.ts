import { db } from "@/lib/db"
import { getConfigNumber, getConfigBool } from "@/lib/config"
import { userGroupIds } from "@/lib/permissions"

// ============================================================
// r33：统一存储配额体系（用户云盘 + 录像 + 截图 一体计量）
// ============================================================
// 设计（与闲置超时/录像策略一致的三级策略链，全部可后台精细分配）：
//   总配额 storageQuotaMb：用户级(非null) > 用户组级(非null，多组取首个非空) > 全局 storage.quotaPerUserMb
//     · 0 = 不限（永不拒绝写入，仅统计展示）
//     · null = 继承上层
//   功能开关 storagePolicy（稀疏 JSON，字段级覆盖，未设置字段=继承）：
//     { recording?: bool, screenshot?: bool, upload?: bool,
//       recordingMb?: number, screenshotMb?: number, fileMb?: number }
//     · 总开关 storage.featureEnabled=false → 全员禁（最强否决）
//     · 分类子配额（null/缺省=不限，仅受总配额约束）：录像/截图/云盘文件分别限额
//   计量口径：FileMeta（category=RECORDING/SCREENSHOT/GENERAL...，userId=本人，未物理删除）
//     —— r32 起录像分段 finalize 与 VNC 截图均入 FileMeta，天然统一口径
// ============================================================

export type StorageSource = "user" | "group" | "global"

export interface StorageCategoryQuota {
  /** 分类子配额 MB（null=不限） */
  recordingMb: number | null
  screenshotMb: number | null
  fileMb: number | null
}

export interface StoragePolicy {
  /** 总配额 MB（0=不限） */
  totalMb: number
  source: StorageSource
  sourceLabel: string
  /** 功能开关（总开关 false 时全部强制 false） */
  storageEnabled: boolean
  recordingAllowed: boolean
  screenshotAllowed: boolean
  uploadAllowed: boolean
  /** 开关生效来源说明（诊断/展示用） */
  switchSourceLabel: string
  /** 分类子配额（null=不限） */
  category: StorageCategoryQuota
  /** 原始层级值（表单回显/诊断） */
  raw: { userQuotaMb: number | null; groupQuotaMb: number | null; globalQuotaMb: number }
}

/** 稀疏策略 JSON 解析（容错：坏数据视为未设置） */
function parsePolicyJson(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string") {
    try { return JSON.parse(v) as Record<string, unknown> } catch { return {} }
  }
  return {}
}

const SOURCE_LABELS: Record<StorageSource, string> = { user: "用户级", group: "用户组级", global: "全局默认" }

/** 三级链解析：用户 > 组 > 全局（值链与开关链独立解析，字段级覆盖） */
export async function resolveStoragePolicy(userId: string): Promise<StoragePolicy> {
  const [user, gids] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { storageQuotaMb: true, storagePolicy: true, role: true } }),
    userGroupIds(userId),
  ])
  const groups = gids.length
    ? await db.group.findMany({ where: { id: { in: gids }, deletedAt: null }, select: { id: true, name: true, storageQuotaMb: true, storagePolicy: true }, orderBy: { createdAt: "asc" } })
    : []

  // ---- 值链：总配额 ----
  const userQuotaMb = user?.storageQuotaMb ?? null
  let groupQuotaMb: number | null = null
  for (const g of groups) {
    if (g.storageQuotaMb != null) { groupQuotaMb = g.storageQuotaMb; break }
  }
  const globalQuotaMb = Math.max(0, await getConfigNumber("storage.quotaPerUserMb", 2048))
  const totalMb = userQuotaMb != null ? userQuotaMb : groupQuotaMb != null ? groupQuotaMb : globalQuotaMb
  const source: StorageSource = userQuotaMb != null ? "user" : groupQuotaMb != null ? "group" : "global"

  // ---- 开关链：总开关 > 用户字段 > 组字段 > 全局 ----
  const masterEnabled = await getConfigBool("storage.featureEnabled", true)
  const gUser = parsePolicyJson(user?.storagePolicy)
  const gGroup: Record<string, unknown> = {}
  for (const g of groups) {
    const j = parsePolicyJson(g.storagePolicy)
    for (const k of ["recording", "screenshot", "upload", "recordingMb", "screenshotMb", "fileMb"]) {
      if (gGroup[k] === undefined && j[k] !== undefined && j[k] !== null) gGroup[k] = j[k]
    }
  }
  const pickBool = async (key: string, globalKey: string): Promise<boolean> => {
    const uv = gUser[key]
    if (typeof uv === "boolean") return uv
    const gv = gGroup[key]
    if (typeof gv === "boolean") return gv
    return await getConfigBool(globalKey, true)
  }
  const pickNum = (key: string): number | null => {
    const uv = gUser[key]
    if (typeof uv === "number" && Number.isFinite(uv) && uv >= 0) return Math.floor(uv)
    const gv = gGroup[key]
    if (typeof gv === "number" && Number.isFinite(gv) && gv >= 0) return Math.floor(gv)
    return null
  }
  // 开关来源标签（诊断：最靠近用户层的设置者）
  let switchSourceLabel = "全局默认"
  if (typeof gUser.recording === "boolean" || typeof gUser.screenshot === "boolean" || typeof gUser.upload === "boolean") switchSourceLabel = "用户级覆盖"
  else if (Object.keys(gGroup).some((k) => ["recording", "screenshot", "upload"].includes(k))) switchSourceLabel = "用户组级基线"

  return {
    totalMb,
    source,
    sourceLabel: SOURCE_LABELS[source],
    storageEnabled: masterEnabled,
    recordingAllowed: masterEnabled && (await pickBool("recording", "storage.recordingEnabled")),
    screenshotAllowed: masterEnabled && (await pickBool("screenshot", "storage.screenshotEnabled")),
    uploadAllowed: masterEnabled && (await pickBool("upload", "storage.uploadEnabled")),
    switchSourceLabel,
    category: { recordingMb: pickNum("recordingMb"), screenshotMb: pickNum("screenshotMb"), fileMb: pickNum("fileMb") },
    raw: { userQuotaMb, groupQuotaMb, globalQuotaMb },
  }
}

export interface StorageUsage {
  totalBytes: number
  recordingBytes: number
  screenshotBytes: number
  fileBytes: number
  recordingCount: number
  screenshotCount: number
  fileCount: number
}

/** 用量聚合（FileMeta 口径；软删除不计入；AVATAR 不计） */
export async function getUserStorageUsage(userId: string): Promise<StorageUsage> {
  const rows = await db.fileMeta.groupBy({
    by: ["category"],
    where: { userId, deletedAt: null, purgedAt: null, category: { not: "AVATAR" } },
    _sum: { size: true },
    _count: { _all: true },
  })
  const pick = (cat: string) => rows.find((r) => r.category === cat)
  const recording = pick("RECORDING")
  const screenshot = pick("SCREENSHOT")
  const totalBytes = rows.reduce((acc, r) => acc + (r._sum.size || 0), 0)
  const fileBytes = totalBytes - (recording?._sum.size || 0) - (screenshot?._sum.size || 0)
  const fileCount = rows.reduce((acc, r) => acc + r._count._all, 0) - (recording?._count._all || 0) - (screenshot?._count._all || 0)
  return {
    totalBytes,
    recordingBytes: recording?._sum.size || 0,
    screenshotBytes: screenshot?._sum.size || 0,
    fileBytes,
    recordingCount: recording?._count._all || 0,
    screenshotCount: screenshot?._count._all || 0,
    fileCount,
  }
}

export interface StorageCheckResult {
  ok: boolean
  reason?: string
  /** 检查后剩余空间（MB，配额不限时为 null） */
  freeMb: number | null
}

/**
 * 写入前配额校验（统一入口：上传 / 录像入库 / 截图入库）
 * @param kind 写入类别（总配额 + 分类子配额双重校验）
 */
export async function checkStorageQuota(
  userId: string,
  incomingBytes: number,
  kind: "recording" | "screenshot" | "upload",
): Promise<StorageCheckResult> {
  const [policy, usage] = await Promise.all([resolveStoragePolicy(userId), getUserStorageUsage(userId)])
  const incomingMb = incomingBytes / (1024 * 1024)
  const freeMb = policy.totalMb > 0 ? Math.max(0, policy.totalMb - usage.totalBytes / (1024 * 1024)) : null

  if (policy.totalMb > 0) {
    const usedMb = usage.totalBytes / (1024 * 1024)
    if (usedMb + incomingMb > policy.totalMb) {
      return {
        ok: false,
        reason: `存储配额不足：已用 ${fmtMb(usedMb)} / ${fmtMb(policy.totalMb)}，本次写入约 ${fmtMb(incomingMb)}（可在个人中心清理录像/截图/云盘文件，或联系管理员调整配额）`,
        freeMb,
      }
    }
  }
  // 分类子配额
  const catLimit = kind === "recording" ? policy.category.recordingMb : kind === "screenshot" ? policy.category.screenshotMb : policy.category.fileMb
  if (catLimit != null && catLimit > 0) {
    const catUsed = kind === "recording" ? usage.recordingBytes : kind === "screenshot" ? usage.screenshotBytes : usage.fileBytes
    const catUsedMb = catUsed / (1024 * 1024)
    if (catUsedMb + incomingMb > catLimit) {
      const label = kind === "recording" ? "录像" : kind === "screenshot" ? "截图" : "云盘文件"
      return {
        ok: false,
        reason: `${label}分类配额不足：已用 ${fmtMb(catUsedMb)} / ${fmtMb(catLimit)}（管理员为${label}单独设置了限额）`,
        freeMb,
      }
    }
  }
  return { ok: true, freeMb }
}

/** 水位预警（超额/接近超额时提醒；dedupe：单用户 1 小时 1 条） */
export async function notifyStorageWatermark(userId: string): Promise<void> {
  try {
    const [policy, usage] = await Promise.all([resolveStoragePolicy(userId), getUserStorageUsage(userId)])
    if (policy.totalMb <= 0) return
    const pct = (usage.totalBytes / (1024 * 1024) / policy.totalMb) * 100
    const watermark = Math.max(50, await getConfigNumber("storage.watermarkPct", 80))
    if (pct < watermark) return
    const dedupeKey = `storage-watermark-${userId}`
    const g = globalThis as unknown as { __dyStorageWarnAt?: Map<string, number> }
    if (!g.__dyStorageWarnAt) g.__dyStorageWarnAt = new Map()
    const last = g.__dyStorageWarnAt.get(dedupeKey) || 0
    if (Date.now() - last < 3600_000) return
    g.__dyStorageWarnAt.set(dedupeKey, Date.now())
    await db.notice.create({
      data: {
        userId,
        title: `存储空间已使用 ${pct.toFixed(0)}%`,
        content: `配额 ${fmtMb(policy.totalMb)}（${policy.sourceLabel}），已用 ${fmtMb(usage.totalBytes / (1024 * 1024))}：录像 ${fmtMb(usage.recordingBytes / (1024 * 1024))} · 截图 ${fmtMb(usage.screenshotBytes / (1024 * 1024))} · 云盘文件 ${fmtMb(usage.fileBytes / (1024 * 1024))}。可在「我的文件」清理空间，或联系管理员调整配额。`,
        type: "ALERT",
        link: "/files",
        sourceType: "FILE",
        sourceKey: userId,
      },
    })
  } catch { /* 通知失败不影响主流程 */ }
}

export function fmtMb(mb: number): string {
  if (mb < 1) return `${(mb * 1024).toFixed(0)}KB`
  if (mb < 1024) return `${mb.toFixed(1)}MB`
  return `${(mb / 1024).toFixed(2)}GB`
}

/** 序列化视图（个人中心/仪表盘/管理端用户行） */
export interface StorageOverviewView {
  policy: {
    totalMb: number
    sourceLabel: string
    storageEnabled: boolean
    recordingAllowed: boolean
    screenshotAllowed: boolean
    uploadAllowed: boolean
    switchSourceLabel: string
    category: { recordingMb: number | null; screenshotMb: number | null; fileMb: number | null }
  }
  usage: {
    totalMb: number
    recordingMb: number
    screenshotMb: number
    fileMb: number
    recordingCount: number
    screenshotCount: number
    fileCount: number
  }
  pct: number | null // null=配额不限
}

export async function getStorageOverview(userId: string): Promise<StorageOverviewView> {
  const [policy, usage] = await Promise.all([resolveStoragePolicy(userId), getUserStorageUsage(userId)])
  const usageMb = usage.totalBytes / (1024 * 1024)
  return {
    policy: {
      totalMb: policy.totalMb,
      sourceLabel: policy.sourceLabel,
      storageEnabled: policy.storageEnabled,
      recordingAllowed: policy.recordingAllowed,
      screenshotAllowed: policy.screenshotAllowed,
      uploadAllowed: policy.uploadAllowed,
      switchSourceLabel: policy.switchSourceLabel,
      category: policy.category,
    },
    usage: {
      totalMb: Math.round(usageMb * 10) / 10,
      recordingMb: Math.round((usage.recordingBytes / (1024 * 1024)) * 10) / 10,
      screenshotMb: Math.round((usage.screenshotBytes / (1024 * 1024)) * 10) / 10,
      fileMb: Math.round((usage.fileBytes / (1024 * 1024)) * 10) / 10,
      recordingCount: usage.recordingCount,
      screenshotCount: usage.screenshotCount,
      fileCount: usage.fileCount,
    },
    pct: policy.totalMb > 0 ? Math.min(100, Math.round((usageMb / policy.totalMb) * 100)) : null,
  }
}
