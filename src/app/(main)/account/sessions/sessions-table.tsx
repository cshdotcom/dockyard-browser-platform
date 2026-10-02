"use client"

// 登录会话列表：当前设备徽章 / 踢出单个会话 / 一键下线全部其他设备
// r23-d：已下线/已过期行支持「删除记录」（DB 删除，cookie 彻底失效）、行多选批量删除、一键清理全部已下线记录

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, LogOut, MonitorSmartphone, ShieldCheck, Trash2 } from "lucide-react"
import {
  revokeMySessionAction, revokeAllMyOtherSessionsAction,
  deleteMySessionRecordAction, deleteAllMyOfflineSessionsAction,
} from "@/server/actions/profile"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export interface SessionRow {
  id: string
  ip: string
  browser: string
  os: string
  deviceLabel: string
  trusted: boolean
  isCurrent: boolean
  rememberMe: boolean
  revoked: boolean
  revokedReason: string | null
  expired: boolean
  expiresAt: string
  lastActiveAt: string
  createdAt: string
}

const REVOKE_REASON_LABEL: Record<string, string> = {
  LOGOUT: "手动登出",
  PASSWORD_CHANGE: "密码变更",
  ADMIN_KICK: "管理员强制下线",
  IDLE_TIMEOUT: "闲置超时",
  EXPIRED: "会话到期",
  SECURITY: "安全策略",
}

function sessionState(row: SessionRow): { label: string; tone: "active" | "warn" | "muted" | "danger" } {
  if (row.revoked) return { label: REVOKE_REASON_LABEL[row.revokedReason || ""] || "已下线", tone: "muted" }
  if (row.expired) return { label: "已过期", tone: "danger" }
  if (row.isCurrent) return { label: "当前设备", tone: "active" }
  return { label: "在线", tone: "active" }
}

// r23-d：已下线/已过期行（可删除记录；在线行必须先下线再删）
const isOfflineRow = (row: SessionRow) => row.revoked || row.expired

const TONE_CLASS: Record<string, string> = {
  active: "bg-emerald-600 hover:bg-emerald-600 text-white",
  warn: "bg-orange-500 hover:bg-orange-500 text-white",
  muted: "bg-muted text-muted-foreground",
  danger: "bg-red-600 hover:bg-red-600 text-white",
}

interface SessionsTableProps {
  rows: SessionRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
}

export function SessionsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters }: SessionsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [busy, setBusy] = React.useState("")
  const [kickTarget, setKickTarget] = React.useState<SessionRow | null>(null)
  const [kickAllOpen, setKickAllOpen] = React.useState(false)

  // ---- r23-d：删除记录（单条 / 批量 / 全部清理） ----
  const [deleteTarget, setDeleteTarget] = React.useState<SessionRow | null>(null)
  const [deleteSelectedOpen, setDeleteSelectedOpen] = React.useState(false)
  const [clearOfflineOpen, setClearOfflineOpen] = React.useState(false)
  const [selSids, setSelSids] = React.useState<string[]>([])

  const offlineRows = rows.filter(isOfflineRow)
  // 依赖稳定化：以 rows 为 memo 依赖（避免每帧新建数组触发 setState 循环）；筛选结果引用相等时跳过更新
  const offlineIds = React.useMemo(() => new Set(rows.filter(isOfflineRow).map((r) => r.id)), [rows])

  // 数据刷新后剔除失效勾选（已重新上线 / 已被删除的行）
  React.useEffect(() => {
    setSelSids((prev) => (prev.some((id) => !offlineIds.has(id)) ? prev.filter((id) => offlineIds.has(id)) : prev))
  }, [offlineIds])

  const toggleSel = (id: string) =>
    setSelSids((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]))

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const otherActiveCount = rows.filter((r) => !r.isCurrent && !r.revoked && !r.expired).length

  const doKick = async () => {
    if (!kickTarget) return
    setBusy(`kick-${kickTarget.id}`)
    try {
      const res = await revokeMySessionAction({ sid: kickTarget.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已下线设备（${kickTarget.browser} · ${kickTarget.os} · ${kickTarget.ip}）`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const doKickAll = async () => {
    setBusy("kick-all")
    try {
      const res = await revokeAllMyOtherSessionsAction()
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已下线全部其他设备（${(res.data as { revoked: number } | undefined)?.revoked ?? 0} 个会话）`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  // r23-d：删除单条已下线/过期记录（DB 删除，sessionHash 不再被承认）
  const doDeleteOne = async () => {
    if (!deleteTarget) return
    setBusy(`del-${deleteTarget.id}`)
    try {
      const res = await deleteMySessionRecordAction({ sids: [deleteTarget.id] })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已删除 1 条会话记录（${deleteTarget.browser} · ${deleteTarget.os}，cookie 彻底失效）`)
      setDeleteTarget(null)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  // r23-d：批量删除所选
  const doDeleteSelected = async () => {
    setBusy("del-sel")
    try {
      const res = await deleteMySessionRecordAction({ sids: selSids })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      const n = (res.data as { deleted: number } | undefined)?.deleted ?? 0
      toast.success(`已删除所选 ${n} 条会话记录`)
      setSelSids([])
      setDeleteSelectedOpen(false)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  // r23-d：一键清理全部已下线/过期记录
  const doClearOffline = async () => {
    setBusy("clear-offline")
    try {
      const res = await deleteAllMyOfflineSessionsAction()
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      const n = (res.data as { deleted: number } | undefined)?.deleted ?? 0
      toast.success(`已清理 ${n} 条已下线/过期会话记录`)
      setClearOfflineOpen(false)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const columns = [
    {
      key: "sel",
      title: "选择",
      render: (row: SessionRow) => {
        const offline = isOfflineRow(row)
        return (
          <Checkbox
            checked={selSids.includes(row.id)}
            disabled={!offline || busy !== ""}
            onCheckedChange={() => toggleSel(row.id)}
            aria-label={offline ? `选择会话记录 ${row.browser} ${row.os}` : "仅已下线/过期行可勾选"}
            className={cn(!offline && "opacity-30")}
          />
        )
      },
    },
    {
      key: "device",
      title: "设备",
      render: (row: SessionRow) => (
        <div>
          <p className="font-medium flex items-center gap-1.5">
            <MonitorSmartphone className="h-3.5 w-3.5 text-muted-foreground" />
            {row.browser} · {row.os}
            {row.isCurrent && <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">当前设备</Badge>}
          </p>
          <p className="text-xs text-muted-foreground truncate max-w-64" title={row.deviceLabel}>
            {row.deviceLabel}
          </p>
        </div>
      ),
    },
    { key: "ip", title: "IP 地址", render: (row: SessionRow) => <span className="text-xs font-mono">{row.ip}</span> },
    {
      key: "state",
      title: "状态",
      render: (row: SessionRow) => {
        const st = sessionState(row)
        return (
          <div className="flex flex-col items-start gap-1">
            <Badge className={TONE_CLASS[st.tone]}>{st.label}</Badge>
            {row.trusted && !row.revoked && (
              <Badge variant="outline" className="text-[10px] gap-0.5">
                <ShieldCheck className="h-3 w-3" /> 受信任
              </Badge>
            )}
          </div>
        )
      },
    },
    { key: "createdAt", title: "登录时间", sortable: true, render: (row: SessionRow) => <span className="text-sm">{row.createdAt}</span> },
    { key: "lastActiveAt", title: "最后活跃", sortable: true, render: (row: SessionRow) => <span className="text-sm">{row.lastActiveAt}</span> },
    { key: "expiresAt", title: "会话过期", sortable: true, render: (row: SessionRow) => <span className="text-sm">{row.expiresAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          撤销会话将同时作废关联的 Refresh Token；已下线/过期记录可从数据库删除（该设备 cookie 彻底失效、不可再用于恢复）
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
            onClick={() => setClearOfflineOpen(true)}
            disabled={busy !== "" || offlineRows.length === 0}
            title={offlineRows.length === 0 ? "当前页没有已下线/过期记录" : "删除全部已下线/过期会话记录（不含在线会话）"}
          >
            {busy === "clear-offline" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
            清理全部已下线记录
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setKickAllOpen(true)}
            disabled={busy !== "" || otherActiveCount === 0}
          >
            {busy === "kick-all" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <LogOut className="mr-1 h-4 w-4" />}
            一键下线全部其他设备
          </Button>
        </div>
      </div>

      {/* r23-d：已选 N 条（仅已下线/过期行可勾选） */}
      {selSids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 dark:border-red-900 bg-red-50/60 dark:bg-red-950/30 px-2.5 py-1.5">
          <Badge variant="destructive" className="text-[10px]">已选 {selSids.length} 条记录</Badge>
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900"
            disabled={busy !== ""}
            onClick={() => setDeleteSelectedOpen(true)}
          >
            {busy === "del-sel" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
            删除所选（{selSids.length}）
          </Button>
          <button
            type="button"
            className="ml-1 p-1 rounded hover:bg-muted text-muted-foreground"
            onClick={() => setSelSids([])}
            aria-label="清空选择"
          >
            ✕
          </button>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        filters={[
          {
            key: "state",
            placeholder: "会话状态",
            options: [
              { label: "活跃", value: "active" },
              { label: "已下线/过期", value: "revoked" },
            ],
          },
        ]}
        onQueryChange={pushQuery}
        emptyText="暂无登录会话"
        rowActions={(row) => {
          // r23-d：已下线/已过期行 → 删除记录（DB 级，cookie 彻底失效）；在线行保持「下线」语义
          if (isOfflineRow(row)) {
            return (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                disabled={busy !== ""}
                onClick={() => setDeleteTarget(row)}
                title="从数据库删除该会话记录，设备cookie彻底失效"
              >
                {busy === `del-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                删除记录
              </Button>
            )
          }
          const canKick = !row.isCurrent && !row.revoked
          return (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              disabled={!canKick || busy !== ""}
              onClick={() => setKickTarget(row)}
              title={row.isCurrent ? "当前设备不可撤销" : "踢出该设备"}
            >
              {busy === `kick-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="mr-1 h-4 w-4" />}
              下线
            </Button>
          )
        }}
      />

      <ConfirmDialog
        open={!!kickTarget}
        onOpenChange={(v) => !v && setKickTarget(null)}
        title={`下线设备「${kickTarget?.browser || ""} · ${kickTarget?.os || ""}」`}
        description={`该设备位于 ${kickTarget?.ip || "未知 IP"}，撤销后其会话与刷新令牌立即失效，需要重新登录。`}
        confirmText="确认下线"
        destructive
        onConfirm={doKick}
      />

      <ConfirmDialog
        open={kickAllOpen}
        onOpenChange={setKickAllOpen}
        title="一键下线全部其他设备"
        description={`当前共 ${otherActiveCount} 个其他在线会话（本页显示的），全部撤销后除当前设备外均需重新登录。`
          + "若你怀疑账号被盗，建议下线后立即前往账号安全页修改密码。"}
        confirmText="全部下线"
        destructive
        onConfirm={doKickAll}
      />

      {/* r23-d：删除单条已下线/过期记录 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={`删除会话记录「${deleteTarget?.browser || ""} · ${deleteTarget?.os || ""}」`}
        description={`该记录位于 ${deleteTarget?.ip || "未知 IP"}（${sessionState(deleteTarget || ({} as SessionRow)).label}）。\n· 将从数据库物理删除该 LoginSession 行\n· 该设备 cookie 对应的 sessionHash 从此不被数据库承认，彻底失效\n· 此操作不可恢复，仅用于清理历史下线记录`}
        confirmText="确认删除记录"
        destructive
        onConfirm={doDeleteOne}
      />

      {/* r23-d：批量删除所选 */}
      <ConfirmDialog
        open={deleteSelectedOpen}
        onOpenChange={(v) => !v && setDeleteSelectedOpen(false)}
        title={`删除所选 ${selSids.length} 条会话记录`}
        description={`将从中数据库物理删除勾选的 ${selSids.length} 条已下线/过期会话记录：\n· 对应设备 cookie 全部彻底失效\n· 在线会话不可勾选，不受影响\n· 此操作不可恢复`}
        confirmText="确认删除所选"
        destructive
        onConfirm={doDeleteSelected}
      />

      {/* r23-d：一键清理全部已下线/过期记录 */}
      <ConfirmDialog
        open={clearOfflineOpen}
        onOpenChange={(v) => !v && setClearOfflineOpen(false)}
        title="清理全部已下线记录"
        description={`将删除你账号下全部已下线/已过期的登录会话记录（不含当前设备与任何在线会话）：\n· 对应设备 cookie 全部彻底失效\n· 列表瘦身，仅保留在线会话\n· 此操作不可恢复`}
        confirmText="确认清理"
        destructive
        onConfirm={doClearOffline}
      />
    </div>
  )
}
