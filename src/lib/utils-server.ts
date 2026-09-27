// 服务端通用工具：查询参数解析 / CSV / 排序
export interface ListQuery {
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function parseListQuery(searchParams: Record<string, string | string[] | undefined>): ListQuery {
  const get = (k: string) => {
    const v = searchParams[k]
    return Array.isArray(v) ? v[0] : v
  }
  const num = (k: string, d: number) => {
    const v = Number(get(k))
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : d
  }
  const filters: Record<string, string> = {}
  for (const [k, v] of Object.entries(searchParams)) {
    if (["page", "pageSize", "keyword", "sortField", "sortOrder"].includes(k)) continue
    const val = Array.isArray(v) ? v[0] : v
    if (val) filters[k] = val
  }
  return {
    page: num("page", 1),
    pageSize: num("pageSize", 20),
    keyword: get("keyword"),
    sortField: get("sortField"),
    sortOrder: get("sortOrder") === "desc" ? "desc" : "asc",
    filters,
  }
}

export function pageSkipTake(q: ListQuery) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize }
}

// 允许的排序字段白名单（防注入）
export function safeOrderBy(q: ListQuery, allowed: string[], fallback: Record<string, string>): Record<string, string> {
  if (q.sortField && allowed.includes(q.sortField)) {
    return { [q.sortField]: q.sortOrder || "desc" }
  }
  return fallback
}

// CSV 转义输出
export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`.replace(/[\r\n]+/g, " ")
  return s.replace(/[\r\n]+/g, " ")
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(","), ...rows.map((r) => r.map(csvEscape).join(","))]
  return "\uFEFF" + lines.join("\n")
}

export function fmtDate(d?: Date | string | null): string {
  if (!d) return "-"
  const dt = typeof d === "string" ? new Date(d) : d
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
}

export function fmtBytes(bytes?: number | null): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Math.round(v * 1000) / 1000} ${units[i]}`
}
