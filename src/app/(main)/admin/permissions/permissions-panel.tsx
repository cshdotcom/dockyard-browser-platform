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
import { Loader2, Save, Lock, Search, Globe2, UsersRound, UserRound, Boxes, X } from "lucide-react"
import { listPermissionTargetsAction, setGlobalPermissionLocksAction, setUserPermissionLocksAction, setGroupPermissionLocksAction } from "@/server/actions/permissions-center"

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

type Scope = "global" | "group" | "user"

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

          {/* 三级矩阵 */}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中…</div>
          ) : scope !== "global" && !targetId ? (
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
