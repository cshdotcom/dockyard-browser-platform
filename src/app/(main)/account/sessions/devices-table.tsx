"use client"

// 受信任设备列表：设备标签 / UA / IP / 添加时间 / 最后使用 / 过期时间 / 撤销信任
// r23-d：已撤销信任的设备行支持「删除记录」（DB 物理删除，列表瘦身）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, KeySquare, ShieldCheck, ShieldX, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { revokeMyTrustedDeviceAction, deleteMyRevokedTrustedDevicesAction } from "@/server/actions/profile"

export interface TrustedDeviceRow {
  id: string
  label: string
  browser: string
  os: string
  ip: string
  revoked: boolean
  expired: boolean
  expiresAt: string
  lastUsedAt: string
  createdAt: string
}

interface DevicesTableProps {
  rows: TrustedDeviceRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  backupCodes: number
}

export function DevicesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, backupCodes }: DevicesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [busy, setBusy] = React.useState("")
  const [revokeTarget, setRevokeTarget] = React.useState<TrustedDeviceRow | null>(null)
  // r23-d：删除已撤销信任设备记录
  const [deleteTarget, setDeleteTarget] = React.useState<TrustedDeviceRow | null>(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const doRevoke = async () => {
    if (!revokeTarget) return
    setBusy(`revoke-${revokeTarget.id}`)
    try {
      const res = await revokeMyTrustedDeviceAction({ id: revokeTarget.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已撤销受信任设备「${revokeTarget.label}」，该设备下次登录需要完整 2FA 验证`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  // r23-d：删除已撤销信任的设备记录（DB 物理删除）
  const doDeleteRevoked = async () => {
    if (!deleteTarget) return
    setBusy(`del-${deleteTarget.id}`)
    try {
      const res = await deleteMyRevokedTrustedDevicesAction({ ids: [deleteTarget.id] })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已删除 1 条已撤销信任的设备记录（${deleteTarget.label}）`)
      setDeleteTarget(null)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const columns = [
    {
      key: "label",
      title: "设备标签",
      render: (row: TrustedDeviceRow) => (
        <div>
          <p className="font-medium flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
            {row.label}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.browser} · {row.os}
          </p>
        </div>
      ),
    },
    { key: "ip", title: "绑定 IP", render: (row: TrustedDeviceRow) => <span className="text-xs font-mono">{row.ip}</span> },
    {
      key: "state",
      title: "状态",
      render: (row: TrustedDeviceRow) =>
        row.revoked ? (
          <Badge variant="outline" className="text-xs">
            <ShieldX className="mr-1 h-3 w-3" /> 信任已撤销
          </Badge>
        ) : row.expired ? (
          <Badge variant="destructive" className="text-xs">已过期</Badge>
        ) : (
          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">信任生效中</Badge>
        ),
    },
    { key: "createdAt", title: "添加时间", sortable: true, render: (row: TrustedDeviceRow) => <span className="text-sm">{row.createdAt}</span> },
    { key: "lastUsedAt", title: "最后使用", sortable: true, render: (row: TrustedDeviceRow) => <span className="text-sm">{row.lastUsedAt}</span> },
    { key: "expiresAt", title: "过期时间", sortable: true, render: (row: TrustedDeviceRow) => <span className="text-sm">{row.expiresAt}</span> },
  ]

  return (
    <div className="space-y-3">
      {backupCodes > 0 ? (
        <div className="rounded-md border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 px-4 py-2.5 text-xs text-teal-800 dark:text-teal-300 flex items-center gap-2">
          <KeySquare className="h-3.5 w-3.5 shrink-0" />
          <span>
            当前剩余 <strong className="tabular-nums">{backupCodes}</strong> 组 2FA 备份码 —— 若撤销所有受信任设备后手机丢失，备份码是唯一的恢复途径，请前往
            账号安全页 确认备份。
          </span>
        </div>
      ) : (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <KeySquare className="h-3.5 w-3.5 shrink-0" />
          <span>你当前没有可用的 2FA 备份码。撤销受信任设备前，建议先在账号安全页生成并保存备份码，避免设备丢失后无法登录。</span>
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
            key: "dstate",
            placeholder: "信任状态",
            options: [
              { label: "生效中", value: "active" },
              { label: "已撤销/过期", value: "revoked" },
            ],
          },
        ]}
        onQueryChange={pushQuery}
        emptyText="暂无受信任设备"
        rowActions={(row) => {
          // r23-d：已撤销信任的行 → 删除记录（DB 物理删除）；其余行保持「撤销信任」
          if (row.revoked) {
            return (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                disabled={busy !== ""}
                onClick={() => setDeleteTarget(row)}
                title="从数据库删除该已撤销设备记录"
              >
                {busy === `del-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                删除记录
              </Button>
            )
          }
          return (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              disabled={busy !== ""}
              onClick={() => setRevokeTarget(row)}
              title={"撤销该设备的信任"}
            >
              {busy === `revoke-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldX className="mr-1 h-4 w-4" />}
              撤销信任
            </Button>
          )
        }}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(v) => !v && setRevokeTarget(null)}
        title={`撤销受信任设备「${revokeTarget?.label || ""}」`}
        description="撤销后该设备下次登录将被要求完整 2FA 验证（TOTP 或备份码）。此操作不可自动恢复，需要时可在登录时重新勾选信任。"
        confirmText="确认撤销"
        destructive
        onConfirm={doRevoke}
      />

      {/* r23-d：删除已撤销信任的设备记录 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={`删除设备记录「${deleteTarget?.label || ""}」`}
        description={`该设备的信任已被撤销。确认从数据库物理删除该受信任设备记录？\n· 仅清理历史记录，不影响任何在线会话\n· 此操作不可恢复`}
        confirmText="确认删除记录"
        destructive
        onConfirm={doDeleteRevoked}
      />
    </div>
  )
}
