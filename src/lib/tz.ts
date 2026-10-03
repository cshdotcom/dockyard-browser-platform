// ============================================================
// r31：平台时区系统（服务端；后台可改；默认北京时间 Asia/Shanghai）
//   · 语义：服务端权威时间显示统一带时区标注，避免歧义（“谨慎带上时区”）
//   · 存储：数据库/内部时间仍为 UTC ISO（不变）；仅「面向用户的展示」按平台时区格式化
//   · 消费点：邮件模板时间行 / 录像水印 serverNow+serverTz / 配置中心展示
//   · 缓存：60s 进程级缓存（配置变更最多 1 分钟生效；读路径零开销）
//   · 常量与纯函数在 tz-constants.ts（客户端安全；本文件仅服务端配置读取）
// ============================================================

import { getConfig } from "./config"
import { TIMEZONE_LABELS, fmtInTz, tzOffsetLabel, isValidTz } from "./tz-constants"

export { TIMEZONE_OPTIONS, TIMEZONE_LABELS, isValidTz, fmtInTz, tzOffsetLabel, tzFullLabel } from "./tz-constants"

const DEFAULT_TZ = "Asia/Shanghai"
let cached: { tz: string; at: number } | null = null
const TTL_MS = 60_000

/** 平台时区（配置键 general.timezone；60s 缓存；非法值回退北京时间） */
export async function platformTz(): Promise<string> {
  const now = Date.now()
  if (cached && now - cached.at < TTL_MS) return cached.tz
  let tz = DEFAULT_TZ
  try {
    const v = await getConfig<string>("general.timezone", DEFAULT_TZ)
    if (typeof v === "string" && v && isValidTz(v)) tz = v
  } catch { /* 配置不可用 → 默认 */ }
  cached = { tz, at: now }
  return tz
}

/** 当前时刻（平台时区字符串；水印/邮件等面向用户的“服务器权威时间”） */
export async function tzNow(): Promise<{ now: string; tz: string; label: string }> {
  const tz = await platformTz()
  return { now: fmtInTz(new Date(), tz), tz, label: `${tzOffsetLabel(tz)}${tz === "Asia/Shanghai" ? " (北京时间)" : ""}` }
}
