// ============================================================
// r26：模板配置字段级差异计算（纯函数库，供 actions 与 UI 复用）
// 注意：不可放在 "use server" 文件内（Server Actions 必须全为 async）
// ============================================================

// 字段级差异计算（含 variables 键级与 crx 数组级）
export function diffTemplateConfig(beforeJson: string, afterJson: string): string[] {
  let before: Record<string, unknown> = {}
  let after: Record<string, unknown> = {}
  try { before = JSON.parse(beforeJson) } catch { /* 空配置 */ }
  try { after = JSON.parse(afterJson) } catch { /* 空配置 */ }
  const fields: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    const b = before[k]
    const a = after[k]
    if (JSON.stringify(b) !== JSON.stringify(a)) fields.push(k)
  }
  return fields
}

// CRX 相关字段识别（模板 configJson 内嵌 crx 配置段或字段名含 crx/extension）
export function isCrxRelatedField(field: string): boolean {
  return /crx|extension|plugin/i.test(field)
}

// 版本差异结构（前端三栏渲染）
export interface TemplateVersionDiffItem {
  field: string
  before: string
  after: string
  kind: "ADDED" | "REMOVED" | "CHANGED" // 新增字段 / 删除字段 / 值变更
  crxRelated: boolean // CRX 相关字段高亮（需求：差异对比高亮 CRX 变更）
}

export function parseTemplateConfig(json: string): Record<string, unknown> {
  try { return JSON.parse(json) } catch { return {} }
}

export function fmtTemplateVal(v: unknown): string {
  if (v === undefined || v === null) return "（未设置）"
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}
