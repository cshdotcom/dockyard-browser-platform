"use client"

// 用户组配套管理弹窗：组员 / 组管理员 / 代理绑定 / 权限锁 / 复制 / 导入JSON

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Search, Trash2, UserPlus } from "lucide-react"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/components/shared/data-table"
import {
  setGroupUsersAction, setGroupAdminAction, setGroupProxyAction, updateGroupLocksAction,
  copyGroupAction, importGroupsJsonAction, type GroupImportReport,
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
  const [busy, setBusy] = React.useState(false)

  const memberIds = React.useMemo(() => new Set(members.map((m) => m.userId)), [members])
  const candidates = React.useMemo(() => {
    const kw = search.trim().toLowerCase()
    const pool = userOptions.filter((u) => !memberIds.has(u.id))
    if (!kw) return pool.slice(0, 30)
    return pool
      .filter((u) => u.username.toLowerCase().includes(kw) || (u.displayName || "").toLowerCase().includes(kw) || (u.email || "").toLowerCase().includes(kw))
      .slice(0, 30)
  }, [userOptions, memberIds, search])

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
          <DialogTitle>组员管理 · {group?.name}</DialogTitle>
          <DialogDescription>当前 {members.length} 名成员（展示前500）；搜索用户加入或移出现有成员</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">当前成员</p>
            <ScrollArea className="h-64 rounded-md border">
              <div className="p-2 space-y-1">
                {members.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">暂无成员</p>}
                {members.map((m) => (
                  <div key={m.userId} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted">
                    <span className="text-sm truncate">{m.username}</span>
                    <Button
                      size="sm" variant="ghost" disabled={busy}
                      onClick={() => act(() => setGroupUsersAction({ groupId: group!.id, userIds: [m.userId], op: "remove" }))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

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
                    <div className="min-w-0">
                      <p className="text-sm truncate">
                        {u.username}
                        {!u.enabled && <Badge variant="outline" className="ml-1 text-[10px]">禁用</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{u.email || u.displayName || "-"}</p>
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
          </div>
        </div>
      </DialogContent>
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

// ============ 导入组JSON弹窗 ============

export function ImportGroupsDialog({
  open, onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [text, setText] = React.useState("")
  const [report, setReport] = React.useState<GroupImportReport | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setText("")
      setReport(null)
    }
  }, [open])

  const submit = async () => {
    if (!text.trim()) {
      toast.error("请粘贴JSON或选择文件")
      return
    }
    setBusy(true)
    try {
      const res = await importGroupsJsonAction({ text })
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
          <DialogTitle>导入用户组 JSON</DialogTitle>
          <DialogDescription>
            支持导出文件格式：{"[{ name, description, parentName, quota, reservedQuota, force2fa, tags, permissionLocks, userIds, proxyNodeIds }]"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <input
            type="file"
            accept=".json,application/json"
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
            placeholder={'[\n  {\n    "name": "华东运营组",\n    "parentName": "默认用户组",\n    "quota": { "sessions": 30, "novncSessions": 10, "diskMb": 8192 },\n    "force2fa": false,\n    "tags": ["运营"]\n  }\n]'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
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
