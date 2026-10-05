"use client"

// 用户组 新建/编辑 表单弹窗：父组树形选择（防循环）/ 配额 / 预留配额 / 继承 / 强制2FA / 标签
// r14（22-c）：组级闲置超时策略（继承全局/无限/自定义分钟 + 锁定开关；编辑时拉取当前策略回显）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PrecisionInput } from "@/components/shared/confirm"
import { createGroupAction, updateGroupAction, getGroupIdlePolicyAction, setGroupIdleTimeoutAction } from "@/server/actions/groups"

export interface GroupTreeNodeInfo {
  id: string
  name: string
  parentId: string | null
}

interface GroupFormDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: "create" | "edit"
  group?: {
    id: string
    name: string
    description: string | null
    parentId: string | null
    enabled: boolean
    inheritParentQuota: boolean
    quota: Record<string, number | null> | null
    reservedQuota: Record<string, number | null> | null
    force2fa: boolean
    managedPolicyOverrides?: string | null
    allowInternalNetwork: boolean
    allowSecureLocationAccess: boolean
    allowShare: boolean
    allowGuestShare: boolean
    vncSessionMaxMinutes: number | null
    tags: string[]
    // r33：组级存储配额 + 沙箱最大时长基线
    storageQuotaMb: number | null
    storagePolicy: { recording?: boolean | null; screenshot?: boolean | null; upload?: boolean | null; recordingMb?: number | null; screenshotMb?: number | null; fileMb?: number | null } | null
    maxTtlMinutes: number | null
    allowUnlimitedTtl: boolean | null
  } | null
  defaultParentId?: string | null
  allNodes: GroupTreeNodeInfo[]
}

// 计算某节点在树中的路径显示（如 总公司 / 华东 / 运维组）
function pathOf(id: string, byId: Map<string, GroupTreeNodeInfo>): string[] {
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

// 收集后代ID集合
function descendantsOf(id: string, all: GroupTreeNodeInfo[]): Set<string> {
  const childMap = new Map<string, string[]>()
  for (const n of all) {
    if (n.parentId) {
      const arr = childMap.get(n.parentId) || []
      arr.push(n.id)
      childMap.set(n.parentId, arr)
    }
  }
  const out = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const cur = queue.shift()!
    for (const c of childMap.get(cur) || []) {
      if (!out.has(c)) {
        out.add(c)
        queue.push(c)
      }
    }
  }
  return out
}

export function GroupFormDialog({ open, onOpenChange, mode, group, defaultParentId, allNodes }: GroupFormDialogProps) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  // r35：组级企业策略覆盖 JSON
  const [policyOverrides, setPolicyOverrides] = React.useState("")

  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [parentId, setParentId] = React.useState<string>("__none__")
  const [enabled, setEnabled] = React.useState(true)
  const [inheritParentQuota, setInheritParentQuota] = React.useState(true)
  const [force2fa, setForce2fa] = React.useState(false)
  const [allowInternalNetwork, setAllowInternalNetwork] = React.useState(false)
  const [allowShare, setAllowShare] = React.useState(true)
  const [allowGuestShare, setAllowGuestShare] = React.useState(true)
  const [vncLimitEnabled, setVncLimitEnabled] = React.useState(false)
  const [vncLimitMinutes, setVncLimitMinutes] = React.useState(120)
  const [allowSecureLocationAccess, setAllowSecureLocationAccess] = React.useState(false)
  const [tagsText, setTagsText] = React.useState("")

  const [quotaEnabled, setQuotaEnabled] = React.useState(false)
  const [qSessions, setQSessions] = React.useState(20)
  const [qNovnc, setQNovnc] = React.useState(8)
  const [qDisk, setQDisk] = React.useState(4096)
  const [qBandwidth, setQBandwidth] = React.useState(0)
  const [reservedEnabled, setReservedEnabled] = React.useState(false)
  const [rSessions, setRSessions] = React.useState(2)
  const [rNovnc, setRNovnc] = React.useState(1)

  // r14（22-c）：组级闲置超时策略（inherit=继承全局默认 / unlimited=0 无限 / limit=自定义分钟 + 锁定开关）
  const [idleMode, setIdleMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [idleMinutes, setIdleMinutes] = React.useState(60)
  const [idleLocked, setIdleLocked] = React.useState(false)
  const [idleInitial, setIdleInitial] = React.useState<{ minutes: number | null; locked: boolean } | null>(null)
  const [idleGlobalDefault, setIdleGlobalDefault] = React.useState(60)
  const [idleAffected, setIdleAffected] = React.useState<number | null>(null)
  const [idleLoading, setIdleLoading] = React.useState(false)

  // r33：组级存储配额 + 沙箱最大时长（成员基线；成员用户级可再覆盖）
  const [stMode, setStMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [stMb, setStMb] = React.useState(5120)
  const [stRec, setStRec] = React.useState<"inherit" | "on" | "off">("inherit")
  const [stShot, setStShot] = React.useState<"inherit" | "on" | "off">("inherit")
  const [stUpload, setStUpload] = React.useState<"inherit" | "on" | "off">("inherit")
  const [ttlMode, setTtlMode] = React.useState<"inherit" | "unlimited" | "limit">("inherit")
  const [ttlMinutes, setTtlMinutes] = React.useState(240)
  const [ttlAllowUnlimited, setTtlAllowUnlimited] = React.useState<"inherit" | "yes" | "no">("inherit")

  React.useEffect(() => {
    if (!open) return
    if (mode === "edit" && group) {
      setName(group.name)
      setDescription(group.description || "")
      setParentId(group.parentId || "__none__")
      setEnabled(group.enabled)
      setInheritParentQuota(group.inheritParentQuota)
      setForce2fa(group.force2fa)
      setPolicyOverrides(group.managedPolicyOverrides ? (() => { try { return JSON.stringify(JSON.parse(group.managedPolicyOverrides), null, 2) } catch { return group.managedPolicyOverrides } })() : "")
      setAllowInternalNetwork(group.allowInternalNetwork)
      setAllowShare(group.allowShare !== false)
      setAllowGuestShare(group.allowGuestShare !== false)
      setVncLimitEnabled(group.vncSessionMaxMinutes != null && group.vncSessionMaxMinutes > 0)
      setVncLimitMinutes(group.vncSessionMaxMinutes && group.vncSessionMaxMinutes > 0 ? group.vncSessionMaxMinutes : 120)
      setAllowSecureLocationAccess(group.allowSecureLocationAccess)
      setTagsText(group.tags.join(", "))
      const q = group.quota
      if (q && (q.sessions !== null && q.sessions !== undefined || q.novncSessions != null || q.diskMb != null)) {
        setQuotaEnabled(true)
        setQSessions(q.sessions ?? 20)
        setQNovnc(q.novncSessions ?? 8)
        setQDisk(q.diskMb ?? 4096)
        setQBandwidth(q.proxyBandwidthMb ?? 0)
      } else {
        setQuotaEnabled(false)
      }
      const r = group.reservedQuota
      if (r && (r.sessions != null || r.novncSessions != null)) {
        setReservedEnabled(true)
        setRSessions(r.sessions ?? 2)
        setRNovnc(r.novncSessions ?? 1)
      } else {
        setReservedEnabled(false)
      }
      // r14（22-c）：拉取当前组级闲置超时策略回显（groups-tree 行数据不含新字段，弹层自取）
      setIdleInitial(null)
      setIdleMode("inherit")
      setIdleMinutes(60)
      setIdleLocked(false)
      setIdleLoading(true)
      // r33：组级存储/时长回显
      const sp = group.storagePolicy || null
      setStMode(group.storageQuotaMb == null ? "inherit" : group.storageQuotaMb === 0 ? "unlimited" : "limit")
      setStMb(group.storageQuotaMb && group.storageQuotaMb > 0 ? group.storageQuotaMb : 5120)
      setStRec(sp?.recording == null ? "inherit" : sp.recording ? "on" : "off")
      setStShot(sp?.screenshot == null ? "inherit" : sp.screenshot ? "on" : "off")
      setStUpload(sp?.upload == null ? "inherit" : sp.upload ? "on" : "off")
      setTtlMode(group.maxTtlMinutes == null ? "inherit" : group.maxTtlMinutes === 0 ? "unlimited" : "limit")
      setTtlMinutes(group.maxTtlMinutes && group.maxTtlMinutes > 0 ? group.maxTtlMinutes : 240)
      setTtlAllowUnlimited(group.allowUnlimitedTtl == null ? "inherit" : group.allowUnlimitedTtl ? "yes" : "no")
      getGroupIdlePolicyAction({ id: group.id })
        .then((res) => {
          if (res.code === 0 && res.data) {
            const d = res.data
            setIdleMode(d.minutes == null ? "inherit" : d.minutes === 0 ? "unlimited" : "limit")
            if (d.minutes != null && d.minutes > 0) setIdleMinutes(d.minutes)
            setIdleLocked(d.locked)
            setIdleInitial({ minutes: d.minutes, locked: d.locked })
            setIdleGlobalDefault(d.globalDefault)
            setIdleAffected(d.affectedMembers)
          } else {
            toast.error(res.msg || "闲置超时策略加载失败")
          }
        })
        .catch(() => toast.error("闲置超时策略加载失败"))
        .finally(() => setIdleLoading(false))
    } else {
      setName("")
      setDescription("")
      setParentId(defaultParentId || "__none__")
      setEnabled(true)
      setInheritParentQuota(true)
      setForce2fa(false)
      setAllowInternalNetwork(false)
      setAllowSecureLocationAccess(false)
      setTagsText("")
      setQuotaEnabled(false)
      setQSessions(20)
      setQNovnc(8)
      setQDisk(4096)
      setReservedEnabled(false)
      setRSessions(2)
      setRNovnc(1)
      setIdleMode("inherit")
      setIdleMinutes(60)
      setIdleLocked(false)
      setIdleInitial(null)
      setIdleAffected(null)
      setStMode("inherit")
      setStMb(5120)
      setStRec("inherit")
      setStShot("inherit")
      setStUpload("inherit")
      setTtlMode("inherit")
      setTtlMinutes(240)
      setTtlAllowUnlimited("inherit")
    }
  }, [open, mode, group])

  const byId = React.useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes])
  const banned = React.useMemo(
    () => (mode === "edit" && group ? descendantsOf(group.id, allNodes) : new Set<string>()),
    [mode, group, allNodes]
  )

  const submit = async () => {
    if (name.trim().length < 2) {
      toast.error("组名至少2位")
      return
    }
    const tags = tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      parentId: parentId === "__none__" ? undefined : parentId,
      enabled,
      inheritParentQuota,
      force2fa,
      managedPolicyOverrides: policyOverrides.trim() || undefined,
      allowInternalNetwork,
      allowSecureLocationAccess,
      allowShare,
      allowGuestShare,
      vncSessionMaxMinutes: vncLimitEnabled ? vncLimitMinutes : 0,
      tags,
      quota: quotaEnabled ? { sessions: qSessions, novncSessions: qNovnc, diskMb: qDisk, proxyBandwidthMb: qBandwidth } : undefined,
      reservedQuota: reservedEnabled ? { sessions: rSessions, novncSessions: rNovnc } : undefined,
      // r33：组级存储配额 + 沙箱最大时长
      storageQuotaMb: stMode === "inherit" ? null : stMode === "unlimited" ? 0 : Math.max(1, Math.round(stMb)),
      storagePolicy:
        stRec === "inherit" && stShot === "inherit" && stUpload === "inherit"
          ? null
          : {
              ...(stRec !== "inherit" ? { recording: stRec === "on" } : {}),
              ...(stShot !== "inherit" ? { screenshot: stShot === "on" } : {}),
              ...(stUpload !== "inherit" ? { upload: stUpload === "on" } : {}),
            },
      maxTtlMinutes: ttlMode === "inherit" ? null : ttlMode === "unlimited" ? 0 : Math.max(1, Math.round(ttlMinutes)),
      allowUnlimitedTtl: ttlAllowUnlimited === "inherit" ? null : ttlAllowUnlimited === "yes",
    }

    setBusy(true)
    try {
      // r14（22-c）：闲置超时策略取值（null=继承全局默认，0=无限，N=分钟）
      const idleMinutesValue: number | null =
        idleMode === "inherit" ? null : idleMode === "unlimited" ? 0 : Math.max(1, Math.min(43200, Math.round(idleMinutes)))

      const res =
        mode === "edit" && group
          ? await updateGroupAction({ id: group.id, ...payload })
          : await createGroupAction(payload)
      if (res.code === 0) {
        // r14（22-c）：保存组级闲置超时策略（创建：非默认才落库；编辑：与拉取初值比对变化才落库，避免审计噪声）
        const targetId = mode === "edit" && group ? group.id : res.data?.id
        const idleChanged =
          mode === "edit"
            ? !idleInitial || idleMinutesValue !== idleInitial.minutes || idleLocked !== idleInitial.locked
            : idleMinutesValue !== null || idleLocked
        if (targetId && idleChanged) {
          const idleRes = await setGroupIdleTimeoutAction({ id: targetId, minutes: idleMinutesValue, locked: idleLocked })
          if (idleRes.code !== 0) {
            toast.warning(`闲置超时策略保存失败：${idleRes.msg}（其余字段已保存）`)
          }
        }
        toast.success(mode === "edit" ? "用户组已更新" : "用户组创建成功")
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新建用户组" : `编辑用户组 · ${group?.name || ""}`}</DialogTitle>
          <DialogDescription>
            {mode === "create" ? "创建组织节点并配置配额与策略" : "修改名称 / 父组 / 配额 / 策略；父组禁止选择自身及后代"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>组名 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：华东运营组" />
          </div>
          <div className="space-y-1.5">
            <Label>描述</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>父组（树形层级）</Label>
            <ScrollArea className="h-32 rounded-md border p-2">
              <div className="space-y-0.5">
                <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer">
                  <Checkbox checked={parentId === "__none__"} onCheckedChange={() => setParentId("__none__")} />
                  <span className="text-muted-foreground">（无父组 · 根节点）</span>
                </label>
                {allNodes
                  .filter((n) => !(mode === "edit" && group && n.id === group.id))
                  .map((n) => {
                    const isBanned = banned.has(n.id)
                    const path = pathOf(n.id, byId).join(" / ")
                    return (
                      <label
                        key={n.id}
                        className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted ${isBanned ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                        title={isBanned ? "不能选择自己或后代（会形成循环）" : path}
                      >
                        <Checkbox
                          checked={parentId === n.id}
                          disabled={isBanned}
                          onCheckedChange={() => setParentId(n.id)}
                        />
                        <span className="truncate">{path}</span>
                      </label>
                    )
                  })}
              </div>
            </ScrollArea>
          </div>
          <div className="space-y-1.5">
            <Label>标签（逗号分隔）</Label>
            <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="如：核心,运营" />
          </div>
          <div className="space-y-2 flex flex-col justify-end gap-2 pb-1">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">启用该组</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="space-y-1.5">
          <Label className="text-sm">企业策略覆盖（Chromium Managed Policy）</Label>
          <textarea
            value={policyOverrides}
            onChange={(e) => setPolicyOverrides(e.target.value)}
            placeholder={'{\n  "DefaultSearchProviderEnabled": false,\n  "DnsOverHttpsMode": "off",\n  "DeveloperToolsAvailability": 2\n}'}
            className="min-h-[96px] w-full rounded-md border bg-background p-2 font-mono text-xs"
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground">组级策略 JSON（成员继承；用户级可覆盖组级）。可用键：搜索引擎/DNS/DevTools/下载/无痕等 40+ 项。</p>
        </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm">组级强制2FA</span>
              <Switch checked={force2fa} onCheckedChange={setForce2fa} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">允许访问内网</span>
                <p className="text-[10px] text-muted-foreground">成员浏览器会话可访问私有网段（用户级覆盖优先）</p>
              </div>
              <Switch checked={allowInternalNetwork} onCheckedChange={setAllowInternalNetwork} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">允许访问容器安全位置</span>
                <p className="text-[10px] text-muted-foreground">CDP/VNC端口、file://、平台内部端点（默认拒绝）</p>
              </div>
              <Switch checked={allowSecureLocationAccess} onCheckedChange={setAllowSecureLocationAccess} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">允许工作区共享</span>
                <p className="text-[10px] text-muted-foreground">关闭后组内成员默认禁止共享工作区（用户级可覆盖；沙箱级否决优先级最高）</p>
              </div>
              <Switch checked={allowShare} onCheckedChange={setAllowShare} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">允许访客访问（免登录接入）</span>
                <p className="text-[10px] text-muted-foreground">r37：关闭后组内成员的分享链接不允许访客免登录接入（用户级 guestShareAllowed 可覆盖；全局开关仍需开启）</p>
              </div>
              <Switch checked={allowGuestShare} onCheckedChange={setAllowGuestShare} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">VNC 连接总时长上限</span>
                <p className="text-[10px] text-muted-foreground">组级策略：成员 HelmPort 会话到期自动断开（沙箱级/用户级覆盖优先；关闭=不限）</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={43200}
                  value={vncLimitMinutes}
                  disabled={!vncLimitEnabled}
                  onChange={(e) => setVncLimitMinutes(Math.max(1, Math.min(43200, Number(e.target.value) || 120)))}
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">分钟</span>
                <Switch checked={vncLimitEnabled} onCheckedChange={(b) => { setVncLimitEnabled(b); if (b && vncLimitMinutes <= 0) setVncLimitMinutes(120) }} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm flex items-center gap-1.5">
                  沙箱闲置超时
                  {idleLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </span>
                <p className="text-[10px] text-muted-foreground">组级策略：成员创建/编辑工作区时的默认闲置超时（沙箱级/用户级覆盖优先）</p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={idleMode} onValueChange={(v) => setIdleMode(v as "inherit" | "unlimited" | "limit")}>
                  <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">继承全局默认</SelectItem>
                    <SelectItem value="unlimited">无限（0）</SelectItem>
                    <SelectItem value="limit">限制时长</SelectItem>
                  </SelectContent>
                </Select>
                {idleMode === "limit" && (
                  <Input
                    type="number"
                    min={1}
                    max={43200}
                    value={idleMinutes}
                    onChange={(e) => setIdleMinutes(Math.max(1, Math.min(43200, Number(e.target.value) || 60)))}
                    className="h-8 w-20"
                  />
                )}
                {idleMode === "limit" && <span className="text-xs text-muted-foreground">分钟</span>}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0 pr-2">
                <span className="text-sm">锁定闲置超时</span>
                <p className="text-[10px] text-muted-foreground">
                  开启后组内成员创建/编辑工作区时不可自行调整闲置超时（用户级锁定优先；管理员不受限）
                  {idleMode === "inherit" && idleGlobalDefault != null && (
                    <span> · 当前全局默认 {idleGlobalDefault > 0 ? `${Math.round(idleGlobalDefault)} 分钟` : "无限"}</span>
                  )}
                  {idleAffected != null && <span> · 影响成员 {idleAffected} 人</span>}
                </p>
              </div>
              <Switch checked={idleLocked} onCheckedChange={setIdleLocked} />
            </div>
          </div>
        </div>

        {/* 组配额 */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">自定义组配额</p>
              <p className="text-xs text-muted-foreground">该组全部成员合计并发上限</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">继承父组配额</span>
              <Switch checked={inheritParentQuota} onCheckedChange={setInheritParentQuota} />
              <Switch checked={quotaEnabled} onCheckedChange={setQuotaEnabled} />
            </div>
          </div>
          {quotaEnabled && (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">并发会话</Label>
                <PrecisionInput value={qSessions} onChange={setQSessions} min={0} max={100000} suffix="个" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">NoVNC 会话</Label>
                <PrecisionInput value={qNovnc} onChange={setQNovnc} min={0} max={100000} suffix="个" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">磁盘</Label>
                <PrecisionInput value={qDisk} onChange={setQDisk} min={0} max={10000000} suffix="MB" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">代理带宽</Label>
                <PrecisionInput value={qBandwidth} onChange={setQBandwidth} min={0} max={10000000} suffix="MB" />
              </div>
            </div>
          )}
        </div>

        {/* 预留配额 */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">预留配额水位</p>
              <p className="text-xs text-muted-foreground">普通成员不可挤占的保留量</p>
            </div>
            <Switch checked={reservedEnabled} onCheckedChange={setReservedEnabled} />
          </div>
          {reservedEnabled && (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">预留会话</Label>
                <PrecisionInput value={rSessions} onChange={setRSessions} min={0} max={100000} suffix="个" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">预留 NoVNC</Label>
                <PrecisionInput value={rNovnc} onChange={setRNovnc} min={0} max={100000} suffix="个" />
              </div>
            </div>
          )}
        </div>

        {/* r33：组级存储配额基线（成员统一口径：录像+截图+云盘；成员用户级可覆盖） */}
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">存储配额（组基线）</p>
          <p className="text-xs text-muted-foreground">组内成员默认生效；成员用户级设置可覆盖本值</p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">总配额</Label>
              <Select value={stMode} onValueChange={(v) => setStMode(v as "inherit" | "unlimited" | "limit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承全局默认</SelectItem>
                  <SelectItem value="unlimited">不限（0）</SelectItem>
                  <SelectItem value="limit">限定（MB）</SelectItem>
                </SelectContent>
              </Select>
              {stMode === "limit" && <PrecisionInput value={stMb} onChange={(v) => setStMb(Math.max(1, Math.round(v)))} min={1} max={10000000} suffix="MB" />}
            </div>
            <div className="space-y-2">
              <Label className="text-xs">功能开关（三态）</Label>
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
            </div>
          </div>
        </div>

        {/* r33：组级沙箱最大时长基线 */}
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">沙箱最大时长（组基线）</p>
          <p className="text-xs text-muted-foreground">组内成员创建工作区时可选时长上限；「无限时长」开关管控是否必须选有限时长</p>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">时长上限</Label>
              <Select value={ttlMode} onValueChange={(v) => setTtlMode(v as "inherit" | "unlimited" | "limit")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承全局默认</SelectItem>
                  <SelectItem value="unlimited">不限（0）</SelectItem>
                  <SelectItem value="limit">限定（分钟）</SelectItem>
                </SelectContent>
              </Select>
              {ttlMode === "limit" && <PrecisionInput value={ttlMinutes} onChange={(v) => setTtlMinutes(Math.max(1, Math.round(v)))} min={1} max={525600} suffix="分" />}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">允许「无限时长」</Label>
              <Select value={ttlAllowUnlimited} onValueChange={(v) => setTtlAllowUnlimited(v as "inherit" | "yes" | "no")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承全局默认</SelectItem>
                  <SelectItem value="yes">允许</SelectItem>
                  <SelectItem value="no">禁止（必选有限时长）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={submit} disabled={busy} className="bg-teal-600 hover:bg-teal-700">
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {mode === "create" ? "创建用户组" : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
