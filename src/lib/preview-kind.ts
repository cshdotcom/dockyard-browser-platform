// ============================================================
// 预览能力判定（纯函数 · 前后端共用）
// 从 lib/file-share.ts 抽取：无 fs/db/node 依赖，客户端组件可直接引用
// （用户云盘 /files 预览弹窗与公开分享页 /s/<token> 使用同一套语义）
// 注意：此文件会被打进客户端 bundle —— 只允许纯 JS 逻辑
// ============================================================

export type PreviewKind = "text" | "image" | "svg" | "video" | "audio" | "pdf" | "office-hint" | "none"

// 常见纯文本族扩展名（可在线预览 + 在线编辑）
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "yml", "yaml", "xml", "html", "htm",
  "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "bash", "sql", "ini", "toml",
  "conf", "env", "properties", "srt", "vtt", "gitignore", "editorconfig", "dockerfile",
])

const OFFICE_EXTS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"])

// 纯 JS 后缀提取（等价 path.extname，避免客户端 bundle 依赖 node:path）
function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".")
  if (i <= 0 || i === fileName.length - 1) return ""
  return fileName.slice(i + 1).toLowerCase()
}

export function previewKindOf(mime: string | null, fileName: string): PreviewKind {
  const m = (mime || "").toLowerCase()
  const ext = extOf(fileName)
  if (m.startsWith("image/svg") || ext === "svg") return "svg"
  if (m.startsWith("image/")) return "image"
  if (m.startsWith("video/")) return "video"
  if (m.startsWith("audio/")) return "audio"
  if (m === "application/pdf" || ext === "pdf") return "pdf"
  if (m.startsWith("text/") || TEXT_EXTS.has(ext)) return "text"
  if (OFFICE_EXTS.has(ext)) return "office-hint"
  return "none"
}

// 可在线编辑：纯文本族 + SVG（源码即文本）
export function isTextEditable(mime: string | null, fileName: string): boolean {
  const kind = previewKindOf(mime, fileName)
  return kind === "text" || kind === "svg"
}
