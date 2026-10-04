"use client"

// 用户组树形渲染：缩进层级 + 展开折叠 + 行操作（编辑/组员/组管理员/代理/复制/权限锁/删除）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, FileDown, FileUp, KeyRound, MoreHorizontal, Plus, Search, Trash2, X, Loader2, UserX , Video , Recycle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/shared/confirm"
import { deleteGroupAction } from "@/server/actions/groups"
import { batchDeleteGroupsAction } from "@/server/actions/batch"
import { adminEvictGroupSharesAction, adminShareEvictPreviewAction } from "@/server/actions/admin-share-evict"
import { BatchFailuresDialog } from "@/components/shared/batch-ui"
import { GroupFormDialog } from "./group-form"
import { GroupTokenPolicyDialog } from "../users/token-policy-dialog"
import { PlaybackPolicyDialog } from "@/components/recordings/playback-policy-dialog"
import { HardwarePermsDialog } from "@/components/hardware/hardware-perms-dialog"
import { Cpu } from "lucide-react"
import { RetentionPolicyDialog } from "@/components/recycle/retention-policy-dialog"
import {
  MembersDialog, AdminsDialog, ProxiesDialog, LocksDialog, CopyGroupDialog, ImportGroupsDialog,
  type UserOption, type ProxyOption,
} from "./group-dialogs"

export interface AdminGroupNode {
  id: string
  name: string
  description: string | null
  parentId: string | null
  enabled: boolean
  inheritParentQuota: boolean
  quota: Record<string, number | null> | null
  reservedQuota: Record<string, number | null> | null
  tags: string[]
  force2fa: boolean
  allowInternalNetwork: boolean
  allowSecureLocationAccess: boolean
  allowShare: boolean
  policy: Record<string, unknown> | null
  vncSessionMaxMinutes: number | null
  // r33：组级存储配额 + 沙箱最大时长基线
  storageQuotaMb: number | null
  storagePolicy: { recording?: boolean | null; screenshot?: boolean | null; upload?: boolean | null; recordingMb?: number | null; screenshotMb?: number | null; fileMb?: number | null } | null
  maxTtlMinutes: number | null
  allowUnlimitedTtl: boolean | null
  userCount: number
  proxyBindings: string[]
  members: { userId: string; username: string }[]
  admins: { userId: string; username: string; canModifyQuota: boolean }[]
  proxies: { id: string; name: string; status: string }[]
  createdAt: string
  children: AdminGroupNode[]
}

interface GroupsTreeProps {
  roots: AdminGroupNode[]
  allNodes: AdminGroupNode[]
  lockKeys: string[]
  userOptions: UserOption[]
  proxyOptions: ProxyOption[]
}

export function GroupsTree({ roots, allNodes, lockKeys, userOptions, proxyOptions }: GroupsTreeProps) {
  const router = useRouter()
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(roots.map((r) => r.id)))
  const [busyId, setBusyId] = React.useState("")

  // 弹窗状态
  const [formOpen, setFormOpen] = React.useState(false)
  const [formMode, setFormMode] = React.useState<"create" | "edit">("create")
  const [formParentId, setFormParentId] = React.useState<string | null>(null)
  const [editingGroup, setEditingGroup] = React.useState<AdminGroupNode | null>(null)

  const [membersGroup, setMembersGroup] = React.useState<AdminGroupNode | null>(null)
  // 23-a：组员弹窗数据新鲜度 —— membersGroup 捕获的是打开时的节点引用，router.refresh() 后
  // 服务端重渲 allNodes（含最新组员名单），按 id 同步最新节点，避免弹窗内展示过期成员/候选
  const membersGroupLive = membersGroup
    ? allNodes.find((n) => n.id === membersGroup.id) || membersGroup
    : null
  const [adminsGroup, setAdminsGroup] = React.useState<AdminGroupNode | null>(null)
  const [proxiesGroup, setProxiesGroup] = React.useState<AdminGroupNode | null>(null)
  const [locksGroup, setLocksGroup] = React.useState<AdminGroupNode | null>(null)
  // r23-d：组级 API-Key 策略（成员默认基线）
  const [tokenPolicyGroup, setTokenPolicyGroup] = React.useState<AdminGroupNode | null>(null)
  const [pbPolicyGroup, setPbPolicyGroup] = React.useState<AdminGroupNode | null>(null)
  const [hwPolicyGroup, setHwPolicyGroup] = React.useState<AdminGroupNode | null>(null)
  const [retentionGroup, setRetentionGroup] = React.useState<AdminGroupNode | null>(null)
  const [copyGroup, setCopyGroup] = React.useState<AdminGroupNode | null>(null)
  const [deleteGroup, setDeleteGroup] = React.useState<AdminGroupNode | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)

  // r22b：清退本组成员收到的共享（接收者维度批量撤销；超管/ADMIN）
  const [evictGroup, setEvictGroup] = React.useState<AdminGroupNode | null>(null)
  const [evictGroupCount, setEvictGroupCount] = React.useState<{ memberCount: number; activeCount: number } | null>(null)
  const [evictGroupBusy, setEvictGroupBusy] = React.useState(false)

  const openEvictGroup = (node: AdminGroupNode) => {
    setEvictGroup(node)
    setEvictGroupCount(null)
    void adminShareEvictPreviewAction({ kind: "GROUP", id: node.id })
      .then((res) => {
        setEvictGroupCount(res.code === 0 ? { memberCount: res.data?.memberCount ?? 0, activeCount: res.data?.activeCount ?? 0 } : null)
      })
      .catch(() => setEvictGroupCount(null))
  }

  const runEvictGroup = async () => {
    if (!evictGroup) return
    setEvictGroupBusy(true)
    try {
      const res = await adminEvictGroupSharesAction({ groupId: evictGroup.id })
      if (res.code === 0) {
        toast.success(`已清退组「${evictGroup.name}」（${res.data?.memberCount ?? 0} 名成员）：撤销 ${res.data?.revoked ?? 0} 条生效共享`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清退失败")
    } finally {
      setEvictGroupBusy(false)
      setEvictGroup(null)
    }
  }

  // ---- 批量选择与批量删除（多选框 + 逐条失败隔离） ----
  const [selGroups, setSelGroups] = React.useState<string[]>([])
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
  const [batchDeleteBusy, setBatchDeleteBusy] = React.useState(false)
  const [batchFailures, setBatchFailures] = React.useState<{ id: string; reason: string }[] | null>(null)
  const toggleSelGroup = (id: string) => setSelGroups((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]))

  const runBatchDeleteGroups = async () => {
    setBatchDeleteBusy(true)
    try {
      const res = await batchDeleteGroupsAction({ ids: selGroups })
      if (res.code === 0) {
        const n = res.data?.affected ?? 0
        const failed = res.data?.failed ?? []
        if (failed.length > 0) {
          setBatchFailures(failed)
          toast.warning(`批量删除完成：成功 ${n} 个组，失败 ${failed.length} 个（查看原因）`)
        } else {
          toast.success(`已删除 ${n} 个用户组（软删入回收站）`)
        }
        setSelGroups([])
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量删除失败")
    } finally {
      setBatchDeleteBusy(false)
      setBatchDeleteOpen(false)
    }
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ---- r25-b 树内关键词搜索：组名/描述/组员/标签匹配；命中节点及其祖先自动展开 ----
  const [groupFilter, setGroupFilter] = React.useState("")
  const kw = groupFilter.trim().toLowerCase()
  const { visibleRoots, matchCount } = React.useMemo(() => {
    if (!kw) return { visibleRoots: roots, matchCount: allNodes.length }
    const matchSelf = (n: AdminGroupNode) =>
      n.name.toLowerCase().includes(kw)
      || (n.description || "").toLowerCase().includes(kw)
      || n.tags.some((t) => t.toLowerCase().includes(kw))
      || n.members.some((m) => m.username.toLowerCase().includes(kw))
    const keep = new Set<string>()
    let count = 0
    const walk = (n: AdminGroupNode): boolean => {
      const self = matchSelf(n)
      const kept = n.children.map((c) => walk(c)).some(Boolean)
      if (self || kept) {
        keep.add(n.id)
        if (self) count++
        return true
      }
      return false
    }
    roots.forEach((r) => walk(r))
    // 过滤树：仅保留命中节点及其祖先链（复制节点构建新树，不改原引用）
    const filterTree = (nodes: AdminGroupNode[]): AdminGroupNode[] =>
      nodes
        .filter((n) => keep.has(n.id))
        .map((n) => ({ ...n, children: filterTree(n.children) }))
    return { visibleRoots: filterTree(roots), matchCount: count }
  }, [kw, roots, allNodes])
  // 搜索命中时自动展开全部可见节点（祖先链可见即展开）
  React.useEffect(() => {
    if (kw) setExpanded(new Set(allNodes.map((n) => n.id)))
  }, [kw, allNodes])

  const expandAll = () => setExpanded(new Set(allNodes.map((n) => n.id)))
  const collapseAll = () => setExpanded(new Set())

  const doDelete = async () => {
    if (!deleteGroup) return
    setBusyId(deleteGroup.id)
    try {
      const res = await deleteGroupAction({ id: deleteGroup.id })
      if (res.code === 0) {
        toast.success("用户组已删除")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusyId("")
      setDeleteGroup(null)
    }
  }

  // ---- 递归树节点渲染 ----
  const renderNode = (node: AdminGroupNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isOpen = expanded.has(node.id)
    const quota = node.quota
    const lockCount = Object.values(((node.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | undefined) || {}).filter(Boolean).length

    return (
      <div key={node.id}>
        <div
          className="group flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 hover:bg-muted/50 transition-colors"
          style={{ marginLeft: depth * 24 }}
        >
          <Checkbox
            checked={selGroups.includes(node.id)}
            onCheckedChange={() => toggleSelGroup(node.id)}
            className="shrink-0"
            aria-label={`选择 ${node.name}`}
          />
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted"
            onClick={() => hasChildren && toggleExpand(node.id)}
            aria-label={hasChildren ? (isOpen ? "折叠" : "展开") : "无子组"}
            disabled={!hasChildren}
          >
            {hasChildren ? (
              isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium truncate">{node.name}</span>
              {!node.enabled && <Badge variant="outline">已禁用</Badge>}
              {node.force2fa && <Badge variant="destructive" className="text-[10px]">强制2FA</Badge>}
              {node.allowInternalNetwork && <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100">内网✓</Badge>}
              {node.allowShare === false && <Badge variant="destructive" className="text-[10px]">禁共享</Badge>}
              {node.allowSecureLocationAccess && <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100">安全位置✓</Badge>}
              {lockCount > 0 && <Badge variant="secondary" className="text-[10px]">权限锁×{lockCount}</Badge>}
              {node.tags.slice(0, 3).map((t) => (
                <Badge key={t} variant="outline" className="text-[10px] max-w-24 truncate">{t}</Badge>
              ))}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>成员 {node.userCount}</span>
              <span>子组 {node.children.length}</span>
              {quota && (quota.sessions != null || quota.novncSessions != null || quota.diskMb != null) && (
                <span>
                  配额 {quota.sessions ?? "-"}会话/{quota.novncSessions ?? "-"}NoVNC
                  {quota.diskMb != null ? `/${quota.diskMb}MB` : ""}
                </span>
              )}
              {node.inheritParentQuota && node.parentId && <span>继承父组</span>}
              {node.proxyBindings.length > 0 && (
                <span className="truncate max-w-48" title={node.proxyBindings.join(", ")}>
                  代理：{node.proxyBindings.join("、")}
                </span>
              )}
              <span className="hidden sm:inline">创建于 {node.createdAt}</span>
            </div>
            {node.description && (
              <p className="mt-0.5 text-xs text-muted-foreground/80 truncate max-w-md">{node.description}</p>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {node.admins.length > 0 && (
              <Badge variant="secondary" className="hidden md:inline-flex text-[10px] max-w-40 truncate" title={node.admins.map((a) => a.username).join(", ")}>
                管理：{node.admins.map((a) => a.username).join("、")}
              </Badge>
            )}
            <Button
              size="sm" variant="outline"
              onClick={() => { setMembersGroup(node) }}
            >
              组员
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => { setEditingGroup(node); setFormMode("edit"); setFormOpen(true) }}>
                  编辑组
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setMembersGroup(node) }}>组员管理</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setAdminsGroup(node) }}>组管理员</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setProxiesGroup(node) }}>代理绑定</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setLocksGroup(node) }}>权限锁</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setHwPolicyGroup(node) }}>
                  <Cpu className="mr-1.5 h-4 w-4 text-indigo-600" /> 硬件权限基线（17 项）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setPbPolicyGroup(node) }}>
                  <Video className="mr-1.5 h-4 w-4 text-teal-600" /> 回放安全策略（水印/导出）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setRetentionGroup(node) }}>
                  <Recycle className="mr-1.5 h-4 w-4 text-amber-600" /> 回收站保留期（天）
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setTokenPolicyGroup(node) }}>
                  <KeyRound className="mr-1.5 h-4 w-4" /> API-Key 策略
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setCopyGroup(node) }}>复制组</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openEvictGroup(node)}>
                  <UserX className="mr-1.5 h-4 w-4 text-rose-600" /> 清退组内收到的共享
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setFormMode("create")
                    setFormParentId(node.id)
                    setEditingGroup(null)
                    setFormOpen(true)
                  }}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> 创建子组
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteGroup(node)}>
                  删除组
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {isOpen && hasChildren && (
          <div className="mt-1.5 space-y-1.5">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* r25-b 组树关键词搜索：名称/描述/组员/标签实时过滤 + 自动展开 */}
        <div className="flex min-w-56 flex-1 md:max-w-xs items-center gap-2 rounded-md border px-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            placeholder="搜索用户组 / 描述 / 组员 / 标签…"
            className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label="搜索用户组"
          />
          {groupFilter && (
            <button type="button" aria-label="清空搜索" onClick={() => setGroupFilter("")} className="rounded p-0.5 text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={() => { setFormMode("create"); setFormParentId(null); setEditingGroup(null); setFormOpen(true) }}>
          <Plus className="mr-1 h-4 w-4" /> 新建用户组
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <FileUp className="mr-1 h-4 w-4" /> 导入JSON
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.open("/api/export/groups", "_blank")}>
          <FileDown className="mr-1 h-4 w-4" /> 导出JSON
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={expandAll}>全部展开</Button>
          <Button size="sm" variant="ghost" onClick={collapseAll}>全部折叠</Button>
        </div>
      </div>

      {/* 批量操作条（勾选后出现） */}
      {selGroups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50/60 dark:bg-teal-950/30 dark:border-teal-800 px-2 py-1.5">
          <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">已选 {selGroups.length} 个组</Badge>
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900"
            disabled={batchDeleteBusy}
            onClick={() => setBatchDeleteOpen(true)}
          >
            {batchDeleteBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
            批量删除
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.open(`/api/export/groups?ids=${encodeURIComponent(selGroups.join(","))}`, "_blank")}>
            <FileDown className="mr-1 h-3.5 w-3.5" /> 导出选中
          </Button>
          <button
            type="button"
            className="ml-1 p-1 rounded hover:bg-muted text-muted-foreground"
            onClick={() => setSelGroups([])}
            aria-label="清空选择"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 树 */}
      <div className="space-y-1.5">
        {allNodes.length === 0 && (
          <div className="rounded-lg border bg-card py-12 text-center text-sm text-muted-foreground">
            暂无用户组，点击「新建用户组」创建第一个组织节点
          </div>
        )}
        {kw && matchCount === 0 && (
          <div className="rounded-lg border bg-card py-12 text-center text-sm text-muted-foreground">
            无匹配「{groupFilter}」的组（可搜组名 / 描述 / 组员 / 标签）
          </div>
        )}
        {visibleRoots.map((r) => renderNode(r, 0))}
      </div>

      {/* 新建/编辑弹窗 */}
      <GroupFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={formMode}
        group={formMode === "edit" ? editingGroup : null}
        defaultParentId={formMode === "create" ? formParentId : undefined}
        allNodes={allNodes.map((n) => ({ id: n.id, name: n.name, parentId: n.parentId }))}
      />

      {/* 组员管理 */}
      <MembersDialog
        open={!!membersGroup}
        onOpenChange={(v) => !v && setMembersGroup(null)}
        group={membersGroup ? { id: membersGroup.id, name: membersGroup.name } : null}
        members={membersGroupLive?.members || []}
        userOptions={userOptions}
      />

      {/* 组管理员 */}
      <AdminsDialog
        open={!!adminsGroup}
        onOpenChange={(v) => !v && setAdminsGroup(null)}
        group={adminsGroup ? { id: adminsGroup.id, name: adminsGroup.name } : null}
        admins={adminsGroup?.admins || []}
        userOptions={userOptions}
      />

      {/* 代理绑定 */}
      <ProxiesDialog
        open={!!proxiesGroup}
        onOpenChange={(v) => !v && setProxiesGroup(null)}
        group={proxiesGroup ? { id: proxiesGroup.id, name: proxiesGroup.name } : null}
        proxies={proxiesGroup?.proxies || []}
        proxyOptions={proxyOptions}
      />

      {/* 权限锁 */}
      <LocksDialog
        open={!!locksGroup}
        onOpenChange={(v) => !v && setLocksGroup(null)}
        group={locksGroup ? { id: locksGroup.id, name: locksGroup.name } : null}
        lockKeys={lockKeys}
        currentLocks={
          ((locksGroup?.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | undefined) || {}
        }
      />

      {/* r23-d：组级 API-Key 策略基线（组内成员默认；用户级可覆盖收紧） */}
      <GroupTokenPolicyDialog
        open={!!tokenPolicyGroup}
        onOpenChange={(v) => !v && setTokenPolicyGroup(null)}
        group={tokenPolicyGroup ? { id: tokenPolicyGroup.id, name: tokenPolicyGroup.name } : null}
      />
      {retentionGroup && (
        <RetentionPolicyDialog
          open={!!retentionGroup}
          onOpenChange={(v) => !v && setRetentionGroup(null)}
          scope="group"
          targetId={retentionGroup.id}
          targetName={retentionGroup.name}
          initialDays={null}
        />
      )}
      {hwPolicyGroup && (
        <HardwarePermsDialog
          open={!!hwPolicyGroup}
          onOpenChange={(v) => !v && setHwPolicyGroup(null)}
          scope="group"
          targetId={hwPolicyGroup.id}
          targetName={hwPolicyGroup.name}
        />
      )}
      {pbPolicyGroup && (
        <PlaybackPolicyDialog
          open={!!pbPolicyGroup}
          onOpenChange={(v) => !v && setPbPolicyGroup(null)}
          scope="group"
          targetId={pbPolicyGroup.id}
          targetName={pbPolicyGroup.name}
        />
      )}

      {/* 复制 */}
      <CopyGroupDialog
        open={!!copyGroup}
        onOpenChange={(v) => !v && setCopyGroup(null)}
        group={copyGroup ? { id: copyGroup.id, name: copyGroup.name } : null}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteGroup}
        onOpenChange={(v) => !v && setDeleteGroup(null)}
        title="删除用户组"
        description={`确认删除用户组 ${deleteGroup?.name || ""}？\n· 组内有成员 / 子组 / 代理绑定 / 运行中会话时将被拒绝\n· 通过校验后软删除并清理组管理员与代理绑定`}
        requirePhrase="DELETE"
        destructive
        onConfirm={doDelete}
      />

      {/* r22b：清退本组成员收到的共享（确认时展示将撤销条数） */}
      <ConfirmDialog
        open={!!evictGroup}
        onOpenChange={(v) => { if (!v && !evictGroupBusy) setEvictGroup(null) }}
        title="清退组内收到的共享"
        description={`确认清退用户组 ${evictGroup?.name || ""} 全体成员收到的全部工作区共享？\n· 成员 ${evictGroupCount?.memberCount ?? evictGroup?.userCount ?? 0} 名，将撤销其作为接收者的生效共享 ${evictGroupCount ? `${evictGroupCount.activeCount} 条` : "…（统计中）"}\n· 相关成员立即失去访问权，不影响工作区所有权与他人\n· 审计记录保留，可由所有者重新共享恢复`}
        destructive
        confirmText="确认清退"
        loading={evictGroupBusy}
        onConfirm={runEvictGroup}
      />

      {/* 导入JSON */}
      <ImportGroupsDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* 批量删除确认 + 失败清单 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && !batchDeleteBusy && setBatchDeleteOpen(v)}
        title={`批量删除 ${selGroups.length} 个用户组`}
        description={`将软删除选中的 ${selGroups.length} 个用户组：\n· 有未删除子组 / 有成员的组会跳过并在结果中列明原因\n· 通过校验的组进入回收站，可追溯恢复`}
        requirePhrase="DELETE"
        destructive
        loading={batchDeleteBusy}
        confirmText="确认批量删除"
        onConfirm={runBatchDeleteGroups}
      />
      <BatchFailuresDialog failures={batchFailures} onClose={() => setBatchFailures(null)} />
    </div>
  )
}
