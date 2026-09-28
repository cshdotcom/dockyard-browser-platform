// ============================================================
// HelmPort 键码映射（DOM KeyboardEvent → RFB keysym）
// 自研实现（替代 @novnc/novnc）：覆盖 ASCII / 控制键 / 方向键 /
// 功能键 F1-F12 / 修饰键（含右侧变体）
// ============================================================

export const KEYSYMS: Record<string, number> = {
  // 控制与编辑键
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Space: 0x20,
  // 方向与翻页
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowUp: 0xff52,
  ArrowDown: 0xff54,
  ArrowLeft: 0xff51,
  ArrowRight: 0xff53,
  // 功能键
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  // 修饰键（左侧主用；右侧带区分变体）
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffec,
  // 常见命名差异兜底
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  PrintScreen: 0xff61,
  ContextMenu: 0xff67,
}

export const KEYSYMS_RIGHT: Record<string, number> = {
  Shift: 0xffe2, // ShiftRight
  Control: 0xffe4, // ControlRight
  Alt: 0xffea, // AltRight
  Meta: 0xffed, // MetaRight
}

// DOM key → keysym（e.code 区分左右修饰键）
export function keysymFor(e: KeyboardEvent): number | null {
  // 修饰键：用 e.code 判定左右
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
    if (e.code && e.code.endsWith("Right") && KEYSYMS_RIGHT[e.key] !== undefined) return KEYSYMS_RIGHT[e.key]
    return KEYSYMS[e.key] ?? null
  }
  if (e.key.length === 1) {
    // 单字符：keysym = Unicode 码点（ASCII 与 Latin-1 与 RFB 直接兼容）
    return e.key.codePointAt(0) ?? null
  }
  return KEYSYMS[e.key] ?? null
}
