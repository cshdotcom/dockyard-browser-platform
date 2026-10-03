// ============================================================
// 沙箱输入法（IME）控制 — r24-c
//
// 架构（自研单容器内嵌形态）：
//   · 每个沙箱 = 独立 Xvfb 显示（:N）+ 独立 fcitx5 守护进程（监督树成员）
//   → 输入法切换严格作用域 = 该沙箱的 X 显示；其他沙箱（其他用户/其他在线会话）
//     各持独立 fcitx5 实例与独立显示，完全不受影响
//   · 平台侧通过 fcitx5-remote / setxkbmap 对该显示执行查询与切换
//     （fcitx5 以沙箱专用 Linux 用户运行；remote 经 X root window 发现 DBus 地址）
//
// 语言覆盖（随镜像安装）：
//   中文（拼音/双拼/五笔/注音/仓颉…fcitx5-chinese-addons）
//   日文（mozc，尽力安装）· 韩文（hangul）· 越南文（unikey，尽力安装）
//   各语言键盘布局（xkb layouts：us/cn/de/fr/es/it/ru/jp/kr/ar/…）
// ============================================================

import { spawnSync } from "child_process"
import fs from "fs"
import { readFile } from "fs/promises"
import { join } from "path"

// fcitx5 输入法元数据目录（测试可用 DY_FCITX5_IM_DIR 覆盖）
export const FCITX5_IM_DIR = () => process.env.DY_FCITX5_IM_DIR || "/usr/share/fcitx5/inputmethod"
export const XKB_RULES_FILE = () => process.env.DY_XKB_RULES || "/usr/share/X11/xkb/rules/evdev.xml"

export interface ImeEngineInfo {
  name: string // fcitx5 UniqueName（fcitx5-remote -s 的目标）
  label: string // 展示名（优先 i18n Name）
  category: string // keyboard | pinyin-like | table | other
}

export interface KbLayoutInfo {
  name: string // xkb layout（setxkbmap 目标）
  label: string
}

// 常用布局兜底清单（xkb rules 解析失败/文件缺失时使用；中英日韩德法西俄葡意阿拉伯…）
const FALLBACK_LAYOUTS: KbLayoutInfo[] = [
  { name: "us", label: "英语（美国）" },
  { name: "cn", label: "中文（中国）" },
  { name: "tw", label: "中文（台湾）" },
  { name: "jp", label: "日语（日本）" },
  { name: "kr", label: "韩语（韩国）" },
  { name: "de", label: "德语（德国）" },
  { name: "fr", label: "法语（法国）" },
  { name: "es", label: "西班牙语（西班牙）" },
  { name: "it", label: "意大利语（意大利）" },
  { name: "ru", label: "俄语（俄罗斯）" },
  { name: "pt", label: "葡萄牙语（葡萄牙）" },
  { name: "br", label: "葡萄牙语（巴西）" },
  { name: "gb", label: "英语（英国）" },
  { name: "ara", label: "阿拉伯语" },
  { name: "il", label: "希伯来语（以色列）" },
  { name: "th", label: "泰语（泰国）" },
  { name: "vn", label: "越南语" },
  { name: "tr", label: "土耳其语（土耳其）" },
  { name: "gr", label: "希腊语（希腊）" },
  { name: "in", label: "印地语（印度）" },
]

// 常用输入法友好名映射（fcitx5 .conf 的 UniqueName → 展示名）
const IME_LABELS: Record<string, string> = {
  "keyboard-us": "英语（美国）键盘",
  "keyboard-cn": "中文键盘",
  "keyboard-jp": "日语键盘",
  "keyboard-kr": "韩语键盘",
  "keyboard-de": "德语键盘",
  "keyboard-fr": "法语键盘",
  "keyboard-ru": "俄语键盘",
  pinyin: "中文拼音",
  shuangpin: "中文双拼",
  wubi: "五笔（86）",
  wubi98: "五笔（98）",
  zhuyin: "注音（ㄅㄆㄇㄈ）",
  cangjie: "仓颉",
  cangjie5: "仓颉五代",
  cantonese: "粤语拼音",
  "quick-classic": "速成",
  "scj6key": "简易六键",
  "wbpy-compact": "五笔拼音混输",
  "t9-pinyin": "T9 拼音",
  "goauyen": "注音大千式",
  mozc: "日语 Mozc",
  "mozc-jp": "日语 Mozc",
  anthy: "日语 Anthy",
  kktrc: "日语罗马字",
  hangul: "韩文 Hangul",
  "hangul2": "韩文 2 Set（두벌식）",
  "hangul3": "韩文 3 Set（세벌식）",
  romaja: "韩文罗马字",
  unikey: "越南文 Unikey",
  "vni": "越南文 VNI",
  "russian-english-advanced": "俄英切换",
  "rus-english": "俄英切换",
  thai: "泰语",
  "thai-kedmanee": "泰语 Kedmanee",
  "thai-pattachote": "泰语 Pattachote",
  arabic: "阿拉伯语",
  hebrew: "希伯来语",
  "kbnext": "下一输入法",
}

// 解析单个 fcitx5 .conf（INI 风格：[InputMethod] Name=/UniqueName=/Icon= …）
function parseImeConf(path: string): ImeEngineInfo | null {
  try {
    const text = fs.readFileSync(path, "utf8")
    const get = (key: string): string => {
      const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, "mi").exec(text)
      return m ? m[1].trim() : ""
    }
    const unique = get("UniqueName") || get("Name")
    if (!unique) return null
    const name = get("Name")
    const label = IME_LABELS[unique] || name || unique
    const category = unique.startsWith("keyboard-") ? "keyboard" : unique === "pinyin" || unique === "shuangpin" || unique.includes("hangul") || unique.includes("mozc") || unique === "unikey" || unique === "zhuyin" ? "ime" : "table"
    return { name: unique, label, category }
  } catch {
    return null
  }
}

// 枚举容器内可用输入法（fcitx5 inputmethod 目录下全部 .conf）
export function listImeEngines(dir = FCITX5_IM_DIR()): ImeEngineInfo[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".conf"))
  } catch {
    return []
  }
  const engines = files.map((f) => parseImeConf(join(dir, f))).filter((v): v is ImeEngineInfo => !!v)
  // 排序：keyboard 组在前，拼音等常用 IME 次之，table 最后；组内按名称
  const order = { keyboard: 0, ime: 1, table: 2 } as Record<string, number>
  return engines.sort((a, b) => (order[a.category] ?? 3) - (order[b.category] ?? 3) || a.name.localeCompare(b.name))
}

// 枚举键盘布局（解析 xkb evdev.xml；失败回退常用清单）
export async function listKbLayouts(): Promise<KbLayoutInfo[]> {
  try {
    const xml = await readFile(XKB_RULES_FILE(), "utf8")
    const layouts: KbLayoutInfo[] = []
    // 宽松匹配：<layout><configItem><name>…</name>（中间可夹注释/其他标签）…<description>…</description>
    // evdev.xml / base.xml 同构；name 与 description 之间的注释/shortDescription 等均容忍
    const re = /<layout>\s*<configItem>\s*<name>([^<]+)<\/name>(?:(?!<\/layout>).)*?<description>([^<]+)<\/description>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) && layouts.length < 120) {
      const name = m[1].trim()
      const label = m[2].trim()
      if (name && label) layouts.push({ name, label })
    }
    if (layouts.length > 0) return layouts
  } catch {
    /* 解析失败 → 回退 */
  }
  return FALLBACK_LAYOUTS
}

// ============================================================
// 运行态控制（作用域 = 单个沙箱的 X 显示）
// ============================================================

export interface ImeRuntimeHandle {
  display: number
  linuxUser: string | null
  sandboxDir: string
}

function runAsSandboxUser(handle: ImeRuntimeHandle, cmd: string, args: string[], timeoutMs = 8000): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: `:${handle.display}`,
    XMODIFIERS: "@im=fcitx",
    HOME: handle.sandboxDir,
  }
  if (handle.linuxUser && process.getuid?.() === 0) {
    // root 环境以沙箱专用用户执行（fcitx5 归属用户；X 显示访问一致性）
    const full = spawnSync("setpriv", ["--reuid", handle.linuxUser, "--regid", handle.linuxUser, "--init-groups", "--", cmd, ...args], { env, timeout: timeoutMs, encoding: "utf8" })
    return { code: full.status ?? -1, stdout: full.stdout || "", stderr: full.stderr || "" }
  }
  const r = spawnSync(cmd, args, { env, timeout: timeoutMs, encoding: "utf8" })
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" }
}

// fcitx5 组件是否可用（容器内安装检测；未安装时 UI 显示降级说明）
export function fcitx5Installed(): boolean {
  for (const p of ["/usr/bin/fcitx5", "/usr/local/bin/fcitx5"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch { /* next */ }
  }
  return false
}

// setxkbmap 是否可用
export function setxkbmapInstalled(): boolean {
  const r = spawnSync("which", ["setxkbmap"], { timeout: 3000, encoding: "utf8" })
  return (r.status ?? 1) === 0
}

// 查询当前输入法（fcitx5-remote -n；无 fcitx5 返回 null）
export function imeCurrentEngine(handle: ImeRuntimeHandle): string | null {
  if (!fcitx5Installed()) return null
  const r = runAsSandboxUser(handle, "fcitx5-remote", ["-n"], 5000)
  if (r.code !== 0) return null
  return r.stdout.trim() || null
}

// 切换输入法引擎（fcitx5-remote -s <name>；作用域=该显示的 fcitx5 实例）
export function applyImeEngine(handle: ImeRuntimeHandle, engine: string): { ok: boolean; error?: string } {
  if (!fcitx5Installed()) return { ok: false, error: "容器未安装 fcitx5 输入法组件（镜像需包含 fcitx5 全家桶）" }
  if (!/^[\w.-]{1,64}$/.test(engine)) return { ok: false, error: `输入法名非法：${engine}` }
  const r = runAsSandboxUser(handle, "fcitx5-remote", ["-s", engine])
  if (r.code !== 0) return { ok: false, error: `fcitx5-remote 切换失败（exit=${r.code}${r.stderr ? `：${r.stderr.slice(0, 120)}` : ""}）` }
  return { ok: true }
}

// 切换键盘布局（setxkbmap；作用域=该显示）
export function applyKbLayout(handle: ImeRuntimeHandle, layout: string): { ok: boolean; error?: string } {
  if (!setxkbmapInstalled()) return { ok: false, error: "容器未安装 setxkbmap（x11-xkb-utils）" }
  if (!/^[a-z]{2,8}$/.test(layout)) return { ok: false, error: `布局名非法：${layout}` }
  const r = runAsSandboxUser(handle, "setxkbmap", ["-display", `:${handle.display}`, layout])
  if (r.code !== 0) return { ok: false, error: `setxkbmap 失败（exit=${r.code}${r.stderr ? `：${r.stderr.slice(0, 120)}` : ""}）` }
  return { ok: true }
}

// 查询当前键盘布局
// 优先 setxkbmap -print 解析 xkb_symbols 实际生效 include（如 pc+de+inet(evdev)）——
// 部分 X 服务器的 _XKB_RULES_NAMES 属性更新滞后（-query 读到旧值），-print 为真实生效键位证据；
// 回退 -query 的 layout 字段。
export function imeCurrentKbLayout(handle: ImeRuntimeHandle): string | null {
  if (!setxkbmapInstalled()) return null
  const print = runAsSandboxUser(handle, "setxkbmap", ["-display", `:${handle.display}`, "-print"], 6000)
  if (print.code === 0) {
    // xkb_symbols { include "pc+de+inet(evdev)" } → 取主布局段（pc 与 inet 之间）
    const m = /include\s*"pc\+([a-z-]+)\+/.exec(print.stdout)
    if (m) return m[1]
    const m2 = /xkb_symbols[^}]*include\s*"([a-z-]+)/.exec(print.stdout)
    if (m2) return m2[1]
  }
  const q = runAsSandboxUser(handle, "setxkbmap", ["-display", `:${handle.display}`, "-query"], 6000)
  if (q.code !== 0) return null
  const m = /layout:\s*(\S+)/.exec(q.stdout)
  return m ? m[1] : null
}
