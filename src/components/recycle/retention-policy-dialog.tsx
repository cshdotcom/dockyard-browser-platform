"use client"

// r28：回收站保留期基线对话框（用户/组级；天数；null=继承；0=永久）

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import { setRecycleRetentionBaselineAction } from "@/server/actions/recycle"

export function RetentionPolicyDialog({ open, onOpenChange, scope, targetId, targetName, initialDays }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  scope: "user" | "group"
  targetId: string
  targetName: string
  initialDays: number | null
}) {
  const [days, setDays] = useState<string>(initialDays == null ? "" : String(initialDays))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setDays(initialDays == null ? "" : String(initialDays))
  }, [open, initialDays])

  const save = async (clear?: boolean) => {
    setSaving(true)
    try {
      const parsed = clear ? null : days === "" ? null : Math.max(0, Math.min(3650, Number(days) || 0))
      const res = await setRecycleRetentionBaselineAction({ scope, targetId, days: parsed })
      if (res.code === 0) {
        toast.success(clear || days === "" ? "已设为继承上层策略" : parsed === 0 ? "已设为永久保留" : `已设为 ${parsed} 天保留期`)
        onOpenChange(false)
      } else toast.error(res.msg || "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>回收站保留期基线</DialogTitle>
          <DialogDescription>
            {scope === "user" ? `用户「${targetName}」` : `用户组「${targetName}」组内成员`}的软删除数据保留天数
            （优先级：单条指定 &gt; 用户 &gt; 用户组 &gt; 全局默认）
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="留空=继承上层；0=永久保留；如 30"
            inputMode="numeric"
          />
          <div className="text-xs text-muted-foreground">
            含义：沙箱/录像/文件/令牌等软删除进入回收站后，保留该天数到期自动物理清除；
            0 = 永久保留（需管理员手动清除）；留空 = 继承上层策略链。
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void save(true)}>继承上层</Button>
          <Button size="sm" disabled={saving} onClick={() => void save(false)}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
