"use client"

// ============================================================
// r28：VNC 快捷键面板（接入 helmport-viewer 工具栏）
//   - 40+ 内置快捷键（8 分类，可搜索，可折叠）
//   - 点击即注入远程（绕过本地浏览器/系统按键抢占）
//   - 自定义：电脑端物理按键捕获录入 / 移动端小键盘点选构造
//   - 用户偏好持久化（跨端同步）
// ============================================================

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Keyboard, Search, ChevronDown, ChevronRight, Plus, Trash2, Save, X, Zap } from "lucide-react"
import { toast } from "sonner"
import {
  BUILTIN_SHORTCUTS, SHORTCUT_CATEGORIES, keyEventToCombo, KS_CTRL, KS_ALT, KS_SHIFT, KS_SUPER,
  MODIFIER_CAPS, MAIN_CAPS, NUMBER_CAPS, FUNCTION_CAPS, ARROW_CAPS, NAV_CAPS, PAGING_CAPS, PUNCT_CAPS,
} from "@/lib/vnc-shortcuts"
import { getMyShortcutsAction, saveMyShortcutsAction, type CustomShortcut } from "@/server/actions/vnc-shortcuts"

interface KeySender {
  (keysym: number, down: boolean): void
}

function modLabel(k: number): string {
  if (k === KS_CTRL) return "Ctrl"
  if (k === KS_ALT) return "Alt"
  if (k === KS_SHIFT) return "Shift"
  if (k === KS_SUPER) return "Win"
  return ""
}

function keyName(k: number): string {
  if (k >= 0x61 && k <= 0x7a) return String.fromCharCode(k).toUpperCase()
  if (k >= 0x30 && k <= 0x39) return String.fromCharCode(k)
  if (k >= 0x20 && k <= 0x7e) return String.fromCharCode(k)
  const named: Record<number, string> = {
    0xff0d: "Enter", 0xff09: "Tab", 0xff1b: "Esc", 0xff08: "Backspace", 0xffff: "Delete",
    0xff63: "Insert", 0xff50: "Home", 0xff57: "End", 0xff55: "PageUp", 0xff56: "PageDown",
    0xff51: "←", 0xff52: "↑", 0xff53: "→", 0xff54: "↓", 0xff61: "Print", 0xffeb: "Win",
  }
  if (named[k]) return named[k]
  if (k >= 0xffbe && k <= 0xffc9) return `F${k - 0xffbd}`
  return `#${k}`
}

function comboLabel(keys: number[]): string {
  const mods = keys.slice(0, -1).map(modLabel).filter(Boolean)
  return [...mods, keyName(keys[keys.length - 1])].filter(Boolean).join("+")
}

export function ShortcutPanel({ sendKey, disabled }: { sendKey: KeySender; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [customList, setCustomList] = useState<CustomShortcut[]>([])
  const [customOpen, setCustomOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [draftKeys, setDraftKeys] = useState<number[]>([])
  const [draftTitle, setDraftTitle] = useState("")
  const [subKeyboard, setSubKeyboard] = useState<"alpha" | "numbers" | "fn" | "arrows" | "nav" | "punct">("alpha")
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (open && customList.length === 0 && !dirty) {
      void getMyShortcutsAction().then((res) => {
        if (res.code === 0 && res.data) setCustomList(res.data.shortcuts)
      })
    }
  }, [open, customList.length, dirty])

  // ---- 发送：down 顺序 → up 逆序 ----
  const fireCombo = (keys: number[]) => {
    for (const k of keys) sendKey(k, true)
    setTimeout(() => {
      for (const k of [...keys].reverse()) sendKey(k, false)
    }, 80)
  }

  const fireBuiltin = (keys: Array<{ keysym: number }>) => {
    fireCombo(keys.map((x) => x.keysym))
  }

  // ---- 物理键捕获（电脑端录入） ----
  useEffect(() => {
    if (!recording) return
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const combo = keyEventToCombo(e)
      if (combo) {
        setDraftKeys(combo.keys)
      }
    }
    window.addEventListener("keydown", onDown, { capture: true })
    return () => window.removeEventListener("keydown", onDown, { capture: true } as never)
  }, [recording])

  const filteredBuiltin = useMemo(() => {
    if (!search) return BUILTIN_SHORTCUTS
    const kw = search.toLowerCase()
    return BUILTIN_SHORTCUTS.filter((s) =>
      s.label.toLowerCase().includes(kw) || s.title.toLowerCase().includes(kw) || s.category.toLowerCase().includes(kw))
  }, [search])

  const filteredCustom = useMemo(() => {
    if (!search) return customList
    const kw = search.toLowerCase()
    return customList.filter((s) => s.label.toLowerCase().includes(kw) || (s.title || "").toLowerCase().includes(kw))
  }, [search, customList])

  const saveCustom = async () => {
    const res = await saveMyShortcutsAction({ shortcuts: customList })
    if (res.code === 0) { toast.success(`已保存 ${res.data?.saved || 0} 条自定义快捷键（跨端同步）`); setDirty(false) }
    else toast.error(res.msg || "保存失败")
  }

  const addDraft = () => {
    if (draftKeys.length === 0) { toast.error("请先录入组合键（物理按键或点选小键盘）"); return }
    const label = comboLabel(draftKeys)
    if (customList.some((c) => c.label === label)) { toast.error("已存在相同组合"); return }
    setCustomList([...customList, {
      id: `c-${Date.now()}`, label, title: draftTitle || "自定义快捷键", keys: draftKeys,
    }])
    setDraftKeys([])
    setDraftTitle("")
    setDirty(true)
    toast.success("已添加（记得保存）")
  }

  // 小键盘点选
  const toggleMod = (m: number) => {
    setDraftKeys((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
  }
  const appendMain = (m: number) => {
    setDraftKeys((prev) => {
      const mods = prev.filter((x) => [KS_CTRL, KS_ALT, KS_SHIFT, KS_SUPER].includes(x))
      return [...mods, m]
    })
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setCustomOpen(false); setRecording(false) } }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={disabled} title="快捷键面板（40+ 内置 + 自定义）">
          <Keyboard className="h-3.5 w-3.5" />快捷键
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="end">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-teal-600" />
            <span className="text-sm font-semibold">远程快捷键</span>
            <span className="ml-auto text-[10px] text-muted-foreground">{BUILTIN_SHORTCUTS.length + customList.length} 项</span>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索快捷键 / 作用…" className="h-8 pl-8 text-xs" />
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={() => setCustomOpen(!customOpen)}>
              <Plus className="h-3 w-3" />自定义{customList.length > 0 ? `（${customList.length}）` : ""}
            </Button>
            {dirty && (
              <Button size="sm" className="h-7 text-xs gap-1" onClick={() => void saveCustom()}><Save className="h-3 w-3" />保存</Button>
            )}
          </div>
        </div>

        {/* 自定义编辑区 */}
        {customOpen && (
          <div className="p-3 border-b bg-muted/30 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">录入新快捷键</span>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setCustomOpen(false)}><X className="h-3 w-3" /></Button>
            </div>
            <Button
              variant={recording ? "destructive" : "outline"}
              size="sm"
              className="w-full h-8 text-xs gap-1"
              onClick={() => setRecording(!recording)}
            >
              <Zap className="h-3 w-3" />
              {recording ? "录制中：请按下组合键…" : "物理按键录入（电脑端）"}
            </Button>
            <div className="text-center py-1 rounded border bg-background min-h-9 flex items-center justify-center font-mono text-sm">
              {draftKeys.length > 0 ? comboLabel(draftKeys) : <span className="text-xs text-muted-foreground">尚未录入</span>}
            </div>
            {/* 移动端小键盘 */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1">
                {MODIFIER_CAPS.map((c) => (
                  <button key={c.keysym} onClick={() => toggleMod(c.keysym)}
                    className={`px-2 h-7 rounded text-xs border transition ${draftKeys.includes(c.keysym) ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"}`}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 flex-wrap">
                {(["alpha", "numbers", "fn", "arrows", "nav", "punct"] as const).map((k) => (
                  <button key={k} onClick={() => setSubKeyboard(k)}
                    className={`px-1.5 h-6 rounded text-[10px] border ${subKeyboard === k ? "bg-muted font-medium" : "bg-background"}`}>
                    {{ alpha: "字母", numbers: "数字", fn: "F键", arrows: "方向", nav: "导航", punct: "符号" }[k]}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                {(subKeyboard === "alpha" ? MAIN_CAPS.filter((c) => c.keysym >= 0x61)
                  : subKeyboard === "numbers" ? NUMBER_CAPS
                  : subKeyboard === "fn" ? FUNCTION_CAPS
                  : subKeyboard === "arrows" ? ARROW_CAPS
                  : subKeyboard === "nav" ? [...NAV_CAPS, ...PAGING_CAPS]
                  : PUNCT_CAPS).map((c, i) => (
                  <button key={`${c.label}-${i}`} onClick={() => appendMain(c.keysym)}
                    className="px-2 h-7 min-w-7 rounded text-xs border bg-background hover:bg-muted">
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="作用说明（可选）" className="h-8 text-xs" />
            <Button size="sm" className="w-full h-8 text-xs" onClick={addDraft}>添加到我的快捷键</Button>
            {customList.length > 0 && (
              <div className="space-y-1 pt-1 border-t">
                {customList.map((c) => (
                  <div key={c.id} className="flex items-center gap-1.5 text-xs py-1">
                    <button className="px-2 h-7 rounded border bg-background hover:bg-muted font-mono" onClick={() => fireCombo(c.keys)}>{c.label}</button>
                    <span className="truncate text-muted-foreground flex-1">{c.title}</span>
                    <button className="text-red-500 hover:text-red-600" onClick={() => { setCustomList(customList.filter((x) => x.id !== c.id)); setDirty(true) }}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 内置分类列表 */}
        <div className="max-h-[50vh] overflow-y-auto">
          {SHORTCUT_CATEGORIES.map((cat) => {
            const items = filteredBuiltin.filter((s) => s.category === cat)
            if (items.length === 0) return null
            const isCollapsed = collapsed.has(cat)
            return (
              <div key={cat}>
                <button
                  className="w-full flex items-center gap-1.5 px-3 py-2 hover:bg-muted/50 text-xs font-medium border-t"
                  onClick={() => {
                    const next = new Set(collapsed)
                    if (next.has(cat)) { next.delete(cat) } else { next.add(cat) }
                    setCollapsed(next)
                  }}
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {cat}
                  <span className="ml-auto text-[10px] text-muted-foreground">{items.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                    {items.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => { fireBuiltin(s.keys); toast(`已发送 ${s.label} → ${s.title}`, { duration: 1200 }) }}
                        className={`text-left px-2 py-1.5 rounded border bg-background hover:bg-muted hover:border-primary/40 transition text-xs ${s.danger ? "border-red-200 text-red-700" : ""}`}
                        title={s.title}
                      >
                        <span className="font-mono">{s.label}</span>
                        <span className="block text-[10px] text-muted-foreground truncate">{s.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {filteredCustom.length > 0 && (
            <div>
              <div className="px-3 py-2 text-xs font-medium border-t flex items-center gap-1.5">
                自定义
                <span className="ml-auto text-[10px] text-muted-foreground">{filteredCustom.length}</span>
              </div>
              <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                {filteredCustom.map((c) => (
                  <button key={c.id} onClick={() => { fireCombo(c.keys); toast(`已发送 ${c.label}`, { duration: 1200 }) }}
                    className="text-left px-2 py-1.5 rounded border bg-teal-50 hover:bg-teal-100 border-teal-200 text-xs"
                    title={c.title}>
                    <span className="font-mono">{c.label}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">{c.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {filteredBuiltin.length === 0 && filteredCustom.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">无匹配快捷键</div>
          )}
        </div>
        <div className="px-3 py-2 border-t text-[10px] text-muted-foreground">
          组合键直达远程沙箱桌面（绕过本地浏览器/系统抢占）；自定义跨端同步
        </div>
      </PopoverContent>
    </Popover>
  )
}
