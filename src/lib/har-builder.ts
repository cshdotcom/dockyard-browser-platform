// ============================================================
// HAR 1.2 标准导出构建器
// 数据源：CDP 网关缓存的网络事件环形缓冲（cdp-control networkLogSnapshot）
//   · "GET https://a.com/x"        → requestWillBeSent
//   · "← 200 https://a.com/x"      → responseReceived
//   · "✕ net::ERR_... https://..." → loadingFailed
// 解析为 request/response 配对（按 URL+近邻时间戳合并），
// 输出 DevTools / Charles / Fiddler 均可直接打开的标准 HAR 1.2 结构。
// ============================================================

interface NetworkLogLine { ts: number; level: string; text: string; source: string }

interface HarEntryDraft {
  startedAt: number
  method: string
  url: string
  status: number | null
  errorText: string | null
}

const REQ_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S+)$/i
const RES_RE = /^←\s+(\d{3})\s+(\S+)$/
const FAIL_RE = /^✕\s+(\S+)(?:\s+(\S+))?$/

/** 从网络事件缓冲行解析为请求/响应配对的 HAR entry 草稿 */
export function parseNetworkLines(lines: NetworkLogLine[]): HarEntryDraft[] {
  const drafts: HarEntryDraft[] = []
  // 按 URL 聚合（同 URL 重定向/重试取最近邻匹配）
  for (const line of lines) {
    const text = line.text.trim()
    let m = REQ_RE.exec(text)
    if (m) {
      drafts.push({ startedAt: line.ts, method: m[1].toUpperCase(), url: m[2], status: null, errorText: null })
      continue
    }
    m = RES_RE.exec(text)
    if (m) {
      const status = Number(m[1])
      const url = m[2]
      // 找到同 URL 且尚无 status 的最近请求草稿
      const target = [...drafts].reverse().find((d) => d.url === url && d.status === null)
      if (target) {
        target.status = status
        target.errorText = null
      } else {
        // 响应先行（缓冲截断）→ 生成仅响应侧的 entry
        drafts.push({ startedAt: line.ts, method: "GET", url, status, errorText: null })
      }
      continue
    }
    m = FAIL_RE.exec(text)
    if (m) {
      const err = m[1]
      const url = m[2] || ""
      const target = url ? [...drafts].reverse().find((d) => d.url === url && d.status === null) : null
      if (target) {
        target.errorText = err
      } else if (url) {
        drafts.push({ startedAt: line.ts, method: "GET", url, status: null, errorText: err })
      }
    }
  }
  return drafts
}

function iso(ts: number): string {
  return new Date(ts).toISOString()
}

/** 组装标准 HAR 1.2 文档（workspace 元数据以 _workspace 扩展字段携带） */
export function buildHarDocument(
  drafts: HarEntryDraft[],
  meta: { workspaceId: string; workspaceName?: string; uuid?: string; mode?: string },
): { doc: object; sizeBytes: number } {
  const entries = drafts.map((d) => {
    const u = safeUrl(d.url)
    const ok = d.status !== null && d.status >= 200 && d.status < 400
    return {
      startedDateTime: iso(d.startedAt),
      time: 0, // 网关缓冲不含完整计时（请求/响应各自时间戳可差分；保守 0）
      request: {
        method: d.method,
        url: d.url,
        httpVersion: "HTTP/1.1",
        headers: [],
        queryString: u ? Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value })) : [],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: d.status ?? 0,
        statusText: d.status === null ? (d.errorText || "(no response)") : httpStatusText(d.status),
        httpVersion: "HTTP/1.1",
        headers: [],
        content: { size: 0, mimeType: u ? guessMime(u.pathname) : "text/plain", text: "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      ...(d.errorText ? { _error: d.errorText } : {}),
    }
  })
  const doc = {
    log: {
      version: "1.2",
      creator: { name: "Dockyard Gateway (CDP Network 缓存)", version: "1.0" },
      entries,
      _workspace: {
        id: meta.workspaceId,
        uuid: meta.uuid,
        name: meta.workspaceName,
        mode: meta.mode,
      },
      _generatedAt: new Date().toISOString(),
      _note: "entries 来自平台网关缓存的 CDP Network 域事件（请求/响应行）",
    },
  }
  const json = JSON.stringify(doc, null, 2)
  return { doc, sizeBytes: Buffer.byteLength(json, "utf8") }
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function guessMime(pathname: string): string {
  const p = pathname.toLowerCase()
  if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html"
  if (p.endsWith(".json")) return "application/json"
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript"
  if (p.endsWith(".css")) return "text/css"
  if (p.endsWith(".png")) return "image/png"
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg"
  if (p.endsWith(".svg")) return "image/svg+xml"
  if (p.endsWith(".gif")) return "image/gif"
  if (p.endsWith(".woff2")) return "font/woff2"
  if (p.endsWith(".txt")) return "text/plain"
  return "application/octet-stream"
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found",
  304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
}
function httpStatusText(code: number): string {
  return STATUS_TEXT[code] || String(code)
}
