"use client"

// 用户组 新建/编辑 表单弹窗：父组树形选择（防循环）/ 配额 / 预留配额 / 继承 / 强制2FA / 标签

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
import { PrecisionInput } from "@/components/shared/confirm"
import { createGroupAction, updateGroupAction } from "@/server/actions/groups"

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
    allowInternalNetwork: boolean
    allowSecureLocationAccess: boolean
    vncSessionMaxMinutes: number | null
    tags: string[]
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

  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [parentId, setParentId] = React.useState<string>("__none__")
  const [enabled, setEnabled] = React.useState(true)
  const [inheritParentQuota, setInheritParentQuota] = React.useState(true)
  const [force2fa, setForce2fa] = React.useState(false)
  const [allowInternalNetwork, setAllowInternalNetwork] = React.useState(false)
  const [vncLimitEnabled, setVncLimitEnabled] = React.useState(false)
  const [vncLimitMinutes, setVncLimitMinutes] = React.useState(120)
  const [allowSecureLocationAccess, setAllowSecureLocationAccess] = React.useState(false)
  const [tagsText, setTagsText] = React.useState("")

  const [quotaEnabled, setQuotaEnabled] = React.useState(false)
  const [qSessions, setQSessions] = React.useState(20)
  const [qNovnc, setQNovnc] = React.useState(8)
  const [qDisk, setQDisk] = React.useState(4096)
  const [reservedEnabled, setReservedEnabled] = React.useState(false)
  const [rSessions, setRSessions] = React.useState(2)
  const [rNovnc, setRNovnc] = React.useState(1)

  React.useEffect(() => {
    if (!open) return
    if (mode === "edit" && group) {
      setName(group.name)
      setDescription(group.description || "")
      setParentId(group.parentId || "__none__")
      setEnabled(group.enabled)
      setInheritParentQuota(group.inheritParentQuota)
      setForce2fa(group.force2fa)
      setAllowInternalNetwork(group.allowInternalNetwork)
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
      allowInternalNetwork,
      allowSecureLocationAccess,
      vncSessionMaxMinutes: vncLimitEnabled ? vncLimitMinutes : 0,
      tags,
      quota: quotaEnabled ? { sessions: qSessions, novncSessions: qNovnc, diskMb: qDisk } : undefined,
      reservedQuota: reservedEnabled ? { sessions: rSessions, novncSessions: rNovnc } : undefined,
    }

    setBusy(true)
    try {
      const res =
        mode === "edit" && group
          ? await updateGroupAction({ id: group.id, ...payload })
          : await createGroupAction(payload)
      if (res.code === 0) {
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

        <div className="grid gap-4 sm:grid-cols-2">
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
            <div className="grid gap-3 sm:grid-cols-3">
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
            <div className="grid gap-3 sm:grid-cols-2">
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
