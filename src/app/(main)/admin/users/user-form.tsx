"use client"

// 用户创建/编辑表单弹窗：角色 / 邮箱 / 显示名 / 所属组多选 / 0.001精度配额 / 启用冻结
// r14（22-c）：沙箱闲置超时策略（继承组/无限/自定义分钟 + 锁定开关；编辑时拉取当前策略回显）

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
import { createUserAction, updateUserAction, getUserIdlePolicyAction, setUserIdleTimeoutAction, setUserStorageQuotaAction } from "@/server/actions/users"
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
  const [qBandwidth, setQBandwidth] = React.useState(0)

  // r14（22-c）：闲置超时策略（inherit=继承组 / unlimited=0 无限 / limit=自定义分钟 + 锁定开关）
  const [idleMode, setIdleMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [idleMinutes, setIdleMinutes] = React.useState(60)
  const [idleLocked, setIdleLocked] = React.useState(false)
  /** 编辑态拉取的当前策略（变化检测 + 生效提示） */
  const [idleInitial, setIdleInitial] = React.useState<{ minutes: number | null; locked: boolean } | null>(null)
  const [idleHint, setIdleHint] = React.useState<{ defaultMinutes: number; defaultSourceLabel: string; groupMinutes: number | null; globalDefault: number } | null>(null)
  const [idleLoading, setIdleLoading] = React.useState(false)

  // —— r33：存储配额（三态：inherit=继承 / unlimited=0 不限 / limit=MB）+ 分类开关（inherit/on/off）+ 分类子配额 ——
  const [stMode, setStMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [stMb, setStMb] = React.useState(2048)
  const [stRec, setStRec] = React.useState<"inherit" | "on" | "off">("inherit")
  const [stShot, setStShot] = React.useState<"inherit" | "on" | "off">("inherit")
  const [stUpload, setStUpload] = React.useState<"inherit" | "on" | "off">("inherit")
  const [stAdvanced, setStAdvanced] = React.useState(false)
  const [stRecMb, setStRecMb] = React.useState(0)
  const [stShotMb, setStShotMb] = React.useState(0)
  const [stFileMb, setStFileMb] = React.useState(0)
  const [stInitial, setStInitial] = React.useState<{
    quota: number | null
    policy: AdminUserRow["storagePolicy"]
  } | null>(null)

  // —— r33：沙箱最大时长（三态：inherit=继承 / unlimited=0 不限 / limit=分钟 + 允许无限开关三态）——
  const [ttlMode, setTtlMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [ttlMinutes, setTtlMinutes] = React.useState(120)
  const [ttlAllowUnlimited, setTtlAllowUnlimited] = React.useState<"inherit" | "yes" | "no">("inherit")
  const [ttlInitial, setTtlInitial] = React.useState<{ max: number | null; allow: boolean | null } | null>(null)

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
        setQBandwidth(quota.proxyBandwidthMb ?? 0)
      } else {
        setQuotaEnabled(false)
      }
      setGroupSearch("")
      // 编辑模式初始组：由父组件传入的 user.groups 名称无法还原ID，组选择交由用户操作
      setGroupIds([])
      // r14（22-c）：拉取当前闲置超时策略回显（users-table 行数据不含新字段，弹层自取）
      setIdleInitial(null)
      setIdleHint(null)
      setIdleMode("inherit")
      setIdleMinutes(60)
      setIdleLocked(false)
      setIdleLoading(true)
      // r33：存储/时长回显（行数据携带）
      const sp = user.storagePolicy || null
      setStMode(user.storageQuotaMb == null ? "inherit" : user.storageQuotaMb === 0 ? "unlimited" : "limit")
      setStMb(user.storageQuotaMb && user.storageQuotaMb > 0 ? user.storageQuotaMb : 2048)
      setStRec(sp?.recording == null ? "inherit" : sp.recording ? "on" : "off")
      setStShot(sp?.screenshot == null ? "inherit" : sp.screenshot ? "on" : "off")
      setStUpload(sp?.upload == null ? "inherit" : sp.upload ? "on" : "off")
      setStAdvanced(!!(sp?.recordingMb || sp?.screenshotMb || sp?.fileMb))
      setStRecMb(sp?.recordingMb || 0)
      setStShotMb(sp?.screenshotMb || 0)
      setStFileMb(sp?.fileMb || 0)
      setStInitial({ quota: user.storageQuotaMb, policy: sp })
      setTtlMode(user.maxTtlMinutes == null ? "inherit" : user.maxTtlMinutes === 0 ? "unlimited" : "limit")
      setTtlMinutes(user.maxTtlMinutes && user.maxTtlMinutes > 0 ? user.maxTtlMinutes : 120)
      setTtlAllowUnlimited(user.allowUnlimitedTtl == null ? "inherit" : user.allowUnlimitedTtl ? "yes" : "no")
      setTtlInitial({ max: user.maxTtlMinutes, allow: user.allowUnlimitedTtl })
      getUserIdlePolicyAction({ id: user.id })
        .then((res) => {
          if (res.code === 0 && res.data) {
            const d = res.data
            setIdleMode(d.minutes == null ? "inherit" : d.minutes === 0 ? "unlimited" : "limit")
            if (d.minutes != null && d.minutes > 0) setIdleMinutes(d.minutes)
            setIdleLocked(d.locked)
            setIdleInitial({ minutes: d.minutes, locked: d.locked })
            setIdleHint({
              defaultMinutes: d.effective.defaultMinutes,
              defaultSourceLabel: d.effective.defaultSourceLabel,
              groupMinutes: d.effective.groupMinutes,
              globalDefault: d.effective.globalDefault,
            })
          } else {
            toast.error(res.msg || "闲置超时策略加载失败")
          }
        })
        .catch(() => toast.error("闲置超时策略加载失败"))
        .finally(() => setIdleLoading(false))
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
      setIdleMode("inherit")
      setIdleMinutes(60)
      setIdleLocked(false)
      setIdleInitial(null)
      setIdleHint(null)
      setStMode("inherit")
      setStMb(2048)
      setStRec("inherit")
      setStShot("inherit")
      setStUpload("inherit")
      setStAdvanced(false)
      setStRecMb(0)
      setStShotMb(0)
      setStFileMb(0)
      setStInitial(null)
      setTtlMode("inherit")
      setTtlMinutes(120)
      setTtlAllowUnlimited("inherit")
      setTtlInitial(null)
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
            proxyBandwidthMb: qBandwidth,
          }
        : undefined

      // r14（22-c）：闲置超时策略取值（null=继承组，0=无限，N=分钟）
      const idleMinutesValue: number | null =
        idleMode === "inherit" ? null : idleMode === "unlimited" ? 0 : Math.max(1, Math.min(43200, Math.round(idleMinutes)))

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
        // r14（22-c）：保存闲置超时策略（创建：非默认才落库；编辑：与拉取初值比对变化才落库，避免审计噪声）
        const targetId = mode === "create" ? res.data?.id : user!.id
        const idleChanged =
          mode === "create"
            ? idleMinutesValue !== null || idleLocked
            : !idleInitial || idleMinutesValue !== idleInitial.minutes || idleLocked !== idleInitial.locked
        if (targetId && idleChanged) {
          const idleRes = await setUserIdleTimeoutAction({ id: targetId, minutes: idleMinutesValue, locked: idleLocked })
          if (idleRes.code !== 0) {
            toast.warning(`闲置超时策略保存失败：${idleRes.msg}（其余字段已保存）`)
          }
        }
        // r33：存储配额 + 沙箱最大时长（创建：非默认才落库；编辑：与初值比对变化才落库）
        const stQuotaValue: number | null = stMode === "inherit" ? null : stMode === "unlimited" ? 0 : Math.max(1, Math.round(stMb))
        const stPolicyValue: AdminUserRow["storagePolicy"] =
          stRec === "inherit" && stShot === "inherit" && stUpload === "inherit" && !stAdvanced
            ? null
            : {
                ...(stRec !== "inherit" ? { recording: stRec === "on" } : {}),
                ...(stShot !== "inherit" ? { screenshot: stShot === "on" } : {}),
                ...(stUpload !== "inherit" ? { upload: stUpload === "on" } : {}),
                ...(stAdvanced && stRecMb > 0 ? { recordingMb: Math.round(stRecMb) } : {}),
                ...(stAdvanced && stShotMb > 0 ? { screenshotMb: Math.round(stShotMb) } : {}),
                ...(stAdvanced && stFileMb > 0 ? { fileMb: Math.round(stFileMb) } : {}),
              }
        const ttlValue: number | null = ttlMode === "inherit" ? null : ttlMode === "unlimited" ? 0 : Math.max(1, Math.round(ttlMinutes))
        const ttlAllowValue: boolean | null = ttlAllowUnlimited === "inherit" ? null : ttlAllowUnlimited === "yes"
        const stChanged =
          mode === "create"
            ? stQuotaValue !== null || stPolicyValue !== null || ttlValue !== null || ttlAllowValue !== null
            : !stInitial || stQuotaValue !== stInitial.quota || JSON.stringify(stPolicyValue) !== JSON.stringify(stInitial.policy) || ttlValue !== ttlInitial?.max || ttlAllowValue !== ttlInitial?.allow
        if (targetId && stChanged) {
          const stRes = await setUserStorageQuotaAction({
            id: targetId,
            storageQuotaMb: stQuotaValue,
            storagePolicy: stPolicyValue,
            maxTtlMinutes: ttlValue,
            allowUnlimitedTtl: ttlAllowValue,
          })
          if (stRes.code !== 0) {
            toast.warning(`存储配额/时长策略保存失败：${stRes.msg}（其余字段已保存）`)
          }
        }
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

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
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
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
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
              <div className="space-y-1.5">
                <Label className="text-xs">代理带宽配额</Label>
                <PrecisionInput value={qBandwidth} onChange={setQBandwidth} min={0} max={10000000} suffix="MB" />
              </div>
            </div>
          )}
        </div>

        {/* r14（22-c）：沙箱闲置超时策略（四级链：沙箱＞用户＞组＞全局） */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5">
                沙箱闲置超时策略
                {idleLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </p>
              <p className="text-xs text-muted-foreground">该用户创建/编辑工作区时的默认闲置超时；工作区创建后以沙箱锁定值生效</p>
            </div>
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">策略</Label>
              <Select value={idleMode} onValueChange={(v) => setIdleMode(v as "inherit" | "unlimited" | "limit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承用户组</SelectItem>
                  <SelectItem value="unlimited">无限（永不闲置回收，0）</SelectItem>
                  <SelectItem value="limit">限制时长（分钟）</SelectItem>
                </SelectContent>
              </Select>
              {idleMode === "limit" && (
                <div className="space-y-1">
                  <PrecisionInput value={idleMinutes} onChange={(v) => setIdleMinutes(Math.max(1, Math.round(v)))} min={1} max={43200} suffix="分" />
                  <p className="text-[10px] text-muted-foreground">闲置超过该时长无活跃则自动回收（1-43200 分钟）</p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">锁定</span>
                <p className="text-[10px] text-muted-foreground">开启后该用户创建/编辑工作区时不可自行调整闲置超时（管理员不受限）</p>
              </div>
              <Switch checked={idleLocked} onCheckedChange={setIdleLocked} />
            </div>
          </div>
          {mode === "edit" && idleHint && idleMode === "inherit" && (
            <p className="text-[11px] text-muted-foreground">
              继承解析结果：{idleHint.defaultMinutes > 0 ? `${Math.round(idleHint.defaultMinutes)} 分钟` : "无限（0）"}
              <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0">{idleHint.defaultSourceLabel}</Badge>
              {idleHint.groupMinutes == null && <span className="ml-1">（组未设置，全局默认 {idleHint.globalDefault > 0 ? `${Math.round(idleHint.globalDefault)} 分钟` : "无限"}）</span>}
            </p>
          )}
        </div>

        {/* r33：存储配额分配（用户级覆盖：总配额三态 + 录屏/截图/上传开关 + 分类子配额） */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">存储配额（录像+截图+云盘统一计量）</p>
              <p className="text-xs text-muted-foreground">null=继承组/全局；配额内写入实时校验，超额拒绝并站内信提醒</p>
            </div>
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">总配额</Label>
              <Select value={stMode} onValueChange={(v) => setStMode(v as "inherit" | "unlimited" | "limit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承用户组/全局</SelectItem>
                  <SelectItem value="unlimited">不限（0）</SelectItem>
                  <SelectItem value="limit">限定（MB）</SelectItem>
                </SelectContent>
              </Select>
              {stMode === "limit" && (
                <div className="space-y-1">
                  <PrecisionInput value={stMb} onChange={(v) => setStMb(Math.max(1, Math.round(v)))} min={1} max={10000000} suffix="MB" />
                  <p className="text-[10px] text-muted-foreground">当前用量 {mode === "edit" ? `${user?.storageUsageMb ?? 0}MB` : "—"}（保存后在用户列表可见）</p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-xs">功能开关（三态覆盖）</Label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { label: "录像", v: stRec, set: setStRec },
                  { label: "截图", v: stShot, set: setStShot },
                  { label: "上传", v: stUpload, set: setStUpload },
                ] as const).map((it) => (
                  <Select key={it.label} value={it.v} onValueChange={(v) => it.set(v as "inherit" | "on" | "off")}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{it.label}·继承</SelectItem>
                      <SelectItem value="on">{it.label}·允许</SelectItem>
                      <SelectItem value="off">{it.label}·禁止</SelectItem>
                    </SelectContent>
                  </Select>
                ))}
              </div>
              <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => setStAdvanced(!stAdvanced)}>
                {stAdvanced ? "收起分类子配额" : "展开分类子配额（精细颗粒分配）"}
              </button>
              {stAdvanced && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">录像限 MB</Label>
                    <PrecisionInput value={stRecMb} onChange={(v) => setStRecMb(Math.max(0, Math.round(v)))} min={0} max={10000000} suffix="MB" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">截图限 MB</Label>
                    <PrecisionInput value={stShotMb} onChange={(v) => setStShotMb(Math.max(0, Math.round(v)))} min={0} max={10000000} suffix="MB" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">云盘限 MB</Label>
                    <PrecisionInput value={stFileMb} onChange={(v) => setStFileMb(Math.max(0, Math.round(v)))} min={0} max={10000000} suffix="MB" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* r33：沙箱最大时长（用户创建沙箱的可选时长上限 + 是否允许无限时长） */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">沙箱最大时长</p>
              <p className="text-xs text-muted-foreground">该用户创建工作区时可选的生存时长（TTL）上限；关闭「无限时长」后创建必选有限时长</p>
            </div>
          </div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">时长上限</Label>
              <Select value={ttlMode} onValueChange={(v) => setTtlMode(v as "inherit" | "unlimited" | "limit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承用户组/全局</SelectItem>
                  <SelectItem value="unlimited">不限（0）</SelectItem>
                  <SelectItem value="limit">限定（分钟）</SelectItem>
                </SelectContent>
              </Select>
              {ttlMode === "limit" && (
                <PrecisionInput value={ttlMinutes} onChange={(v) => setTtlMinutes(Math.max(1, Math.round(v)))} min={1} max={525600} suffix="分" />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">允许「无限时长」沙箱</Label>
              <Select value={ttlAllowUnlimited} onValueChange={(v) => setTtlAllowUnlimited(v as "inherit" | "yes" | "no")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承用户组/全局</SelectItem>
                  <SelectItem value="yes">允许选择无限时长</SelectItem>
                  <SelectItem value="no">禁止（必须选有限时长）</SelectItem>
                </SelectContent>
              </Select>
              {ttlAllowUnlimited === "no" && ttlMode === "inherit" && (
                <p className="text-[10px] text-amber-600">未设上限且禁无限时，将按全局兜底 30 天封顶</p>
              )}
            </div>
          </div>
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
