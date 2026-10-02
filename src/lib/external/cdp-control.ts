// ============================================================
// 浏览器全量控制层（Browser Control Layer）
// 自研浏览器控制动作注册表：MCP 与 OpenAPI 共用同一事实源 BROWSER_ACTIONS
//   会话：status / debug_info / back / forward / reload
//   页面：navigate / screenshot / scrape / evaluate / get_url / dom_snapshot / wait_for
//   输入：click / type / press_key / scroll / hover
//   标签：get_tabs / new_tab / close_tab / activate_tab
//   网络：throttle / block_urls / allow_urls / clear_url_filters / set_extra_headers
//   指纹：set_user_agent / set_viewport / set_geolocation
//   数据：get_cookies / set_cookies / get_logs
// 双形态执行：
//   · 真实 CDP：WebSocket 直连会话容器/浏览器 CDP 端点（Target.attach + 各 CDP 域命令）
//   · 模拟引擎：无集群环境全链路可验证（虚拟 DOM / 虚拟标签页 / PNG 截图 / 日志缓冲）
// 安全：归属强制（本人工作区或 ADMIN 权限位）+ 独立限流 + 全量审计 + 行为追踪
// ============================================================

import { db } from "@/lib/db"
import { externalAvailable } from "@/lib/env"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { trackBehavior } from "@/lib/risk"
import { TOKEN_PERM } from "@/lib/api-token-auth"
import type { BrowserWorkspace } from "@prisma/client"

export interface BrowserControlContext {
  userId: string
  username: string
  isAdmin: boolean
  via: "MCP" | "OPENAPI"
}

export interface BrowserActionDef {
  action: string
  summary: string
  perm: number
  danger?: boolean
  params: Record<string, string>
  execute: (ws: BrowserWorkspace, ctx: BrowserControlContext, params: Record<string, unknown>) => Promise<unknown>
}

// ============================================================
// 一、CDP WebSocket 客户端（真实形态）
// ============================================================

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string }

class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners: Array<(msg: CdpMessage) => void> = []
  closed = false
  lastUsedAt = Date.now()

  constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.addEventListener("message", (ev) => {
      let msg: CdpMessage
      try { msg = JSON.parse(String(ev.data)) as CdpMessage } catch { return }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`CDP ${msg.error.message || "error"}`))
        else p.resolve(msg.result)
        return
      }
      for (const l of [...this.listeners]) {
        try { l(msg) } catch { /* 监听器异常不影响连接 */ }
      }
    })
    this.ws.addEventListener("close", () => this.teardown())
    this.ws.addEventListener("error", () => this.teardown())
  }

  static connect(url: string, timeoutMs = 8000): Promise<CdpConnection> {
    return new Promise<CdpConnection>((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* noop */ }
        reject(new Error("CDP 连接超时"))
      }, timeoutMs)
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(new CdpConnection(ws)) }, { once: true })
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败（会话可能已停止）")) }, { once: true })
    })
  }

  onEvent(fn: (msg: CdpMessage) => void): () => void {
    this.listeners.push(fn)
    return () => { this.listeners = this.listeners.filter((l) => l !== fn) }
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
    this.lastUsedAt = Date.now()
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("CDP 连接已关闭"))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    this.teardown()
    try { this.ws.close() } catch { /* noop */ }
  }

  private teardown() {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      try { p.reject(new Error("CDP 连接中断")) } catch { /* noop */ }
    }
    this.pending.clear()
  }
}

// ---- 连接池（复用连接；空闲回收；事件进日志环形缓冲）----
interface PoolEntry { conn: CdpConnection; workspaceId: string }
interface ControlLogEntry { ts: number; level: string; text: string; source: string }

const g = globalThis as unknown as {
  __dyCdpPool?: Map<string, PoolEntry>
  __dyCdpLogs?: Map<string, { console: ControlLogEntry[]; network: ControlLogEntry[] }>
}

function cdpPool(): Map<string, PoolEntry> {
  if (!g.__dyCdpPool) g.__dyCdpPool = new Map()
  return g.__dyCdpPool
}
function controlLogs(): Map<string, { console: ControlLogEntry[]; network: ControlLogEntry[] }> {
  if (!g.__dyCdpLogs) g.__dyCdpLogs = new Map()
  return g.__dyCdpLogs
}
function logsOf(workspaceId: string) {
  const m = controlLogs()
  let entry = m.get(workspaceId)
  if (!entry) {
    entry = { console: [], network: [] }
    m.set(workspaceId, entry)
  }
  return entry
}

// 网络事件缓冲快照（HAR 组装数据源：网关缓存的 CDP Network 域事件）
export function networkLogSnapshot(workspaceId: string): Array<{ ts: number; level: string; text: string; source: string }> {
  const logs = logsOf(workspaceId)
  return [...logs.network]
}
function pushLog(workspaceId: string, kind: "console" | "network", level: string, text: string, source = "cdp") {
  const logs = logsOf(workspaceId)
  const arr = kind === "console" ? logs.console : logs.network
  arr.push({ ts: Date.now(), level, text: text.slice(0, 800), source })
  if (arr.length > 300) arr.splice(0, arr.length - 300)
}

// 取/建真实 CDP 连接（附带 Runtime/Network/Page 事件监听）
async function getRealConnection(ws: BrowserWorkspace): Promise<CdpConnection> {
  const pool = cdpPool()
  // 空闲回收（5 分钟）
  for (const [key, entry] of [...pool.entries()]) {
    if (entry.conn.closed || Date.now() - entry.conn.lastUsedAt > 5 * 60_000) {
      try { entry.conn.close() } catch { /* noop */ }
      pool.delete(key)
    }
  }
  const existing = pool.get(ws.id)
  if (existing && !existing.conn.closed) return existing.conn

  if (!ws.cdpUrl) throw new Error("该工作区没有 CDP 端点（仅 CDP 轻量会话支持浏览器控制）")
  const conn = await CdpConnection.connect(ws.cdpUrl)
  // 事件监听 → 日志缓冲（browser 级连接上的事件按 sessionId 不可区分页面时也统一入缓冲）
  conn.onEvent((msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      const p = (msg.params || {}) as { type?: string; args?: Array<{ value?: unknown; description?: string }> }
      const text = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || "obj")).join(" ")
      pushLog(ws.id, "console", (p.type || "log").toUpperCase(), text, "Runtime")
    } else if (msg.method === "Runtime.exceptionThrown") {
      pushLog(ws.id, "console", "ERROR", "页面异常：" + JSON.stringify((msg.params || {}).exceptionDetails || {}).slice(0, 300), "Runtime")
    } else if (msg.method === "Network.requestWillBeSent") {
      const p = (msg.params || {}) as { request?: { method?: string; url?: string } }
      pushLog(ws.id, "network", "INFO", `${p.request?.method || "GET"} ${p.request?.url || ""}`, "Network")
    } else if (msg.method === "Network.responseReceived") {
      const p = (msg.params || {}) as { response?: { status?: number; url?: string } }
      pushLog(ws.id, "network", String(p.response?.status || 0).startsWith("2") ? "OK" : "WARN", `← ${p.response?.status} ${p.response?.url || ""}`, "Network")
    } else if (msg.method === "Network.loadingFailed") {
      const p = (msg.params || {}) as { errorText?: string; url?: string }
      pushLog(ws.id, "network", "BLOCKED", `✕ ${p.errorText || "blocked"} ${p.url || ""}`, "Network")
    }
  })
  pool.set(ws.id, { conn, workspaceId: ws.id })
  return conn
}

// 页面级会话（Target.attachToTarget，flatten 模式）
async function attachPage(conn: CdpConnection, targetId?: string): Promise<string> {
  if (targetId) {
    const res = await conn.send("Target.attachToTarget", { targetId, flatten: true })
    return String(res.sessionId || "")
  }
  // 未指定：取第一个 page 类型 target
  const targets = await conn.send("Target.getTargets")
  const list = (targets.targetInfos || []) as Array<{ targetId: string; type: string; url: string; title: string }>
  const page = list.find((t) => t.type === "page")
  if (!page) {
    const created = await conn.send("Target.createTarget", { url: "about:blank" })
    const res = await conn.send("Target.attachToTarget", { targetId: String(created.targetId), flatten: true })
    return String(res.sessionId || "")
  }
  const res = await conn.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })
  return String(res.sessionId || "")
}

// ============================================================
// 二、模拟引擎（无集群环境全链路可验证）
// ============================================================

interface SimTab { targetId: string; url: string; title: string; history: string[]; histIndex: number }
interface SimDomNode { id: number; tag: string; text: string; href?: string; rect: { x: number; y: number; w: number; h: number }; attrs: Record<string, string> }
interface SimState {
  tabs: SimTab[]
  activeIdx: number
  dom: SimDomNode[]
  domSeq: number
  console: ControlLogEntry[]
  network: ControlLogEntry[]
  cookies: Array<{ name: string; value: string; domain: string; path: string }>
  userAgent: string
  viewport: { width: number; height: number }
  throttle: { downKbps: number; upKbps: number; latencyMs: number; offline: boolean } | null
  blockedUrls: string[]
  allowUrls: string[] | null
  extraHeaders: Record<string, string>
  lastInputAt: number
  startedAt: number
  blockedCount: number
}

const SIM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

function simStates(): Map<string, SimState> {
  const g2 = globalThis as unknown as { __dySimBrowser?: Map<string, SimState> }
  if (!g2.__dySimBrowser) g2.__dySimBrowser = new Map()
  return g2.__dySimBrowser
}

function newSimState(ws: BrowserWorkspace): SimState {
  const tab: SimTab = { targetId: "sim-t1", url: "about:blank", title: "空白页", history: ["about:blank"], histIndex: 0 }
  return {
    tabs: [tab],
    activeIdx: 0,
    dom: [],
    domSeq: 0,
    console: [],
    network: [],
    cookies: [],
    userAgent: SIM_UA,
    viewport: { width: 1280, height: 800 },
    throttle: null,
    blockedUrls: [],
    allowUrls: null,
    extraHeaders: {},
    lastInputAt: Date.now(),
    startedAt: Date.now(),
    blockedCount: 0,
  }
}

function simOf(ws: BrowserWorkspace): SimState {
  let s = simStates().get(ws.id)
  if (!s) {
    s = newSimState(ws)
    simStates().set(ws.id, s)
  }
  return s
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return url.replace(/^https?:\/\//, "").split("/")[0] || "invalid" }
}

function simLog(s: SimState, kind: "console" | "network", level: string, text: string) {
  const arr = kind === "console" ? s.console : s.network
  arr.push({ ts: Date.now(), level, text: text.slice(0, 800), source: "sim" })
  if (arr.length > 300) arr.splice(0, arr.length - 300)
}

function matchesPattern(url: string, pattern: string): boolean {
  const p = pattern.replace(/^\*?\./, "")
  const h = hostnameOf(url)
  if (pattern.includes("*")) {
    const rx = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*") + "$")
    return rx.test(h) || h.endsWith("." + p)
  }
  return h === pattern
}

function urlAllowed(s: SimState, url: string): boolean {
  if (s.allowUrls !== null) {
    if (!s.allowUrls.some((p) => matchesPattern(url, p))) return false
  }
  if (s.blockedUrls.some((p) => matchesPattern(url, p))) return false
  if (s.throttle?.offline) return false
  return true
}

function simRenderDom(s: SimState, url: string) {
  const host = hostnameOf(url)
  const title = url === "about:blank" ? "空白页" : `${host} — 模拟渲染`
  s.domSeq = 0
  const nodes: SimDomNode[] = []
  const mk = (tag: string, text: string, y: number, extra?: Partial<SimDomNode>): SimDomNode => {
    s.domSeq += 1
    return {
      id: s.domSeq,
      tag,
      text,
      rect: { x: 60, y, w: Math.min(900, Math.max(240, text.length * 14)), h: tag === "h1" ? 56 : tag === "button" ? 40 : 30 },
      attrs: extra?.attrs || {},
      href: extra?.href,
    }
  }
  nodes.push(mk("h1", url === "about:blank" ? "about:blank" : `欢迎来到 ${host}`, 60))
  nodes.push(mk("p", "该页面由 Dockyard 模拟浏览器引擎渲染：布局与交互为虚拟实现。", 140))
  nodes.push(mk("a", "官方文档入口", 200, { href: `https://${host}/docs` }))
  nodes.push(mk("a", "关于本站", 240, { href: `https://${host}/about` }))
  nodes.push(mk("button", "提交", 300, { attrs: { id: "submit-btn" } }))
  nodes.push(mk("input", "", 350, { attrs: { id: "search-input", placeholder: "请输入关键词…" } }))
  nodes.push(mk("p", "© Simulated Content · Dockyard Browser Engine", 700))
  s.dom = nodes
  s.tabs[s.activeIdx].title = title
}

function simNavigate(s: SimState, url: string): { ok: boolean; blocked: boolean; reason?: string } {
  const normalized = /^https?:\/\//i.test(url) || url === "about:blank" ? url : `https://${url}`
  if (!urlAllowed(s, normalized)) {
    s.blockedCount++
    simLog(s, "network", "BLOCKED", `✕ ERR_BLOCKED_BY_CLIENT ${normalized}（命中拦截规则）`)
    return { ok: false, blocked: true, reason: "目标 URL 被当前策略拦截（黑名单/白名单/离线节流）" }
  }
  const tab = s.tabs[s.activeIdx]
  tab.url = normalized
  tab.title = `${hostnameOf(normalized)} — 模拟渲染`
  tab.history = tab.history.slice(0, tab.histIndex + 1)
  tab.history.push(normalized)
  tab.histIndex = tab.history.length - 1
  simRenderDom(s, normalized)
  simLog(s, "network", "OK", `GET ${normalized}`)
  simLog(s, "network", "OK", `← 200 ${normalized}`)
  simLog(s, "console", "INFO", `[sim] 已导航：${normalized}`)
  return { ok: true, blocked: false }
}

// 模拟截图：SVG → PNG（sharp 光栅化，真实 base64）
async function simScreenshot(s: SimState, ws: BrowserWorkspace): Promise<{ format: string; width: number; height: number; dataBase64: string }> {
  const { width, height } = s.viewport
  const tab = s.tabs[s.activeIdx]
  const lines = s.dom.slice(0, 8).map((n, i) =>
    `<text x="60" y="${170 + i * 44}" font-size="${n.tag === "h1" ? 26 : 15}" fill="${n.tag === "h1" ? "#e8f7f2" : "#9fc4bb"}" font-family="sans-serif">${escapeXml(n.text || n.attrs.placeholder || `<${n.tag}>`).slice(0, 70)}</text>`,
  ).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1417"/><stop offset="1" stop-color="#10201c"/>
    </linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect x="0" y="0" width="${width}" height="44" fill="#070d10"/>
    <rect x="0" y="43" width="${width}" height="2" fill="#2fd9b5"/>
    <circle cx="26" cy="22" r="9" fill="#2fd9b5"/>
    <text x="46" y="27" font-size="14" fill="#e8f7f2" font-family="sans-serif">Dockyard Simulated Browser · ${escapeXml(hostnameOf(tab.url))}</text>
    ${lines}
    <text x="60" y="${height - 60}" font-size="12" fill="#5f8a80" font-family="sans-serif">workspace ${escapeXml(ws.uuid.slice(0, 12))} · ${new Date().toISOString()} · 模拟引擎</text>
  </svg>`
  const sharp = (await import("sharp")).default
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  return { format: "png", width, height, dataBase64: png.toString("base64") }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// 模拟安全求值（白名单模式，绝不 eval 任意代码）
function simEvaluate(s: SimState, expression: string): { simulated: boolean; result: unknown; note: string } {
  const tab = s.tabs[s.activeIdx]
  const e = expression.trim()
  if (e === "document.title") return { simulated: true, result: tab.title, note: "白名单表达式" }
  if (e === "location.href" || e === "document.location.href") return { simulated: true, result: tab.url, note: "白名单表达式" }
  if (e === "document.cookie") return { simulated: true, result: s.cookies.map((c) => `${c.name}=${c.value}`).join("; "), note: "白名单表达式" }
  const qm = e.match(/^document\.querySelector\((['"])(.+?)\1\)$/)
  if (qm) {
    const node = findSimNode(s, qm[2])
    return { simulated: true, result: node ? { tag: node.tag, text: node.text, rect: node.rect } : null, note: "白名单表达式" }
  }
  const qam = e.match(/^document\.querySelectorAll\((['"])(.+?)\1\)\.length$/)
  if (qam) return { simulated: true, result: countSimNodes(s, qam[2]), note: "白名单表达式" }
  if (/^[\d\s+\-*/().%]+$/.test(e)) {
    try {
      // 纯算术表达式（无标识符）安全求值
      const val = Function(`"use strict"; return (${e})`)()
      return { simulated: true, result: val, note: "纯算术表达式" }
    } catch { /* fallthrough */ }
  }
  return { simulated: true, result: null, note: "模拟环境仅支持白名单表达式（title/href/cookie/querySelector/算术）；生产 CDP 会话执行任意表达式" }
}

function findSimNode(s: SimState, selector: string): SimDomNode | null {
  const idm = selector.match(/^#(.+)$/)
  if (idm) return s.dom.find((n) => n.attrs.id === idm[1]) || null
  const tagm = selector.match(/^[a-z1-6]+$/i)
  if (tagm) return s.dom.find((n) => n.tag === tagm[0]) || null
  const textm = s.dom.find((n) => n.text.includes(selector.replace(/["']/g, "")))
  return textm || null
}
function countSimNodes(s: SimState, selector: string): number {
  if (selector === "*") return s.dom.length
  const idm = selector.match(/^#(.+)$/)
  if (idm) return s.dom.filter((n) => n.attrs.id === idm[1]).length
  const tagm = selector.match(/^[a-z1-6]+$/i)
  if (tagm) return s.dom.filter((n) => n.tag === tagm[0].toLowerCase()).length
  return 0
}

function resolveSimTarget(s: SimState, params: Record<string, unknown>): { x: number; y: number; node: SimDomNode | null } {
  const selector = params.selector ? String(params.selector) : null
  if (selector) {
    const node = findSimNode(s, selector)
    if (!node) throw new Error(`选择器未命中节点：${selector}`)
    return { x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2, node }
  }
  const x = Math.round(Number(params.x ?? 0))
  const y = Math.round(Number(params.y ?? 0))
  const node = s.dom.find((n) => x >= n.rect.x && x <= n.rect.x + n.rect.w && y >= n.rect.y && y <= n.rect.y + n.rect.h) || null
  return { x, y, node }
}

// ============================================================
// 三、工作区解析与鉴权
// ============================================================

async function resolveControlledWorkspace(workspaceIdOrUuid: string, ctx: BrowserControlContext): Promise<BrowserWorkspace> {
  if (!workspaceIdOrUuid) throw new Error("缺少 workspaceId 参数")
  const ws = await db.browserWorkspace.findFirst({
    where: { OR: [{ id: workspaceIdOrUuid }, { uuid: workspaceIdOrUuid }], deletedAt: null },
  })
  if (!ws) throw new Error("工作区不存在")
  // 归属强制：本人资源 或 ADMIN 权限位
  if (ws.userId !== ctx.userId && !ctx.isAdmin) throw new Error("无权控制该工作区（仅资源所有者或管理员）")
  if (ws.status !== "RUNNING" && ws.status !== "IDLE") throw new Error(`工作区当前不可控制（${ws.status}）`)
  if (ws.mode !== "cdp_light") throw new Error("仅 CDP 轻量会话支持浏览器控制 API（NoVNC 会话请使用远程桌面）")
  return ws
}

function isSimulated(ws: BrowserWorkspace): boolean {
  return !externalAvailable.browser && (!ws.cdpUrl || ws.cdpUrl.includes("browser-internal"))
}

// ============================================================
// 四、动作注册表（MCP + OpenAPI 共用唯一事实源）
// ============================================================

// 工具：坐标解析（真实 CDP）
async function realClick(conn: CdpConnection, sessionId: string, x: number, y: number) {
  const base = { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }
  await conn.send("Input.dispatchMouseEvent", base, sessionId)
  await conn.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, sessionId)
}

async function realClickSelector(conn: CdpConnection, sessionId: string, selector: string) {
  const res = await conn.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, tag: el.tagName, text: (el.textContent || "").slice(0, 120) }); })()`,
    returnByValue: true,
  }, sessionId)
  const val = (res.result || {}) as { value?: string }
  if (!val.value) throw new Error(`选择器未命中元素：${selector}`)
  const box = JSON.parse(val.value) as { x: number; y: number; tag: string; text: string }
  await realClick(conn, sessionId, Math.round(box.x), Math.round(box.y))
  return box
}

const VIRTUAL_KEYCODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Shift: 16, Control: 17, Alt: 18, Meta: 91,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}

export const BROWSER_ACTIONS: BrowserActionDef[] = [
  {
    action: "status",
    summary: "获取会话控制通道状态（连接池/模拟引擎/生效策略）",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string（ID或UUID）" },
    async execute(ws, ctx) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const tab = s.tabs[s.activeIdx]
        return {
          mode: "SIMULATED", workspaceId: ws.id, uuid: ws.uuid, name: ws.name,
          activeTab: { url: tab.url, title: tab.title }, tabs: s.tabs.length,
          domNodes: s.dom.length, consoleEntries: s.console.length, networkEntries: s.network.length,
          cookies: s.cookies.length, blockedCount: s.blockedCount,
          throttle: s.throttle, allowUrls: s.allowUrls, blockedUrls: s.blockedUrls,
          uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
          networkPolicy: ws.networkPolicyJson,
        }
      }
      const conn = await getRealConnection(ws)
      const ver = await conn.send("Browser.getVersion")
      const targets = await conn.send("Target.getTargets")
      return {
        mode: "LIVE_CDP", workspaceId: ws.id, uuid: ws.uuid, name: ws.name,
        browser: ver.product || "Chromium", protocol: ver.protocolVersion,
        targets: ((targets.targetInfos || []) as Array<{ type: string; url: string; title: string }>).slice(0, 20),
        networkPolicy: ws.networkPolicyJson,
      }
    },
  },
  {
    action: "debug_info",
    summary: "调试信息：浏览器版本 / 目标列表 / 用户代理 / 视口",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        return { mode: "SIMULATED", userAgent: s.userAgent, viewport: s.viewport, tabs: s.tabs.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title })), extraHeaders: s.extraHeaders, pid: -1 }
      }
      const conn = await getRealConnection(ws)
      const [ver, targets, ua] = await Promise.all([
        conn.send("Browser.getVersion"),
        conn.send("Target.getTargets"),
        conn.send("Browser.getVersion").catch(() => ({}) as Record<string, unknown>),
      ])
      const sid = await attachPage(conn)
      const viewport = await conn.send("Runtime.evaluate", { expression: "JSON.stringify({w: innerWidth, h: innerHeight, ua: navigator.userAgent})", returnByValue: true }, sid).catch(() => ({}) as Record<string, unknown>)
      const vv = ((viewport as Record<string, unknown>).result || {}) as { value?: string }
      const targetsInfo = ((targets.targetInfos || []) as unknown[]).slice(0, 20)
      return {
        mode: "LIVE_CDP", browser: ver.product, protocolVersion: ver.protocolVersion,
        targets: targetsInfo,
        runtime: vv.value ? JSON.parse(vv.value) : null, cdpUrl: ws.cdpUrl, userAgentsRevision: (ua as Record<string, unknown>).revision || null,
      }
    },
  },
  {
    action: "navigate",
    summary: "导航到指定 URL（域名黑白名单策略实时生效）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", url: "string", waitMs: "number?（等待加载毫秒，默认3000）" },
    async execute(ws, ctx, p) {
      const url = String(p.url || "")
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && url !== "about:blank") {
        throw new Error("URL 必须以协议开头（http:// 或 https://）")
      }
      if (/^(file|chrome|devtools):/i.test(url)) {
        throw new Error(`协议 ${url.split(":")[0]} 已被安全策略禁止（容器级沙箱）`)
      }
      const waitMs = Math.min(Number(p.waitMs || 3000), 15000)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const res = simNavigate(s, url)
        return { navigated: res.ok, url: s.tabs[s.activeIdx].url, blocked: res.blocked, reason: res.reason || null }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Page.enable", {}, sid).catch(() => ({}))
      const res = await conn.send("Page.navigate", { url }, sid)
      // 等待加载事件（简化：固定等待 + loadEventFired 由事件缓冲观察）
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)))
      return { navigated: true, frameId: res.frameId, loaderId: res.loaderId, errorText: res.errorText || null, url }
    },
  },
  {
    action: "screenshot",
    summary: "页面截图（PNG base64，可选全页/裁剪）",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string", format: "png|jpeg?", quality: "number?（jpeg 1-100）", fullPage: "boolean?" },
    async execute(ws, ctx, p) {
      const format = p.format === "jpeg" ? "jpeg" : "png"
      const quality = Math.min(Math.max(Number(p.quality || 80), 1), 100)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        return await simScreenshot(s, ws)
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const shot = await conn.send("Page.captureScreenshot", { format, quality: format === "jpeg" ? quality : undefined, captureBeyondViewport: !!p.fullPage }, sid)
      const data = String(shot.data || "")
      return { format, width: 0, height: 0, dataBase64: data, note: "width/height 由客户端解码获得" }
    },
  },
  {
    action: "scrape",
    summary: "抓取页面内容（html / text / 链接提取）",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string", mode: "text|html|links?", selector: "string?（text 模式限定选择器）" },
    async execute(ws, ctx, p) {
      const mode = p.mode === "html" ? "html" : p.mode === "links" ? "links" : "text"
      if (isSimulated(ws)) {
        const s = simOf(ws)
        if (mode === "html") return { mode, content: s.dom.map((n) => `<${n.tag}${n.attrs.id ? ` id="${n.attrs.id}"` : ""}>${escapeXml(n.text)}</${n.tag}>`).join("\n"), url: s.tabs[s.activeIdx].url }
        if (mode === "links") return { mode, links: s.dom.filter((n) => n.href).map((n) => ({ text: n.text, href: n.href })) }
        const sel = p.selector ? String(p.selector) : null
        const nodes = sel ? s.dom.filter((n) => findSimNode(s, sel) === n) : s.dom
        return { mode, content: nodes.map((n) => n.text).filter(Boolean).join("\n"), url: s.tabs[s.activeIdx].url }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const expr = mode === "html"
        ? "document.documentElement.outerHTML"
        : mode === "links"
          ? "JSON.stringify(Array.from(document.querySelectorAll('a')).map(a => ({ text: (a.textContent||'').trim().slice(0,120), href: a.href })).slice(0, 500))"
          : p.selector
            ? `document.querySelector(${JSON.stringify(String(p.selector))})?.textContent || ''`
            : "document.body.innerText.slice(0, 100000)"
      const res = await conn.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid)
      const val = ((res.result || {}) as { value?: unknown }).value
      return { mode, content: mode === "links" && typeof val === "string" ? JSON.parse(val) : val, url: null }
    },
  },
  {
    action: "evaluate",
    summary: "在页面上下文执行 JS 表达式（await Promise 支持）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", expression: "string", awaitPromise: "boolean?" },
    async execute(ws, ctx, p) {
      const expression = String(p.expression || "")
      if (expression.length > 100_000) throw new Error("表达式过长（上限 100KB）")
      if (isSimulated(ws)) return simEvaluate(simOf(ws), expression)
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const res = await conn.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: p.awaitPromise !== false, userGesture: true,
      }, sid)
      const r = (res.result || {}) as { type?: string; value?: unknown; description?: string; subtype?: string }
      if (res.exceptionDetails) {
        const ex = res.exceptionDetails as { text?: string; exception?: { description?: string } }
        throw new Error(`页面执行异常：${ex.exception?.description || ex.text || "unknown"}`)
      }
      return { result: r.subtype === "null" ? null : r.value !== undefined ? r.value : r.description, type: r.type }
    },
  },
  {
    action: "get_url",
    summary: "获取当前页 URL / 标题 / 活动标签",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const t = s.tabs[s.activeIdx]
        return { url: t.url, title: t.title, targetId: t.targetId, historyDepth: t.history.length }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const res = await conn.send("Runtime.evaluate", { expression: "JSON.stringify({ url: location.href, title: document.title })", returnByValue: true }, sid)
      const val = ((res.result || {}) as { value?: string }).value
      return val ? JSON.parse(val) : { url: null, title: null }
    },
  },
  {
    action: "click",
    summary: "点击页面元素（选择器或坐标）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", selector: "string?", x: "number?", y: "number?" },
    async execute(ws, ctx, p) {
      const hasSelector = p.selector !== undefined && p.selector !== null && String(p.selector) !== ""
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const { x, y, node } = resolveSimTarget(s, p)
        if (!node && !hasSelector) throw new Error("坐标未命中任何元素")
        s.lastInputAt = Date.now()
        simLog(s, "console", "INFO", `[sim] click ${hasSelector ? String(p.selector) : `(${x},${y})`} → ${node ? `#${node.id} <${node.tag}> "${node.text.slice(0, 40)}"` : "空区域"}`)
        if (node?.tag === "a" && node.href) {
          simNavigate(s, node.href)
          return { clicked: true, x, y, node: node.tag, navigatedTo: node.href }
        }
        return { clicked: true, x, y, node: node?.tag || null, text: node?.text.slice(0, 60) || null }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      if (hasSelector) {
        const box = await realClickSelector(conn, sid, String(p.selector))
        pushLog(ws.id, "console", "INFO", `click selector ${String(p.selector)} → <${box.tag}> "${(box.text || "").slice(0, 40)}"`, "cdp-control")
        return { clicked: true, selector: String(p.selector), tag: box.tag, text: (box.text || "").slice(0, 60) }
      }
      const x = Math.round(Number(p.x ?? 0))
      const y = Math.round(Number(p.y ?? 0))
      await realClick(conn, sid, x, y)
      pushLog(ws.id, "console", "INFO", `click (${x},${y})`, "cdp-control")
      return { clicked: true, x, y }
    },
  },
  {
    action: "type",
    summary: "输入文本（可选先清空/聚焦目标元素）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", text: "string", selector: "string?", clear: "boolean?" },
    async execute(ws, ctx, p) {
      const text = String(p.text ?? "")
      if (text.length > 10_000) throw new Error("输入文本过长（上限 10000 字符）")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        let target: SimDomNode | null = null
        if (p.selector) {
          target = findSimNode(s, String(p.selector))
          if (!target) throw new Error(`选择器未命中：${String(p.selector)}`)
        } else {
          target = s.dom.find((n) => n.tag === "input") || null
        }
        s.lastInputAt = Date.now()
        if (target) {
          target.attrs.value = p.clear === false ? `${target.attrs.value || ""}${text}` : text
        }
        simLog(s, "console", "INFO", `[sim] type "${text.slice(0, 60)}" → ${target ? `#${target.id} <${target.tag}>` : "焦点元素"}`)
        return { typed: text.length, selector: p.selector ? String(p.selector) : null, value: target?.attrs.value ?? text }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      if (p.selector) {
        const box = await realClickSelector(conn, sid, String(p.selector))
        if (p.clear !== false) {
          await conn.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(String(p.selector))})?.focus(); document.execCommand && document.execCommand('selectAll'); document.execCommand && document.execCommand('delete')`, returnByValue: true }, sid).catch(() => ({}))
        }
        await conn.send("Input.insertText", { text }, sid)
        return { typed: text.length, selector: String(p.selector), tag: box.tag }
      }
      await conn.send("Input.insertText", { text }, sid)
      return { typed: text.length }
    },
  },
  {
    action: "press_key",
    summary: "按键（Enter/Tab/Escape/字母数字/方向键…）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", key: "string", modifiers: "number?（位掩码 1=Alt 2=Ctrl 8=Shift）" },
    async execute(ws, ctx, p) {
      const key = String(p.key || "")
      if (!key || key.length > 20) throw new Error("非法按键")
      const modifiers = Math.min(Number(p.modifiers || 0), 15)
      const keycode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : VIRTUAL_KEYCODES[key]
      if (keycode === undefined) throw new Error(`不支持的按键：${key}`)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.lastInputAt = Date.now()
        simLog(s, "console", "INFO", `[sim] keydown ${key} (code ${keycode})`)
        if (key === "Enter") {
          const btn = s.dom.find((n) => n.tag === "button")
          if (btn) simLog(s, "console", "INFO", `[sim] Enter 触发按钮提交 "${btn.text}"`)
        }
        return { pressed: key, keyCode: keycode }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const base = { type: "keyDown", key, windowsVirtualKeyCode: keycode, nativeVirtualKeyCode: keycode, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers }
      await conn.send("Input.dispatchKeyEvent", base, sid)
      await conn.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, sid)
      return { pressed: key, keyCode: keycode }
    },
  },
  {
    action: "scroll",
    summary: "滚动页面（dx/dy 像素或滚轮按钮）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", dx: "number?（默认0）", dy: "number?（默认300）", x: "number?", y: "number?" },
    async execute(ws, ctx, p) {
      const dx = Math.round(Number(p.dx ?? 0))
      const dy = Math.round(Number(p.dy ?? 300))
      if (Math.abs(dx) > 100_000 || Math.abs(dy) > 100_000) throw new Error("滚动量过大")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.lastInputAt = Date.now()
        simLog(s, "console", "INFO", `[sim] scroll dx=${dx} dy=${dy}`)
        return { scrolled: true, dx, dy }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Number(p.x ?? 400), y: Number(p.y ?? 400), deltaX: dx, deltaY: dy }, sid)
      return { scrolled: true, dx, dy }
    },
  },
  {
    action: "hover",
    summary: "悬停（移动鼠标到选择器/坐标）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", selector: "string?", x: "number?", y: "number?" },
    async execute(ws, ctx, p) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const { x, y, node } = resolveSimTarget(s, p)
        s.lastInputAt = Date.now()
        return { hovered: true, x, y, node: node?.tag || null }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      let x = Math.round(Number(p.x ?? 0))
      let y = Math.round(Number(p.y ?? 0))
      if (p.selector) {
        const box = await realClickSelector(conn, sid, String(p.selector)).catch(() => null)
        if (box) { x = Math.round(box.x); y = Math.round(box.y) }
      }
      await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, sid)
      return { hovered: true, x, y }
    },
  },
  {
    action: "get_tabs",
    summary: "获取全部标签页列表",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        return { tabs: s.tabs.map((t, i) => ({ index: i, targetId: t.targetId, url: t.url, title: t.title, active: i === s.activeIdx })) }
      }
      const conn = await getRealConnection(ws)
      const targets = await conn.send("Target.getTargets")
      const list = (targets.targetInfos || []) as Array<{ targetId: string; type: string; url: string; title: string }>
      return { tabs: list.filter((t) => t.type === "page").map((t, i) => ({ index: i, targetId: t.targetId, url: t.url, title: t.title, active: false })) }
    },
  },
  {
    action: "new_tab",
    summary: "新建标签页（可携带初始 URL）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", url: "string?（默认 about:blank）" },
    async execute(ws, ctx, p) {
      const url = String(p.url || "about:blank")
      if (/^(file|chrome|devtools):/i.test(url)) throw new Error("协议被安全策略禁止")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        if (s.tabs.length >= 10) throw new Error("模拟引擎标签页上限 10")
        const tid = `sim-t${Date.now().toString(36)}`
        const tab: SimTab = { targetId: tid, url, title: url, history: [url], histIndex: 0 }
        s.tabs.push(tab)
        s.activeIdx = s.tabs.length - 1
        if (url !== "about:blank") simRenderDom(s, url)
        simLog(s, "console", "INFO", `[sim] new tab ${url}`)
        return { targetId: tid, index: s.tabs.length - 1, url }
      }
      const conn = await getRealConnection(ws)
      const created = await conn.send("Target.createTarget", { url })
      return { targetId: String(created.targetId), url }
    },
  },
  {
    action: "close_tab",
    summary: "关闭标签页（至少保留一个标签）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", targetId: "string" },
    async execute(ws, ctx, p) {
      const targetId = String(p.targetId || "")
      if (!targetId) throw new Error("缺少 targetId")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const idx = s.tabs.findIndex((t) => t.targetId === targetId)
        if (idx === -1) throw new Error("标签不存在")
        if (s.tabs.length <= 1) throw new Error("至少保留一个标签页")
        s.tabs.splice(idx, 1)
        if (s.activeIdx >= s.tabs.length) s.activeIdx = s.tabs.length - 1
        return { closed: targetId }
      }
      const conn = await getRealConnection(ws)
      await conn.send("Target.closeTarget", { targetId })
      return { closed: targetId }
    },
  },
  {
    action: "activate_tab",
    summary: "激活（切换到）指定标签页",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", targetId: "string" },
    async execute(ws, ctx, p) {
      const targetId = String(p.targetId || "")
      if (!targetId) throw new Error("缺少 targetId")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const idx = s.tabs.findIndex((t) => t.targetId === targetId)
        if (idx === -1) throw new Error("标签不存在")
        s.activeIdx = idx
        return { activated: targetId, index: idx }
      }
      const conn = await getRealConnection(ws)
      await conn.send("Target.activateTarget", { targetId })
      return { activated: targetId }
    },
  },
  {
    action: "back",
    summary: "历史后退",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const t = s.tabs[s.activeIdx]
        if (t.histIndex <= 0) throw new Error("已无历史可后退")
        t.histIndex -= 1
        t.url = t.history[t.histIndex]
        simRenderDom(s, t.url)
        return { url: t.url, index: t.histIndex }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const hist = await conn.send("Page.getNavigationHistory", {}, sid)
      const h = hist as { currentIndex: number; entries: Array<{ id: number; url: string }> }
      if (h.currentIndex <= 0) throw new Error("已无历史可后退")
      const entry = h.entries[h.currentIndex - 1]
      await conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sid)
      return { url: entry.url }
    },
  },
  {
    action: "forward",
    summary: "历史前进",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const t = s.tabs[s.activeIdx]
        if (t.histIndex >= t.history.length - 1) throw new Error("已无历史可前进")
        t.histIndex += 1
        t.url = t.history[t.histIndex]
        simRenderDom(s, t.url)
        return { url: t.url, index: t.histIndex }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const hist = await conn.send("Page.getNavigationHistory", {}, sid)
      const h = hist as { currentIndex: number; entries: Array<{ id: number; url: string }> }
      if (h.currentIndex >= h.entries.length - 1) throw new Error("已无历史可前进")
      const entry = h.entries[h.currentIndex + 1]
      await conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sid)
      return { url: entry.url }
    },
  },
  {
    action: "reload",
    summary: "重新加载当前页（可忽略缓存）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", ignoreCache: "boolean?" },
    async execute(ws, ctx, p) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const t = s.tabs[s.activeIdx]
        simRenderDom(s, t.url)
        simLog(s, "network", "OK", `GET ${t.url}（reload）`)
        return { reloaded: true, url: t.url }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Page.reload", { ignoreCache: !!p.ignoreCache }, sid)
      await new Promise((r) => setTimeout(r, 1500))
      return { reloaded: true }
    },
  },
  {
    action: "get_cookies",
    summary: "读取会话 Cookie",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string", urls: "string[]?（限定站点）" },
    async execute(ws, ctx, p) {
      const urls = Array.isArray(p.urls) ? (p.urls as string[]).slice(0, 20).map(String) : undefined
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const all = urls ? s.cookies.filter((c) => urls.some((u) => c.domain.includes(hostnameOf(u)))) : s.cookies
        // 脱敏输出（与真实形态一致：值仅保留前后 4 位）
        return { cookies: all.map((c) => ({ ...c, value: c.value.length > 8 ? `${c.value.slice(0, 4)}…${c.value.slice(-4)}` : "***", valueRedacted: true })) }
      }
      const conn = await getRealConnection(ws)
      const res = await conn.send("Storage.getCookies", urls ? { browserContextId: undefined } : {})
      const cookies = (res.cookies || []) as Array<Record<string, unknown>>
      const filtered = urls ? cookies.filter((c) => urls.some((u) => String(c.domain || "").includes(hostnameOf(u)))) : cookies
      // 脱敏输出：值仅保留前后4位（安全审计要求）
      return { cookies: filtered.map((c) => ({ ...c, value: `${String(c.value || "").slice(0, 4)}…${String(c.value || "").slice(-4)}`, valueRedacted: true })) }
    },
  },
  {
    action: "set_cookies",
    summary: "写入会话 Cookie",
    perm: TOKEN_PERM.WRITE,
    params: { workspaceId: "string", cookies: "[{name,value,domain,path?}]" },
    async execute(ws, ctx, p) {
      const cookies = Array.isArray(p.cookies) ? (p.cookies as Array<Record<string, unknown>>) : []
      if (cookies.length === 0 || cookies.length > 50) throw new Error("cookies 数组须为 1-50 项")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        for (const c of cookies) {
          const name = String(c.name || "")
          if (!name || name.length > 200) throw new Error("非法 cookie name")
          s.cookies.push({ name, value: String(c.value || "").slice(0, 2000), domain: String(c.domain || hostnameOf(s.tabs[s.activeIdx].url)), path: String(c.path || "/") })
        }
        return { set: cookies.length }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.enable", {}, sid).catch(() => ({}))
      let set = 0
      for (const c of cookies) {
        await conn.send("Network.setCookie", {
          name: String(c.name || ""),
          value: String(c.value || ""),
          domain: String(c.domain || ""),
          path: String(c.path || "/"),
        }, sid)
        set++
      }
      return { set }
    },
  },
  {
    action: "block_urls",
    summary: "运行时 URL 黑名单（叠加域名策略）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", patterns: "string[]（支持通配符）" },
    async execute(ws, ctx, p) {
      const patterns = Array.isArray(p.patterns) ? (p.patterns as unknown[]).slice(0, 200).map(String) : []
      if (patterns.length === 0) throw new Error("patterns 不能为空")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.blockedUrls = [...new Set([...s.blockedUrls, ...patterns])]
        s.allowUrls = null // 黑名单与白名单互斥（后设置者生效）
        return { blockedUrls: s.blockedUrls }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.enable", {}, sid)
      await conn.send("Network.setBlockedURLs", { urls: patterns })
      return { blockedUrls: patterns, note: "Network.setBlockedURLs 已生效（叠加 Chromium 托管策略）" }
    },
  },
  {
    action: "allow_urls",
    summary: "运行时 URL 白名单（仅放行名单，最强管控）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", patterns: "string[]" },
    async execute(ws, ctx, p) {
      const patterns = Array.isArray(p.patterns) ? (p.patterns as unknown[]).slice(0, 200).map(String) : []
      if (patterns.length === 0) throw new Error("白名单不能为空（清空请用 clear_url_filters）")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.allowUrls = [...new Set(patterns)]
        s.blockedUrls = []
        return { allowUrls: s.allowUrls }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.enable", {}, sid)
      // CDP 无原生白名单：黑名单全量 + Fetch 域放行名单（真实拦截）
      const fetchPatterns = patterns.map((p2) => ({ urlPattern: `*${p2.includes("://") ? "" : "://"}${p2.replace(/^\*\./, "*.")}*` }))
      await conn.send("Fetch.enable", {
        patterns: [{ urlPattern: "*" }, ...fetchPatterns.map((f) => ({ ...f, requestStage: "Request" }))],
        handleAuthRequests: false,
      }, sid).catch(() => ({}))
      await conn.send("Network.setBlockedURLs", { urls: patterns.map((p2) => `!${p2}`.replace("!!", "!")) }, sid).catch(() => ({}))
      return { allowUrls: patterns, note: "白名单模式已启用（Fetch 拦截 + 黑名单反选）" }
    },
  },
  {
    action: "clear_url_filters",
    summary: "清除运行时 URL 过滤（恢复托管策略基线）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string" },
    async execute(ws) {
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.blockedUrls = []
        s.allowUrls = null
        return { cleared: true }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.setBlockedURLs", { urls: [] }, sid).catch(() => ({}))
      await conn.send("Fetch.disable", {}, sid).catch(() => ({}))
      return { cleared: true, note: "运行时过滤已清除，Chromium 托管策略仍然生效" }
    },
  },
  {
    action: "throttle",
    summary: "网络节流（0.001 精度，含离线模拟）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", downKbps: "number?", upKbps: "number?", latencyMs: "number?", offline: "boolean?" },
    async execute(ws, ctx, p) {
      const throttle = {
        downKbps: Number(p.downKbps ?? 0),
        upKbps: Number(p.upKbps ?? 0),
        latencyMs: Number(p.latencyMs ?? 0),
        offline: p.offline === true,
      }
      if ([throttle.downKbps, throttle.upKbps, throttle.latencyMs].some((v) => v < 0 || v > 10_000_000)) throw new Error("节流参数超界")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.throttle = throttle
        simLog(s, "console", "INFO", `[sim] 网络节流 ${JSON.stringify(throttle)}`)
        return { throttle }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.enable", {}, sid)
      await conn.send("Network.emulateNetworkConditions", {
        offline: throttle.offline,
        latency: Math.round(throttle.latencyMs),
        downloadThroughput: throttle.downKbps > 0 ? throttle.downKbps * 1024 / 8 : -1,
        uploadThroughput: throttle.upKbps > 0 ? throttle.upKbps * 1024 / 8 : -1,
      }, sid)
      return { throttle }
    },
  },
  {
    action: "set_user_agent",
    summary: "运行时覆盖 User-Agent / 语言 / 平台",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", userAgent: "string", acceptLanguage: "string?", platform: "string?" },
    async execute(ws, ctx, p) {
      const userAgent = String(p.userAgent || "")
      if (userAgent.length < 10 || userAgent.length > 500) throw new Error("UA 字符串非法（10-500 字符）")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.userAgent = userAgent
        return { userAgent }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: p.acceptLanguage ? String(p.acceptLanguage) : undefined,
        platform: p.platform ? String(p.platform) : undefined,
      }, sid)
      return { userAgent }
    },
  },
  {
    action: "set_viewport",
    summary: "覆盖视口尺寸（响应式测试）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", width: "number", height: "number", mobile: "boolean?", deviceScaleFactor: "number?" },
    async execute(ws, ctx, p) {
      const width = Math.round(Number(p.width ?? 0))
      const height = Math.round(Number(p.height ?? 0))
      if (width < 200 || width > 5000 || height < 200 || height > 8000) throw new Error("视口尺寸非法（200-5000 × 200-8000）")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.viewport = { width, height }
        return { width, height, viewport: { width, height } }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Emulation.setDeviceMetricsOverride", {
        width, height,
        mobile: p.mobile === true,
        deviceScaleFactor: Number(p.deviceScaleFactor ?? 1),
      }, sid)
      return { width, height }
    },
  },
  {
    action: "set_geolocation",
    summary: "覆盖地理位置（经纬度）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", latitude: "number", longitude: "number", accuracy: "number?" },
    async execute(ws, ctx, p) {
      const latitude = Number(p.latitude ?? 0)
      const longitude = Number(p.longitude ?? 0)
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("经纬度超界（±90 / ±180）")
      if (isSimulated(ws)) {
        const s = simOf(ws)
        simLog(s, "console", "INFO", `[sim] geolocation → ${latitude},${longitude}`)
        return { latitude, longitude }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Emulation.setGeolocationOverride", { latitude, longitude, accuracy: Number(p.accuracy ?? 100) }, sid)
      return { latitude, longitude }
    },
  },
  {
    action: "set_extra_headers",
    summary: "为后续请求附加自定义请求头",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", headers: "json（name→value）" },
    async execute(ws, ctx, p) {
      const headers = (p.headers && typeof p.headers === "object" ? p.headers : {}) as Record<string, unknown>
      const entries = Object.entries(headers).slice(0, 30)
      if (entries.length === 0) throw new Error("headers 不能为空")
      for (const [k, v] of entries) {
        if (/^(host|content-length|connection)$/i.test(k)) throw new Error(`禁止覆盖保留头：${k}`)
        if (String(k).length > 100 || String(v).length > 2000) throw new Error("请求头尺寸超界")
      }
      if (isSimulated(ws)) {
        const s = simOf(ws)
        s.extraHeaders = Object.fromEntries(entries.map(([k, v]) => [String(k), String(v)]))
        return { headers: s.extraHeaders }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      await conn.send("Network.enable", {}, sid)
      await conn.send("Network.setExtraHTTPHeaders", { headers: Object.fromEntries(entries.map(([k, v]) => [String(k), String(v)])) }, sid)
      return { headers: entries.length }
    },
  },
  {
    action: "wait_for",
    summary: "等待条件（选择器出现 / 文本出现 / 固定延时）",
    perm: TOKEN_PERM.EXECUTE,
    params: { workspaceId: "string", selector: "string?", text: "string?", timeoutMs: "number?（默认10000）" },
    async execute(ws, ctx, p) {
      const timeoutMs = Math.min(Number(p.timeoutMs ?? 10000), 30000)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          if (p.selector && findSimNode(s, String(p.selector))) {
            return { matched: true, condition: "selector", selector: String(p.selector), waitedMs: Date.now() - start }
          }
          if (p.text && s.dom.some((n) => n.text.includes(String(p.text)))) {
            return { matched: true, condition: "text", text: String(p.text), waitedMs: Date.now() - start }
          }
          if (!p.selector && !p.text) {
            await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1000)))
            return { matched: true, condition: "timeout", waitedMs: Math.min(timeoutMs, 1000) }
          }
          await new Promise((r) => setTimeout(r, 200))
        }
        throw new Error(`等待条件超时（${timeoutMs}ms）`)
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const start = Date.now()
      const expr = p.selector
        ? `!!document.querySelector(${JSON.stringify(String(p.selector))})`
        : p.text
          ? `document.body.innerText.includes(${JSON.stringify(String(p.text))})`
          : "true"
      while (Date.now() - start < timeoutMs) {
        const res = await conn.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid)
        const val = ((res.result || {}) as { value?: unknown }).value
        if (val === true) return { matched: true, waitedMs: Date.now() - start }
        await new Promise((r) => setTimeout(r, 300))
      }
      throw new Error(`等待条件超时（${timeoutMs}ms）`)
    },
  },
  {
    action: "get_logs",
    summary: "读取控制台 / 网络日志（环形缓冲，最近优先）",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string", kind: "console|network?", tail: "number?（默认50）" },
    async execute(ws, ctx, p) {
      const kind = p.kind === "network" ? "network" : "console"
      const tail = Math.min(Math.max(Number(p.tail || 50), 1), 300)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        const arr = kind === "console" ? s.console : s.network
        return { kind, entries: arr.slice(-tail).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })), total: arr.length }
      }
      const logs = logsOf(ws.id)
      const arr = kind === "console" ? logs.console : logs.network
      return { kind, entries: arr.slice(-tail).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })), total: arr.length }
    },
  },
  {
    action: "dom_snapshot",
    summary: "DOM 快照（结构化树）",
    perm: TOKEN_PERM.READ,
    params: { workspaceId: "string", maxNodes: "number?（默认200）" },
    async execute(ws, ctx, p) {
      const maxNodes = Math.min(Math.max(Number(p.maxNodes || 200), 1), 2000)
      if (isSimulated(ws)) {
        const s = simOf(ws)
        return {
          url: s.tabs[s.activeIdx].url,
          nodes: s.dom.slice(0, maxNodes).map((n) => ({ id: n.id, tag: n.tag, text: n.text.slice(0, 120), href: n.href, id2: n.attrs.id, rect: n.rect })),
        }
      }
      const conn = await getRealConnection(ws)
      const sid = await attachPage(conn)
      const res = await conn.send("Runtime.evaluate", {
        expression: `(() => { const out = []; const walk = (el, depth) => { if (out.length >= ${maxNodes} || depth > 12) return; const r = el.getBoundingClientRect(); out.push({ tag: el.tagName, id: el.id || null, text: (el.textContent || '').trim().slice(0, 100), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, children: el.children.length }); for (const c of Array.from(el.children).slice(0, 20)) walk(c, depth + 1); }; walk(document.body, 0); return JSON.stringify(out); })()`,
        returnByValue: true,
      }, sid)
      const val = ((res.result || {}) as { value?: string }).value
      return { nodes: val ? JSON.parse(val) : [] }
    },
  },
]

// ============================================================
// 五、对外执行入口（鉴权 / 限流 / 审计 / 行为追踪）
// ============================================================

export interface BrowserControlResult {
  action: string
  workspaceId: string
  workspaceName: string
  mode: "SIMULATED" | "LIVE_CDP"
  data: unknown
  durationMs: number
}

export async function executeBrowserAction(input: {
  action: string
  workspaceIdOrUuid: string
  ctx: BrowserControlContext
  params?: Record<string, unknown>
}): Promise<BrowserControlResult> {
  const def = BROWSER_ACTIONS.find((a) => a.action === input.action)
  if (!def) throw new Error(`未知浏览器控制动作：${input.action}（可用动作见 GET /api/openapi/browser）`)
  const ws = await resolveControlledWorkspace(input.workspaceIdOrUuid, input.ctx)

  // 独立限流（按用户）：180 次/分钟
  if (!rateLimit(`browserControl:${input.ctx.userId}`, 180, 60_000).allowed) {
    throw new Error("浏览器控制调用过于频繁（180次/分钟），请稍后再试")
  }

  const start = Date.now()
  const data = await def.execute(ws, input.ctx, input.params || {})
  const durationMs = Date.now() - start

  // 更新工作区活跃计数（防闲置回收误伤 API 驱动的会话；cdp 调用计数 + 最近活跃时间）
  await db.browserWorkspace.update({ where: { id: ws.id }, data: { cdpCallCount: { increment: 1 }, lastActiveAt: new Date() } }).catch(() => {})

  // 全量审计 + 行为追踪
  await writeAudit({
    operatorUserId: input.ctx.userId,
    operatorName: input.ctx.username,
    operationType: "BROWSER_CONTROL",
    resourceType: "WORKSPACE",
    resourceId: ws.id,
    resourceName: ws.name,
    ownerUserId: ws.userId,
    after: { action: def.action, via: input.ctx.via, paramsSummary: JSON.stringify(input.params || {}).slice(0, 300), durationMs, mode: isSimulated(ws) ? "SIMULATED" : "LIVE_CDP" },
  })
  await trackBehavior(input.ctx.userId, "BATCH")

  return {
    action: def.action,
    workspaceId: ws.id,
    workspaceName: ws.name,
    mode: isSimulated(ws) ? "SIMULATED" : "LIVE_CDP",
    data,
    durationMs,
  }
}

// 目录输出（MCP tools/list + OpenAPI 文档共用）
export function listBrowserActions() {
  return BROWSER_ACTIONS.map((a) => ({
    action: a.action,
    summary: a.summary,
    perm: a.perm,
    danger: !!a.danger,
    params: a.params,
  }))
}
