/**
 * r29：浏览器硬件权限管控（17 项全覆盖，四级策略链）
 *
 * 每项权限独立四开关：
 *   enabled —— 是否允许网页使用该硬件（false=拒绝授权）
 *   audit   —— 授权/使用行为入审计
 *   record  —— 允许录制（音视频流落取证目录）
 *   silent  —— 允许静默监控（无用户提示；仅超管可授予）
 *
 * 策略链：沙箱 hardwareOverride > 用户 hardwarePolicy > 用户组（继承链） > 全局 hardware.defaults
 *
 * Chromium 落地（零内核 Patch）：
 *   有原生企业策略键的项 → Managed Preferences 注入（Default*Setting / Web*Blocked）
 *   无原生键的项（传感器类/屏幕共享/剪贴板）→ 平台层管控（VNC 透传开关 + CDP 拦截 + 审计）
 */

// ---- 17 项权限目录 ----
export interface HardwarePermDef {
  id: string
  label: string
  group: string
  /** Chromium Managed Preferences 键（有原生策略时注入） */
  chromium?: { key: string; blockValue: number; allowValue: number }
  /** 平台层管控通道（无原生策略键时） */
  platformChannel?: "clipboard" | "sensor" | "screen" | "none"
  danger?: boolean
}

export const HARDWARE_PERMS: HardwarePermDef[] = [
  { id: "camera", label: "摄像头", group: "音视频与画面", chromium: { key: "DefaultCameraSetting", blockValue: 2, allowValue: 3 } },
  { id: "microphone", label: "麦克风", group: "音视频与画面", chromium: { key: "DefaultMicrophoneSetting", blockValue: 2, allowValue: 3 } },
  { id: "screenShare", label: "屏幕共享", group: "音视频与画面", platformChannel: "screen", danger: true },
  { id: "location", label: "定位", group: "位置与传感器", chromium: { key: "DefaultGeolocationSetting", blockValue: 2, allowValue: 1 } },
  { id: "accelerometer", label: "加速度传感器", group: "位置与传感器", platformChannel: "sensor" },
  { id: "gyroscope", label: "陀螺仪", group: "位置与传感器", platformChannel: "sensor" },
  { id: "magnetometer", label: "磁力计", group: "位置与传感器", platformChannel: "sensor" },
  { id: "deviceOrientation", label: "设备方向", group: "位置与传感器", platformChannel: "sensor" },
  { id: "deviceMotion", label: "设备运动", group: "位置与传感器", platformChannel: "sensor" },
  { id: "clipboardRead", label: "剪贴板读", group: "剪贴板", platformChannel: "clipboard", danger: true },
  { id: "clipboardWrite", label: "剪贴板写", group: "剪贴板", platformChannel: "clipboard" },
  { id: "notifications", label: "通知", group: "系统交互", chromium: { key: "DefaultNotificationsSetting", blockValue: 2, allowValue: 1 } },
  { id: "bluetooth", label: "蓝牙", group: "外设硬件", chromium: { key: "WebBluetoothBlocked", blockValue: 1, allowValue: 0 } },
  { id: "usb", label: "USB 设备", group: "外设硬件", chromium: { key: "WebUSBBlocked", blockValue: 1, allowValue: 0 } },
  { id: "serial", label: "串口", group: "外设硬件", chromium: { key: "WebSerialBlocked", blockValue: 1, allowValue: 0 } },
  { id: "midi", label: "MIDI 设备", group: "外设硬件", chromium: { key: "WebMIDIBlocked", blockValue: 1, allowValue: 0 } },
  { id: "hid", label: "HID 设备", group: "外设硬件", chromium: { key: "WebHIDBlocked", blockValue: 1, allowValue: 0 } },
]

export const HARDWARE_PERM_IDS = HARDWARE_PERMS.map((p) => p.id)

// ---- 单项四开关状态 ----
export interface HardwarePermState {
  enabled: boolean
  audit: boolean
  record: boolean
  silent: boolean
}

export type HardwarePermMap = Record<string, Partial<HardwarePermState>>
export type ResolvedHardwarePolicy = Record<string, HardwarePermState> & { __source?: "SANDBOX" | "USER" | "GROUP" | "GLOBAL" }

const FULL_DEFAULT: HardwarePermState = { enabled: false, audit: true, record: false, silent: false }

/** 稀疏覆盖合并（深层：逐项逐字段） */
function mergeSparse(base: Record<string, HardwarePermState>, sparse: HardwarePermMap): Record<string, HardwarePermState> {
  const out: Record<string, HardwarePermState> = {}
  for (const def of HARDWARE_PERMS) {
    const b = base[def.id] || FULL_DEFAULT
    const s = sparse[def.id]
    out[def.id] = s ? { ...b, ...s } : { ...b }
  }
  return out
}

/** 校验稀疏配置（保存路径用；静默权限仅超管可授予——服务端二次校验） */
export function validateHardwarePolicy(v: unknown): { ok: boolean; errors: string[]; clean: HardwarePermMap | null } {
  const errors: string[] = []
  if (v == null) return { ok: true, errors: [], clean: null }
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, errors: ["格式必须为对象"], clean: null }
  const obj = v as Record<string, unknown>
  const out: HardwarePermMap = {}
  for (const [permId, val] of Object.entries(obj)) {
    if (!HARDWARE_PERM_IDS.includes(permId)) { errors.push(`未知权限项：${permId}`); continue }
    if (typeof val !== "object" || val == null) { errors.push(`${permId} 的值必须为对象`); continue }
    const clean: Partial<HardwarePermState> = {}
    const o = val as Record<string, unknown>
    for (const k of ["enabled", "audit", "record", "silent"] as const) {
      if (k in o) {
        if (typeof o[k] !== "boolean") { errors.push(`${permId}.${k} 必须为布尔`); continue }
        clean[k] = o[k]
      }
    }
    if (Object.keys(clean).length > 0) out[permId] = clean
  }
  return { ok: errors.length === 0, errors, clean: Object.keys(out).length > 0 ? out : null }
}

// ---- 四级链解析（沙箱 > 用户 > 组（继承链） > 全局默认） ----
import { db } from "@/lib/db"

export interface ResolvedHardware {
  policy: Record<string, HardwarePermState>
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL"
  /** 任一层级显式设置过的权限项（平台通道回退判定用：未显式 → 沿用旧版全局开关语义） */
  explicit: Record<string, boolean>
}

/** 稀疏显式标记合并（层级链上出现过即置位） */
function mergeExplicit(acc: Record<string, boolean>, sparse: HardwarePermMap): void {
  for (const k of Object.keys(sparse)) acc[k] = true
}

export async function resolveHardwarePolicy(userId: string, workspaceId?: string): Promise<ResolvedHardware> {
  const { getConfig } = await import("@/lib/config")
  const defaultsStr = await getConfig("hardware.defaults", "{}")
  let defaults: HardwarePermMap = {}
  try { defaults = JSON.parse(String(defaultsStr || "{}")) as HardwarePermMap } catch { defaults = {} }

  const explicit: Record<string, boolean> = {}
  mergeExplicit(explicit, defaults)
  let policy = mergeSparse({}, defaults)
  let source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL" = "GLOBAL"

  // 组级（继承链向上，首个命中稀疏键的组）
  const links = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  for (const l of links) {
    let gid: string | null = l.groupId
    let depth = 0
    while (gid && depth < 6) {
      const g = await db.group.findUnique({ where: { id: gid }, select: { hardwarePolicy: true, parentId: true } })
      if (!g) break
      if (g.hardwarePolicy && Object.keys(g.hardwarePolicy as object).length > 0) {
        policy = mergeSparse(policy, g.hardwarePolicy as HardwarePermMap)
        mergeExplicit(explicit, g.hardwarePolicy as HardwarePermMap)
        source = "GROUP"
        break
      }
      gid = g.parentId
      depth++
    }
  }

  // 用户级
  const user = await db.user.findUnique({ where: { id: userId }, select: { hardwarePolicy: true } })
  if (user?.hardwarePolicy && Object.keys(user.hardwarePolicy as object).length > 0) {
    policy = mergeSparse(policy, user.hardwarePolicy as HardwarePermMap)
    mergeExplicit(explicit, user.hardwarePolicy as HardwarePermMap)
    source = "USER"
  }

  // 沙箱级覆盖（最强）
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({ where: { id: workspaceId }, select: { hardwareOverride: true } })
    if (ws?.hardwareOverride && Object.keys(ws.hardwareOverride as object).length > 0) {
      policy = mergeSparse(policy, ws.hardwareOverride as HardwarePermMap)
      mergeExplicit(explicit, ws.hardwareOverride as HardwarePermMap)
      source = "SANDBOX"
    }
  }

  return { policy, source, explicit }
}

/**
 * VNC 剪贴板透传解析（r29-a：硬件权限接管旧版全局开关）
 * 语义：剪贴板读/写任一层级显式设置 → 硬件策略生效（读或写启用即透传）；
 *       全链未显式 → 回退 workspace.clipboardVncSync 旧语义（升级零破坏）。
 */
export async function resolveClipboardSync(userId: string, workspaceId?: string): Promise<{ enabled: boolean; source: string }> {
  const { policy, explicit } = await resolveHardwarePolicy(userId, workspaceId)
  if (explicit.clipboardRead || explicit.clipboardWrite) {
    const on = !!(policy.clipboardRead?.enabled || policy.clipboardWrite?.enabled)
    return { enabled: on, source: explicit.clipboardWrite && !explicit.clipboardRead ? "clipboardWrite" : explicit.clipboardRead && !explicit.clipboardWrite ? "clipboardRead" : "hardware" }
  }
  const { getConfigBool } = await import("@/lib/config")
  return { enabled: await getConfigBool("workspace.clipboardVncSync", true), source: "legacy-config" }
}

/** 生成 Chromium Managed Preferences 片段（仅有原生键的项；enabled=true=allowValue，false=blockValue） */
export function hardwareManagedPolicies(policy: Record<string, HardwarePermState>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const def of HARDWARE_PERMS) {
    if (!def.chromium) continue
    const state = policy[def.id]
    if (!state) continue
    out[def.chromium.key] = state.enabled ? def.chromium.allowValue : def.chromium.blockValue
  }
  return out
}

/** 平台层通道清单（无原生 Chromium 键的项；由 VNC/CDP/剪贴板治理层执行） */
export function platformControlledPerms(policy: Record<string, HardwarePermState>): Array<{ def: HardwarePermDef; state: HardwarePermState }> {
  return HARDWARE_PERMS.filter((d) => d.platformChannel && d.platformChannel !== "none").map((def) => ({
    def, state: policy[def.id] || FULL_DEFAULT,
  }))
}
