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
import { GripHorizontal, X, Smile } from "lucide-react"
import {
  KS_CTRL, KS_ALT, KS_SHIFT, KS_SUPER, KS,
  SHIFT_SYMBOL_CAPS, EXTENDED_CAPS, PUNCT_CAPS, resolveKeysym, type KeyCap,
} from "@/lib/vnc-shortcuts"

interface KeySender {
  (keysym: number, down: boolean): void
}

type Layer = "main" | "nums" | "fn" | "emoji"

// r35：常用表情符号层（直接以 Unicode keysym 注入 —— 远端任意网页输入框可打出）
const EMOJI_ROWS: string[][] = [
  ["😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😜", "🤔", "🙄"],
  ["😢", "😭", "😡", "🥳", "😴", "🤯", "🥺", "😱", "😤", "😇"],
  ["👍", "👎", "👏", "🙏", "💪", "🤝", "✌️", "👋", "🫶", "🤌"],
  ["❤️", "💔", "⭐", "🔥", "✨", "💯", "🎉", "🎁", "🏆", "👑"],
  ["☀️", "🌙", "☕", "🍎", "🍜", "🍺", "⚽", "🎮", "💰", "🔔"],
  ["😀-range2", "🐱", "🐶", "🌸", "🌈", "⚡", "❄️", "🌊", "🎵", "📷"],
]

const LETTER_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
]

// 上档符号行（数字行的 Shift 形态，与物理键盘一致）
const SHIFT_ROW = SHIFT_SYMBOL_CAPS.slice(0, 10).map((c) => c.label)
const NUM_ROW = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]

// r34：主层底行 = 标准 QWERTY 标点（- [ ] ; ' , . /），Shift 生效时显示上档形态（_ { } : " < > ?）
// （此前主层底行误用上档符号行 → 点号/逗号在主层根本找不到 —— 用户报障“软键盘打不出点号”）
const PUNCT_ROW_KEYS = ["-", "[", "]", ";", "'", ",", ".", "/"]
const punctLabel = (ch: string, shift: boolean) =>
  shift ? { "-": "_", "[": "{", "]": "}", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?" }[ch] || ch : ch

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
  // r35：软键盘可拖动 —— 拖动头部手柄整体移动（桌面 absolute 定位；移动端也支持拖到舒适位置）
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null)
  const dragRef = React.useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const kbRef = React.useRef<HTMLDivElement | null>(null)
  const onHandlePointerDown = (e: React.PointerEvent) => {
    if (pos === null) {
      // 首次拖动：记录当前视口位置为基准
      const rect = kbRef.current?.getBoundingClientRect()
      if (!rect) return
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top }
    } else {
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }
    }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onHandlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const x = Math.min(Math.max(0, d.ox + e.clientX - d.sx), Math.max(0, window.innerWidth - 220))
    const y = Math.min(Math.max(0, d.oy + e.clientY - d.sy), Math.max(0, window.innerHeight - 120))
    setPos({ x, y })
  }
  const onHandlePointerUp = () => { dragRef.current = null }

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

  // 普通字符键：r34 Shift 语义修正 —— 直接发送上档字符的 keysym（真实键盘 key 事件形态），
  // 不再发送 Shift+基础键组合（部分服务器布局会错位成其他符号）；修饰键组合仍走 fireCombo
  const pressChar = (ch: string) => {
    if (disabled) return
    const finalKeysym = resolveKeysym(ch, effectiveShift)
    const hasNonShiftMods = effectiveMods.length > 0
    if (hasNonShiftMods) {
      fireCombo(sendKey, [...effectiveMods, finalKeysym])
    } else {
      sendKey(finalKeysym, true)
      setTimeout(() => sendKey(finalKeysym, false), 60)
    }
    const shown = effectiveShift ? ch.toUpperCase() : ch
    doFlash(shown.length === 1 ? shown : ch)
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

  // r35：Unicode 字符（emoji）注入 —— codePoint 作为 keysym 直发（远端按 UCS4 键事件解释）
  const pressUnicode = (ch: string) => {
    if (disabled) return
    const cp = ch.codePointAt(0)
    if (cp === undefined) return
    sendKey(cp, true)
    setTimeout(() => sendKey(cp, false), 60)
    doFlash(ch)
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
    <div
      ref={kbRef}
      style={pos ? { position: "fixed", left: pos.x, top: pos.y, zIndex: 40, maxWidth: "min(96vw, 720px)" } : undefined}
      className="rounded-xl border border-slate-200 bg-slate-50/80 p-2 shadow-sm select-none"
      data-testid="vnc-virtual-keyboard">
      {/* 头部：拖动手柄 + 层切换（含 emoji 表情层）+ 关闭（r35 可拖动） */}
      <div className="mb-1.5 flex items-center gap-1">
        <span
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          className="flex cursor-grab touch-none items-center rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 active:cursor-grabbing"
          title="拖动移动软键盘位置">
          <GripHorizontal className="h-4 w-4" />
        </span>
        <span className="mr-auto truncate pl-1 text-[10px] font-medium text-slate-500">在线软键盘{pos ? "（已拖动定位）" : "（按住抓手拖动）"}</span>
        {([["main", "字母"], ["nums", "数字符号"], ["fn", "功能导航"], ["emoji", "表情"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setLayer(k)}
            className={cn("flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-colors",
              layer === k ? "border-teal-400 bg-teal-50 text-teal-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-100")}>
            {k === "emoji" && <Smile className="h-3 w-3" />}
            {label}
          </button>
        ))}
        {onClose && (
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600" title="收起软键盘">
            <X className="h-3.5 w-3.5" />
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
          {/* r34：主层底行 = 标准标点行（含点号/逗号；Shift 显示上档形态） */}
          <div className="flex gap-1">
            <VKeyBtn label="符号" onPress={() => setLayer("nums")} wide={1.1} />
            {PUNCT_ROW_KEYS.map((ch) => (
              <VKeyBtn key={ch} label={punctLabel(ch, effectiveShift)} onPress={() => pressChar(ch)} />
            ))}
            <VKeyBtn label="␣ Space" onPress={() => pressNamed(0x20, "Space")} wide={2.6} />
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
            {PUNCT_CAPS.map((c) => <VKeyBtn key={c.label} label={c.label} onPress={() => pressChar(c.label)} />)}
          </div>
          <div className="flex gap-1">
            {SHIFT_SYMBOL_CAPS.slice(10).map((c) => <VKeyBtn key={c.label} label={c.label} onPress={() => pressChar(c.label)} />)}
          </div>
          <div className="flex gap-1">
            <VKeyBtn label="←" onPress={() => pressNamed(KS.Left, "←")} />
            <VKeyBtn label="↑" onPress={() => pressNamed(KS.Up, "↑")} />
            <VKeyBtn label="↓" onPress={() => pressNamed(KS.Down, "↓")} />
            <VKeyBtn label="→" onPress={() => pressNamed(KS.Right, "→")} />
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

      {/* r35：表情符号层 —— Unicode keysym 直注入（远端任意输入框可打出；常用 60 个分类精选） */}
      {layer === "emoji" && (
        <div className="space-y-1">
          {EMOJI_ROWS.filter((r) => !r[0].includes("-range2")).map((row, ri) => (
            <div key={ri} className="flex gap-1">
              {row.map((em) => (
                <button key={em} type="button" disabled={disabled}
                  onPointerDown={(e) => { e.preventDefault(); pressUnicode(em) }}
                  className="h-10 min-w-0 flex-1 select-none rounded-md border border-slate-200 bg-white text-xl transition-transform touch-manipulation active:scale-90 hover:border-teal-300 hover:bg-teal-50">
                  {em}
                </button>
              ))}
            </div>
          ))}
          <div className="flex items-center justify-center gap-2 pt-1">
            <button type="button" onClick={() => setLayer("main")} className="rounded-md border border-slate-200 bg-white px-3 py-1 text-[10px] text-slate-600 hover:bg-slate-100">← 返回字母层</button>
            <span className="text-[10px] text-slate-400">表情以 Unicode 直注入：选择后即上屏远端输入框</span>
          </div>
        </div>
      )}

      <p className="mt-1 px-1 text-[10px] leading-relaxed text-slate-400">
        修饰键为粘滞语义：点选 Ctrl 后再按 C = 发送 Ctrl+C（自动复位）；连点两次修饰键 = 保持。输入中文等语言请使用输入法输入通道（顶部"输入法"切换器 + 画面点击获得焦点）。表情层含常用 60 个分类表情。
      </p>
    </div>
  )
}
