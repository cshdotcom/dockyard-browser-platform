// ============================================================
// r29-c：沙箱 CDP 控制通道（监控中心远程操作）
//   零内核 Patch —— 全部走 Chromium DevTools Protocol 标准协议：
//   · Page.captureScreenshot   宫格快照（JPEG base64）
//   · Page.navigate            强制跳转 URL
//   · Target.closeTarget(/json/close) 强制关标签
//   · Runtime.evaluate         消息推送（页面内浮层横幅，30s 自动消失）
//   · Input.dispatch*          远程键鼠注入（管理员接管）
// 通道安全：CDP 端点仅容器网络可达（回环基线封禁用户侧访问），
//   本模块仅服务端调用（管理员 RBAC 在 actions 层校验）。
// ============================================================

import { listWorkspacePages } from "./browsing-collector"

const CALL_TIMEOUT_MS = 8000

interface CdpResponse { id: number; result?: unknown; error?: { message?: string } }

/** 单命令 WS 拨号（连接 → 发送 → 等响应 → 关闭；Node24/Bun 原生 WebSocket） */
async function cdpCall(wsUrl: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      if (err) reject(err)
      else resolve(result)
    }
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => done(new Error(`CDP 命令超时（${method}）`)), CALL_TIMEOUT_MS)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params: params || {} }))
    }
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CdpResponse
        if (msg.id === 1) {
          if (msg.error) done(new Error(msg.error.message || "CDP 错误"))
          else done(null, msg.result)
        }
      } catch { /* 非 JSON 帧（事件）忽略 */ }
    }
    ws.onerror = () => done(new Error("CDP WebSocket 拨号失败"))
    ws.onclose = () => done(new Error("CDP 连接提前关闭"))
  })
}

/** cdpUrl(浏览器级 webSocketDebuggerUrl 或 http 基址) → 页面级 WS URL
 *  /json/list 条目的 id 即 targetId；条目自带 webSocketDebuggerUrl（host 适配） */
async function pageWsUrl(cdpUrl: string, targetId?: string): Promise<{ wsUrl: string; targetId: string } | null> {
  const pages = await listWorkspacePages(cdpUrl)
  if (!pages || pages.length === 0) return null
  const target = targetId ? pages.find((p) => (p.targetId || p.id) === targetId) : pages[0]
  const tid = target?.targetId || target?.id
  if (!tid) return null
  if (target?.webSocketDebuggerUrl) return { wsUrl: target.webSocketDebuggerUrl, targetId: tid }
  const base = cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "")
  return { wsUrl: `${base.replace(/^http/, "ws")}/devtools/page/${tid}`, targetId: tid }
}

// ---- 宫格快照（10s 内存缓存防连拍压垮 Chromium） ----
interface SnapCacheEntry { at: number; b64: string }
const gSnapCache = ((globalThis as unknown as { __dySnapCache?: Map<string, SnapCacheEntry> }).__dySnapCache) || new Map<string, SnapCacheEntry>()
;(globalThis as unknown as { __dySnapCache?: Map<string, SnapCacheEntry> }).__dySnapCache = gSnapCache

export async function captureScreenshot(cdpUrl: string, workspaceId: string, opts?: { force?: boolean }): Promise<{ b64: string; targetId: string } | null> {
  const cached = gSnapCache.get(workspaceId)
  if (!opts?.force && cached && Date.now() - cached.at < 10_000) {
    return { b64: cached.b64, targetId: "" }
  }
  const page = await pageWsUrl(cdpUrl)
  if (!page) return null
  const result = (await cdpCall(page.wsUrl, "Page.captureScreenshot", { format: "jpeg", quality: 70 }).catch(() => null)) as { data?: string } | null
  if (!result?.data) return null
  gSnapCache.set(workspaceId, { at: Date.now(), b64: result.data })
  return { b64: result.data, targetId: page.targetId }
}

/** 强制跳转（全部页面目标；审计在 action 层） */
export async function forceNavigateAll(cdpUrl: string, url: string): Promise<number> {
  const pages = await listWorkspacePages(cdpUrl)
  if (!pages) return 0
  let n = 0
  for (const p of pages) {
    const tid = p.targetId || p.id
    if (!tid) continue
    const wsUrl = p.webSocketDebuggerUrl || `${cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "").replace(/^http/, "ws")}/devtools/page/${tid}`
    const ok = await cdpCall(wsUrl, "Page.navigate", { url }).then(() => true).catch(() => false)
    if (ok) n++
  }
  return n
}

/** 强制关标签（HTTP /json/close/<targetId> —— 无需 WS） */
export async function closeTab(cdpUrl: string, targetId: string): Promise<boolean> {
  try {
    const base = cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "")
    const res = await fetch(`${base}/json/close/${targetId}`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

/** 消息推送（页面内浮层横幅：品牌样式 + 30s 自动消失；不阻塞页面 alert） */
export async function pushMessage(cdpUrl: string, message: string, fromName: string): Promise<boolean> {
  const page = await pageWsUrl(cdpUrl)
  if (!page) return false
  const expr = `(function(){
    var old = document.getElementById('dy-admin-msg');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'dy-admin-msg';
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0f766e;color:#fff;font:14px/1.5 system-ui,sans-serif;padding:12px 16px;box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;align-items:center;gap:10px;';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f87171;flex:none;box-shadow:0 0 0 0 rgba(248,113,113,.7);animation:dyPulse 1.2s infinite;';
    var st = document.createElement('style');
    st.textContent = '@keyframes dyPulse{0%{box-shadow:0 0 0 0 rgba(248,113,113,.7)}70%{box-shadow:0 0 0 8px rgba(248,113,113,0)}100%{box-shadow:0 0 0 0 rgba(248,113,113,0)}}';
    var txt = document.createElement('span');
    txt.textContent = ${JSON.stringify(`[${fromName}] ${message}`)};
    var close = document.createElement('span');
    close.textContent = '×';
    close.style.cssText = 'margin-left:auto;cursor:pointer;font-size:18px;padding:0 6px;flex:none;';
    close.onclick = function(){ box.remove(); };
    box.appendChild(dot); box.appendChild(txt); box.appendChild(close);
    document.documentElement.appendChild(st);
    document.documentElement.appendChild(box);
    setTimeout(function(){ box.remove(); st.remove(); }, 30000);
    return true;
  })()`
  const result = (await cdpCall(page.wsUrl, "Runtime.evaluate", { expression: expr, returnByValue: true }).catch(() => null)) as { result?: { value?: unknown } } | null
  return result?.result?.value === true
}

/** 远程键鼠注入（Input.dispatch*；type=key/mouseLeft/mouseRight/mouseMove/mouseScroll） */
export async function dispatchInput(
  cdpUrl: string,
  input: { type: "key" | "mouseLeft" | "mouseRight" | "mouseMove" | "mouseScroll"; key?: string; x?: number; y?: number; text?: string },
): Promise<boolean> {
  const page = await pageWsUrl(cdpUrl)
  if (!page) return false
  let ok = false
  if (input.type === "key") {
    const keyDef = keyToCdp(input.key || "")
    if (!keyDef) return false
    ok = await cdpCall(page.wsUrl, "Input.dispatchKeyEvent", { type: "keyDown", ...keyDef }).then(() => true).catch(() => false)
    if (ok) ok = await cdpCall(page.wsUrl, "Input.dispatchKeyEvent", { type: "keyUp", ...keyDef }).then(() => true).catch(() => false)
  } else if (input.type === "mouseLeft" || input.type === "mouseRight") {
    const button = input.type === "mouseLeft" ? "left" : "right"
    ok = await cdpCall(page.wsUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x: input.x || 0, y: input.y || 0, button, clickCount: 1 }).then(() => true).catch(() => false)
    if (ok) ok = await cdpCall(page.wsUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x: input.x || 0, y: input.y || 0, button, clickCount: 1 }).then(() => true).catch(() => false)
  } else if (input.type === "mouseMove") {
    ok = await cdpCall(page.wsUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x: input.x || 0, y: input.y || 0 }).then(() => true).catch(() => false)
  } else {
    ok = await cdpCall(page.wsUrl, "Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x || 0, y: input.y || 0, deltaX: 0, deltaY: input.text === "up" ? -300 : 300 }).then(() => true).catch(() => false)
  }
  return ok
}

/** 常用按键 → CDP key 定义（字母/数字/方向/回车/退格/Tab/ESC/F1-F12） */
function keyToCdp(k: string): Record<string, unknown> | null {
  if (!k) return null
  const single = /^[a-zA-Z0-9]$/.test(k)
  if (single) {
    const code = k.toUpperCase()
    return { key: k.length === 1 && k === k.toUpperCase() ? k : k.toUpperCase(), code: `Key${k.match(/[0-9]/) ? `Digit${k}` : code}`, windowsVirtualKeyCode: k.charCodeAt(0), text: k }
  }
  const map: Record<string, { key: string; code: string; vk: number }> = {
    Enter: { key: "Enter", code: "Enter", vk: 13 },
    Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
    Delete: { key: "Delete", code: "Delete", vk: 46 },
    Tab: { key: "Tab", code: "Tab", vk: 9 },
    Escape: { key: "Escape", code: "Escape", vk: 27 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
    Home: { key: "Home", code: "Home", vk: 36 },
    End: { key: "End", code: "End", vk: 35 },
  }
  const f = /^F(\d{1,2})$/.exec(k)
  if (f) return { key: k, code: k, windowsVirtualKeyCode: 111 + Number(f[1]) }
  const m = map[k]
  if (m) return { ...m }
  return null
}

// ---- 多管理员控制互斥（内存租约：单 Master 实例语义） ----
interface ControlLease { adminId: string; adminName: string; acquiredAt: number; lastHeartbeat: number }
const gLease = ((globalThis as unknown as { __dyCtlLease?: Map<string, ControlLease> }).__dyCtlLease) || new Map<string, ControlLease>()
;(globalThis as unknown as { __dyCtlLease?: Map<string, ControlLease> }).__dyCtlLease = gLease

const LEASE_TTL_MS = 30_000

/** 获取控制租约（他人持有时返回持有者；成功返回 null） */
export function acquireControlLease(workspaceId: string, adminId: string, adminName: string): { ok: boolean; holder?: { adminName: string; acquiredAt: number } } {
  const cur = gLease.get(workspaceId)
  const now = Date.now()
  if (cur && cur.adminId !== adminId && now - cur.lastHeartbeat < LEASE_TTL_MS) {
    return { ok: false, holder: { adminName: cur.adminName, acquiredAt: cur.acquiredAt } }
  }
  gLease.set(workspaceId, { adminId, adminName, acquiredAt: now, lastHeartbeat: now })
  return { ok: true }
}

/** 心跳续期（查看持有者时顺带刷新自身） */
export function heartbeatControlLease(workspaceId: string, adminId: string): boolean {
  const cur = gLease.get(workspaceId)
  if (!cur || cur.adminId !== adminId) return false
  cur.lastHeartbeat = Date.now()
  return true
}

export function releaseControlLease(workspaceId: string, adminId: string): boolean {
  const cur = gLease.get(workspaceId)
  if (!cur || cur.adminId !== adminId) return false
  gLease.delete(workspaceId)
  return true
}

/** 当前持有者（宫格可见性展示；过期自动清理） */
export function controlLeaseHolder(workspaceId: string): { adminName: string; acquiredAt: number } | null {
  const cur = gLease.get(workspaceId)
  if (!cur) return null
  if (Date.now() - cur.lastHeartbeat > LEASE_TTL_MS) { gLease.delete(workspaceId); return null }
  return { adminName: cur.adminName, acquiredAt: cur.acquiredAt }
}
