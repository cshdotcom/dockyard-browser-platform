import { db } from "@/lib/db"
import { getConfigNumber, getConfigBool } from "@/lib/config"
import { userGroupIds } from "@/lib/permissions"

// ============================================================
// r33：沙箱最大生存时长（TTL）策略链
// ============================================================
// 需求：用户创建沙箱时可选时长 ≤ 管理员为该用户/用户组配置的最大时长；
//       且有开关决定是否允许「无限时长」。
// 解析（与闲置超时一致的三级链）：
//   maxTtlMinutes：用户级(非null) > 用户组级(非null，多组取首个非空) > 全局 workspace.maxTtlMinutes
//     · 0 = 不限（不设上限）
//     · null = 继承上层
//   allowUnlimitedTtl：用户级(非null) > 组级(非null) > 全局 workspace.allowUnlimitedTtl
// 语义：
//   · maxTtl=0 且 allowUnlimited=true → 完全放开（默认）
//   · allowUnlimited=false → 创建必选有限时长（1 ≤ ttl ≤ maxTtl；maxTtl=0 时强制按全局兜底 43200）
//   · 管理员角色豁免（可设置任意值，便于运维与模板验证）
// ============================================================

export type TtlSource = "user" | "group" | "global"

export interface TtlPolicy {
  /** 最大时长（分钟，0=不限） */
  maxTtlMinutes: number
  source: TtlSource
  sourceLabel: string
  /** 是否允许选择「无限时长」 */
  allowUnlimited: boolean
  unlimitedSourceLabel: string
  /** 原始层级值（表单回显/诊断） */
  raw: { userMaxTtl: number | null; groupMaxTtl: number | null; globalMaxTtl: number; userUnlimited: boolean | null; groupUnlimited: boolean | null }
}

const SOURCE_LABELS: Record<TtlSource, string> = { user: "用户级", group: "用户组级", global: "全局默认" }

export async function resolveTtlPolicyForUser(userId: string): Promise<TtlPolicy> {
  const [user, gids] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { maxTtlMinutes: true, allowUnlimitedTtl: true } }),
    userGroupIds(userId),
  ])
  const groups = gids.length
    ? await db.group.findMany({ where: { id: { in: gids }, deletedAt: null }, select: { maxTtlMinutes: true, allowUnlimitedTtl: true }, orderBy: { createdAt: "asc" } })
    : []

  const userMaxTtl = user?.maxTtlMinutes ?? null
  let groupMaxTtl: number | null = null
  for (const g of groups) {
    if (g.maxTtlMinutes != null) { groupMaxTtl = g.maxTtlMinutes; break }
  }
  const globalMaxTtl = Math.max(0, await getConfigNumber("workspace.maxTtlMinutes", 0))
  const maxTtlMinutes = userMaxTtl != null ? userMaxTtl : groupMaxTtl != null ? groupMaxTtl : globalMaxTtl
  const source: TtlSource = userMaxTtl != null ? "user" : groupMaxTtl != null ? "group" : "global"

  const userUnlimited = user?.allowUnlimitedTtl ?? null
  let groupUnlimited: boolean | null = null
  for (const g of groups) {
    if (g.allowUnlimitedTtl != null) { groupUnlimited = g.allowUnlimitedTtl; break }
  }
  const globalUnlimited = await getConfigBool("workspace.allowUnlimitedTtl", true)
  const allowUnlimited = userUnlimited != null ? userUnlimited : groupUnlimited != null ? groupUnlimited : globalUnlimited
  const unlimitedSourceLabel =
    userUnlimited != null ? "用户级覆盖" : groupUnlimited != null ? "用户组级基线" : "全局默认"

  return {
    maxTtlMinutes,
    source,
    sourceLabel: SOURCE_LABELS[source],
    allowUnlimited,
    unlimitedSourceLabel,
    raw: { userMaxTtl, groupMaxTtl, globalMaxTtl, userUnlimited, groupUnlimited },
  }
}

export function fmtTtlMinutes(min: number | null | undefined): string {
  if (min == null) return "—"
  if (min <= 0) return "不限"
  if (min < 60) return `${min} 分钟`
  if (min < 1440) return `${(min / 60).toFixed(min % 60 === 0 ? 0 : 1)} 小时`
  return `${(min / 1440).toFixed(min % 1440 === 0 ? 0 : 1)} 天`
}

/**
 * 创建/修改 TTL 校验：返回可直接抛出的错误信息（null=通过）
 * @param minutes 请求的 TTL（分钟，0=无限）
 */
export function validateTtlAgainstPolicy(policy: TtlPolicy, minutes: number, isAdmin: boolean): string | null {
  if (isAdmin) return null // 管理员豁免（运维/模板验证可任意设置）
  if (minutes <= 0) {
    if (!policy.allowUnlimited) {
      return `管理员已禁止「无限时长」沙箱（${policy.unlimitedSourceLabel}）：请选择有限时长${policy.maxTtlMinutes > 0 ? `（最长 ${fmtTtlMinutes(policy.maxTtlMinutes)}）` : ""}`
    }
    return null
  }
  if (policy.maxTtlMinutes > 0 && minutes > policy.maxTtlMinutes) {
    return `时长超出上限：最长 ${fmtTtlMinutes(policy.maxTtlMinutes)}（${policy.sourceLabel}），当前请求 ${fmtTtlMinutes(minutes)}`
  }
  return null
}

/** 表单可选项推导（前端选择器/提示复用） */
export function ttlOptionBounds(policy: TtlPolicy): { allowUnlimited: boolean; maxMinutes: number; effectiveMaxMinutes: number } {
  // allowUnlimited=false 时强制有限上限；maxTtl=0 且禁无限 → 兜底 30 天
  const fallback = 43200
  const effective = !policy.allowUnlimited && policy.maxTtlMinutes <= 0 ? fallback : policy.maxTtlMinutes
  return { allowUnlimited: policy.allowUnlimited, maxMinutes: policy.maxTtlMinutes, effectiveMaxMinutes: effective }
}
