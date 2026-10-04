"use client"

// 用户组配套管理弹窗：组员 / 组管理员 / 代理绑定 / 权限锁 / 复制 / 导入JSON+CSV / 安全策略 / 批量移动父级

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Search, ShieldAlert, Trash2, UserPlus } from "lucide-react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfirmDialog } from "@/components/shared/confirm"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/components/shared/data-table"
import {
  setGroupUsersAction, setGroupAdminAction, setGroupProxyAction, updateGroupLocksAction,
  copyGroupAction, importGroupsJsonAction, importGroupsCsvAction,
  setGroupForce2faAction, getGroupSecurityPolicyAction, batchMoveGroupParentAction,
  type GroupImportReport,
} from "@/server/actions/groups"

export interface UserOption {
  id: string
  username: string
  displayName: string | null
  email: string | null
  enabled: boolean
}

export interface ProxyOption {
  id: string
  name: string
  status: string
}

export const LOCK_LABELS: Record<string, string> = {
  blockCreateWorkspace: "禁止创建工作区",
  blockModifyWorkspace: "禁止修改工作区",
  blockModifyResourceExpiry: "禁止修改资源有效期",
  blockCreateApiToken: "禁止创建 API 令牌",
  blockEditTokenExpiry: "禁止编辑令牌有效期",
  blockDeleteResource: "禁止删除资源",
  blockRestoreRecycle: "禁止恢复回收站",
  blockBatchOps: "禁止批量操作",
  blockExportData: "禁止导出数据",
  blockImportTemplate: "禁止导入模板",
  blockModifyProxyNetwork: "禁止修改代理网络",
  blockSwitchVncMode: "禁止切换 VNC 模式",
  blockModifyOwnQuota: "禁止修改个人配额",
  blockViewOthersResourceList: "禁止查看他人资源列表",
  blockViewUsageStats: "禁止查看使用统计",
  blockEditProfile: "禁止编辑个人资料",
  blockUploadScript: "禁止上传脚本",
  blockCustomVncResolution: "禁止自定义 VNC 分辨率",
  blockCustomNetworkThrottle: "禁止自定义网络限速",
  blockRefreshToken: "禁止刷新令牌",
  blockRefreshVncKey: "禁止刷新 VNC 密钥",
  blockExportLogs: "禁止导出日志",
  blockShareWorkspace: "禁止分享工作区",
  blockCopyOthersTemplate: "禁止复制他人模板",
  blockViewPublicIp: "禁止查看公网 IP",
  blockSwitchProxyNode: "禁止切换代理节点",
  blockViewContainerDetail: "禁止查看容器详情",
  blockRestartInstance: "禁止重启实例",
  blockCleanOwnRecycle: "禁止清理个人回收站",
}

// ============ 组员管理弹窗 ============

// 23-a：批量操作增强 ——
// · 左列「当前成员」：实时搜索（用户名包含）+ 行 Checkbox 多选 + 底部「已选 N」+「批量移除」（ConfirmDialog 确认）
// · 右列「添加用户」：候选行 Checkbox 多选（可跨搜索连续勾选累积）+「添加所选（N）」批量添加，成功后清空已选
// · 单个添加/移除按钮保留；后端 setGroupUsersAction 原生支持 userIds 数组批量
export function MembersDialog({
  open, onOpenChange, group, members, userOptions,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string } | null
  members: { userId: string; username: string }[]
  userOptions: UserOption[]
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [memberSearch, setMemberSearch] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  // ---- 23-a：批量多选状态 ----
  const [selectedMemberIds, setSelectedMemberIds] = React.useState<string[]>([])
  const [selectedCandidateIds, setSelectedCandidateIds] = React.useState<string[]>([])
  const [batchRemoveConfirm, setBatchRemoveConfirm] = React.useState(false)

  const memberIds = React.useMemo(() => new Set(members.map((m) => m.userId)), [members])
  const candidates = React.useMemo(() => {
    const kw = search.trim().toLowerCase()
    const pool = userOptions.filter((u) => !memberIds.has(u.id))
    if (!kw) return pool.slice(0, 30)
    return pool
      .filter((u) => u.username.toLowerCase().includes(kw) || (u.displayName || "").toLowerCase().includes(kw) || (u.email || "").toLowerCase().includes(kw))
      .slice(0, 30)
  }, [userOptions, memberIds, search])

  // 左列：成员实时过滤（用户名包含匹配）
  const filteredMembers = React.useMemo(() => {
    const kw = memberSearch.trim().toLowerCase()
    if (!kw) return members
    return members.filter((m) => m.username.toLowerCase().includes(kw))
  }, [members, memberSearch])

  // 数据刷新后剔除失效勾选：已移出的成员 / 已加入组的候选（批量添加后自动清空）
  React.useEffect(() => {
    setSelectedMemberIds((prev) => prev.filter((id) => memberIds.has(id)))
    setSelectedCandidateIds((prev) => prev.filter((id) => !memberIds.has(id)))
  }, [memberIds])

  // 弹窗打开时重置本地状态（按 group.id 依赖：父组件每次渲染会新建 group 对象，避免误重置）
  React.useEffect(() => {
    if (open) {
      setSearch(""); setMemberSearch("")
      setSelectedMemberIds([]); setSelectedCandidateIds([])
      setBatchRemoveConfirm(false)
    }
  }, [open, group?.id])

  const act = async (fn: () => Promise<{ code: number; msg: string }>): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
        return true
      } else {
        toast.error(res.msg)
        return false
      }
    } finally {
      setBusy(false)
    }
  }

  const toggleMember = (id: string) => {
    setSelectedMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const toggleCandidate = (id: string) => {
    setSelectedCandidateIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const doBatchRemove = async () => {
    if (!group || selectedMemberIds.length === 0) return
    const ok = await act(() => setGroupUsersAction({ groupId: group.id, userIds: selectedMemberIds, op: "remove" }))
    if (ok) setSelectedMemberIds([])
  }

  const doBatchAdd = async () => {
    if (!group || selectedCandidateIds.length === 0) return
    const ok = await act(() => setGroupUsersAction({ groupId: group.id, userIds: selectedCandidateIds, op: "add" }))
    if (ok) setSelectedCandidateIds([])
  }

  const selectedMemberNames = members.filter((m) => selectedMemberIds.includes(m.userId)).map((m) => m.username)
  const selectedMemberNameText =
    selectedMemberNames.length > 20
      ? `${selectedMemberNames.slice(0, 20).join("、")} 等 ${selectedMemberNames.length} 名`
      : selectedMemberNames.join("、")

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>组员管理 · {group?.name}</DialogTitle>
          <DialogDescription>
            当前 {members.length} 名成员（展示前500）；支持搜索后单个或勾选批量添加/移出
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          {/* ---- 左列：当前成员（搜索 + 多选 + 批量移除） ---- */}
          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">当前成员</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="搜索成员用户名..."
                className="pl-8"
                aria-label="搜索当前成员（用户名包含匹配）"
              />
            </div>
            <ScrollArea className="h-64 rounded-md border">
              <div className="p-2 space-y-1">
                {members.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">暂无成员</p>}
                {members.length > 0 && filteredMembers.length === 0 && (
                  <p className="text-xs text-muted-foreground py-6 text-center">无匹配成员（调整搜索词）</p>
                )}
                {filteredMembers.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <div className="flex items-center gap-2 min-w-0">
                      <Checkbox
                        checked={selectedMemberIds.includes(m.userId)}
                        onCheckedChange={() => toggleMember(m.userId)}
                        disabled={busy}
                        aria-label={`选择成员 ${m.username}`}
                        className="shrink-0"
                      />
                      <span className="text-sm truncate">{m.username}</span>
                    </div>
                    <Button
                      size="sm" variant="ghost" disabled={busy}
                      onClick={() => act(() => setGroupUsersAction({ groupId: group!.id, userIds: [m.userId], op: "remove" }))}
                      aria-label={`移除成员 ${m.username}`}
                      title={`将 ${m.username} 移出本组`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                已选 {selectedMemberIds.length} 人{memberSearch.trim() ? ` · 匹配 ${filteredMembers.length}/${members.length}` : ""}
              </span>
              <Button
                size="sm" variant="destructive"
                disabled={busy || selectedMemberIds.length === 0}
                onClick={() => setBatchRemoveConfirm(true)}
                title="将勾选的成员批量移出本组"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                批量移除{selectedMemberIds.length > 0 ? `（${selectedMemberIds.length}）` : ""}
              </Button>
            </div>
          </div>

          {/* ---- 右列：添加用户（候选多选可跨搜索累积 + 批量添加） ---- */}
          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><UserPlus className="h-4 w-4" /> 添加用户</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索用户名/邮箱..." className="pl-8" />
            </div>
            <ScrollArea className="h-56 rounded-md border">
              <div className="p-2 space-y-1">
                {candidates.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">无匹配用户</p>}
                {candidates.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <div className="flex items-center gap-2 min-w-0">
                      <Checkbox
                        checked={selectedCandidateIds.includes(u.id)}
                        onCheckedChange={() => toggleCandidate(u.id)}
                        disabled={busy}
                        aria-label={`选择用户 ${u.username}`}
                        className="shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-sm truncate">
                          {u.username}
                          {!u.enabled && <Badge variant="outline" className="ml-1 text-[10px]">禁用</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{u.email || u.displayName || "-"}</p>
                      </div>
                    </div>
                    <Button
                      size="sm" variant="outline" disabled={busy}
                      onClick={() => act(() => setGroupUsersAction({ groupId: group!.id, userIds: [u.id], op: "add" }))}
                    >
                      添加
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">已选 {selectedCandidateIds.length} 人（可连续搜索勾选累积）</span>
              <Button
                size="sm"
                className="bg-teal-600 hover:bg-teal-700"
                disabled={busy || selectedCandidateIds.length === 0}
                onClick={() => void doBatchAdd()}
                title="将勾选的用户批量加入本组"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                添加所选{selectedCandidateIds.length > 0 ? `（${selectedCandidateIds.length}）` : ""}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>

      {/* 23-a：批量移除确认（仅移出所选成员，组内其他成员不受影响） */}
      <ConfirmDialog
        open={batchRemoveConfirm}
        onOpenChange={(v) => { if (!busy) setBatchRemoveConfirm(v) }}
        title="批量移除组成员"
        description={
          selectedMemberNames.length > 0
            ? `确定将以下 ${selectedMemberNames.length} 名成员移出用户组「${group?.name || ""}」？\n· ${selectedMemberNameText}\n· 仅移出所选成员，组内其他成员不受影响`
            : ""
        }
        destructive
        confirmText={`确认移出${selectedMemberNames.length > 0 ? `（${selectedMemberNames.length}）` : ""}`}
        loading={busy}
        onConfirm={doBatchRemove}
      />
    </Dialog>
  )
}

// ============ 组管理员管理弹窗 ============

export function AdminsDialog({
  open, onOpenChange, group, admins, userOptions,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string } | null
  admins: { userId: string; username: string; canModifyQuota: boolean }[]
  userOptions: UserOption[]
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const adminIds = React.useMemo(() => new Set(admins.map((a) => a.userId)), [admins])
  const candidates = React.useMemo(() => {
    const kw = search.trim().toLowerCase()
    const pool = userOptions.filter((u) => !adminIds.has(u.id))
    if (!kw) return pool.slice(0, 30)
    return pool.filter((u) => u.username.toLowerCase().includes(kw) || (u.email || "").toLowerCase().includes(kw)).slice(0, 30)
  }, [userOptions, adminIds, search])

  const act = async (fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>组管理员 · {group?.name}</DialogTitle>
          <DialogDescription>组管理员可管理本组资源；canModifyQuota 决定是否可调整组配额</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">现任组管理员</p>
            <ScrollArea className="h-64 rounded-md border">
              <div className="p-2 space-y-1">
                {admins.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">暂无组管理员</p>}
                {admins.map((a) => (
                  <div key={a.userId} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <span className="text-sm truncate">{a.username}</span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        配额权
                        <Switch
                          checked={a.canModifyQuota}
                          disabled={busy}
                          onCheckedChange={(v) => act(() => setGroupAdminAction({ groupId: group!.id, userId: a.userId, op: "bind", canModifyQuota: v }))}
                        />
                      </label>
                      <Button
                        size="sm" variant="ghost" disabled={busy}
                        onClick={() => act(() => setGroupAdminAction({ groupId: group!.id, userId: a.userId, op: "unbind", canModifyQuota: true }))}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-2"><UserPlus className="h-4 w-4" /> 绑定新管理员</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索用户..." className="pl-8" />
            </div>
            <ScrollArea className="h-56 rounded-md border">
              <div className="p-2 space-y-1">
                {candidates.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">无匹配用户</p>}
                {candidates.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <div className="min-w-0">
                      <p className="text-sm truncate">{u.username}</p>
                      <p className="text-xs text-muted-foreground truncate">{u.email || "-"}</p>
                    </div>
                    <Button
                      size="sm" variant="outline" disabled={busy}
                      onClick={() => act(() => setGroupAdminAction({ groupId: group!.id, userId: u.id, op: "bind", canModifyQuota: true }))}
                    >
                      绑定
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============ 组代理绑定弹窗 ============

export function ProxiesDialog({
  open, onOpenChange, group, proxies, proxyOptions,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string } | null
  proxies: { id: string; name: string; status: string }[]
  proxyOptions: ProxyOption[]
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const boundIds = React.useMemo(() => new Set(proxies.map((p) => p.id)), [proxies])

  const act = async (fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>代理节点绑定 · {group?.name}</DialogTitle>
          <DialogDescription>组内成员的浏览器工作区将调度到绑定的代理节点</DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>代理节点</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proxyOptions.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground py-6">暂无可用代理节点</TableCell>
              </TableRow>
            )}
            {proxyOptions.map((p) => {
              const bound = boundIds.has(p.id)
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell><StatusBadge status={p.status} /></TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={bound ? "destructive" : "outline"}
                      disabled={busy}
                      onClick={() =>
                        act(() => setGroupProxyAction({ groupId: group!.id, proxyNodeIds: [p.id], op: bound ? "unbind" : "bind" }))
                      }
                    >
                      {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                      {bound ? "解绑" : "绑定"}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  )
}

// ============ 权限锁弹窗 ============

export function LocksDialog({
  open, onOpenChange, group, lockKeys, currentLocks,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string } | null
  lockKeys: string[]
  currentLocks: Record<string, boolean>
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [locks, setLocks] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    if (open) setLocks({ ...currentLocks })
  }, [open, currentLocks])

  const save = async () => {
    if (!group) return
    setBusy(true)
    try {
      const res = await updateGroupLocksAction({ groupId: group.id, locks })
      if (res.code === 0) {
        toast.success("权限锁已更新")
        onOpenChange(false)
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  const enabledCount = Object.values(locks).filter(Boolean).length

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>组级权限锁 · {group?.name}</DialogTitle>
          <DialogDescription>
            全集 {lockKeys.length} 项细粒度开关（锁死优先：全局 &gt; 组 &gt; 用户）；当前已启用 {enabledCount} 项
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-96 pr-2">
          <div className="space-y-1">
            {lockKeys.map((k) => (
              <div key={k} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm">{LOCK_LABELS[k] || k}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">{k}</p>
                </div>
                <Switch
                  checked={locks[k] === true}
                  onCheckedChange={(v) => setLocks((prev) => ({ ...prev, [k]: v }))}
                />
              </div>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={save} disabled={busy} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            保存权限锁
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============ 组复制弹窗 ============

export function CopyGroupDialog({
  open, onOpenChange, group,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string } | null
}) {
  const router = useRouter()
  const [newName, setNewName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open && group) setNewName(`${group.name}-副本`)
  }, [open, group])

  const submit = async () => {
    if (!group) return
    if (newName.trim().length < 2) {
      toast.error("新组名至少2位")
      return
    }
    setBusy(true)
    try {
      const res = await copyGroupAction({ id: group.id, newName: newName.trim() })
      if (res.code === 0) {
        toast.success("组复制成功（配额/组员/代理绑定已同步）")
        onOpenChange(false)
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>复制用户组</DialogTitle>
          <DialogDescription>将 {group?.name} 的配额 / 组员 / 代理绑定复制到新组</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>新组名</Label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="输入新组名称" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={submit} disabled={busy} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            创建副本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============ 导入组弹窗（r28b：JSON / CSV 双模式，对齐用户管理 CSV 导入） ============

export function ImportGroupsDialog({
  open, onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [mode, setMode] = React.useState<"json" | "csv">("json")
  const [text, setText] = React.useState("")
  const [report, setReport] = React.useState<GroupImportReport | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setMode("json")
      setText("")
      setReport(null)
    }
  }, [open])

  const submit = async () => {
    if (!text.trim()) {
      toast.error(mode === "json" ? "请粘贴JSON或选择文件" : "请粘贴CSV内容或选择文件")
      return
    }
    setBusy(true)
    try {
      const res = mode === "json"
        ? await importGroupsJsonAction({ text })
        : await importGroupsCsvAction({ text })
      if (res.code === 0 && res.data) {
        setReport(res.data)
        toast.success(`导入完成：成功 ${res.data.success} / 失败 ${res.data.failed}`)
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入用户组（JSON / CSV）</DialogTitle>
          <DialogDescription>
            {mode === "json"
              ? "JSON 完整配置：配额 / 组员 / 代理绑定 / 权限锁（可回灌导出文件）"
              : "CSV 批量建组：父组可引用库中已有组或本批次前部先声明的组（天然防循环引用）"}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as "json" | "csv")} className="flex gap-4">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="json" id="imp-json" />
            <Label htmlFor="imp-json">JSON（完整配置）</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="csv" id="imp-csv" />
            <Label htmlFor="imp-csv">CSV（批量建组）</Label>
          </div>
        </RadioGroup>
        <div className="space-y-2">
          <input
            type="file"
            accept={mode === "json" ? ".json,application/json" : ".csv,text/csv"}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-teal-600 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-teal-700"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const reader = new FileReader()
              reader.onload = () => setText(String(reader.result || ""))
              reader.readAsText(f)
            }}
          />
          <textarea
            className="flex min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
            placeholder={mode === "json"
              ? '[\n  {\n    "name": "华东运营组",\n    "parentName": "默认用户组",\n    "quota": { "sessions": 30, "novncSessions": 10, "diskMb": 8192 },\n    "force2fa": false,\n    "tags": ["运营"]\n  }\n]'
              : "组名,父组名,描述\n华东运营组,默认用户组,华东区域运营团队\n华北运营组,默认用户组,华北区域运营团队\n独立项目组,,不挂父组（根节点）"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {mode === "csv" && (
            <p className="text-[11px] text-muted-foreground">
              表头必含「组名」列（支持 组名,父组名,描述 或 name,parentName,description）；「父组名」「描述」可选
            </p>
          )}
        </div>
        {report && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>
              共 {report.total} 组 · 成功 {report.success} · 失败{" "}
              <span className={report.failed > 0 ? "text-red-600 font-medium" : ""}>{report.failed}</span>
            </p>
            {report.errors.length > 0 && (
              <div className="space-y-1 text-xs max-h-32 overflow-y-auto">
                {report.errors.map((e, i) => (
                  <p key={i} className="text-red-600">第 {e.line} 项：{e.message}</p>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>
          <Button onClick={submit} disabled={busy} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            开始导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============ r28b：组级安全策略弹窗（2FA 强制状态与生效人数；行内开关乐观更新失败回滚） ============

export function GroupSecurityDialog({
  open, onOpenChange, group,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  group: { id: string; name: string; force2fa: boolean; userCount: number; twoFactorReady: number } | null
}) {
  const router = useRouter()
  const [detail, setDetail] = React.useState<{
    force2fa: boolean
    memberCount: number
    twoFactorReady: number
    globalForce2fa: boolean
    groupInherit: boolean
  } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [toggling, setToggling] = React.useState(false)

  React.useEffect(() => {
    if (!open || !group) {
      setDetail(null)
      return
    }
    setLoading(true)
    getGroupSecurityPolicyAction({ id: group.id })
      .then((res) => {
        if (res.code === 0 && res.data) {
          setDetail({
            force2fa: res.data.force2fa,
            memberCount: res.data.memberCount,
            twoFactorReady: res.data.twoFactorReady,
            globalForce2fa: res.data.globalForce2fa,
            groupInherit: res.data.groupInherit,
          })
        } else {
          toast.error(res.msg || "安全策略加载失败")
        }
      })
      .catch(() => toast.error("安全策略加载失败"))
      .finally(() => setLoading(false))
  }, [open, group])

  // 行内开关：乐观更新（本地先翻转）→ 失败回滚
  const toggle2fa = async (next: boolean) => {
    if (!group || !detail || toggling) return
    const prev = detail
    setDetail({ ...detail, force2fa: next })
    setToggling(true)
    try {
      const res = await setGroupForce2faAction({ id: group.id, force2fa: next })
      if (res.code === 0 && res.data) {
        setDetail((d) => (d ? { ...d, force2fa: res.data!.force2fa, memberCount: res.data!.affectedMembers, twoFactorReady: res.data!.twoFactorReady } : d))
        toast.success(next ? `已开启组级强制 2FA：${res.data.affectedMembers - res.data.twoFactorReady} 名未开通成员登录时将被要求设置` : "已关闭组级强制 2FA")
        router.refresh()
      } else {
        setDetail(prev)
        toast.error(res.msg)
      }
    } catch (e) {
      setDetail(prev)
      toast.error(e instanceof Error ? e.message : "设置失败")
    } finally {
      setToggling(false)
    }
  }

  const memberCount = detail?.memberCount ?? group?.userCount ?? 0
  const ready = detail?.twoFactorReady ?? group?.twoFactorReady ?? 0
  const affected = Math.max(0, memberCount - ready)

  return (
    <Dialog open={open} onOpenChange={(v) => !toggling && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" /> 安全策略 · {group?.name || ""}
          </DialogTitle>
          <DialogDescription>组级 2FA 强制管控与生效面（登录链路实时判定）</DialogDescription>
        </DialogHeader>

        {loading && !detail && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        )}

        {detail && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0 pr-2">
                <p className="text-sm font-medium">组级强制 2FA</p>
                <p className="text-[11px] text-muted-foreground">
                  开启后：组内未开通 2FA 的成员登录时被强制进入 2FA 设置流程
                </p>
              </div>
              <Switch checked={detail.force2fa} disabled={toggling} onCheckedChange={toggle2fa} aria-label="组级强制2FA开关" />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2.5">
                <p className="text-lg font-semibold">{memberCount}</p>
                <p className="text-[11px] text-muted-foreground">组内成员</p>
              </div>
              <div className="rounded-md border p-2.5">
                <p className="text-lg font-semibold text-emerald-600">{ready}</p>
                <p className="text-[11px] text-muted-foreground">已开通 2FA</p>
              </div>
              <div className="rounded-md border p-2.5">
                <p className="text-lg font-semibold text-amber-600">{affected}</p>
                <p className="text-[11px] text-muted-foreground">将受强制影响</p>
              </div>
            </div>

            <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-xs">
              <p className="font-medium text-foreground">判定优先级（登录时逐级检查）</p>
              <p>1 · 用户自身强制 2FA 开关（用户管理 2FA 管控）</p>
              <p>2 · 全局强制策略（当前：{detail.globalForce2fa ? "已开启" : "未开启"}）</p>
              <p>3 · 所在组强制 2FA（本开关 · 继承配置当前：{detail.groupInherit ? "生效" : "已停用"}）</p>
              <p className="text-muted-foreground">已开通 2FA 的成员不受任何一级强制影响；未开通者命中任一级即被强制设置。</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={toggling}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============ r28b：批量移动父级弹窗（对齐用户管理「批量迁移用户组」交互） ============

export function BatchMoveParentDialog({
  open, onOpenChange, ids, allNodes, onFailures,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  ids: string[]
  allNodes: { id: string; name: string; parentId: string | null }[]
  onFailures: (failed: { id: string; reason: string }[]) => void
}) {
  const router = useRouter()
  const [parentId, setParentId] = React.useState<string>("__none__")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) setParentId("__none__")
  }, [open])

  // 被移动组自身及相互之间的选择无意义（服务端逐组校验后代环；UI 端仅过滤被移动组本身）
  const movingIds = React.useMemo(() => new Set(ids), [ids])

  const submit = async () => {
    if (ids.length === 0) return
    setBusy(true)
    try {
      const res = await batchMoveGroupParentAction({ ids, parentId: parentId === "__none__" ? null : parentId })
      if (res.code === 0 && res.data) {
        const failed = res.data.failed ?? []
        if (failed.length > 0) {
          onFailures(failed)
          toast.warning(`批量移动完成：成功 ${res.data.affected} 个组，失败 ${failed.length} 个（查看原因）`)
        } else {
          toast.success(`已移动 ${res.data.affected} 个用户组到新父级`)
        }
        router.refresh()
        onOpenChange(false)
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量移动失败")
    } finally {
      setBusy(false)
    }
  }

  // 计算显示路径（如 总公司 / 华东 / 运维组）
  const byId = React.useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes])
  const pathOf = (id: string): string[] => {
    const path: string[] = []
    let cur = byId.get(id)
    const guard = new Set<string>()
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id)
      path.unshift(cur.name)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return path
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>批量移动父级</DialogTitle>
          <DialogDescription>
            将所选 {ids.length} 个用户组挂到新父组下（服务端逐组校验：父组不能是自己或自己的后代，禁止循环层级；不选 = 移为根节点）
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-52 rounded-md border p-2">
          <div className="space-y-0.5">
            <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer">
              <Checkbox checked={parentId === "__none__"} onCheckedChange={() => setParentId("__none__")} />
              <span className="text-muted-foreground">（无父组 · 根节点）</span>
            </label>
            {allNodes
              .filter((n) => !movingIds.has(n.id))
              .map((n) => (
                <label key={n.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer" title={pathOf(n.id).join(" / ")}>
                  <Checkbox checked={parentId === n.id} onCheckedChange={() => setParentId(n.id)} />
                  <span className="truncate">{pathOf(n.id).join(" / ")}</span>
                </label>
              ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={submit} disabled={busy || ids.length === 0} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            确认移动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
