"use client"

// ============================================================
// r31：HelmPort 在线软键盘（完整虚拟键盘，移动端主输入通道之一）
//   - QWERTY 主层（Shift 上档：大写 + 上档符号行）
//   - 数字/符号层 / 功能导航层（F1-F12 + 导航簇 + 扩展控制键）
//   - 修饰键粘滞状态机：点选 Ctrl/Alt/Shift/Win → 下一次按键作为组合发送后自动清除
//     （连点两次 = 保持粘滞，再点取消；等效手机键盘的 Shift 锁语义）
//   - 键按下高亮反馈；按键直达远程（与物理键盘同一条 RFB KeyEvent 路径）
// ============================================================

import * as React from "react"
import { cn } from "@/lib/utils"
import {
  KS_CTRL, KS_ALT, KS_SHIFT, KS_SUPER, KS,
  SHIFT_SYMBOL_CAPS, EXTENDED_CAPS, type KeyCap,
} from "@/lib/vnc-shortcuts"

interface KeySender {
  (keysym: number, down: boolean): void
}

type Layer = "main" | "nums" | "fn"

const LETTER_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
]

// 上档符号行（数字行的 Shift 形态，与物理键盘一致）
const SHIFT_ROW = SHIFT_SYMBOL_CAPS.slice(0, 10).map((c) => c.label)
const NUM_ROW = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]

const BOTTOM_SYMBOLS = SHIFT_SYMBOL_CAPS.slice(10)

function fireCombo(sendKey: KeySender, keys: number[]) {
  for (const k of keys) sendKey(k, true)
  setTimeout(() => {
    for (const k of [...keys].reverse()) sendKey(k, false)
  }, 60)
}

// 键帽按钮（顶层组件：避免 render 内创建组件重置状态）
function VKeyBtn({ label, onPress, className, wide, active, sub, disabled }: {
  label: string
  onPress: () => void
  className?: string
  wide?: number
  active?: boolean
  sub?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); onPress() }}
      className={cn(
        "relative select-none rounded-md border text-sm font-medium transition-colors touch-manipulation active:scale-95",
        "h-10 min-w-0 flex-1 flex items-center justify-center",
        active
          ? "border-teal-500 bg-teal-500 text-white shadow-sm"
          : "border-slate-200 bg-white text-slate-700 hover:border-teal-300 hover:bg-teal-50",
        disabled && "opacity-40 pointer-events-none",
        className,
      )}
      style={wide ? { flex: wide } : undefined}
      title={sub || label}
    >
      {label}
    </button>
  )
}

export function VirtualKeyboard({ sendKey, disabled, onClose }: {
  sendKey: KeySender
  disabled?: boolean
  onClose?: () => void
}) {
  const [layer, setLayer] = React.useState<Layer>("main")
  const [shiftOn, setShiftOn] = React.useState(false)
  const [shiftLocked, setShiftLocked] = React.useState(false)
  const [mods, setMods] = React.useState<number[]>([])
  const [lockedMods, setLockedMods] = React.useState<number[]>([])
  const [flash, setFlash] = React.useState<string | null>(null)

  const effectiveShift = shiftOn || shiftLocked
  const effectiveMods = React.useMemo(() => {
    const all = new Set<number>([...mods, ...lockedMods])
    // Shift 已有独立状态 → 合并去重
    if (effectiveShift) all.add(KS_SHIFT)
    return [...all]
  }, [mods, lockedMods, effectiveShift])

  const doFlash = (label: string) => {
    setFlash(label)
    setTimeout(() => setFlash((f) => (f === label ? null : f)), 160)
  }

  // 普通字符键：修饰键组合发送（一次性）后清除粘滞
  const pressChar = (ch: string) => {
    if (disabled) return
    const cp = ch.charCodeAt(0)
    const keys = [...effectiveMods, cp]
    fireCombo(sendKey, keys)
    doFlash(ch.toUpperCase())
    setMods([])
    if (!shiftLocked) setShiftOn(false)
  }

  const pressKey = (cap: KeyCap) => {
    if (disabled) return
    const keys = [...effectiveMods, cap.keysym]
    fireCombo(sendKey, keys)
    doFlash(cap.label)
    setMods([])
    if (!shiftLocked) setShiftOn(false)
  }

  const pressNamed = (keysym: number, label: string) => {
    if (disabled) return
    const keys = [...effectiveMods, keysym]
    fireCombo(sendKey, keys)
    doFlash(label)
    setMods([])
    if (!shiftLocked) setShiftOn(false)
  }

  const pressShift = () => {
    if (shiftLocked) { setShiftLocked(false); setShiftOn(false); return }
    if (shiftOn) { setShiftLocked(true); setShiftOn(false); return }
    setShiftOn(true)
  }

  const toggleMod = (m: number) => {
    if (lockedMods.includes(m)) { setLockedMods((s) => s.filter((x) => x !== m)); setMods((s) => s.filter((x) => x !== m)); return }
    if (mods.includes(m)) { setMods((s) => [...s.filter((x) => x !== m)]); setLockedMods((s) => [...s, m]); return }
    setMods((s) => [...s, m])
  }

  const modActive = (m: number) => mods.includes(m) || lockedMods.includes(m)

  const kd = disabled

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-2 shadow-sm select-none" data-testid="vnc-virtual-keyboard">
      {/* 头部：层切换 + 关闭 */}
      <div className="mb-1.5 flex items-center gap-1">
        <span className="mr-auto pl-1 text-[10px] font-medium text-slate-500">在线软键盘（按键直达远程桌面）</span>
        {([["main", "字母"], ["nums", "数字符号"], ["fn", "功能导航"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setLayer(k)}
            className={cn("rounded-md border px-2 py-0.5 text-[10px] transition-colors",
              layer === k ? "border-teal-400 bg-teal-50 text-teal-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-100")}>
            {label}
          </button>
        ))}
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600" title="收起软键盘">
            ✕
          </button>
        )}
      </div>

      {/* 修饰键状态行 */}
      <div className="mb-1.5 flex gap-1">
        {([["Ctrl", KS_CTRL], ["Alt", KS_ALT], ["Shift", KS_SHIFT], ["Win", KS_SUPER]] as const).map(([label, m]) => {
          if (m === KS_SHIFT) {
            return <VKeyBtn key={label} label={shiftLocked ? "Shift ⇩锁" : effectiveShift ? "Shift ⇧" : "Shift"} onPress={pressShift} active={effectiveShift} wide={1.2} />
          }
          return <VKeyBtn key={label} label={label} onPress={() => toggleMod(m)} active={modActive(m)} wide={1.2} />
        })}
        <VKeyBtn label="Esc" onPress={() => pressNamed(KS.Esc, "Esc")} wide={1.2} />
        <VKeyBtn label="Tab" onPress={() => pressNamed(KS.Tab, "Tab")} wide={1.2} />
        {(effectiveMods.length > 0 || effectiveShift) && (
          <button type="button" onClick={() => { setMods([]); setLockedMods([]); setShiftOn(false); setShiftLocked(false) }}
            className="rounded-md border border-amber-300 bg-amber-50 px-2 text-[10px] font-medium text-amber-700 hover:bg-amber-100">
            清除修饰({effectiveMods.length + (effectiveShift ? 1 : 0)})
          </button>
        )}
      </div>

      {/* ---- 主层：QWERTY ---- */}
      {layer === "main" && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {(effectiveShift ? SHIFT_ROW : NUM_ROW).map((ch, i) => (
              <VKeyBtn key={`${ch}-${i}`} label={ch} onPress={() => pressChar(ch)} />
            ))}
          </div>
          {LETTER_ROWS.map((row, ri) => (
            <div key={ri} className="flex gap-1" style={{ paddingLeft: ri === 1 ? 8 : ri === 2 ? 18 : 0, paddingRight: ri === 2 ? 10 : 0 }}>
              {row.map((ch) => (
                <VKeyBtn key={ch} label={effectiveShift ? ch.toUpperCase() : ch} onPress={() => pressChar(ch)} active={flash === ch.toUpperCase()} />
              ))}
              {ri === 2 && <VKeyBtn label="⌫" onPress={() => pressNamed(KS.BackSpace, "Backspace")} wide={1.6} />}
            </div>
          ))}
          <div className="flex gap-1">
            <VKeyBtn label="符号" onPress={() => setLayer("nums")} wide={1.1} />
            {BOTTOM_SYMBOLS.slice(0, 6).map((c) => (
              <VKeyBtn key={c.label} label={c.label} onPress={() => pressChar(c.label)} />
            ))}
            <VKeyBtn label="␣ Space" onPress={() => pressNamed(0x20, "Space")} wide={3.2} />
            {BOTTOM_SYMBOLS.slice(6, 9).map((c) => (
              <VKeyBtn key={c.label} label={c.label} onPress={() => pressChar(c.label)} />
            ))}
            <VKeyBtn label="⏎ Enter" onPress={() => pressNamed(KS.Enter, "Enter")} wide={1.8} />
          </div>
        </div>
      )}

      {/* ---- 数字符号层 ---- */}
      {layer === "nums" && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {NUM_ROW.map((ch) => <VKeyBtn key={ch} label={ch} onPress={() => pressChar(ch)} />)}
          </div>
          <div className="flex gap-1">
            {SHIFT_ROW.map((ch) => <VKeyBtn key={ch} label={ch} onPress={() => pressChar(ch)} />)}
          </div>
          <div className="flex gap-1">
            {BOTTOM_SYMBOLS.map((c) => <VKeyBtn key={c.label} label={c.label} onPress={() => pressChar(c.label)} />)}
          </div>
          <div className="flex gap-1">
            <VKeyBtn label="←" onPress={() => pressNamed(KS.Left, "←")} />
            <VKeyBtn label="↑" onPress={() => pressNamed(KS.Up, "↑")} />
            <VKeyBtn label="↓" onPress={() => pressNamed(KS.Down, "↓")} />
            <VKeyBtn label="→" onPress={() => pressNamed(KS.Right, "→")} />
            <VKeyBtn label=".,;'" onPress={() => pressChar(".")} wide={1} />
            <VKeyBtn label="字母层" onPress={() => setLayer("main")} wide={1.4} />
          </div>
        </div>
      )}

      {/* ---- 功能导航层 ---- */}
      {layer === "fn" && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {Array.from({ length: 12 }, (_, i) => (
              <VKeyBtn key={`F${i + 1}`} label={`F${i + 1}`} onPress={() => pressNamed(0xffbe + i, `F${i + 1}`)} />
            ))}
          </div>
          <div className="flex gap-1">
            {EXTENDED_CAPS.map((c) => (
              <VKeyBtn key={c.label} label={c.label} onPress={() => pressKey(c)} />
            ))}
          </div>
          <div className="flex gap-1">
            <VKeyBtn label="Home" onPress={() => pressNamed(KS.Home, "Home")} wide={1.3} />
            <VKeyBtn label="End" onPress={() => pressNamed(KS.End, "End")} wide={1.3} />
            <VKeyBtn label="PgUp" onPress={() => pressNamed(KS.PgUp, "PgUp")} wide={1.3} />
            <VKeyBtn label="PgDn" onPress={() => pressNamed(KS.PgDn, "PgDn")} wide={1.3} />
            <VKeyBtn label="字母层" onPress={() => setLayer("main")} wide={1.4} />
          </div>
          {/* 导航簇（十字布局） */}
          <div className="flex justify-center gap-1 pt-0.5">
            <div className="grid grid-cols-3 gap-1 w-44">
              <div />
              <VKeyBtn label="↑" onPress={() => pressNamed(KS.Up, "↑")} />
              <div />
              <VKeyBtn label="←" onPress={() => pressNamed(KS.Left, "←")} />
              <VKeyBtn label="↓" onPress={() => pressNamed(KS.Down, "↓")} />
              <VKeyBtn label="→" onPress={() => pressNamed(KS.Right, "→")} />
            </div>
          </div>
        </div>
      )}

      <p className="mt-1 px-1 text-[10px] leading-relaxed text-slate-400">
        修饰键为粘滞语义：点选 Ctrl 后再按 C = 发送 Ctrl+C（自动复位）；连点两次修饰键 = 保持。输入中文等语言请使用输入面板（本地输入法组合注入）。
      </p>
    </div>
  )
}
