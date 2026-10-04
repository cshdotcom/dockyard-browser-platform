"use client"

// 用户组树形渲染：缩进层级 + 展开折叠 + 行操作（编辑/组员/组管理员/代理/复制/权限锁/安全策略/删除）
// r28b：URL 筛选参数模式对齐用户管理（keyword/enabled/创建日期范围走 searchParams）
//      + 批量启用/禁用/移动父级/全选 + 行内 2FA 强制开关（乐观更新失败回滚）+ CSV 导出

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronDown, ChevronRight, FileDown, FileUp, KeyRound, MoreHorizontal, Plus, Search, Trash2, X,
  Loader2, UserX, ShieldAlert, FolderInput, Power, Ban, CheckSquare,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/shared/confirm"
import { deleteGroupAction, setGroupForce2faAction, batchSetGroupStatusAction } from "@/server/actions/groups"
import { batchDeleteGroupsAction } from "@/server/actions/batch"
import { adminEvictGroupSharesAction, adminShareEvictPreviewAction } from "@/server/actions/admin-share-evict"
import { BatchFailuresDialog } from "@/components/shared/batch-ui"
import { GroupFormDialog } from "./group-form"
import { GroupTokenPolicyDialog } from "../users/token-policy-dialog"
import {
  MembersDialog, AdminsDialog, ProxiesDialog, LocksDialog, CopyGroupDialog, ImportGroupsDialog,
  GroupSecurityDialog, BatchMoveParentDialog,
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
  vncSessionMaxMinutes: number | null
  policy: Record<string, unknown> | null
  userCount: number
  twoFactorReady: number
  proxyBindings: string[]
  members: { userId: string; username: string }[]
  admins: { userId: string; username: string; canModifyQuota: boolean }[]
  proxies: { id: string; name: string; status: string }[]
  createdAt: string
  children: AdminGroupNode[]
}

interface GroupsTreeFilter {
  keyword?: string
  enabled?: string
  createdFrom?: string
  createdTo?: string
  /** 当前筛选下被排除的组数（服务端过滤统计） */
  filteredOut: number
}

interface GroupsTreeProps {
  roots: AdminGroupNode[]
  allNodes: AdminGroupNode[]
  lockKeys: string[]
  userOptions: UserOption[]
  proxyOptions: ProxyOption[]
  filter: GroupsTreeFilter
}

export function GroupsTree({ roots, allNodes, lockKeys, userOptions, proxyOptions, filter }: GroupsTreeProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(roots.map((r) => r.id)))
  const [busyId, setBusyId] = React.useState("")

  // ---- r28b：URL 筛选参数（对齐用户管理 pushQuery 模式） ----
  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  // 关键词防抖（350ms → URL keyword，服务端过滤树）
  const [keywordInput, setKeywordInput] = React.useState(filter.keyword || "")
  React.useEffect(() => {
    setKeywordInput(filter.keyword || "")
  }, [filter.keyword])
  React.useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = keywordInput.trim()
      if ((filter.keyword || "") !== trimmed) {
        pushQuery({ keyword: trimmed || undefined })
      }
    }, 350)
    return () => clearTimeout(t)
  }, [keywordInput])

  // 筛选中（关键词非空或状态/日期条件）自动展开全部可见节点
  const hasFilter = !!(filter.keyword?.trim() || filter.enabled === "true" || filter.enabled === "false" || filter.createdFrom || filter.createdTo)
  React.useEffect(() => {
    if (hasFilter) setExpanded(new Set(allNodes.map((n) => n.id)))
  }, [hasFilter, allNodes])

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
  const [copyGroup, setCopyGroup] = React.useState<AdminGroupNode | null>(null)
  const [deleteGroup, setDeleteGroup] = React.useState<AdminGroupNode | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)
  // r28b：安全策略弹窗（2FA 强制状态与生效人数）
  const [securityGroup, setSecurityGroup] = React.useState<AdminGroupNode | null>(null)

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

  // ---- 批量选择（多选框 + 全选 + 逐条失败隔离） ----
  const [selGroups, setSelGroups] = React.useState<string[]>([])
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
  const [batchDeleteBusy, setBatchDeleteBusy] = React.useState(false)
  const [batchStatusBusy, setBatchStatusBusy] = React.useState("")
  const [batchMoveOpen, setBatchMoveOpen] = React.useState(false)
  const [batchFailures, setBatchFailures] = React.useState<{ id: string; reason: string }[] | null>(null)
  const toggleSelGroup = (id: string) => setSelGroups((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]))
  // r28b：全选/反选（当前筛选后可见的全部组，上限 500 与批量 action 一致）
  const allVisibleIds = React.useMemo(() => allNodes.map((n) => n.id).slice(0, 500), [allNodes])
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selGroups.includes(id))
  const toggleSelectAll = () => {
    if (allSelected) setSelGroups((prev) => prev.filter((id) => !allVisibleIds.includes(id)))
    else setSelGroups((prev) => [...new Set([...prev, ...allVisibleIds])])
  }

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

  // r28b：批量启用/禁用（失败清单复用 BatchFailuresDialog）
  const runBatchStatus = async (enabled: boolean) => {
    setBatchStatusBusy(enabled ? "enable" : "disable")
    try {
      const res = await batchSetGroupStatusAction({ ids: selGroups, enabled })
      if (res.code === 0) {
        const failed = res.data?.failed ?? []
        if (failed.length > 0) {
          setBatchFailures(failed)
          toast.warning(`批量${enabled ? "启用" : "禁用"}完成：成功 ${res.data?.affected ?? 0} 个组，跳过 ${failed.length} 个（查看原因）`)
        } else {
          toast.success(`已${enabled ? "启用" : "禁用"} ${res.data?.affected ?? 0} 个用户组`)
        }
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `批量${enabled ? "启用" : "禁用"}失败`)
    } finally {
      setBatchStatusBusy("")
    }
  }

  // r28b：行内 2FA 强制开关（乐观更新失败回滚：本地 override 立即生效，失败清除回滚）
  const [force2faOverride, setForce2faOverride] = React.useState<Map<string, boolean>>(new Map())
  const [force2faBusyId, setForce2faBusyId] = React.useState("")
  const toggleRowForce2fa = async (node: AdminGroupNode, next: boolean) => {
    if (force2faBusyId) return
    setForce2faOverride((prev) => new Map(prev).set(node.id, next))
    setForce2faBusyId(node.id)
    try {
      const res = await setGroupForce2faAction({ id: node.id, force2fa: next })
      if (res.code === 0 && res.data) {
        toast.success(next
          ? `已开启「${node.name}」强制 2FA：${Math.max(0, res.data.affectedMembers - res.data.twoFactorReady)} 名未开通成员登录时将被要求设置`
          : `已关闭「${node.name}」强制 2FA`)
        router.refresh()
      } else {
        setForce2faOverride((prev) => {
          const m = new Map(prev)
          m.delete(node.id)
          return m
        })
        toast.error(res.msg)
      }
    } catch (e) {
      setForce2faOverride((prev) => {
        const m = new Map(prev)
        m.delete(node.id)
        return m
      })
      toast.error(e instanceof Error ? e.message : "设置失败")
    } finally {
      setForce2faBusyId("")
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

  // ---- r28b：CSV 导出（当前筛选结果；选中优先） ----
  const exportCsv = (ids?: string[]) => {
    const params = new URLSearchParams()
    params.set("format", "csv")
    if (ids && ids.length > 0) {
      params.set("ids", ids.join(","))
    } else {
      if (filter.keyword?.trim()) params.set("keyword", filter.keyword.trim())
      if (filter.enabled === "true" || filter.enabled === "false") params.set("enabled", filter.enabled)
      if (filter.createdFrom) params.set("createdFrom", filter.createdFrom)
      if (filter.createdTo) params.set("createdTo", filter.createdTo)
    }
    window.open(`/api/export/groups?${params.toString()}`, "_blank")
  }

  // ---- 递归树节点渲染 ----
  const renderNode = (node: AdminGroupNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isOpen = expanded.has(node.id)
    const quota = node.quota
    const lockCount = Object.values(((node.policy as Record<string, unknown> | null)?.permissionLocks as Record<string, boolean> | undefined) || {}).filter(Boolean).length
    // 乐观值：override 优先（行内 2FA 开关切换中）
    const effectiveForce2fa = force2faOverride.has(node.id) ? force2faOverride.get(node.id)! : node.force2fa

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
              {effectiveForce2fa && <Badge variant="destructive" className="text-[10px]">强制2FA</Badge>}
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
            {/* r28b：行内 2FA 强制快捷开关（对齐用户管理 2FA 管控入口；乐观更新失败回滚） */}
            <div className="flex items-center gap-1 rounded-md border px-2 py-1" title={`组级强制 2FA：组内 ${Math.max(0, node.userCount - node.twoFactorReady)} 名未开通成员登录时将被强制设置`}>
              <ShieldAlert className={`h-3.5 w-3.5 ${effectiveForce2fa ? "text-amber-600" : "text-muted-foreground"}`} />
              <Switch
                checked={effectiveForce2fa}
                disabled={force2faBusyId === node.id}
                onCheckedChange={(v) => toggleRowForce2fa(node, v)}
                aria-label={`${node.name} 组级强制2FA开关`}
                className="scale-90"
              />
            </div>
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
                <DropdownMenuItem onClick={() => { setSecurityGroup(node) }}>
                  <ShieldAlert className="mr-1.5 h-4 w-4 text-amber-600" /> 安全策略（2FA）
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
      {/* 顶部操作栏（r28b：URL 筛选参数模式对齐用户管理——搜索/状态/日期范围） */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-56 flex-1 md:max-w-xs items-center gap-2 rounded-md border px-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="搜索用户组 / 描述 / 组员 / 标签…"
            className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label="搜索用户组"
          />
          {keywordInput && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => { setKeywordInput(""); pushQuery({ keyword: undefined }) }}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={filter.enabled || "all"} onValueChange={(v) => pushQuery({ enabled: v === "all" ? undefined : v })}>
          <SelectTrigger className="h-9 w-28 text-xs" aria-label="启停状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="true">已启用</SelectItem>
            <SelectItem value="false">已禁用</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>创建于</span>
          <Input
            type="date"
            className="h-9 w-36"
            value={filter.createdFrom || ""}
            onChange={(e) => pushQuery({ createdFrom: e.target.value || undefined })}
            aria-label="创建日期起"
          />
          <span>至</span>
          <Input
            type="date"
            className="h-9 w-36"
            value={filter.createdTo || ""}
            onChange={(e) => pushQuery({ createdTo: e.target.value || undefined })}
            aria-label="创建日期止"
          />
        </div>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={() => { setFormMode("create"); setFormParentId(null); setEditingGroup(null); setFormOpen(true) }}>
          <Plus className="mr-1 h-4 w-4" /> 新建用户组
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <FileUp className="mr-1 h-4 w-4" /> 导入 (JSON/CSV)
        </Button>
        <Button size="sm" variant="outline" onClick={() => exportCsv()}>
          <FileDown className="mr-1 h-4 w-4" /> 导出CSV
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.open("/api/export/groups", "_blank")}>
          <FileDown className="mr-1 h-4 w-4" /> 导出JSON
        </Button>
        {(filter.keyword || filter.enabled || filter.createdFrom || filter.createdTo) && (
          <button
            type="button"
            onClick={() => { setKeywordInput(""); pushQuery({ keyword: undefined, enabled: undefined, createdFrom: undefined, createdTo: undefined }) }}
            className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="清空全部筛选"
          >
            <X className="h-3.5 w-3.5" /> 清空筛选
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={expandAll}>全部展开</Button>
          <Button size="sm" variant="ghost" onClick={collapseAll}>全部折叠</Button>
        </div>
      </div>

      {/* 筛选结果提示 */}
      {filter.filteredOut > 0 && (
        <p className="text-xs text-muted-foreground">
          当前筛选命中 {allNodes.length} 个组（已排除 {filter.filteredOut} 个不匹配）
        </p>
      )}

      {/* 批量操作条（勾选后出现；r28b 对齐用户管理批量按钮布局 + 全选） */}
      {selGroups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50/60 dark:bg-teal-950/30 dark:border-teal-800 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="全选当前可见组" />
            <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">已选 {selGroups.length} 个组</Badge>
          </div>
          <Button size="sm" variant="outline" disabled={!!batchStatusBusy} onClick={() => runBatchStatus(true)}>
            {batchStatusBusy === "enable" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Power className="mr-1 h-3.5 w-3.5 text-emerald-600" />}
            批量启用
          </Button>
          <Button size="sm" variant="outline" disabled={!!batchStatusBusy} onClick={() => runBatchStatus(false)}>
            {batchStatusBusy === "disable" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1 h-3.5 w-3.5 text-muted-foreground" />}
            批量禁用
          </Button>
          <Button size="sm" variant="outline" onClick={() => setBatchMoveOpen(true)}>
            <FolderInput className="mr-1 h-3.5 w-3.5" /> 批量移动父级
          </Button>
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
            <FileDown className="mr-1 h-3.5 w-3.5" /> 导出选中JSON
          </Button>
          <Button size="sm" variant="secondary" onClick={() => exportCsv(selGroups)}>
            <CheckSquare className="mr-1 h-3.5 w-3.5" /> 导出选中CSV
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
            {hasFilter ? "当前筛选无匹配的用户组（可调整关键词 / 状态 / 日期范围）" : "暂无用户组，点击「新建用户组」创建第一个组织节点"}
          </div>
        )}
        {roots.map((r) => renderNode(r, 0))}
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

      {/* r28b：安全策略弹窗（2FA 强制状态与生效人数） */}
      <GroupSecurityDialog
        open={!!securityGroup}
        onOpenChange={(v) => !v && setSecurityGroup(null)}
        group={securityGroup ? { id: securityGroup.id, name: securityGroup.name, force2fa: securityGroup.force2fa, userCount: securityGroup.userCount, twoFactorReady: securityGroup.twoFactorReady } : null}
      />

      {/* r23-d：组级 API-Key 策略基线（组内成员默认；用户级可覆盖收紧） */}
      <GroupTokenPolicyDialog
        open={!!tokenPolicyGroup}
        onOpenChange={(v) => !v && setTokenPolicyGroup(null)}
        group={tokenPolicyGroup ? { id: tokenPolicyGroup.id, name: tokenPolicyGroup.name } : null}
      />

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

      {/* 导入（JSON / CSV） */}
      <ImportGroupsDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* r28b：批量移动父级弹窗 */}
      <BatchMoveParentDialog
        open={batchMoveOpen}
        onOpenChange={setBatchMoveOpen}
        ids={selGroups}
        allNodes={allNodes.map((n) => ({ id: n.id, name: n.name, parentId: n.parentId }))}
        onFailures={(failed) => setBatchFailures(failed)}
      />

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
