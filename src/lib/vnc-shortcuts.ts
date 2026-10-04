/**
 * r28：VNC 快捷键库（noVNC 常用敏感快捷键扩展）
 *
 * 背景：noVNC 自带的快捷键只有 Ctrl+Alt+Del 等极少数；浏览器/网页优先吃掉大多数
 * 组合键（Ctrl+W 关标签、Ctrl+T 新标签、F5 刷新、Alt+Tab 被系统抢占等），
 * 通过本面板按键序列注入绕过浏览器与系统拦截，直达远程沙箱桌面。
 *
 * keysym 常量：X11 keysym（RFB KeyEvent 协议）
 */

// ---- 修饰键 keysym ----
export const KS_CTRL = 0xffe3
export const KS_CTRL_R = 0xffe4
export const KS_ALT = 0xffe9
export const KS_ALT_R = 0xffea
export const KS_SHIFT = 0xffe1
export const KS_SUPER = 0xffeb // Win/Meta 左
export const KS_SUPER_R = 0xffec

// ---- 常用键 keysym ----
export const KS = {
  Enter: 0xff0d, Tab: 0xff09, Esc: 0xff1b, BackSpace: 0xff08,
  Delete: 0xffff, Insert: 0xff63,
  Home: 0xff50, End: 0xff57, PgUp: 0xff55, PgDn: 0xff56,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Print: 0xff61, ScrollLock: 0xff14, Pause: 0xff13,
  NumLock: 0xff7f, Menu: 0xff67,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
} as const

// 字母/数字 keysym = ASCII 码
export function charKeysym(c: string): number {
  return c.charCodeAt(0)
}

export interface ShortcutDef {
  id: string
  label: string // 显示名（如 Ctrl+C）
  title: string // 作用描述
  category: string
  keys: Array<{ keysym: number; down: true }> // 发送序列（依次 down，再统一 up）
  danger?: boolean
}

/** 组合键序列构造：[Ctrl, Shift, T] → down 全部（按序）→ up 全部（逆序） */
export function combo(mods: number[], main: number): Array<{ keysym: number; down: true }> {
  return [...mods, main].map((keysym) => ({ keysym, down: true as const }))
}

// ============================================================
// 内置快捷键目录（8 分类 40 项）
// ============================================================

export const SHORTCUT_CATEGORIES = ["剪贴板与编辑", "系统与窗口", "浏览器标签页", "页面导航", "缩放与视图", "开发者", "文本输入", "功能键"] as const

export const BUILTIN_SHORTCUTS: ShortcutDef[] = [
  // ---- 剪贴板与编辑 ----
  { id: "copy", label: "Ctrl+C", title: "复制（远程沙箱剪贴板）", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("c")) },
  { id: "cut", label: "Ctrl+X", title: "剪切", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("x")) },
  { id: "paste", label: "Ctrl+V", title: "粘贴（沙箱侧粘贴板）", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("v")) },
  { id: "paste-shift", label: "Ctrl+Shift+V", title: "无格式粘贴", category: "剪贴板与编辑", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("v")) },
  { id: "selectall", label: "Ctrl+A", title: "全选", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("a")) },
  { id: "undo", label: "Ctrl+Z", title: "撤销", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("z")) },
  { id: "redo", label: "Ctrl+Y", title: "重做", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("y")) },
  { id: "find", label: "Ctrl+F", title: "页面内查找", category: "剪贴板与编辑", keys: combo([KS_CTRL], charKeysym("f")) },

  // ---- 系统与窗口 ----
  { id: "cad", label: "Ctrl+Alt+Del", title: "系统管理（任务管理器/锁屏）", category: "系统与窗口", keys: combo([KS_CTRL, KS_ALT], KS.Delete), danger: true },
  { id: "alt-tab", label: "Alt+Tab", title: "切换窗口（远程桌面内）", category: "系统与窗口", keys: combo([KS_ALT], KS.Tab) },
  { id: "alt-f4", label: "Alt+F4", title: "关闭远程窗口", category: "系统与窗口", keys: combo([KS_ALT], KS.F4), danger: true },
  { id: "win", label: "Win", title: "打开远程开始菜单", category: "系统与窗口", keys: [{ keysym: KS_SUPER, down: true }] },
  { id: "win-d", label: "Win+D", title: "显示桌面", category: "系统与窗口", keys: combo([KS_SUPER], charKeysym("d")) },
  { id: "win-l", label: "Win+L", title: "锁定远程桌面", category: "系统与窗口", keys: combo([KS_SUPER], charKeysym("l")), danger: true },
  { id: "win-e", label: "Win+E", title: "打开文件管理器", category: "系统与窗口", keys: combo([KS_SUPER], charKeysym("e")) },
  { id: "win-r", label: "Win+R", title: "运行对话框", category: "系统与窗口", keys: combo([KS_SUPER], charKeysym("r")) },
  { id: "alt-f2", label: "Alt+F2", title: "运行命令（GNOME）", category: "系统与窗口", keys: combo([KS_ALT], KS.F2) },
  { id: "ctrl-alt-t", label: "Ctrl+Alt+T", title: "打开终端（如沙箱允许）", category: "系统与窗口", keys: combo([KS_CTRL, KS_ALT], charKeysym("t")) },
  { id: "print", label: "Print Screen", title: "远程截屏到剪贴板", category: "系统与窗口", keys: [{ keysym: KS.Print, down: true }] },

  // ---- 浏览器标签页（本地浏览器吃掉的组合，直达远程 Chromium） ----
  { id: "new-tab", label: "Ctrl+T", title: "远程浏览器新标签页", category: "浏览器标签页", keys: combo([KS_CTRL], charKeysym("t")) },
  { id: "close-tab", label: "Ctrl+W", title: "关闭远程标签页", category: "浏览器标签页", keys: combo([KS_CTRL], charKeysym("w")), danger: true },
  { id: "reopen-tab", label: "Ctrl+Shift+T", title: "恢复关闭的标签页", category: "浏览器标签页", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("t")) },
  { id: "next-tab", label: "Ctrl+Tab", title: "下一个标签页", category: "浏览器标签页", keys: combo([KS_CTRL], KS.Tab) },
  { id: "prev-tab", label: "Ctrl+Shift+Tab", title: "上一个标签页", category: "浏览器标签页", keys: combo([KS_CTRL, KS_SHIFT], KS.Tab) },
  { id: "tab-1", label: "Ctrl+1", title: "跳到第 1 个标签页", category: "浏览器标签页", keys: combo([KS_CTRL], charKeysym("1")) },
  { id: "tab-9", label: "Ctrl+9", title: "跳到最后一个标签页", category: "浏览器标签页", keys: combo([KS_CTRL], charKeysym("9")) },
  { id: "new-win", label: "Ctrl+N", title: "新窗口", category: "浏览器标签页", keys: combo([KS_CTRL], charKeysym("n")) },
  { id: "new-private", label: "Ctrl+Shift+N", title: "新无痕窗口（受策略管控）", category: "浏览器标签页", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("n")) },
  { id: "reopen-win", label: "Ctrl+Shift+P", title: " reopen 上次会话", category: "浏览器标签页", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("p")) },

  // ---- 页面导航 ----
  { id: "reload", label: "F5", title: "刷新远程页面", category: "页面导航", keys: [{ keysym: KS.F5, down: true }] },
  { id: "reload-cache", label: "Ctrl+F5", title: "强制刷新（跳过缓存）", category: "页面导航", keys: combo([KS_CTRL], KS.F5) },
  { id: "stop", label: "Esc", title: "停止加载 / 关闭弹层", category: "页面导航", keys: [{ keysym: KS.Esc, down: true }] },
  { id: "back", label: "Alt+←", title: "后退", category: "页面导航", keys: combo([KS_ALT], KS.Left) },
  { id: "forward", label: "Alt+→", title: "前进", category: "页面导航", keys: combo([KS_ALT], KS.Right) },
  { id: "home-key", label: "Alt+Home", title: "回到主页", category: "页面导航", keys: combo([KS_ALT], KS.Home) },
  { id: "focus-url", label: "Ctrl+L", title: "聚焦地址栏", category: "页面导航", keys: combo([KS_CTRL], charKeysym("l")) },

  // ---- 缩放与视图 ----
  { id: "zoom-in", label: "Ctrl++", title: "放大", category: "缩放与视图", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("=")) },
  { id: "zoom-out", label: "Ctrl+-", title: "缩小", category: "缩放与视图", keys: combo([KS_CTRL], charKeysym("-")) },
  { id: "zoom-reset", label: "Ctrl+0", title: "恢复 100% 缩放", category: "缩放与视图", keys: combo([KS_CTRL], charKeysym("0")) },
  { id: "fullscreen-f11", label: "F11", title: "远程浏览器全屏切换", category: "缩放与视图", keys: [{ keysym: KS.F11, down: true }] },
  { id: "devtools-f12", label: "F12", title: "开发者工具（受策略管控）", category: "缩放与视图", keys: [{ keysym: KS.F12, down: true }] },

  // ---- 开发者 ----
  { id: "devtools", label: "Ctrl+Shift+I", title: "开发者工具（受策略管控）", category: "开发者", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("i")) },
  { id: "console", label: "Ctrl+Shift+J", title: "控制台（受策略管控）", category: "开发者", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("j")) },
  { id: "view-source", label: "Ctrl+U", title: "查看页面源码", category: "开发者", keys: combo([KS_CTRL], charKeysym("u")) },
  { id: "downloads", label: "Ctrl+J", title: "打开下载列表", category: "开发者", keys: combo([KS_CTRL], charKeysym("j")) },
  { id: "history", label: "Ctrl+H", title: "打开历史记录", category: "开发者", keys: combo([KS_CTRL], charKeysym("h")) },
  { id: "bookmarks", label: "Ctrl+D", title: "收藏当前页", category: "开发者", keys: combo([KS_CTRL], charKeysym("d")) },
  { id: "bookmark-all", label: "Ctrl+Shift+D", title: "收藏全部标签页", category: "开发者", keys: combo([KS_CTRL, KS_SHIFT], charKeysym("d")) },

  // ---- 文本输入 ----
  { id: "del-word", label: "Ctrl+Backspace", title: "删除前一个词", category: "文本输入", keys: combo([KS_CTRL], KS.BackSpace) },
  { id: "del-line", label: "Ctrl+Delete", title: "删除后一个词", category: "文本输入", keys: combo([KS_CTRL], KS.Delete) },
  { id: "line-start", label: "Home", title: "行首", category: "文本输入", keys: [{ keysym: KS.Home, down: true }] },
  { id: "line-end", label: "End", title: "行尾", category: "文本输入", keys: [{ keysym: KS.End, down: true }] },
  { id: "page-up", label: "Page Up", title: "上一页", category: "文本输入", keys: [{ keysym: KS.PgUp, down: true }] },
  { id: "page-down", label: "Page Down", title: "下一页", category: "文本输入", keys: [{ keysym: KS.PgDn, down: true }] },

  // ---- 功能键 ----
  { id: "f1", label: "F1", title: "帮助", category: "功能键", keys: [{ keysym: KS.F1, down: true }] },
  { id: "f2", label: "F2", title: "重命名（文件管理器）", category: "功能键", keys: [{ keysym: KS.F2, down: true }] },
  { id: "f3", label: "F3", title: "搜索", category: "功能键", keys: [{ keysym: KS.F3, down: true }] },
  { id: "f6", label: "F6", title: "切换窗格焦点", category: "功能键", keys: [{ keysym: KS.F6, down: true }] },
  { id: "f10", label: "F10", title: "菜单键", category: "功能键", keys: [{ keysym: KS.F10, down: true }] },
]

// ---- 录入：物理键盘事件 → keysym 组合（自定义快捷键用） ----
export function keyEventToCombo(e: KeyboardEvent): { keys: number[]; label: string } | null {
  const mods: number[] = []
  if (e.ctrlKey) mods.push(KS_CTRL)
  if (e.altKey) mods.push(KS_ALT)
  if (e.shiftKey) mods.push(KS_SHIFT)
  if (e.metaKey) mods.push(KS_SUPER)

  let main: number | null = null
  let mainLabel = ""
  const k = e.key
  if (/^[a-zA-Z0-9]$/.test(k)) { main = k.toLowerCase().charCodeAt(0); mainLabel = k.toUpperCase() }
  else if (k === "Enter") { main = KS.Enter; mainLabel = "Enter" }
  else if (k === "Tab") { main = KS.Tab; mainLabel = "Tab" }
  else if (k === "Escape") { main = KS.Esc; mainLabel = "Esc" }
  else if (k === "Backspace") { main = KS.BackSpace; mainLabel = "Backspace" }
  else if (k === "Delete") { main = KS.Delete; mainLabel = "Delete" }
  else if (k === "Insert") { main = KS.Insert; mainLabel = "Insert" }
  else if (k === " ") { main = 0x20; mainLabel = "Space" }
  else if (k === "ArrowUp") { main = KS.Up; mainLabel = "↑" }
  else if (k === "ArrowDown") { main = KS.Down; mainLabel = "↓" }
  else if (k === "ArrowLeft") { main = KS.Left; mainLabel = "←" }
  else if (k === "ArrowRight") { main = KS.Right; mainLabel = "→" }
  else if (k === "Home") { main = KS.Home; mainLabel = "Home" }
  else if (k === "End") { main = KS.End; mainLabel = "End" }
  else if (k === "PageUp") { main = KS.PgUp; mainLabel = "PageUp" }
  else if (k === "PageDown") { main = KS.PgDn; mainLabel = "PageDown" }
  else if (/^F(\d{1,2})$/.test(k)) { const n = Number(k.slice(1)); main = 0xffbd + n; mainLabel = k }
  else if (/^[\x20-\x7e]$/.test(k)) { main = k.charCodeAt(0); mainLabel = k }

  // 纯修饰键按下不完整
  if (main === null) return null

  const parts: string[] = []
  if (e.ctrlKey) parts.push("Ctrl")
  if (e.altKey) parts.push("Alt")
  if (e.shiftKey) parts.push("Shift")
  if (e.metaKey) parts.push("Win")
  parts.push(mainLabel)
  return { keys: [...mods, main], label: parts.join("+") }
}

// ---- 小键盘点选构造（移动端） ----
export interface KeyCap { label: string; keysym: number }
export const MODIFIER_CAPS: KeyCap[] = [
  { label: "Ctrl", keysym: KS_CTRL }, { label: "Alt", keysym: KS_ALT },
  { label: "Shift", keysym: KS_SHIFT }, { label: "Win", keysym: KS_SUPER },
]
export const MAIN_CAPS: KeyCap[] = [
  { label: "A", keysym: 0x61 }, { label: "B", keysym: 0x62 }, { label: "C", keysym: 0x63 }, { label: "D", keysym: 0x64 },
  { label: "E", keysym: 0x65 }, { label: "F", keysym: 0x66 }, { label: "G", keysym: 0x67 }, { label: "H", keysym: 0x68 },
  { label: "I", keysym: 0x69 }, { label: "J", keysym: 0x6a }, { label: "K", keysym: 0x6b }, { label: "L", keysym: 0x6c },
  { label: "M", keysym: 0x6d }, { label: "N", keysym: 0x6e }, { label: "O", keysym: 0x6f }, { label: "P", keysym: 0x70 },
  { label: "Q", keysym: 0x71 }, { label: "R", keysym: 0x72 }, { label: "S", keysym: 0x73 }, { label: "T", keysym: 0x74 },
  { label: "U", keysym: 0x75 }, { label: "V", keysym: 0x76 }, { label: "W", keysym: 0x77 }, { label: "X", keysym: 0x78 },
  { label: "Y", keysym: 0x79 }, { label: "Z", keysym: 0x7a },
  { label: "Tab", keysym: KS.Tab }, { label: "Enter", keysym: KS.Enter }, { label: "Esc", keysym: KS.Esc },
  { label: "Space", keysym: 0x20 }, { label: "Del", keysym: KS.Delete }, { label: "Backspace", keysym: KS.BackSpace },
  { label: "Insert", keysym: KS.Insert },
]
export const NUMBER_CAPS: KeyCap[] = Array.from({ length: 10 }, (_, i) => ({ label: String(i), keysym: 0x30 + i }))
export const FUNCTION_CAPS: KeyCap[] = Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, keysym: 0xffbe + i }))
export const ARROW_CAPS: KeyCap[] = [
  { label: "↑", keysym: KS.Up }, { label: "↓", keysym: KS.Down }, { label: "←", keysym: KS.Left }, { label: "→", keysym: KS.Right },
]
export const NAV_CAPS: KeyCap[] = [{ label: "Home", keysym: KS.Home }, { label: "End", keysym: KS.End }]
export const PAGING_CAPS: KeyCap[] = [{ label: "PageUp", keysym: KS.PgUp }, { label: "PageDown", keysym: KS.PgDn }]
export const PUNCT_CAPS: KeyCap[] = [
  { label: "-", keysym: 0x2d }, { label: "=", keysym: 0x3d }, { label: "[", keysym: 0x5b }, { label: "]", keysym: 0x5d },
  { label: ";", keysym: 0x3b }, { label: "'", keysym: 0x27 }, { label: "`", keysym: 0x60 }, { label: ",", keysym: 0x2c },
  { label: ".", keysym: 0x2e }, { label: "/", keysym: 0x2f }, { label: "\\", keysym: 0x5c },
]

// r34：基础符号 → Shift 上档符号映射表（标准 QWERTY 键位）
// 用途：虚拟键盘/输入通道在 Shift 生效时直接发送上档字符的 keysym（模拟真实键盘
// key 事件的上档形态），而不是发 Shift+基础键 —— 部分服务器/布局下后者会被
// 误解成别的符号（用户报障：软键盘打不出点号/符号错乱）。
export const SHIFT_VARIANTS: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", "`": "~", ",": "<", ".": ">", "/": "?",
}

// r34：解析按键最终 keysym：Shift 生效时返回上档字符（大写字母/上档符号），
// 否则返回基础字符；与浏览器物理键盘 key 事件的 key 字符语义完全一致。
export function resolveKeysym(ch: string, shift: boolean): number {
  if (shift && /[a-z]/.test(ch)) return ch.toUpperCase().charCodeAt(0)
  if (shift && SHIFT_VARIANTS[ch] !== undefined) return SHIFT_VARIANTS[ch].charCodeAt(0)
  return ch.charCodeAt(0)
}

// r31：上档符号层（Shift+数字 → !@#$%^&*() 等；keysym = 符号本身 ASCII 码）
export const SHIFT_SYMBOL_CAPS: KeyCap[] = [
  { label: "!", keysym: 0x21 }, { label: "@", keysym: 0x40 }, { label: "#", keysym: 0x23 }, { label: "$", keysym: 0x24 },
  { label: "%", keysym: 0x25 }, { label: "^", keysym: 0x5e }, { label: "&", keysym: 0x26 }, { label: "*", keysym: 0x2a },
  { label: "(", keysym: 0x28 }, { label: ")", keysym: 0x29 }, { label: "_", keysym: 0x5f }, { label: "+", keysym: 0x2b },
  { label: "{", keysym: 0x7b }, { label: "}", keysym: 0x7d }, { label: "|", keysym: 0x7c }, { label: ":", keysym: 0x3a },
  { label: "\"", keysym: 0x22 }, { label: "<", keysym: 0x3c }, { label: ">", keysym: 0x3e }, { label: "?", keysym: 0x3f },
  { label: "~", keysym: 0x7e },
]

// r31：扩展控制键层（此前缺失 → “好多快捷方式创建不了”的补全项）
export const EXTENDED_CAPS: KeyCap[] = [
  { label: "Insert", keysym: KS.Insert }, { label: "Print", keysym: KS.Print },
  { label: "Pause", keysym: KS.Pause }, { label: "ScrollLk", keysym: KS.ScrollLock },
  { label: "Menu", keysym: KS.Menu }, { label: "NumLk", keysym: KS.NumLock },
  { label: "Ctrl→", keysym: KS_CTRL_R }, { label: "Alt→", keysym: KS_ALT_R },
]
