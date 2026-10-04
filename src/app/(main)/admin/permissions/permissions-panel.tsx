"use client"

// ============================================================
// r31：权限中心面板（30 项锁三级矩阵 + 搜索 + 批量操作 + 沙箱级深链）
//   交互：作用域切换（全局/用户组/用户）→ 目标选择（组/用户可搜索）→
//         锁开关批量编辑（全开/全清/仅显示已锁）→ 保存（审计留痕）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Save, Lock, Search, Globe2, UsersRound, UserRound, Boxes, X, Layers } from "lucide-react"
import { listPermissionTargetsAction, setGlobalPermissionLocksAction, setUserPermissionLocksAction, setGroupPermissionLocksAction, batchSetPermissionLocksAction } from "@/server/actions/permissions-center"

// 锁键分类（30 项 → 8 组；展示分组）
const LOCK_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: "工作区与资源", keys: ["blockCreateWorkspace", "blockModifyWorkspace", "blockModifyResourceExpiry", "blockDeleteResource", "blockRestoreRecycle", "blockBatchOps", "blockRestartInstance", "blockViewContainerDetail"] },
  { title: "共享与导出", keys: ["blockShareWorkspace", "blockExportData", "blockExportLogs", "blockCopyOthersTemplate", "blockViewPublicIp"] },
  { title: "令牌与凭证", keys: ["blockCreateApiToken", "blockEditTokenExpiry", "blockRefreshToken", "blockRefreshVncKey"] },
  { title: "网络与代理", keys: ["blockModifyProxyNetwork", "blockSwitchProxyNode", "blockCustomNetworkThrottle"] },
  { title: "VNC 与输入", keys: ["blockSwitchVncMode", "blockCustomVncResolution"] },
  { title: "查看与统计", keys: ["blockViewOthersResourceList", "blockViewUsageStats"] },
  { title: "账号与个人", keys: ["blockEditProfile", "blockModifyOwnQuota", "blockCleanOwnRecycle"] },
  { title: "脚本与模板", keys: ["blockUploadScript", "blockImportTemplate"] },
]

const LOCK_LABELS: Record<string, string> = {
  blockCreateWorkspace: "创建工作区", blockModifyWorkspace: "修改工作区", blockModifyResourceExpiry: "修改资源有效期",
  blockDeleteResource: "删除资源", blockRestoreRecycle: "从回收站恢复", blockBatchOps: "批量操作",
  blockRestartInstance: "重启实例", blockViewContainerDetail: "查看容器详情",
  blockShareWorkspace: "共享工作区", blockExportData: "导出数据", blockExportLogs: "导出日志",
  blockCopyOthersTemplate: "复制他人模板", blockViewPublicIp: "查看公网 IP",
  blockCreateApiToken: "创建 API 令牌", blockEditTokenExpiry: "编辑令牌有效期", blockRefreshToken: "刷新令牌",
  blockRefreshVncKey: "刷新 VNC 密钥",
  blockModifyProxyNetwork: "修改代理网络", blockSwitchProxyNode: "切换代理节点", blockCustomNetworkThrottle: "自定义网络限速",
  blockSwitchVncMode: "切换 VNC 模式", blockCustomVncResolution: "自定义 VNC 分辨率",
  blockViewOthersResourceList: "查看他人资源列表", blockViewUsageStats: "查看使用统计",
  blockEditProfile: "编辑个人资料", blockModifyOwnQuota: "修改自身配额", blockCleanOwnRecycle: "清理个人回收站",
  blockUploadScript: "上传脚本", blockImportTemplate: "导入模板",
}

type Scope = "global" | "group" | "user" | "batch"

interface GroupTarget { id: string; name: string; locks: Record<string, boolean> }
interface UserTarget { id: string; username: string; displayName: string | null; role: string; locks: Record<string, boolean> }

export function PermissionsCenterPanel() {
  const [scope, setScope] = React.useState<Scope>("global")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [kw, setKw] = React.useState("")
  const [globalLocks, setGlobalLocks] = React.useState<Record<string, boolean>>({})
  const [groups, setGroups] = React.useState<GroupTarget[]>([])
  const [users, setUsers] = React.useState<UserTarget[]>([])
  const [targetId, setTargetId] = React.useState<string>("")
  const [draft, setDraft] = React.useState<Record<string, boolean>>({})
  const [onlyLocked, setOnlyLocked] = React.useState(false)

  // —— r33：批量授权（多用户/组 + 权限三态矩阵）——
  const [batchUserIds, setBatchUserIds] = React.useState<string[]>([])
  const [batchGroupIds, setBatchGroupIds] = React.useState<string[]>([])
  const [batchKw, setBatchKw] = React.useState("")
  const [batchUpdates, setBatchUpdates] = React.useState<Record<string, boolean | null>>({})
  const [batchMode, setBatchMode] = React.useState<"merge" | "replace">("merge")
  const [batchNotify, setBatchNotify] = React.useState(true)
  const [batchSaving, setBatchSaving] = React.useState(false)
  const [batchShowAll, setBatchShowAll] = React.useState(false)

  const toggleBatchUser = (id: string) => setBatchUserIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const toggleBatchGroup = (id: string) => setBatchGroupIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const setBatchKey = (k: string, v: boolean | null) => setBatchUpdates((u) => ({ ...u, [k]: v }))

  // 一键开通「创建和操作实例沙箱」预设（解锁沙箱全生命周期能力）
  const SANDBOX_GRANT_KEYS = ["blockCreateWorkspace", "blockModifyWorkspace", "blockBatchOps", "blockRestartInstance", "blockModifyResourceExpiry", "blockSwitchVncMode", "blockCustomVncResolution", "blockShareWorkspace", "blockRefreshVncKey"]
  const applySandboxGrantPreset = () => {
    setBatchUpdates((u) => {
      const next = { ...u }
      for (const k of SANDBOX_GRANT_KEYS) next[k] = false // 解锁
      return next
    })
  }

  const batchKwLower = batchKw.trim().toLowerCase()
  const batchFilteredUsers = batchKwLower ? users.filter((u) => u.username.toLowerCase().includes(batchKwLower) || (u.displayName || "").toLowerCase().includes(batchKwLower)) : users
  const batchSetCount = Object.entries(batchUpdates).filter(([, v]) => v !== null && v !== undefined).length
  const batchUnlockCount = Object.entries(batchUpdates).filter(([, v]) => v === false).length

  const runBatch = async () => {
    if (batchUserIds.length === 0 && batchGroupIds.length === 0) { toast.error("请选择至少一个用户或用户组"); return }
    if (batchSetCount === 0) { toast.error("请至少设置一项权限变更（解锁或锁定）"); return }
    setBatchSaving(true)
    try {
      const res = await batchSetPermissionLocksAction({
        userIds: batchUserIds,
        groupIds: batchGroupIds,
        updates: batchUpdates,
        mode: batchMode,
        notify: batchNotify,
      })
      if (res.code === 0 && res.data) {
        toast.success(`批量授权完成：${res.data.userCount} 个用户 + ${res.data.groupCount} 个用户组${res.data.noticesSent > 0 ? `，${res.data.noticesSent} 位用户已收到开通通知` : ""}`)
        void reload(kw || undefined)
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBatchSaving(false)
    }
  }

  const reload = React.useCallback(async (keyword?: string) => {
    setLoading(true)
    try {
      const res = await listPermissionTargetsAction({ ...(keyword ? { keyword } : {}) })
      if (res.code === 0 && res.data) {
        setGlobalLocks(res.data.globalLocks)
        setGroups(res.data.groups)
        setUsers(res.data.users)
        // 当前目标保持（若仍存在），否则回退
        setTargetId((cur) => {
          if (cur && (res.data!.groups.some((g) => g.id === cur) || res.data!.users.some((u) => u.id === cur))) return cur
          return ""
        })
        setDraft((cur) => {
          void cur
          // 目标为空 → 展示全局
          return res.data!.globalLocks
        })
      } else toast.error(res.msg || "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void reload() }, [reload])

  // 目标选择（组/用户）→ 载入其锁
  const pickTarget = (id: string) => {
    setTargetId(id)
    if (scope === "group") {
      const g = groups.find((x) => x.id === id)
      setDraft(g ? { ...g.locks } : {})
    } else if (scope === "user") {
      const u = users.find((x) => x.id === id)
      setDraft(u ? { ...u.locks } : {})
    } else {
      setDraft({ ...globalLocks })
    }
  }

  React.useEffect(() => {
    // 作用域切换 → 重置目标与草稿
    setTargetId("")
    setDraft(scope === "global" ? { ...globalLocks } : {})
  }, [scope])  

  const toggle = (k: string, v: boolean) => setDraft((d) => ({ ...d, [k]: v }))
  const lockedCount = Object.values(draft).filter(Boolean).length

  const save = async () => {
    setSaving(true)
    try {
      if (scope === "global") {
        const res = await setGlobalPermissionLocksAction({ locks: draft })
        if (res.code === 0) { toast.success(`全局权限锁已保存（锁死 ${res.data?.updated ?? 0} 项）`); void reload() }
        else toast.error(res.msg)
      } else if (scope === "group") {
        if (!targetId) { toast.error("请先选择用户组"); return }
        const res = await setGroupPermissionLocksAction({ groupId: targetId, locks: draft })
        if (res.code === 0) { toast.success("用户组权限锁已保存"); void reload(kw || undefined) }
        else toast.error(res.msg)
      } else {
        if (!targetId) { toast.error("请先选择用户"); return }
        const res = await setUserPermissionLocksAction({ userId: targetId, locks: draft })
        if (res.code === 0) { toast.success("用户权限锁已保存"); void reload(kw || undefined) }
        else toast.error(res.msg)
      }
    } finally {
      setSaving(false)
    }
  }

  const targetName = scope === "group" ? groups.find((g) => g.id === targetId)?.name : scope === "user" ? (users.find((u) => u.id === targetId)?.username || "") : "全局"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4 text-teal-600" />权限锁分配矩阵</CardTitle>
          <CardDescription>
            锁死优先语义：用户级锁 &gt; 用户组锁（组员任一命中）&gt; 全局锁（ADMIN 对非查看类全局锁豁免；SUPER_ADMIN 不受任何锁约束）。
            仅保存「锁死」项，未开启项等同继承下层。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 作用域 + 搜索 + 目标选择 */}
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <TabsList>
                <TabsTrigger value="global" className="gap-1.5"><Globe2 className="h-3.5 w-3.5" />全局</TabsTrigger>
                <TabsTrigger value="group" className="gap-1.5"><UsersRound className="h-3.5 w-3.5" />用户组</TabsTrigger>
                <TabsTrigger value="user" className="gap-1.5"><UserRound className="h-3.5 w-3.5" />用户</TabsTrigger>
                {/* r33：批量授权（多用户/组 → 权限矩阵三态批量下发） */}
                <TabsTrigger value="batch" className="gap-1.5"><Layers className="h-3.5 w-3.5" />批量授权</TabsTrigger>
              </TabsList>
            </Tabs>

            {scope === "group" && (
              <select value={targetId} onChange={(e) => pickTarget(e.target.value)} className="h-9 min-w-44 rounded-md border bg-background px-2 text-sm">
                <option value="">选择用户组…</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            )}
            {scope === "user" && (
              <div className="flex items-center gap-1.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={kw}
                    onChange={(e) => setKw(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void reload(kw || undefined) }}
                    placeholder="搜索用户（回车）"
                    className="h-9 w-44 pl-8"
                  />
                </div>
                <select value={targetId} onChange={(e) => pickTarget(e.target.value)} className="h-9 min-w-40 rounded-md border bg-background px-2 text-sm">
                  <option value="">选择用户…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.displayName ? `${u.displayName}（${u.username}）` : u.username}{u.role !== "USER" ? ` · ${u.role}` : ""}</option>)}
                </select>
              </div>
            )}

            <Button size="sm" variant="ghost" onClick={() => void reload(kw || undefined)} title="刷新">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "刷新"}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={onlyLocked} onChange={(e) => setOnlyLocked(e.target.checked)} className="accent-teal-500 h-3 w-3" />
                仅显示已锁项
              </label>
              <Badge variant={lockedCount > 0 ? "destructive" : "secondary"}>已锁 {lockedCount} 项</Badge>
              <Button size="sm" variant="outline" onClick={() => setDraft({})}>全清</Button>
              <Button size="sm" disabled={saving || (scope !== "global" && !targetId)} onClick={() => void save()}>
                {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
                保存{scope !== "global" && targetId ? `（${targetName}）` : ""}
              </Button>
            </div>
          </div>

          {/* r33：批量授权面板（多用户/组多选 + 权限三态矩阵 + 合并模式） */}
          {scope === "batch" && (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                {/* 用户多选 */}
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5" /> 目标用户（可搜索多选）</span>
                    <Badge variant="secondary">已选 {batchUserIds.length}</Badge>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input value={batchKw} onChange={(e) => setBatchKw(e.target.value)} placeholder="搜索用户名/显示名…" className="h-8 pl-8" />
                  </div>
                  <div className="max-h-56 overflow-y-auto space-y-1">
                    {batchFilteredUsers.map((u) => (
                      <label key={u.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                        <input type="checkbox" checked={batchUserIds.includes(u.id)} onChange={() => toggleBatchUser(u.id)} className="accent-teal-500" />
                        <span className="truncate">{u.displayName ? `${u.displayName}（${u.username}）` : u.username}</span>
                        {u.locks["blockCreateWorkspace"] && <Badge variant="outline" className="text-[9px] px-1 text-amber-600 border-amber-300">创建被锁</Badge>}
                      </label>
                    ))}
                    {batchFilteredUsers.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">无匹配用户（先在上方搜索过滤）</p>}
                  </div>
                  {batchUserIds.length > 0 && (
                    <button className="text-[11px] text-muted-foreground underline" onClick={() => setBatchUserIds([])}>清空已选用户</button>
                  )}
                </div>
                {/* 组多选 */}
                <div className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5" /> 目标用户组（整组生效）</span>
                    <Badge variant="secondary">已选 {batchGroupIds.length}</Badge>
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                        <input type="checkbox" checked={batchGroupIds.includes(g.id)} onChange={() => toggleBatchGroup(g.id)} className="accent-teal-500" />
                        <span className="truncate">{g.name}</span>
                        {Object.values(g.locks).some(Boolean) && <Badge variant="outline" className="text-[9px] px-1">已锁 {Object.values(g.locks).filter(Boolean).length} 项</Badge>}
                      </label>
                    ))}
                  </div>
                  {batchGroupIds.length > 0 && (
                    <button className="text-[11px] text-muted-foreground underline" onClick={() => setBatchGroupIds([])}>清空已选组</button>
                  )}
                </div>
              </div>

              {/* 权限矩阵（三态：不变/解锁/锁定） */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={applySandboxGrantPreset} title="解锁创建/重启/修改/批量操作/共享等沙箱全生命周期能力">
                    一键开通「创建和操作实例沙箱」
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setBatchUpdates({})}>清空变更</Button>
                  <button className="text-[11px] text-muted-foreground underline" onClick={() => setBatchShowAll(!batchShowAll)}>
                    {batchShowAll ? "收起全部 30 项锁" : "展开全部 30 项锁（完整颗粒度）"}
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <Badge variant="secondary" className={batchUnlockCount > 0 ? "border-emerald-300 text-emerald-700 dark:text-emerald-400" : undefined}>解锁 {batchUnlockCount} 项</Badge>
                    <Badge variant={batchSetCount - batchUnlockCount > 0 ? "destructive" : "secondary"}>锁定 {batchSetCount - batchUnlockCount} 项</Badge>
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {(batchShowAll ? LOCK_GROUPS : [{ title: "沙箱操作（常用）", keys: SANDBOX_GRANT_KEYS }]).map((g) => (
                    <div key={g.title} className="rounded-lg border p-3 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold">{g.title}</span>
                        <span className="text-[10px] text-muted-foreground">{g.keys.length} 项</span>
                      </div>
                      {g.keys.map((k) => (
                        <div key={k} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                          <div className="min-w-0">
                            <p className="text-sm truncate">{LOCK_LABELS[k] || k}</p>
                            <p className="text-[10px] text-muted-foreground font-mono truncate">{k}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            {([
                              { v: null, label: "不变", cls: "text-muted-foreground" },
                              { v: false, label: "解锁", cls: "text-emerald-600" },
                              { v: true, label: "锁定", cls: "text-red-600" },
                            ] as const).map((opt) => (
                              <button
                                key={String(opt.v)}
                                type="button"
                                onClick={() => setBatchKey(k, opt.v)}
                                className={`h-6 rounded px-2 text-[11px] border transition-colors ${
                                  (batchUpdates[k] === undefined ? null : batchUpdates[k]) === opt.v
                                    ? "border-teal-500 bg-teal-50 dark:bg-teal-950/40 font-medium " + opt.cls
                                    : "border-border hover:bg-muted/60 " + opt.cls
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* 合并模式 + 通知 + 执行 */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">合并模式：</span>
                  {(["merge", "replace"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setBatchMode(m)}
                      className={`h-7 rounded px-2 text-xs border transition-colors ${batchMode === m ? "border-teal-500 bg-teal-50 dark:bg-teal-950/40 font-medium text-teal-700 dark:text-teal-400" : "border-border hover:bg-muted/60 text-muted-foreground"}`}
                      title={m === "merge" ? "在目标现有锁集合上叠加本次变更（仅改动提交的键）" : "以本次设置整体替换目标现有锁集合（未提交键视为解锁）"}
                    >
                      {m === "merge" ? "叠加合并（推荐）" : "整体替换"}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={batchNotify} onChange={(e) => setBatchNotify(e.target.checked)} className="accent-teal-500" />
                  开通时发站内信告知用户
                </label>
                <Button size="sm" className="ml-auto bg-teal-600 hover:bg-teal-700" disabled={batchSaving || (batchUserIds.length === 0 && batchGroupIds.length === 0) || batchSetCount === 0} onClick={() => void runBatch()}>
                  {batchSaving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Layers className="mr-1 h-3.5 w-3.5" />}
                  执行批量授权（{batchUserIds.length + batchGroupIds.length} 个目标）
                </Button>
              </div>
            </div>
          )}

          {/* 三级矩阵（单目标模式） */}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中…</div>
          ) : scope !== "batch" && scope !== "global" && !targetId ? (
            <div className="py-10 text-center text-sm text-muted-foreground">请先选择{scope === "group" ? "用户组" : "用户"}</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {LOCK_GROUPS.map((g) => {
                const items = onlyLocked ? g.keys.filter((k) => draft[k]) : g.keys
                if (items.length === 0) return null
                return (
                  <div key={g.title} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">{g.title}</span>
                      <span className="text-[10px] text-muted-foreground">{g.keys.filter((k) => draft[k]).length}/{g.keys.length} 锁</span>
                    </div>
                    {items.map((k) => (
                      <div key={k} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{LOCK_LABELS[k] || k}</p>
                          <p className="text-[10px] text-muted-foreground font-mono truncate">{k}</p>
                        </div>
                        <Switch checked={draft[k] === true} onCheckedChange={(b) => toggle(k, b)} />
                      </div>
                    ))}
                  </div>
                )
              })}
              {onlyLocked && lockedCount === 0 && (
                <div className="md:col-span-2 py-6 text-center text-sm text-muted-foreground">当前目标无已锁项（全部继承下层）</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 沙箱级策略汇总（深链入口） */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Boxes className="h-4 w-4 text-indigo-600" />沙箱级策略入口（最高优先级覆盖）</CardTitle>
          <CardDescription>
            以下策略按单个沙箱覆盖四级链（优先级高于用户组与全局）；在工作区列表行菜单中设置，此处提供直达入口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { title: "共享否决（沙箱级）", desc: "shareDisabled：单沙箱禁止共享，最高优先级", href: "/admin/workspaces" },
              { title: "录像策略覆盖", desc: "recordingOverride：强制开录 / 强制不录 / 继承", href: "/admin/workspaces" },
              { title: "VNC 会话时长上限", desc: "vncSessionMaxMinutes：沙箱级覆盖用户/组/全局", href: "/admin/workspaces" },
              { title: "硬件权限（17 项）", desc: "摄像头/麦克风/剪贴板等四级链 + 静默特权", href: "/admin/config?tab=HARDWARE" },
              { title: "回放安全策略", desc: "水印/导出管控（沙箱>用户>组>全局）", href: "/admin/workspaces" },
              { title: "回收站保留期", desc: "单条 override 分钟数覆盖（四级链）", href: "/admin/recycle" },
            ].map((item) => (
              <a key={item.title} href={item.href} className="rounded-lg border p-3 hover:border-teal-300 hover:bg-teal-50/40 dark:hover:bg-teal-950/20 transition-colors group">
                <p className="text-sm font-medium group-hover:text-teal-700 dark:group-hover:text-teal-400">{item.title} →</p>
                <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
