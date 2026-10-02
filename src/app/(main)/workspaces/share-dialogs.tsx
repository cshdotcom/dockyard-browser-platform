"use client"

// r22b：工作区共享弹窗（可复用组件）
// 用户端共享入口统一组件：工作区列表行内「共享」按钮与详情页「共享管理」共用同一弹窗。
// · 接收者名单：当前已共享给谁（用户名/权限/到期/状态），支持单个「移除」（撤销该接收者的共享，
//   不影响其他接收者；仅发起人/管理员可操作，服务端二次校验）
// · 多选共享：搜索建议列表带勾选，可连续选择多个用户（胶囊展示可单个移除），
//   一次提交批量授权（shareWorkspaceBatchAction：逐个校验 + 部分失败汇总提示）
// · 权限（只读/可操作）+ 有效期（0=永久）
// 管理员四级管控（全局/用户组/用户/沙箱）禁止时展示阻断原因并禁用新共享（名单仍可查看/移除）。

import * as React from "react"
import { toast } from "sonner"
import { Loader2, Share2, Check, X, UserX } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { cn } from "@/lib/utils"
import {
  shareWorkspaceBatchAction, searchShareTargetUsersAction,
  listWorkspaceShareRecipientsAction, revokeShareAction,
} from "@/server/actions/workspaces"

export interface WorkspaceShareDialogProps {
  workspace: { id: string; name: string }
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
  /** 四级管控阻断原因（非空时弹窗内展示；服务端仍强制校验，前端提示仅为体验） */
  blockedReason?: string
}

interface SuggestUser {
  id: string
  username: string
  displayName: string | null
  shared: boolean
}

interface RecipientRow {
  id: string
  targetUsername: string
  targetDisplayName: string | null
  permission: string
  expireAt: string | null
  revokedAt: string | null
  status: "active" | "revoked" | "expired"
  createdAt: string
}

// 客户端时间格式化（与平台 fmtDate 同格式：YYYY-MM-DD HH:mm:ss）
function fmtDT(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function WorkspaceShareDialog({ workspace, open, onOpenChange, onDone, blockedReason }: WorkspaceShareDialogProps) {
  // ---- 多选共享表单 ----
  const [username, setUsername] = React.useState("")
  const [permission, setPermission] = React.useState("VIEW")
  const [hours, setHours] = React.useState(24)
  const [busy, setBusy] = React.useState(false)
  const [suggests, setSuggests] = React.useState<SuggestUser[]>([])
  const [suggestBusy, setSuggestBusy] = React.useState(false)
  const [selected, setSelected] = React.useState<SuggestUser[]>([])
  const [batchFailures, setBatchFailures] = React.useState<{ username: string; reason: string }[] | null>(null)

  // ---- 接收者名单 ----
  const [recipients, setRecipients] = React.useState<RecipientRow[] | null>(null)
  const [recipientsBusy, setRecipientsBusy] = React.useState(false)
  const [revoking, setRevoking] = React.useState<string | null>(null) // 正在移除的 shareId
  const [removeTarget, setRemoveTarget] = React.useState<RecipientRow | null>(null)

  const loadRecipients = React.useCallback(async () => {
    setRecipientsBusy(true)
    try {
      const res = await listWorkspaceShareRecipientsAction({ workspaceId: workspace.id })
      setRecipients(res.code === 0 ? res.data?.items || [] : [])
    } catch {
      setRecipients([])
    } finally {
      setRecipientsBusy(false)
    }
  }, [workspace.id])

  React.useEffect(() => {
    if (!open) return
    void loadRecipients()
  }, [open, loadRecipients])

  // 用户搜索建议（输入 ≥1 字符触发；服务端精确用户名优先 + 昵称/用户名包含）
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
    if (open) {
      setUsername(""); setSuggests([]); setSelected([]); setPermission("VIEW"); setHours(24); setBatchFailures(null)
      setRecipients(null)
    }
  }, [open, workspace.id])

  const toggleSelected = (u: SuggestUser) => {
    setSelected((prev) => (prev.some((s) => s.id === u.id) ? prev.filter((s) => s.id !== u.id) : [...prev, u]))
  }

  const submit = async () => {
    if (selected.length === 0) return
    setBusy(true)
    try {
      const res = await shareWorkspaceBatchAction({
        workspaceId: workspace.id,
        targetUsernames: selected.map((s) => s.username),
        permission,
        expireHours: hours,
      })
      if (res.code === 0 && res.data) {
        const { success, failures } = res.data
        if (failures.length === 0) {
          toast.success(`已共享给 ${success} 个用户`)
          onOpenChange(false)
        } else {
          setBatchFailures(failures)
          toast.warning(`批量共享完成：成功 ${success} 个，失败 ${failures.length} 个（见弹窗内明细）`)
        }
        // 部分失败时保留弹窗与已选项，便于修正后重试；全部成功则关闭
        if (failures.length === 0) { setSelected([]); setUsername(""); setSuggests([]) }
        await loadRecipients()
        onDone()
      } else {
        toast.error(res.msg)
      }
    } finally { setBusy(false) }
  }

  const doRemove = async () => {
    if (!removeTarget) return
    setRevoking(removeTarget.id)
    try {
      const res = await revokeShareAction({ shareId: removeTarget.id })
      if (res.code === 0) {
        toast.success(`已移除接收者「${removeTarget.targetUsername}」（其他接收者不受影响）`)
        await loadRecipients()
        onDone()
      } else toast.error(res.msg)
    } finally {
      setRevoking(null)
      setRemoveTarget(null)
    }
  }

  const activeRecipients = (recipients || []).filter((r) => r.status === "active").length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Share2 className="h-4 w-4" /> 共享工作区「{workspace.name}」
          </DialogTitle>
        </DialogHeader>
        {blockedReason && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {blockedReason}（新增共享将被服务端拦截；下方既有接收者仍可查看与移除）
          </div>
        )}

        <div className="space-y-3">
          {/* ---- 接收者名单（共享给了谁 / 单个移除） ---- */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>接收者名单{recipients ? `（生效中 ${activeRecipients} / 共 ${recipients.length}）` : ""}</Label>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={recipientsBusy} onClick={() => void loadRecipients()}>
                {recipientsBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "刷新"}
              </Button>
            </div>
            {recipientsBusy && !recipients ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 border border-dashed rounded-md justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载接收者…
              </div>
            ) : !recipients || recipients.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground border border-dashed rounded-md">尚未共享给任何用户</p>
            ) : (
              <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
                {recipients.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium font-mono text-[13px]">{r.targetUsername}</span>
                        <Badge variant={r.permission === "OPERATE" ? "default" : "outline"} className={cn("text-[9px]", r.permission === "OPERATE" && "bg-teal-600 hover:bg-teal-600")}>
                          {r.permission === "OPERATE" ? "可操作" : "只读"}
                        </Badge>
                        {r.status === "active" ? (
                          <Badge variant="secondary" className="text-[9px] text-teal-600">生效中</Badge>
                        ) : r.status === "revoked" ? (
                          <Badge variant="secondary" className="text-[9px] text-red-600">已移除</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[9px] text-amber-600">已过期</Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {r.targetDisplayName ? `${r.targetDisplayName} · ` : ""}创建 {fmtDT(r.createdAt)?.slice(0, 16)}
                        {r.expireAt ? ` · 过期 ${fmtDT(r.expireAt)?.slice(0, 16)}` : " · 永久有效"}
                      </p>
                    </div>
                    {r.status !== "revoked" ? (
                      <Button
                        variant="ghost" size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive shrink-0"
                        disabled={revoking === r.id}
                        onClick={() => setRemoveTarget(r)}
                        title={`移除「${r.targetUsername}」对该工作区的访问权（不影响其他接收者）`}
                      >
                        {revoking === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />} 移除
                      </Button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground shrink-0">—</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---- 添加共享（多选用户） ---- */}
          <div className="space-y-1.5 pt-1 border-t">
            <Label>添加共享（可多选：搜索后点击勾选用户）</Label>
            <div className="relative">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入用户名或昵称搜索" autoComplete="off" disabled={!!blockedReason} />
              {suggestBusy && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 max-h-24 overflow-y-auto">
                {selected.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs">
                    <span className="font-mono">{s.username}</span>
                    {s.shared && <Badge className="bg-amber-600 hover:bg-amber-600 text-[9px] px-1 h-4">已共享</Badge>}
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
                      onClick={() => toggleSelected(s)}
                      aria-label={`移除已选用户 ${s.username}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <span className="text-[11px] text-muted-foreground self-center ml-1">已选 {selected.length} 人</span>
              </div>
            )}
            {/* 搜索建议：勾选多选 + 已共享标记 */}
            {suggests.length > 0 && (
              <div className="rounded-md border divide-y max-h-44 overflow-y-auto">
                {suggests.map((s) => {
                  const checked = selected.some((x) => x.id === s.id)
                  return (
                    <label
                      key={s.id}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/70 transition",
                        checked && "bg-teal-50/70 dark:bg-teal-950/30",
                      )}
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleSelected(s)} aria-label={`选择用户 ${s.username}`} />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium font-mono text-[13px]">{s.username}</span>
                        {s.displayName && <span className="ml-1.5 text-xs text-muted-foreground truncate">{s.displayName}</span>}
                      </span>
                      {checked && <Check className="h-3.5 w-3.5 text-teal-600 shrink-0" />}
                      {s.shared && <Badge variant="secondary" className="text-[10px] shrink-0">已共享</Badge>}
                    </label>
                  )
                })}
              </div>
            )}
            {username.trim() && !suggestBusy && suggests.length === 0 && (
              <p className="text-xs text-red-600">未找到匹配用户（可尝试输入完整用户名或昵称关键字）</p>
            )}
            {selected.some((s) => s.shared) && (
              <p className="text-xs text-amber-600">已标记「已共享」的用户：提交将更新其权限与有效期</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>权限（对本次全部所选用户生效）</Label>
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
            <PrecisionInput value={hours} onChange={setHours} min={0} max={8760} suffix="h" disabled={!!blockedReason} />
          </div>
          {batchFailures && batchFailures.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-3 py-2 space-y-1">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">部分用户共享失败（{batchFailures.length} 个）：</p>
              <div className="max-h-24 overflow-y-auto text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
                {batchFailures.map((f) => (
                  <p key={f.username} className="truncate"><span className="font-mono">{f.username}</span>：{f.reason}</p>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy || selected.length === 0 || !!blockedReason}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 确认共享{selected.length > 0 ? `（${selected.length} 人）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* 移除单个接收者确认（仅影响该接收者） */}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(v) => { if (!v) setRemoveTarget(null) }}
        title="移除接收者"
        description={`确定移除「${removeTarget?.targetUsername || ""}」对工作区「${workspace.name}」的共享？\n· 该接收者立即失去访问权，其他接收者不受影响\n· 审计记录保留，可重新共享恢复`}
        destructive
        confirmText="确认移除"
        onConfirm={doRemove}
      />
    </Dialog>
  )
}
