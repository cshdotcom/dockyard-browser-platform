// ============================================================
// r23：标准 5 字段 cron 表达式解析与下次到期计算
// 字段：分 时 日 月 周（空格分隔）
// 支持：* / , - 范围列表 与 N-M/Step；别名不使用（保持数字，与平台任务 UI 一致）
// 用于：/api/cron 到期判定 + 自定义任务的下次运行预览
// 纯函数模块（无 DB / 无 React 依赖），双端可用
// ============================================================

export interface CronParseResult {
  ok: boolean
  error?: string
  /** 每个字段的允许值集合（分钟/小时/日/月/周） */
  sets: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 和 7 都表示周日）
]

function parseField(field: string, idx: number): Set<number> {
  const [min, max] = FIELD_RANGES[idx]
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const seg = part.trim()
    if (!seg) throw new Error(`字段 ${idx + 1} 存在空段`)
    let rangeStart = min
    let rangeEnd = max
    let step = 1
    let stepPart = ""
    if (seg.includes("/")) {
      const [rangeStr, stepStr] = seg.split("/")
      stepPart = stepStr
      step = Number(stepStr)
      if (!Number.isInteger(step) || step < 1) throw new Error(`步长非法：${seg}`)
      if (rangeStr === "*") {
        rangeStart = min
        rangeEnd = max
      } else if (rangeStr.includes("-")) {
        const [a, b] = rangeStr.split("-").map(Number)
        rangeStart = a
        rangeEnd = b
      } else {
        // "N/step" 语义：从 N 到字段最大值
        rangeStart = Number(rangeStr)
        rangeEnd = max
      }
    } else if (seg === "*") {
      rangeStart = min
      rangeEnd = max
    } else if (seg.includes("-")) {
      const [a, b] = seg.split("-").map(Number)
      rangeStart = a
      rangeEnd = b
    } else {
      const v = Number(seg)
      rangeStart = v
      rangeEnd = v // 单值
    }
    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) throw new Error(`数值非法：${seg}`)
    if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) throw new Error(`范围越界：${seg}（字段 ${idx + 1} 允许 ${min}-${max}）`)
    for (let v = rangeStart; v <= rangeEnd; v += step) {
      // 周字段：0 与 7 均归一化为 0（周日）
      out.add(idx === 4 && v === 7 ? 0 : v)
    }
  }
  if (out.size === 0) throw new Error(`字段 ${idx + 1} 解析结果为空`)
  return out
}

const CRON_RE = /^(\S+\s+){4}\S+$/

export function parseCron(expr: string): CronParseResult {
  const e = (expr || "").trim().replace(/\s+/g, " ")
  if (!CRON_RE.test(e)) return { ok: false, error: "cron 表达式必须为5字段格式：分 时 日 月 周（空格分隔）", sets: [new Set(), new Set(), new Set(), new Set(), new Set()] }
  try {
    const fields = e.split(" ")
    const sets = fields.map((f, i) => parseField(f, i)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
    return { ok: true, sets }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), sets: [new Set(), new Set(), new Set(), new Set(), new Set()] }
  }
}

/**
 * 计算下一次到期时间（from 之后第一个命中时刻；最多向前搜索 5 年）
 * 标准语义：日 与 周 同时被限制时取并集（Vixie cron 行为）；周字段为 * 或日字段为 * 时不参与交集。
 */
export function nextCronRun(expr: string, from = new Date()): Date | null {
  const p = parseCron(expr)
  if (!p.ok) return null
  const [minSet, hourSet, daySet, monthSet, dowSet] = p.sets
  const dayRestricted = !daySet.has(1) || daySet.size < 31 || !isStar(expr, 2)
  const dowRestricted = !isStar(expr, 4)
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const lastDay = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : daysInMonth[m - 1])

  const d = new Date(from.getTime() + 60_000) // 跳过当前分钟，找严格下一次
  d.setSeconds(0, 0)

  for (let iter = 0; iter < 60 * 24 * 366 * 5; iter++) {
    // 分钟推进（外层循环单位=1分钟；年为限防止死循环）
    if (d.getFullYear() - from.getFullYear() > 5) return null
    if (!monthSet.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!hourSet.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minSet.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    const dayOk = daySet.has(d.getDate())
    const dowOk = dowSet.has(d.getDay())
    const dayMatch = dayRestricted && dowRestricted ? dayOk || dowOk : dayOk && dowOk
    if (!dayMatch) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    return new Date(d)
  }
  return null
}

/** 判断表达式的第 idx 字段是否为裸 *（用于日/周 交集语义判定） */
function isStar(expr: string, idx: number): boolean {
  const fields = (expr || "").trim().replace(/\s+/g, " ").split(" ")
  return fields[idx] === "*"
}

/** 人类可读描述（简版）：用于 UI 预览 */
export function describeCron(expr: string): string {
  const p = parseCron(expr)
  if (!p.ok) return p.error || "表达式非法"
  const fields = (expr || "").trim().replace(/\s+/g, " ").split(" ")
  const [min, hour, day, month, dow] = fields
  if (min === "*" && hour === "*" && day === "*" && month === "*" && dow === "*") return "每分钟"
  const step = (s: string) => s.split("/")[1]
  if (min.startsWith("*/") && hour === "*") return `每 ${step(min)} 分钟`
  if (min === "*" && hour.startsWith("*/")) return `每 ${step(hour)} 小时（整点后每分钟）`
  if (hour.startsWith("*/") && !min.includes("*") && !min.includes("/")) return `每 ${step(hour)} 小时的第 ${min} 分`
  if (min === "0" && hour === "*") return "每小时整点"
  if (min === "0" && hour.startsWith("*/")) return `每 ${step(hour)} 小时整点`
  if (min === "0" && !hour.includes("*") && !hour.includes("/") && day === "*" && month === "*" && dow === "*") {
    return `每天 ${hour.split(",").map((h) => `${h.padStart(2, "0")}:00`).join("、")}`
  }
  if (dow !== "*" && min === "0" && !hour.includes("*")) {
    const dowMap: Record<string, string> = { "0": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "日" }
    const days = dow.split(",").map((x) => `周${dowMap[x.trim()] || x}`).join("、")
    return `${days} ${hour.split(",").map((h) => `${h.padStart(2, "0")}:${min.padStart(2, "0")}`).join("、")}`
  }
  return `按表达式调度（${expr}）`
}
