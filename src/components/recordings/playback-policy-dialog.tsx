"use client"

// r28：回放策略对话框（用户/组/沙箱 三级复用）
// 显示当前生效值（来源徽章）+ 覆盖设置（水印三档 / 导出开关 / 清除覆盖）

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { getPlaybackPolicyAction, setPlaybackPolicyAction } from "@/server/actions/playback-policy-actions"

type Watermark = "force" | "on" | "off"

interface PlaybackPolicyDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  scope: "user" | "group" | "sandbox"
  targetId: string
  targetName: string
  targetUserId?: string // sandbox 时传归属用户（解析链）
}

const WM_DESC: Record<Watermark, string> = {
  force: "强制水印（任何人都无法关闭，防截屏溯源）",
  on: "默认开启（用户回放时可临时关闭本次）",
  off: "默认关闭（策略允许时用户也不显示水印）",
}

export function PlaybackPolicyDialog({ open, onOpenChange, scope, targetId, targetName, targetUserId }: PlaybackPolicyDialogProps) {
  const [wm, setWm] = useState<Watermark | "">("")
  const [allowExport, setAllowExport] = useState<boolean | null>(null)
  const [effective, setEffective] = useState<{ watermark: string; allowExport: boolean; source: string; userOverride: unknown; sandboxOverride: unknown } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    void getPlaybackPolicyAction({
      userId: scope === "user" ? targetId : targetUserId,
      workspaceId: scope === "sandbox" ? targetId : undefined,
    }).then((res) => {
      if (res.code === 0 && res.data) {
        setEffective(res.data)
        // 回显覆盖值
        const ov = (scope === "user" ? res.data.userOverride : scope === "sandbox" ? res.data.sandboxOverride : res.data.groupOverride) as { watermark?: Watermark; allowExport?: boolean } | null
        if (scope === "group") {
          setWm((res.data as unknown as { groupOverride?: { watermark?: Watermark } }).groupOverride?.watermark || "")
          const ge = (res.data as unknown as { groupOverride?: { allowExport?: boolean } }).groupOverride?.allowExport
          setAllowExport(typeof ge === "boolean" ? ge : null)
        } else {
          setWm(ov?.watermark || "")
          setAllowExport(typeof ov?.allowExport === "boolean" ? (ov as { allowExport: boolean }).allowExport : null)
        }
      }
    })
  }, [open, scope, targetId, targetUserId])

  const save = async (clear?: boolean) => {
    setSaving(true)
    try {
      const res = await setPlaybackPolicyAction({
        scope, targetId,
        ...(clear ? { clear: true } : {
          ...(wm ? { watermark: wm as Watermark } : {}),
          ...(allowExport !== null ? { allowExport } : {}),
        }),
      })
      if (res.code === 0) {
        toast.success(clear ? "已清除覆盖（完全继承上层策略）" : "回放策略已保存")
        onOpenChange(false)
      } else toast.error(res.msg || "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-teal-600" />回放安全策略</DialogTitle>
          <DialogDescription>
            {scope === "user" ? `用户「${targetName}」` : scope === "group" ? `用户组「${targetName}」` : `沙箱「${targetName}」`}的水印与导出管控
            （优先级：沙箱 &gt; 用户 &gt; 用户组 &gt; 全局默认）
          </DialogDescription>
        </DialogHeader>

        {effective && (
          <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">当前生效水印</span><span className="font-medium">{WM_DESC[effective.watermark as Watermark]?.split("（")[0]}（来源：{effective.source}）</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">当前导出策略</span><span className="font-medium">{effective.allowExport ? "允许导出/下载" : "仅在线回放"}</span></div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium mb-1.5">水印覆盖（不勾选=继承）</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(["force", "on", "off"] as Watermark[]).map((w) => (
                <button key={w} onClick={() => setWm(wm === w ? "" : w)}
                  className={`px-2 py-1.5 rounded-lg border text-xs transition ${wm === w ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-muted"}`}
                  title={WM_DESC[w]}>
                  {{ force: "强制水印", on: "默认开启", off: "默认关闭" }[w]}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{wm ? WM_DESC[wm] : "未设置（继承上层策略）"}</div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">允许导出/下载</div>
              <div className="text-xs text-muted-foreground">关闭时用户仅可在线回放（下载路由 403）</div>
            </div>
            <div className="flex items-center gap-2">
              {allowExport !== null && (
                <span className={`text-xs ${allowExport ? "text-emerald-600" : "text-red-500"}`}>{allowExport ? "允许" : "禁止"}</span>
              )}
              <Switch checked={allowExport === true} onCheckedChange={(v) => setAllowExport(v)} />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void save(true)}>清除覆盖</Button>
          <Button size="sm" disabled={saving} onClick={() => void save(false)}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
