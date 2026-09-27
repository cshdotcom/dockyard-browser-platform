"use client"

// 登录会话列表：当前设备徽章 / 踢出单个会话 / 一键下线全部其他设备

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, LogOut, MonitorSmartphone, ShieldCheck } from "lucide-react"
import { revokeMySessionAction, revokeAllMyOtherSessionsAction } from "@/server/actions/profile"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

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

  const columns = [
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
          撤销会话将同时作废关联的 Refresh Token，该设备需重新登录；当前设备不可自我撤销
        </p>
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
          const canKick = !row.isCurrent && !row.revoked
          return (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              disabled={!canKick || busy !== ""}
              onClick={() => setKickTarget(row)}
              title={row.isCurrent ? "当前设备不可撤销" : row.revoked ? "该会话已下线" : "踢出该设备"}
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
    </div>
  )
}
