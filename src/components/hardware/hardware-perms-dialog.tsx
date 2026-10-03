"use client"

// r29-a：17 项硬件权限编辑器（global / user / group / sandbox 四 scope 复用）
// 分组卡片 + 每项四开关（允许/审计/录制/静默）
// · 静默列仅超管可见可写（服务端二次校验兜底）
// · 稀疏语义：未触碰的项=继承上层（保存时只提交触碰项）

import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Cpu, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { getHardwarePolicyAction, setHardwarePolicyAction } from "@/server/actions/hardware-policy-actions"

// 目录（与服务端 HARDWARE_PERMS 同步；仅渲染用，权威在服务端）
const PERM_DEFS: Array<{ id: string; label: string; group: string; native: boolean; danger?: boolean }> = [
  { id: "camera", label: "摄像头", group: "音视频与画面", native: true },
  { id: "microphone", label: "麦克风", group: "音视频与画面", native: true },
  { id: "screenShare", label: "屏幕共享", group: "音视频与画面", native: false, danger: true },
  { id: "location", label: "定位", group: "位置与传感器", native: true },
  { id: "accelerometer", label: "加速度传感器", group: "位置与传感器", native: false },
  { id: "gyroscope", label: "陀螺仪", group: "位置与传感器", native: false },
  { id: "magnetometer", label: "磁力计", group: "位置与传感器", native: false },
  { id: "deviceOrientation", label: "设备方向", group: "位置与传感器", native: false },
  { id: "deviceMotion", label: "设备运动", group: "位置与传感器", native: false },
  { id: "clipboardRead", label: "剪贴板读（粘贴入沙箱）", group: "剪贴板", native: false, danger: true },
  { id: "clipboardWrite", label: "剪贴板写（复制出沙箱）", group: "剪贴板", native: false },
  { id: "notifications", label: "通知", group: "系统交互", native: true },
  { id: "bluetooth", label: "蓝牙", group: "外设硬件", native: true },
  { id: "usb", label: "USB 设备", group: "外设硬件", native: true },
  { id: "serial", label: "串口", group: "外设硬件", native: true },
  { id: "midi", label: "MIDI 设备", group: "外设硬件", native: true },
  { id: "hid", label: "HID 设备", group: "外设硬件", native: true },
]

const GROUPS = ["音视频与画面", "位置与传感器", "剪贴板", "系统交互", "外设硬件"]

type PermState = { enabled?: boolean; audit?: boolean; record?: boolean; silent?: boolean }
type PermMap = Record<string, PermState>

interface HardwarePermsDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  scope: "global" | "user" | "group" | "sandbox"
  targetId?: string
  targetName: string
  targetUserId?: string // sandbox 时传归属用户
}

const SOURCE_LABEL: Record<string, string> = { SANDBOX: "沙箱覆盖", USER: "用户覆盖", GROUP: "组级继承", GLOBAL: "全局默认" }

export function HardwarePermsDialog({ open, onOpenChange, scope, targetId, targetName, targetUserId }: HardwarePermsDialogProps) {
  const [effective, setEffective] = useState<{ policy: Record<string, PermState>; source: string; clipboardSync: { enabled: boolean; source: string }; override: PermMap | null; canGrantSilent: boolean } | null>(null)
  const [touched, setTouched] = useState<PermMap>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) { setTouched({}); setEffective(null); return }
    void getHardwarePolicyAction({
      scope, targetId: targetId || undefined,
      ...(scope === "sandbox" && targetUserId ? { targetUserId } : {}),
    }).then((res) => {
      if (res.code === 0 && res.data) {
        setEffective({ policy: res.data.policy, source: res.data.source, clipboardSync: res.data.clipboardSync, override: res.data.override, canGrantSilent: res.data.canGrantSilent })
      } else toast.error(res.msg || "读取硬件权限失败")
    })
  }, [open, scope, targetId, targetUserId])

  const touchedCount = useMemo(() => Object.keys(touched).length, [touched])

  const setPerm = (permId: string, key: keyof PermState, v: boolean) => {
    setTouched((prev) => {
      const cur: PermState = { ...(prev[permId] || {}) }
      if (v) cur[key] = true; else delete cur[key]
      if (Object.keys(cur).length === 0) { const next = { ...prev }; delete next[permId]; return next }
      return { ...prev, [permId]: cur }
    })
  }

  // 生效值展示：触碰项优先（保存预览语义），否则展示解析链结果
  const mergedView = useMemo(() => {
    if (!effective) return {} as Record<string, PermState>
    return { ...effective.policy, ...touched }
  }, [effective, touched])

  const save = async (clear?: boolean) => {
    setSaving(true)
    try {
      const res = await setHardwarePolicyAction({
        scope, targetId: targetId || undefined,
        ...(clear ? { clear: true } : { policy: touched }),
      })
      if (res.code === 0) {
        toast.success(clear ? "已清除覆盖（完全继承上层策略）" : `硬件权限已保存（${res.data?.refreshed || 0} 个沙箱已刷新策略，${res.data?.restarted || 0} 个运行中沙箱已重启生效）`)
        setTouched({})
        onOpenChange(false)
      } else toast.error(res.msg || "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const canSave = touchedCount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-teal-600" />
            17 项硬件权限管控
          </DialogTitle>
          <DialogDescription>
            {scope === "global" ? "全局默认档（所有用户的兜底基线）" : scope === "user" ? `用户「${targetName}」覆盖` : scope === "group" ? `用户组「${targetName}」基线` : `沙箱「${targetName}」覆盖`}
            （优先级：沙箱 &gt; 用户 &gt; 用户组 &gt; 全局默认；未勾选项 = 继承上层）
          </DialogDescription>
        </DialogHeader>

        {effective && (
          <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">当前解析来源</span>
              <span className="font-medium">{SOURCE_LABEL[effective.source] || effective.source}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">VNC 剪贴板透传</span>
              <span className="font-medium">
                {effective.clipboardSync.enabled ? "开启" : "关闭"}
                <span className="text-muted-foreground ml-1">（{effective.clipboardSync.source === "legacy-config" ? "旧版全局开关" : "硬件权限接管"}）</span>
              </span>
            </div>
          </div>
        )}

        {!effective && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在解析四级策略链…
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_44px_44px_44px_44px] items-center gap-2 px-1 text-xs text-muted-foreground">
            <span>权限项</span><span className="text-center">允许</span><span className="text-center">审计</span><span className="text-center">录制</span>
            <span className={`text-center ${effective?.canGrantSilent ? "text-rose-600" : "opacity-0"}`}>静默</span>
          </div>
          {GROUPS.map((g) => {
            const items = PERM_DEFS.filter((d) => d.group === g)
            if (items.length === 0) return null
            return (
              <div key={g} className="rounded-lg border">
                <div className="px-3 py-1.5 bg-muted/50 text-xs font-medium border-b flex items-center gap-2">
                  {g}
                  <Badge variant="outline" className="text-[10px] px-1 py-0">{items.length} 项</Badge>
                </div>
                <div className="divide-y">
                  {items.map((d) => {
                    const state: PermState = mergedView[d.id] || {}
                    const t = touched[d.id]
                    return (
                      <div key={d.id} className="grid grid-cols-[1fr_44px_44px_44px_44px] items-center gap-2 px-3 py-2 text-sm">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate" title={d.label}>{d.label}</span>
                          {d.danger && <Badge variant="destructive" className="text-[10px] px-1 py-0 shrink-0">高危</Badge>}
                          {!d.native && <span className="text-[10px] text-muted-foreground shrink-0" title="无 Chromium 原生策略键，由平台层（VNC 透传/CDP）执行">平台层</span>}
                          {t && <span className="text-[10px] text-teal-600 shrink-0">已改</span>}
                        </div>
                        <div className="flex justify-center"><Switch checked={!!state.enabled} onCheckedChange={(v) => setPerm(d.id, "enabled", v)} aria-label={`${d.label} 允许`} /></div>
                        <div className="flex justify-center"><Switch checked={!!state.audit} onCheckedChange={(v) => setPerm(d.id, "audit", v)} aria-label={`${d.label} 审计`} /></div>
                        <div className="flex justify-center"><Switch checked={!!state.record} onCheckedChange={(v) => setPerm(d.id, "record", v)} aria-label={`${d.label} 录制`} disabled={!state.enabled} /></div>
                        <div className="flex justify-center">
                          {effective?.canGrantSilent
                            ? <Switch checked={!!state.silent} onCheckedChange={(v) => setPerm(d.id, "silent", v)} aria-label={`${d.label} 静默`} className="data-[state=checked]:bg-rose-600" />
                            : <span className="text-[10px] text-muted-foreground" title="仅超级管理员可授予静默监控">锁</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          允许=网页可调用该硬件；审计=授权/使用行为入审计日志；录制=允许媒体流落取证目录（依赖允许开关）；静默=无用户提示监控（仅超级管理员可授予，静默特权模式强制审计）。
          {effective?.canGrantSilent && <span className="text-rose-600"> 静默列以红色标识：授予后对用户完全无感知。</span>}
        </p>

        <DialogFooter className="gap-2">
          {scope !== "global" && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => void save(true)}>清除覆盖</Button>
          )}
          <Button size="sm" disabled={saving || !canSave} onClick={() => void save(false)}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            保存{touchedCount > 0 ? `（${touchedCount} 项变更）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
