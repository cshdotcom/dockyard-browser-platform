"use client"

// r13c：工作区共享弹窗（可复用组件）
// 用户端共享入口统一组件：工作区列表行内「共享」按钮与详情页「共享管理」共用同一弹窗。
// 用户名搜索建议（精确匹配优先置顶，点选填入）+ 权限（只读/可操作）+ 有效期。
// 管理员四级管控（全局/用户组/用户/沙箱）禁止时展示阻断原因（服务端二次强制校验）。

import * as React from "react"
import { toast } from "sonner"
import { Loader2, Share2 } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PrecisionInput } from "@/components/shared/confirm"
import { cn } from "@/lib/utils"
import { shareWorkspaceAction, searchShareTargetUsersAction } from "@/server/actions/workspaces"

export interface WorkspaceShareDialogProps {
  workspace: { id: string; name: string }
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
  /** 四级管控阻断原因（非空时弹窗内展示；服务端仍强制校验，前端提示仅为体验） */
  blockedReason?: string
}

export function WorkspaceShareDialog({ workspace, open, onOpenChange, onDone, blockedReason }: WorkspaceShareDialogProps) {
  const [username, setUsername] = React.useState("")
  const [permission, setPermission] = React.useState("VIEW")
  const [hours, setHours] = React.useState(24)
  const [busy, setBusy] = React.useState(false)
  // 用户搜索建议（输入 ≥1 字符触发；服务端精确用户名优先 + 昵称/用户名包含）
  const [suggests, setSuggests] = React.useState<{ id: string; username: string; displayName: string | null; shared: boolean }[]>([])
  const [suggestBusy, setSuggestBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    const kw = username.trim()
    if (!kw) { setSuggests([]); return }
    let alive = true
    setSuggestBusy(true)
    const t = setTimeout(async () => {
      try {
        const res = await searchShareTargetUsersAction({ workspaceId: workspace.id, q: kw })
        if (alive && res.code === 0) setSuggests(res.data?.items || [])
        else if (alive) setSuggests([])
      } catch { if (alive) setSuggests([]) } finally { if (alive) setSuggestBusy(false) }
    }, 300)
    return () => { alive = false; clearTimeout(t); setSuggestBusy(false) }
  }, [username, open, workspace.id])

  React.useEffect(() => {
    if (open) { setUsername(""); setSuggests([]); setPermission("VIEW"); setHours(24) }
  }, [open, workspace.id])

  const exact = suggests.find((s) => s.username === username.trim())

  const submit = async () => {
    setBusy(true)
    try {
      const res = await shareWorkspaceAction({ workspaceId: workspace.id, targetUsername: username.trim(), permission, expireHours: hours })
      if (res.code === 0) { toast.success("共享授权已创建"); onOpenChange(false); setUsername(""); setSuggests([]); onDone() }
      else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Share2 className="h-4 w-4" /> 共享工作区「{workspace.name}」
          </DialogTitle>
        </DialogHeader>
        {blockedReason && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {blockedReason}（提交将被服务端拦截）
          </div>
        )}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>目标用户名（输入即搜索，点选自动填入）</Label>
            <div className="relative">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入精确用户名" autoComplete="off" />
              {suggestBusy && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            {/* 搜索建议：精确匹配置顶 + 已共享标记 */}
            {suggests.length > 0 && (
              <div className="rounded-md border divide-y max-h-44 overflow-y-auto">
                {suggests.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-muted/70 transition",
                      s.username === username.trim() && "bg-teal-50/70 dark:bg-teal-950/30",
                    )}
                    onClick={() => setUsername(s.username)}
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium font-mono text-[13px]">{s.username}</span>
                      {s.username === username.trim() && <Badge className="ml-1.5 bg-teal-600 hover:bg-teal-600 text-[9px]">精确匹配</Badge>}
                      {s.displayName && <span className="ml-1.5 text-xs text-muted-foreground truncate">{s.displayName}</span>}
                    </span>
                    {s.shared && <Badge variant="secondary" className="text-[10px] shrink-0">已共享</Badge>}
                  </button>
                ))}
              </div>
            )}
            {username.trim() && !suggestBusy && suggests.length === 0 && (
              <p className="text-xs text-red-600">未找到匹配用户（共享按精确用户名匹配，请检查拼写）</p>
            )}
            {exact?.shared && (
              <p className="text-xs text-amber-600">该用户已有有效共享；提交将更新其权限与有效期</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>权限</Label>
            <Select value={permission} onValueChange={setPermission} disabled={!!blockedReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="VIEW">只读（仅查看画面/数据）</SelectItem>
                <SelectItem value="OPERATE">可操作（键鼠/剪贴板/CDP）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>有效期（小时，0=永久）</Label>
            <PrecisionInput value={hours} onChange={setHours} min={0} max={8760} suffix="h" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || !username.trim() || !!blockedReason}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 确认共享
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
