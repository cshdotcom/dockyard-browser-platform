"use client"

// 用户管理交互表格：批量操作 / 行操作菜单 / CSV导入导出 / 2FA管控 / 临时密码与备份码展示

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Copy, FileDown, FileUp, Plus, MoreHorizontal, ShieldAlert, ShieldBan, Users2, Timer, KeyRound, Trash2, Share2, Ban, Undo2, UserX } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { UserAvatar } from "@/components/shared/user-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  importUsersCsvAction, batchSetUserStatusAction, batchMoveGroupAction, batchResetQuotaAction,
  kickUserSessionsAction, deleteUserAction, unlockUserAction, adminResetPasswordAction,
  setForce2faAction, resetUserTotpAction, clearTrustedDevicesAction, resetBackupCodesAction,
  setUserNetworkPolicyAction, setUserShareAllowedAction,
  type CsvImportReport,
} from "@/server/actions/users"
import { batchDeleteUsersAction } from "@/server/actions/batch"
import { adminEvictUserSharesAction, adminShareEvictPreviewAction } from "@/server/actions/admin-share-evict"
import { BatchFailuresDialog } from "@/components/shared/batch-ui"
import { UserFormDialog, type GroupOption } from "./user-form"
import { UserApiTokensDialog } from "./user-api-tokens"

export interface AdminUserRow {
  id: string
  username: string
  email: string | null
  displayName: string | null
  hasAvatar: boolean
  role: string
  enabled: boolean
  frozen: boolean
  emailVerified: boolean
  mustChangePassword: boolean
  twoFactorEnabled: boolean
  force2faSetup: boolean
  lockedUntil: string | null
  failedLoginCount: number
  quota: Record<string, number | null> | null
  lastLoginAt: string | null
  lastLoginIp: string | null
  createdAt: string
  groups: string[]
  allowInternalNetwork: boolean | null // 用户级覆盖（null=继承组）
  vncSessionMaxMinutes: number | null // 用户级 VNC 连接总时长上限（null=继承组，0=不限）
  shareAllowed: boolean | null // r13c：用户级共享开关（null=继承组，true=强制允许，false=强制禁止）
  allowSecureLocationAccess: boolean | null
  netPolicy: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; source: string } | null // 生效快照
}

interface UsersTableProps {
  rows: AdminUserRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  groupOptions: GroupOption[]
  viewerRole: string // 当前操作者角色（API 密钥代管对话框用）
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "超级管理员",
  ADMIN: "管理员",
  GROUP_ADMIN: "组管理员",
  USER: "用户",
}

const POLICY_SOURCE_LABEL: Record<string, string> = {
  USER: "用户覆盖",
  GROUP: "组继承",
  GLOBAL_DEFAULT: "全局默认",
}

// 网络策略徽章：内网 / 容器安全位置（生效值 + 覆盖来源）
function NetPolicyCell({ row }: { row: AdminUserRow }) {
  const np = row.netPolicy
  const ov = (v: boolean | null) => (v === null ? "" : "（覆盖）")
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-1.5">
        <span className={np?.allowInternalNetwork ? "text-emerald-600" : "text-rose-600"}>
          {np?.allowInternalNetwork ? "内网✓" : "内网✕"}
        </span>
        {ov(row.allowInternalNetwork) && <Badge variant="secondary" className="text-[9px] px-1">覆盖</Badge>}
      </div>
      <div className="flex items-center gap-1.5">
        <span className={np?.allowSecureLocationAccess ? "text-emerald-600" : "text-rose-600"}>
          {np?.allowSecureLocationAccess ? "安全位置✓" : "安全位置✕"}
        </span>
        {ov(row.allowSecureLocationAccess) && <Badge variant="secondary" className="text-[9px] px-1">覆盖</Badge>}
      </div>
      <p className="text-[10px] text-muted-foreground">{POLICY_SOURCE_LABEL[np?.source || "GLOBAL_DEFAULT"] || np?.source}</p>
    </div>
  )
}

export function UsersTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, groupOptions, viewerRole }: UsersTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [sel, setSel] = React.useState<string[]>([])
  React.useEffect(() => setSel([]), [rows])

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  // ---- 弹窗状态 ----
  const [formOpen, setFormOpen] = React.useState(false)
  const [formMode, setFormMode] = React.useState<"create" | "edit">("create")
  const [editingUser, setEditingUser] = React.useState<AdminUserRow | null>(null)

  // API 密钥代管
  const [apiTokenUser, setApiTokenUser] = React.useState<AdminUserRow | null>(null)

  const [importOpen, setImportOpen] = React.useState(false)
  const [importMode, setImportMode] = React.useState<"skip" | "update">("skip")
  const [importText, setImportText] = React.useState("")
  const [importReport, setImportReport] = React.useState<CsvImportReport | null>(null)
  const [importBusy, setImportBusy] = React.useState(false)

  const [batchGroupOpen, setBatchGroupOpen] = React.useState(false)
  const [batchGroupIds, setBatchGroupIds] = React.useState<string[]>([])
  const [batchQuotaOpen, setBatchQuotaOpen] = React.useState(false)
  const [bqSessions, setBqSessions] = React.useState(10)
  const [bqNovnc, setBqNovnc] = React.useState(4)
  const [bqDisk, setBqDisk] = React.useState(2048)

  const [deleteUser, setDeleteUser] = React.useState<AdminUserRow | null>(null)
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)

  // r22b：清退该用户收到的共享（接收者维度批量撤销；超管/ADMIN）
  const [evictShareUser, setEvictShareUser] = React.useState<AdminUserRow | null>(null)
  const [evictShareCount, setEvictShareCount] = React.useState<number | null>(null)
  const [evictShareBusy, setEvictShareBusy] = React.useState(false)
  const [batchDeleteBusy, setBatchDeleteBusy] = React.useState(false)
  const [batchFailures, setBatchFailures] = React.useState<{ id: string; reason: string }[] | null>(null)
  const [tempPassword, setTempPassword] = React.useState<{ username: string; password: string } | null>(null)
  const [backupCodes, setBackupCodes] = React.useState<{ username: string; codes: string[] } | null>(null)
  const [busyAction, setBusyAction] = React.useState("")

  // ---- 通用 action 调用 ----
  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusyAction(name)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally {
      setBusyAction("")
    }
  }

  // ---- CSV 导出 ----
  const exportCsv = (ids?: string[]) => {
    const url = ids && ids.length > 0 ? `/api/export/users?ids=${encodeURIComponent(ids.join(","))}` : "/api/export/users"
    window.open(url, "_blank")
  }

  // ---- r22b：打开清退确认（预加载将撤销条数） ----
  const openEvictShare = (row: AdminUserRow) => {
    setEvictShareUser(row)
    setEvictShareCount(null)
    void adminShareEvictPreviewAction({ kind: "USER", id: row.id })
      .then((res) => {
        setEvictShareCount(res.code === 0 ? res.data?.activeCount ?? 0 : null)
      })
      .catch(() => setEvictShareCount(null))
  }

  const runEvictShare = async () => {
    if (!evictShareUser) return
    setEvictShareBusy(true)
    try {
      const res = await adminEvictUserSharesAction({ targetUserId: evictShareUser.id })
      if (res.code === 0) {
        toast.success(`已清退用户「${evictShareUser.username}」收到的 ${res.data?.revoked ?? 0} 条生效共享`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "清退失败")
    } finally {
      setEvictShareBusy(false)
      setEvictShareUser(null)
    }
  }

  // ---- 批量删除（软删入回收站语义：禁用 + 会话下线 + 令牌作废；逐条失败隔离）----
  const runBatchDelete = async () => {
    setBatchDeleteBusy(true)
    try {
      const res = await batchDeleteUsersAction({ ids: sel })
      if (res.code === 0) {
        const n = res.data?.affected ?? 0
        const failed = res.data?.failed ?? []
        if (failed.length > 0) {
          setBatchFailures(failed)
          toast.warning(`批量删除完成：成功 ${n} 条，失败 ${failed.length} 条（点击查看原因）`)
        } else {
          toast.success(`已删除 ${n} 个用户（软删除，可在审计与数据层面追溯）`)
        }
        setSel([])
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

  // ---- CSV 导入 ----
  const runImport = async () => {
    if (!importText.trim()) {
      toast.error("请粘贴CSV内容或选择文件")
      return
    }
    setImportBusy(true)
    try {
      const res = await importUsersCsvAction({ text: importText, mode: importMode })
      if (res.code === 0 && res.data) {
        setImportReport(res.data)
        toast.success(`导入完成：成功 ${res.data.success} / 失败 ${res.data.failed}`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败")
    } finally {
      setImportBusy(false)
    }
  }

  const onImportFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setImportText(String(reader.result || ""))
    reader.readAsText(file)
  }

  // ---- 列定义 ----
  const columns = [
    {
      key: "username",
      title: "用户",
      sortable: true,
      render: (row: AdminUserRow) => (
        <div className="flex items-center gap-2.5 min-w-0">
          <UserAvatar userId={row.hasAvatar ? row.id : null} name={row.displayName || row.username} size={34} />
          <div className="min-w-0">
            <p className="font-medium truncate" title={row.displayName || row.username}>
              {row.username}
              {row.displayName ? <span className="ml-1.5 text-xs text-muted-foreground">{row.displayName}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground truncate" title={row.email || ""}>{row.email || "未绑定邮箱"}</p>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      title: "角色",
      render: (row: AdminUserRow) => (
        <Badge variant={row.role === "SUPER_ADMIN" ? "default" : row.role === "ADMIN" ? "secondary" : "outline"} className={row.role === "SUPER_ADMIN" ? "bg-teal-600 hover:bg-teal-600" : undefined}>
          {ROLE_LABEL[row.role] || row.role}
        </Badge>
      ),
    },
    {
      key: "enabled",
      title: "状态",
      render: (row: AdminUserRow) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={row.enabled ? "RUNNING" : "DISABLED"} map={{ RUNNING: "success", DISABLED: "outline" }} />
          {row.frozen && <Badge variant="destructive">冻结</Badge>}
          {row.lockedUntil && <Badge variant="destructive">锁定</Badge>}
          {row.mustChangePassword && <Badge variant="secondary">待改密</Badge>}
        </div>
      ),
    },
    {
      key: "groups",
      title: "所属组",
      render: (row: AdminUserRow) =>
        row.groups.length === 0 ? (
          <span className="text-xs text-muted-foreground">-</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.groups.slice(0, 2).map((g) => (
              <Badge key={g} variant="outline" className="text-[10px] max-w-28 truncate">{g}</Badge>
            ))}
            {row.groups.length > 2 && <Badge variant="secondary" className="text-[10px]">+{row.groups.length - 2}</Badge>}
          </div>
        ),
    },
    {
      key: "twoFactorEnabled",
      title: "2FA",
      render: (row: AdminUserRow) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={row.twoFactorEnabled ? "RUNNING" : "DISABLED"} map={{ RUNNING: "success", DISABLED: "outline" }} />
          {row.force2faSetup && <Badge variant="destructive" className="text-[10px]">强制中</Badge>}
        </div>
      ),
    },
    {
      key: "netPolicy",
      title: "网络策略",
      render: (row: AdminUserRow) => <NetPolicyCell row={row} />,
    },
    {
      key: "lastLoginAt",
      title: "最后登录",
      sortable: true,
      render: (row: AdminUserRow) => (
        <div className="text-xs">
          <p className={row.lastLoginAt ? "" : "text-muted-foreground"}>{row.lastLoginAt || "从未登录"}</p>
          {row.lastLoginIp && <p className="text-muted-foreground">{row.lastLoginIp}</p>}
        </div>
      ),
    },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: AdminUserRow) => <span className="text-xs">{row.createdAt}</span> },
  ]

  // ---- 行操作菜单 ----
  const rowActions = (row: AdminUserRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          {busyAction === row.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onClick={() => {
            setEditingUser(row)
            setFormMode("edit")
            setFormOpen(true)
          }}
        >
          编辑用户
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            callAction(row.id, () =>
              adminResetPasswordAction({ id: row.id }).then((res) => {
                if (res.code === 0 && res.data) {
                  setTempPassword({ username: row.username, password: res.data.tempPassword })
                }
                return res
              })
            )
          }
        >
          重置密码
        </DropdownMenuItem>
        {(row.lockedUntil || row.failedLoginCount > 0) && (
          <DropdownMenuItem onClick={() => callAction(row.id, () => unlockUserAction({ id: row.id }))}>
            解锁账号
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ShieldAlert className="mr-1.5 h-4 w-4" /> 2FA 管控
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem onClick={() => callAction(row.id, () => setForce2faAction({ id: row.id, force2faSetup: !row.force2faSetup }))}>
              {row.force2faSetup ? "取消强制2FA提示" : "强制启用2FA提示"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => resetUserTotpAction({ id: row.id }))}>
              重置2FA密钥（删密钥+备份码）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => clearTrustedDevicesAction({ id: row.id }))}>
              清空受信任设备
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                callAction(row.id, () =>
                  resetBackupCodesAction({ id: row.id }).then((res) => {
                    if (res.code === 0 && res.data) {
                      setBackupCodes({ username: row.username, codes: res.data.codes })
                    }
                    return res
                  })
                )
              }
            >
              重置备份码
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ShieldBan className="mr-1.5 h-4 w-4" /> 网络访问策略
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              内网（当前：{row.netPolicy?.allowInternalNetwork ? "允许" : "禁止"}{row.allowInternalNetwork !== null ? "·覆盖" : ""}）
            </p>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: true, allowSecureLocationAccess: row.allowSecureLocationAccess }))}>
              允许访问内网
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: false, allowSecureLocationAccess: row.allowSecureLocationAccess }))}>
              禁止访问内网
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: null, allowSecureLocationAccess: row.allowSecureLocationAccess }))}>
              内网：恢复继承组/全局
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              容器安全位置（当前：{row.netPolicy?.allowSecureLocationAccess ? "允许" : "禁止"}{row.allowSecureLocationAccess !== null ? "·覆盖" : ""}）
            </p>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: true }))}>
              允许访问安全位置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: false }))}>
              禁止访问安全位置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: null }))}>
              安全位置：恢复继承组/全局
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-1.5">
            <Share2 className="mr-1.5 h-4 w-4" /> 共享权限
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              工作区共享开关（当前：{row.shareAllowed === null ? "继承所属组" : row.shareAllowed ? "允许共享" : "禁止共享"}）
            </p>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserShareAllowedAction({ id: row.id, shareAllowed: false }))}>
              <Ban className="mr-1.5 h-3.5 w-3.5 text-rose-600" /> 禁止共享（覆盖组设置）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserShareAllowedAction({ id: row.id, shareAllowed: true }))}>
              <Share2 className="mr-1.5 h-3.5 w-3.5 text-emerald-600" /> 允许共享（覆盖组设置）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserShareAllowedAction({ id: row.id, shareAllowed: null }))}>
              <Undo2 className="mr-1.5 h-3.5 w-3.5" /> 恢复继承所属组
            </DropdownMenuItem>
            <p className="px-2 py-1 text-[11px] text-muted-foreground">四级优先级：沙箱否决 {'>'} 用户 {'>'} 用户组 {'>'} 全局</p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {(viewerRole === "SUPER_ADMIN" || viewerRole === "ADMIN") && (
          <DropdownMenuItem onClick={() => openEvictShare(row)}>
            <UserX className="mr-1.5 h-4 w-4 text-rose-600" /> 清退其收到的共享
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-1.5">
            <Timer className="mr-1.5 h-4 w-4" /> VNC 会话时长
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              连接总时长上限（当前：{row.vncSessionMaxMinutes == null ? "继承" : row.vncSessionMaxMinutes > 0 ? `${row.vncSessionMaxMinutes} 分钟` : "不限"}）
            </p>
            {[30, 60, 120, 240, 480].map((m) => (
              <DropdownMenuItem key={m} onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: row.allowSecureLocationAccess, vncSessionMaxMinutes: m }))}>
                限制 {m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: row.allowSecureLocationAccess, vncSessionMaxMinutes: 0 }))}>
              不限制（显式）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => callAction(row.id, () => setUserNetworkPolicyAction({ id: row.id, allowInternalNetwork: row.allowInternalNetwork, allowSecureLocationAccess: row.allowSecureLocationAccess, vncSessionMaxMinutes: null }))}>
              恢复继承用户组/全局
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onClick={() => {
            setApiTokenUser(row)
          }}
        >
          <KeyRound className="mr-1.5 h-4 w-4" /> API 密钥（查看/创建/修改）
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => callAction(row.id, () => kickUserSessionsAction({ ids: [row.id] }))}>
          强制下线全部会话
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportCsv([row.id])}>导出该用户CSV</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => setDeleteUser(row)}>
          删除用户
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // ---- 批量操作栏 ----
  const batchToolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">已选 {sel.length} 项：</span>
      <Button size="sm" variant="outline" disabled={!!busyAction} onClick={() => callAction("batch", () => batchSetUserStatusAction({ ids: sel, enabled: true }))}>
        批量启用
      </Button>
      <Button size="sm" variant="outline" disabled={!!busyAction} onClick={() => callAction("batch", () => batchSetUserStatusAction({ ids: sel, enabled: false }))}>
        批量禁用
      </Button>
      <Button size="sm" variant="outline" disabled={!!busyAction} onClick={() => { setBatchGroupIds([]); setBatchGroupOpen(true) }}>
        <Users2 className="mr-1 h-3.5 w-3.5" /> 迁移用户组
      </Button>
      <Button size="sm" variant="outline" disabled={!!busyAction} onClick={() => setBatchQuotaOpen(true)}>
        重置配额
      </Button>
      <Button size="sm" variant="outline" disabled={!!busyAction} onClick={() => callAction("batch", () => kickUserSessionsAction({ ids: sel }))}>
        强制下线会话
      </Button>
      <Button size="sm" variant="secondary" onClick={() => exportCsv(sel)}>
        <FileDown className="mr-1 h-3.5 w-3.5" /> 导出选中
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900"
        disabled={!!busyAction || batchDeleteBusy}
        onClick={() => setBatchDeleteOpen(true)}
      >
        {batchDeleteBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
        批量删除
      </Button>
      {busyAction === "batch" && <Loader2 className="h-4 w-4 animate-spin" />}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={() => { setFormMode("create"); setEditingUser(null); setFormOpen(true) }}>
          <Plus className="mr-1 h-4 w-4" /> 新建用户
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setImportText(""); setImportReport(null); setImportOpen(true) }}>
          <FileUp className="mr-1 h-4 w-4" /> 导入CSV
        </Button>
        <Button size="sm" variant="outline" onClick={() => exportCsv()}>
          <FileDown className="mr-1 h-4 w-4" /> 导出全部CSV
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>创建于</span>
          <Input
            type="date"
            className="h-8 w-36"
            value={filters.createdFrom || ""}
            onChange={(e) => pushQuery({ createdFrom: e.target.value, page: "1" })}
          />
          <span>至</span>
          <Input
            type="date"
            className="h-8 w-36"
            value={filters.createdTo || ""}
            onChange={(e) => pushQuery({ createdTo: e.target.value, page: "1" })}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        selectedIds={sel}
        onSelectedChange={setSel}
        rowActions={rowActions}
        batchToolbar={batchToolbar}
        emptyText="暂无用户"
        filters={[
          {
            key: "role",
            placeholder: "角色",
            options: [
              { label: "超级管理员", value: "SUPER_ADMIN" },
              { label: "管理员", value: "ADMIN" },
              { label: "组管理员", value: "GROUP_ADMIN" },
              { label: "用户", value: "USER" },
            ],
          },
          {
            key: "enabled",
            placeholder: "启用状态",
            options: [
              { label: "已启用", value: "true" },
              { label: "已禁用", value: "false" },
            ],
          },
          {
            key: "twoFactor",
            placeholder: "2FA",
            options: [
              { label: "已开启", value: "true" },
              { label: "未开启", value: "false" },
            ],
          },
          {
            key: "locked",
            placeholder: "锁定状态",
            options: [{ label: "已锁定", value: "true" }],
          },
        ]}
      />

      {/* 新建/编辑弹窗 */}
      <UserFormDialog open={formOpen} onOpenChange={setFormOpen} mode={formMode} user={editingUser} groupOptions={groupOptions} />

      {/* 管理员代管该用户的 API 密钥 */}
      <UserApiTokensDialog
        user={apiTokenUser ? { id: apiTokenUser.id, username: apiTokenUser.username, displayName: apiTokenUser.displayName, role: apiTokenUser.role } : null}
        open={!!apiTokenUser}
        onOpenChange={(v) => !v && setApiTokenUser(null)}
        viewerRole={viewerRole}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteUser}
        onOpenChange={(v) => !v && setDeleteUser(null)}
        title="删除用户"
        description={`确认软删除用户 ${deleteUser?.username || ""}？\n· 存在运行中浏览器会话时将被拒绝\n· 删除后账号不可登录，全部会话与API令牌作废\n· 该操作不可在界面撤销`}
        requirePhrase="DELETE"
        destructive
        onConfirm={async () => {
          if (!deleteUser) return
          await callAction(deleteUser.id, () => deleteUserAction({ id: deleteUser.id }))
          setDeleteUser(null)
        }}
      />

      {/* 批量删除确认（逐条失败隔离：运行中会话等场景不阻断整批） */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && !batchDeleteBusy && setBatchDeleteOpen(v)}
        title={`批量删除 ${sel.length} 个用户`}
        description={`将软删除选中的 ${sel.length} 个用户：\n· 存在运行中浏览器会话的用户会跳过并在结果中列明原因\n· 删除后账号禁用冻结，全部会话与API令牌作废\n· 不能删除当前登录的管理员自己`}
        requirePhrase="DELETE"
        destructive
        loading={batchDeleteBusy}
        confirmText="确认批量删除"
        onConfirm={runBatchDelete}
      />

      {/* r22b：清退该用户收到的共享（确认时展示将撤销条数） */}
      <ConfirmDialog
        open={!!evictShareUser}
        onOpenChange={(v) => { if (!v && !evictShareBusy) setEvictShareUser(null) }}
        title="清退其收到的共享"
        description={`确认清退用户 ${evictShareUser?.username || ""} 收到的全部工作区共享？\n· 将撤销其作为接收者的生效共享 ${evictShareCount === null ? "…（统计中）" : `${evictShareCount} 条`}\n· 该用户立即失去相关访问权，不影响其自己的工作区与他人\n· 审计记录保留，可由所有者重新共享恢复`}
        destructive
        confirmText="确认清退"
        loading={evictShareBusy}
        onConfirm={runEvictShare}
      />

      {/* 批量删除失败清单 */}
      <BatchFailuresDialog failures={batchFailures} onClose={() => setBatchFailures(null)} />

      {/* 临时密码展示 */}
      <Dialog open={!!tempPassword} onOpenChange={(v) => !v && setTempPassword(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>密码已重置</DialogTitle>
            <DialogDescription>
              用户 {tempPassword?.username} 的临时密码如下，请在首次登录后强制修改：
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3">
            <code className="flex-1 font-mono text-lg font-semibold tracking-wider">{tempPassword?.password}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                if (tempPassword) {
                  await navigator.clipboard.writeText(tempPassword.password).catch(() => {})
                  toast.success("已复制到剪贴板")
                }
              }}
            >
              <Copy className="mr-1 h-3.5 w-3.5" /> 复制
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">该用户全部登录会话已被强制下线，mustChangePassword 已置为 true。</p>
        </DialogContent>
      </Dialog>

      {/* 备份码展示 */}
      <Dialog open={!!backupCodes} onOpenChange={(v) => !v && setBackupCodes(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>2FA 备份码已重置</DialogTitle>
            <DialogDescription>用户 {backupCodes?.username} 的新备份码（一次性，仅此一次展示）：</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-1.5 rounded-md border bg-muted/50 p-3 font-mono text-sm">
            {backupCodes?.codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (backupCodes) {
                await navigator.clipboard.writeText(backupCodes.codes.join("\n")).catch(() => {})
                toast.success("已复制全部备份码")
              }
            }}
          >
            <Copy className="mr-1 h-3.5 w-3.5" /> 复制全部
          </Button>
        </DialogContent>
      </Dialog>

      {/* CSV 导入弹窗 */}
      <Dialog open={importOpen} onOpenChange={(v) => { setImportOpen(v); if (!v) setImportReport(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>导入用户 CSV</DialogTitle>
            <DialogDescription>
              表头必须包含：username,email,password,displayName（顺序不限）。已存在用户的处理方式：
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={importMode} onValueChange={(v) => setImportMode(v as "skip" | "update")} className="flex gap-4">
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="skip" id="imp-skip" />
              <Label htmlFor="imp-skip">跳过已存在用户</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="update" id="imp-update" />
              <Label htmlFor="imp-update">更新已存在用户（邮箱/显示名/密码）</Label>
            </div>
          </RadioGroup>
          <div className="space-y-2">
            <input
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-teal-600 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-teal-700"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onImportFile(f)
              }}
            />
            <textarea
              className="flex min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
              placeholder={"username,email,password,displayName\nalice,alice@corp.com,StrongP@ss1,张三"}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          </div>
          {importReport && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                共 {importReport.total} 行 · 成功 {importReport.success}（其中更新 {importReport.updated}）· 失败{" "}
                <span className={importReport.failed > 0 ? "text-red-600 font-medium" : ""}>{importReport.failed}</span>
              </p>
              {importReport.errors.length > 0 && (
                <ScrollArea className="h-32">
                  <div className="space-y-1 text-xs">
                    {importReport.errors.map((e, i) => (
                      <p key={i} className="text-red-600">
                        第 {e.line} 行：{e.message}
                      </p>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importBusy}>
              关闭
            </Button>
            <Button onClick={runImport} disabled={importBusy} className="bg-teal-600 hover:bg-teal-700">
              {importBusy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              开始导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量迁移组弹窗 */}
      <Dialog open={batchGroupOpen} onOpenChange={setBatchGroupOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>批量迁移用户组</DialogTitle>
            <DialogDescription>
              将所选 {sel.length} 名用户迁移到指定组（替换语义：移出现有全部组，仅保留所选组；不选任何组 = 移出全部组）
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-52 rounded-md border p-2">
            <div className="space-y-1">
              {groupOptions.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">暂无用户组</p>}
              {groupOptions.map((g) => (
                <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted cursor-pointer">
                  <Checkbox
                    checked={batchGroupIds.includes(g.id)}
                    onCheckedChange={() =>
                      setBatchGroupIds((prev) => (prev.includes(g.id) ? prev.filter((i) => i !== g.id) : [...prev, g.id]))
                    }
                  />
                  <span className="truncate">{g.name}</span>
                </label>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchGroupOpen(false)}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!!busyAction}
              onClick={async () => {
                await callAction("batch", () => batchMoveGroupAction({ ids: sel, groupIds: batchGroupIds }))
                setBatchGroupOpen(false)
              }}
            >
              确认迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量重置配额弹窗 */}
      <Dialog open={batchQuotaOpen} onOpenChange={setBatchQuotaOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量重置配额</DialogTitle>
            <DialogDescription>对所选 {sel.length} 名用户覆盖以下个人配额：</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label>并发会话配额</Label>
              <PrecisionInput value={bqSessions} onChange={setBqSessions} min={0} max={100000} suffix="个" />
            </div>
            <div className="space-y-1.5">
              <Label>NoVNC 会话配额</Label>
              <PrecisionInput value={bqNovnc} onChange={setBqNovnc} min={0} max={100000} suffix="个" />
            </div>
            <div className="space-y-1.5">
              <Label>磁盘配额</Label>
              <PrecisionInput value={bqDisk} onChange={setBqDisk} min={0} max={10000000} suffix="MB" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchQuotaOpen(false)}>取消</Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={!!busyAction}
              onClick={async () => {
                await callAction("batch", () =>
                  batchResetQuotaAction({ ids: sel, quota: { sessions: bqSessions, novncSessions: bqNovnc, diskMb: bqDisk } })
                )
                setBatchQuotaOpen(false)
              }}
            >
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
