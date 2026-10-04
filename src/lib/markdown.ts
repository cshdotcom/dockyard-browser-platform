// ============================================================
// r35：Markdown 轻量渲染（客户端安全 —— 无 Node API 依赖）
// 超级编辑器可视化预览与文件管理面板共用。
// ============================================================
// ---- r35：Markdown 轻量渲染（超级编辑器可视化预览共用） ----
export function renderMarkdown(src: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const lines = esc(src).split("\n")
  const out: string[] = []
  let inCode = false
  let inList = false
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false }
      out.push(inCode ? "</code></pre>" : '<pre class="bg-muted rounded p-3 overflow-x-auto text-xs"><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(raw); continue }
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, '<code class="bg-muted px-1 rounded text-xs">$1</code>')
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary underline">$1</a>')
    if (/^---+$/.test(line.trim())) { if (inList) { out.push("</ul>"); inList = false }; out.push('<hr class="my-3 border-border"/>'); continue }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      if (inList) { out.push("</ul>"); inList = false }
      const size = ["text-xl", "text-lg", "text-base", "text-sm"][h[1].length - 1]
      out.push(`<div class="${size} font-semibold mt-3 mb-1">${h[2]}</div>`)
      continue
    }
    if (/^[*-]\s+/.test(line)) {
      if (!inList) { out.push('<ul class="list-disc pl-5 my-1 space-y-0.5">'); inList = true }
      out.push(`<li>${line.replace(/^[*-]\s+/, "")}</li>`)
      continue
    }
    if (inList) { out.push("</ul>"); inList = false }
    if (line.trim().startsWith("&gt;")) {
      out.push(`<blockquote class="border-l-2 border-primary/40 pl-3 text-muted-foreground my-1">${line.trim().slice(4)}</blockquote>`)
      continue
    }
    out.push(`<p class="my-1">${line || "&nbsp;"}</p>`)
  }
  if (inList) out.push("</ul>")
  if (inCode) out.push("</code></pre>")
  return out.join("\n")
}
