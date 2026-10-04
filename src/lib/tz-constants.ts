// ============================================================
// r31：时区常量（客户端/服务端共用；纯函数无依赖，可安全进入客户端包）
// ============================================================

// 常用时区清单（后台选择器选项；企业常用区域全覆盖）
export const TIMEZONE_OPTIONS: string[] = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore",
  "Asia/Bangkok", "Asia/Kolkata", "Asia/Dubai", "Asia/Vladivostok",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow", "Europe/Istanbul",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
  "Australia/Sydney", "Australia/Perth", "Pacific/Auckland", "UTC",
]

export const TIMEZONE_LABELS: Record<string, string> = {
  "Asia/Shanghai": "北京时间（中国标准时间）",
  "Asia/Hong_Kong": "香港时间",
  "Asia/Taipei": "台北时间",
  "Asia/Tokyo": "东京时间",
  "Asia/Seoul": "首尔时间",
  "Asia/Singapore": "新加坡时间",
  "Asia/Bangkok": "曼谷时间",
  "Asia/Kolkata": "印度时间",
  "Asia/Dubai": "迪拜时间",
  "Asia/Vladivostok": "海参崴时间",
  "Europe/London": "伦敦时间",
  "Europe/Paris": "巴黎时间",
  "Europe/Berlin": "柏林时间",
  "Europe/Moscow": "莫斯科时间",
  "Europe/Istanbul": "伊斯坦布尔时间",
  "America/New_York": "美东时间",
  "America/Chicago": "美中时间",
  "America/Denver": "美山时间",
  "America/Los_Angeles": "美西时间",
  "America/Sao_Paulo": "圣保罗时间",
  "Australia/Sydney": "悉尼时间",
  "Australia/Perth": "珀斯时间",
  "Pacific/Auckland": "奥克兰时间",
  UTC: "协调世界时（UTC）",
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** 按时区格式化：YYYY-MM-DD HH:mm:ss（秒级，面向用户展示） */
export function fmtInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value || ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`
}

/** 时区偏移标注（如 "UTC+8"） */
export function tzOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at)
    const off = parts.find((p) => p.type === "timeZoneName")?.value || "GMT"
    return off.replace("GMT", "UTC")
  } catch {
    return "UTC+8"
  }
}

/** 组合标注（如 "Asia/Shanghai · UTC+8 · 北京时间"） */
export function tzFullLabel(tz: string): string {
  const label = TIMEZONE_LABELS[tz]
  return `${tz} · ${tzOffsetLabel(tz)}${label ? ` · ${label}` : ""}`
}
