"use client"

// 用户创建/编辑表单弹窗：角色 / 邮箱 / 显示名 / 所属组多选 / 0.001精度配额 / 启用冻结

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { PrecisionInput } from "@/components/shared/confirm"
import { createUserAction, updateUserAction } from "@/server/actions/users"
import type { AdminUserRow } from "./users-table"

export interface GroupOption {
  id: string
  name: string
}

interface UserFormDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: "create" | "edit"
  user?: AdminUserRow | null
  groupOptions: GroupOption[]
}

const ROLE_OPTIONS = [
  { value: "USER", label: "普通用户" },
  { value: "GROUP_ADMIN", label: "组管理员" },
  { value: "ADMIN", label: "管理员" },
  { value: "SUPER_ADMIN", label: "超级管理员" },
]

export function UserFormDialog({ open, onOpenChange, mode, user, groupOptions }: UserFormDialogProps) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const [username, setUsername] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [role, setRole] = React.useState("USER")
  const [enabled, setEnabled] = React.useState(true)
  const [frozen, setFrozen] = React.useState(false)
  const [groupIds, setGroupIds] = React.useState<string[]>([])
  const [groupSearch, setGroupSearch] = React.useState("")

  const [quotaEnabled, setQuotaEnabled] = React.useState(false)
  const [qSessions, setQSessions] = React.useState(10)
  const [qNovnc, setQNovnc] = React.useState(4)
  const [qDisk, setQDisk] = React.useState(2048)

  React.useEffect(() => {
    if (!open) return
    if (mode === "edit" && user) {
      setUsername(user.username)
      setEmail(user.email || "")
      setDisplayName(user.displayName || "")
      setPassword("")
      setRole(user.role)
      setEnabled(user.enabled)
      setFrozen(user.frozen)
      const quota = user.quota
      if (quota && (quota.sessions !== null || quota.novncSessions !== null || quota.diskMb !== null)) {
        setQuotaEnabled(true)
        setQSessions(quota.sessions ?? 10)
        setQNovnc(quota.novncSessions ?? 4)
        setQDisk(quota.diskMb ?? 2048)
      } else {
        setQuotaEnabled(false)
      }
      setGroupSearch("")
      // 编辑模式初始组：由父组件传入的 user.groups 名称无法还原ID，组选择交由用户操作
      setGroupIds([])
    } else {
      setUsername("")
      setEmail("")
      setDisplayName("")
      setPassword("")
      setRole("USER")
      setEnabled(true)
      setFrozen(false)
      setGroupIds([])
      setQuotaEnabled(false)
      setQSessions(10)
      setQNovnc(4)
      setQDisk(2048)
      setGroupSearch("")
    }
  }, [open, mode, user])

  const filteredGroups = React.useMemo(() => {
    if (!groupSearch.trim()) return groupOptions
    return groupOptions.filter((g) => g.name.toLowerCase().includes(groupSearch.trim().toLowerCase()))
  }, [groupOptions, groupSearch])

  const toggleGroup = (gid: string) => {
    setGroupIds((prev) => (prev.includes(gid) ? prev.filter((i) => i !== gid) : [...prev, gid]))
  }

  const submit = async () => {
    // 前端初校验
    if (mode === "create") {
      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim())) {
        toast.error("用户名需3-32位字母数字下划线点横线")
        return
      }
      if (!password || password.length < 6) {
        toast.error("请填写至少6位初始密码")
        return
      }
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      toast.error("邮箱格式不正确")
      return
    }

    setBusy(true)
    try {
      const quota = quotaEnabled
        ? {
            sessions: qSessions,
            novncSessions: qNovnc,
            diskMb: qDisk,
          }
        : undefined

      const res =
        mode === "create"
          ? await createUserAction({
              username: username.trim(),
              email: email.trim() || undefined,
              password,
              displayName: displayName.trim() || undefined,
              role,
              groupIds,
              quota,
            })
          : await updateUserAction({
              id: user!.id,
              email: email.trim(),
              displayName: displayName.trim(),
              role,
              enabled,
              frozen,
              groupIds: groupIds.length > 0 ? groupIds : undefined,
              quota,
              password: password || undefined,
            })

      if (res.code === 0) {
        toast.success(mode === "create" ? "用户创建成功" : "用户已更新")
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新建用户" : `编辑用户 · ${user?.username || ""}`}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "创建平台账号并分配角色、所属组与个人配额"
              : "修改角色 / 邮箱 / 显示名 / 配额 / 启用状态；留空密码则不修改"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {mode === "create" && (
            <div className="space-y-1.5">
              <Label>用户名 *</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="字母数字下划线点横线" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>邮箱</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>显示名</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="昵称（可选）" />
          </div>
          <div className="space-y-1.5">
            <Label>{mode === "create" ? "初始密码 *" : "重设密码（留空不修改）"}</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "create" ? "符合密码策略" : "留空 = 不修改"} />
          </div>
          <div className="space-y-1.5">
            <Label>角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mode === "edit" && (
            <div className="space-y-3 sm:col-span-1 flex flex-col justify-end gap-3 pb-1">
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">启用账号</span>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">永久冻结</span>
                <Switch checked={frozen} onCheckedChange={setFrozen} />
              </div>
            </div>
          )}
        </div>

        {/* 所属组多选 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>所属用户组{mode === "edit" && <span className="ml-1 text-xs text-muted-foreground">（不勾选 = 不变更现有组）</span>}</Label>
            {groupIds.length > 0 && <Badge variant="secondary">已选 {groupIds.length}</Badge>}
          </div>
          <Input value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} placeholder="搜索组名..." className="max-w-56" />
          <ScrollArea className="h-36 rounded-md border p-2">
            {mode === "edit" && user && user.groups.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                <span className="text-xs text-muted-foreground leading-5">当前：</span>
                {user.groups.map((g) => (
                  <Badge key={g} variant="outline" className="text-[10px]">{g}</Badge>
                ))}
              </div>
            )}
            <div className="space-y-1">
              {filteredGroups.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">无匹配用户组</p>}
              {filteredGroups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer">
                  <Checkbox checked={groupIds.includes(g.id)} onCheckedChange={() => toggleGroup(g.id)} />
                  <span className="truncate">{g.name}</span>
                </label>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* 个人配额 */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">自定义个人配额</p>
              <p className="text-xs text-muted-foreground">关闭时跟随全局与用户组配额</p>
            </div>
            <Switch checked={quotaEnabled} onCheckedChange={setQuotaEnabled} />
          </div>
          {quotaEnabled && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">并发会话配额</Label>
                <PrecisionInput value={qSessions} onChange={setQSessions} min={0} max={100000} suffix="个" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">NoVNC 会话配额</Label>
                <PrecisionInput value={qNovnc} onChange={setQNovnc} min={0} max={100000} suffix="个" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">磁盘配额</Label>
                <PrecisionInput value={qDisk} onChange={setQDisk} min={0} max={10000000} suffix="MB" />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {mode === "create" ? "创建用户" : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
