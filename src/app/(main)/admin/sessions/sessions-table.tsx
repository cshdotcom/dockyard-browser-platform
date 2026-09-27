"use client"

// 在线会话管控交互表格：单条强制下线 / 一键下线该用户全部设备

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, LogOut, Power } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip"
import { kickLoginSessionAction, kickUserSessionsAction } from "@/server/actions/users"

export interface AdminSessionRow {
  id: string
  userId: string
  username: string
  displayName: string | null
  role: string
  ip: string | null
  userAgent: string | null
  deviceLabel: string | null
  trusted: boolean
  rememberMe: boolean
  loginAt: string
  lastActiveAt: string
  expiresAt: string
  idleTimeoutMin: number
}

interface SessionsTableProps {
  rows: AdminSessionRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
}

// UA 简要设备解析（展示用）
function uaSummary(ua?: string | null): string {
  if (!ua) return "未知设备"
  const os = /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "macOS" : /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS" : /Linux/i.test(ua) ? "Linux" : "其他"
  const browser = /Edg\//i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : /Safari/i.test(ua) ? "Safari" : "未知浏览器"
  return `${os} · ${browser}`
}

export function SessionsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder }: SessionsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [busyId, setBusyId] = React.useState("")
  const [kickAllUser, setKickAllUser] = React.useState<AdminSessionRow | null>(null)
  const [kickOne, setKickOne] = React.useState<AdminSessionRow | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const callAction = async (id: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusyId(id)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusyId("")
    }
  }

  const columns = [
    {
      key: "username",
      title: "用户",
      render: (row: AdminSessionRow) => (
        <div className="min-w-0">
          <p className="font-medium truncate">{row.username}</p>
          <p className="text-xs text-muted-foreground truncate">{row.displayName || row.role}</p>
        </div>
      ),
    },
    { key: "ip", title: "IP 地址", render: (row: AdminSessionRow) => <span className="text-xs font-mono">{row.ip || "-"}</span> },
    {
      key: "device",
      title: "设备 / UA",
      render: (row: AdminSessionRow) => (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="max-w-52 cursor-help">
                <p className="text-xs truncate">{uaSummary(row.userAgent)}</p>
                <p className="text-[10px] text-muted-foreground truncate font-mono">{row.userAgent || "-"}</p>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80 break-all">
              <p className="text-xs font-mono">{row.userAgent || "无UA"}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
    },
    {
      key: "trusted",
      title: "受信任",
      render: (row: AdminSessionRow) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={row.trusted ? "RUNNING" : "DISABLED"} map={{ RUNNING: "success", DISABLED: "outline" }} />
          {row.rememberMe && <Badge variant="secondary" className="text-[10px]">记住我</Badge>}
        </div>
      ),
    },
    { key: "createdAt", title: "登录时间", sortable: true, render: (row: AdminSessionRow) => <span className="text-xs">{row.loginAt}</span> },
    { key: "lastActiveAt", title: "最后活跃", sortable: true, render: (row: AdminSessionRow) => <span className="text-xs">{row.lastActiveAt}</span> },
    {
      key: "expiresAt",
      title: "过期时间",
      sortable: true,
      render: (row: AdminSessionRow) => (
        <div className="text-xs">
          <p>{row.expiresAt}</p>
          <p className="text-[10px] text-muted-foreground">闲置超时 {row.idleTimeoutMin} 分钟</p>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
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
        emptyText="当前无活跃登录会话"
        filters={[
          {
            key: "trusted",
            placeholder: "受信任状态",
            options: [
              { label: "受信任设备", value: "true" },
              { label: "普通会话", value: "false" },
            ],
          },
        ]}
        rowActions={(row) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busyId === row.id}
              onClick={() => setKickAllUser(row)}
              title="下线该用户全部设备"
            >
              {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              <span className="ml-1 hidden sm:inline">全部下线</span>
            </Button>
            <Button size="sm" variant="destructive" disabled={busyId === row.id} onClick={() => setKickOne(row)}>
              <LogOut className="h-3.5 w-3.5" />
              <span className="ml-1 hidden sm:inline">下线</span>
            </Button>
          </div>
        )}
      />

      <ConfirmDialog
        open={!!kickOne}
        onOpenChange={(v) => !v && setKickOne(null)}
        title="强制下线该会话"
        description={`确认下线 ${kickOne?.username || ""} 在 ${kickOne?.ip || "未知IP"} 的登录会话？该设备需重新登录。`}
        destructive
        onConfirm={async () => {
          if (kickOne) await callAction(kickOne.id, () => kickLoginSessionAction({ sessionId: kickOne.id }))
          setKickOne(null)
        }}
      />

      <ConfirmDialog
        open={!!kickAllUser}
        onOpenChange={(v) => !v && setKickAllUser(null)}
        title="一键下线该用户全部设备"
        description={`确认将用户 ${kickAllUser?.username || ""} 的全部登录会话强制下线？其刷新令牌同步作废。`}
        destructive
        onConfirm={async () => {
          if (kickAllUser) await callAction(kickAllUser.userId, () => kickUserSessionsAction({ ids: [kickAllUser.userId] }))
          setKickAllUser(null)
        }}
      />
    </div>
  )
}
