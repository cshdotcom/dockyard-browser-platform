"use client"

// r13c：管理员共享关系总列表（企业级共享权限管控中枢）
//   · 全景列：工作区/所有者/被共享者/权限/状态/沙箱否决/有效期/撤销时间/发起人
//   · 精确撤销：单人（行内）/ 批量（勾选）/ 整工作区（一键断掉全部共享）
//   · 沙箱级禁共享否决开关（四级管控最高层：开启后该工作区禁止任何新共享/链接）
//   · 筛选：状态（生效/已撤销/已过期）/ 权限（只读/可操作）/ 关键词（工作区名/uuid/用户名）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Share2, Ban, Undo2, Trash2, ExternalLink } from "lucide-react"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import {
  adminRevokeShareAction, adminBatchRevokeSharesAction, adminRevokeAllWorkspaceSharesAction,
  adminSetWorkspaceShareDisabledAction,
} from "@/server/actions/admin-workspaces"

export interface AdminShareRow {
  id: string
  workspaceId: string
  workspaceName: string
  workspaceUuid: string
  workspaceStatus: string
  workspaceMode: string
  ownerUsername: string
  targetUsername: string
  targetDisplayName: string | null
  permission: string
  status: "active" | "revoked" | "expired"
  shareDisabled: boolean
  expireAt: string
  revokedAt: string
  createdAt: string
  createdByUsername: string
  activeSharesOfWs: number
}

interface Props {
  rows: AdminShareRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  filters: Record<string, string>
}

export function SharesTable(props: Props) {
  const { rows, total, page, pageSize, keyword, filters } = props
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [confirmState, setConfirmState] = React.useState<
    | { kind: "single"; row: AdminShareRow }
    | { kind: "batch" }
    | { kind: "allOfWs"; row: AdminShareRow }
    | null
  >(null)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(name)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(res.msg || "操作成功")
        router.refresh()
      } else {
        toast.error(res.msg || "操作失败")
      }
    } catch (e) {
      toast.error(String((e as Error)?.message || e))
    } finally {
      setBusy("")
    }
  }

  const doRevokeSingle = (row: AdminShareRow) =>
    callAction(`revoke:${row.id}`, () => adminRevokeShareAction({ shareId: row.id }))

  const doBatchRevoke = async () => {
    const res = await adminBatchRevokeSharesAction({ shareIds: selectedIds })
    if (res.code === 0) {
      toast.success(`已撤销 ${res.data?.revoked ?? 0} 条共享${res.data?.skipped ? `，跳过 ${res.data.skipped} 条已撤销` : ""}`)
      setSelectedIds([])
      router.refresh()
    } else toast.error(res.msg || "批量撤销失败")
  }

  const doRevokeAllOfWs = (row: AdminShareRow) =>
    callAction(`revokeAll:${row.workspaceId}`, () => adminRevokeAllWorkspaceSharesAction({ workspaceId: row.workspaceId }))

  const doToggleVeto = (row: AdminShareRow, next: boolean) =>
    callAction(`veto:${row.workspaceId}`, () =>
      adminSetWorkspaceShareDisabledAction({ workspaceId: row.workspaceId, shareDisabled: next }))

  const columns: Column<AdminShareRow>[] = [
    {
      key: "workspace",
      title: "工作区",
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium truncate max-w-[180px]" title={r.workspaceName}>{r.workspaceName}</span>
            {r.shareDisabled && <Badge variant="destructive" className="text-[10px] shrink-0">禁共享</Badge>}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono">{r.workspaceUuid.slice(0, 12)}</div>
          {r.activeSharesOfWs > 0 && (
            <div className="text-[11px] text-muted-foreground">该工作区生效共享 {r.activeSharesOfWs} 条</div>
          )}
        </div>
      ),
    },
    { key: "owner", title: "所有者", render: (r) => <span className="text-sm">{r.ownerUsername}</span> },
    {
      key: "target",
      title: "共享给",
      render: (r) => (
        <div>
          <div className="font-medium">{r.targetUsername}</div>
          {r.targetDisplayName && <div className="text-[11px] text-muted-foreground">{r.targetDisplayName}</div>}
        </div>
      ),
    },
    {
      key: "permission",
      title: "权限",
      render: (r) => (
        <Badge variant={r.permission === "OPERATE" ? "default" : "outline"} className="text-[11px]">
          {r.permission === "OPERATE" ? "可操作" : "只读"}
        </Badge>
      ),
    },
    {
      key: "status",
      title: "状态",
      render: (r) => (
        <Badge
          variant={r.status === "active" ? "default" : r.status === "revoked" ? "destructive" : "secondary"}
          className="text-[11px]"
        >
          {r.status === "active" ? "生效中" : r.status === "revoked" ? "已撤销" : "已过期"}
        </Badge>
      ),
    },
    { key: "expireAt", title: "到期时间", render: (r) => <span className="text-xs text-muted-foreground">{r.expireAt || "永久"}</span> },
    { key: "revokedAt", title: "撤销时间", render: (r) => <span className="text-xs text-muted-foreground">{r.revokedAt || "—"}</span> },
    { key: "createdAt", title: "创建时间", render: (r) => <span className="text-xs text-muted-foreground">{r.createdAt}</span> },
    { key: "createdBy", title: "发起人", render: (r) => <span className="text-xs">{r.createdByUsername}</span> },
    {
      key: "veto",
      title: "沙箱禁共享",
      width: "120px",
      render: (r) => (
        <div className="flex items-center gap-1.5" title="四级管控最高层：开启后该工作区禁止任何新共享/分享链接">
          <Switch
            checked={r.shareDisabled}
            disabled={busy === `veto:${r.workspaceId}`}
            onCheckedChange={(v) => doToggleVeto(r, v)}
          />
          <span className="text-[11px] text-muted-foreground">{r.shareDisabled ? "已否决" : "未否决"}</span>
        </div>
      ),
    },
    {
      key: "actions",
      title: "操作",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost" size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => window.open(`/workspaces/${r.workspaceId}`, "_blank")}
            title="在新窗口打开该工作区详情"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          {r.status === "active" && (
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              disabled={busy === `revoke:${r.id}`}
              onClick={() => setConfirmState({ kind: "single", row: r })}
              title="精确撤销：移除该被共享者的访问权"
            >
              {busy === `revoke:${r.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} 撤销
            </Button>
          )}
          {r.activeSharesOfWs > 1 && (
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              disabled={busy === `revokeAll:${r.workspaceId}`}
              onClick={() => setConfirmState({ kind: "allOfWs", row: r })}
              title="一键撤销该工作区的全部共享"
            >
              {busy === `revokeAll:${r.workspaceId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} 全撤
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      {/* ---- 筛选面板 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => pushQuery({ view: undefined })}>
          <Share2 className="h-3.5 w-3.5 mr-1" /> 返回工作区列表
        </Button>
        <Select
          value={filters.shareStatus || "all"}
          onValueChange={(v) => pushQuery({ page: "1", shareStatus: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">生效中</SelectItem>
            <SelectItem value="revoked">已撤销</SelectItem>
            <SelectItem value="expired">已过期</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.sharePermission || "all"}
          onValueChange={(v) => pushQuery({ page: "1", sharePermission: v === "all" ? undefined : v })}
        >
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部权限</SelectItem>
            <SelectItem value="VIEW">只读</SelectItem>
            <SelectItem value="OPERATE">可操作</SelectItem>
          </SelectContent>
        </Select>
        <Input
          defaultValue={keyword}
          placeholder="搜索：工作区名 / UUID / 用户名（含所有者/被共享者）"
          className="w-72"
          onKeyDown={(e) => {
            if (e.key === "Enter") pushQuery({ page: "1", keyword: (e.target as HTMLInputElement).value || undefined })
          }}
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        filters={[]}
        selectedIds={selectedIds}
        onSelectedChange={setSelectedIds}
        emptyText="暂无共享记录（用户共享工作区后会在此出现，可精确撤销）"
        batchToolbar={
          selectedIds.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">已选 {selectedIds.length} 条</span>
              <Button variant="destructive" size="sm" disabled={busy === "batch"} onClick={() => setConfirmState({ kind: "batch" })}>
                {busy === "batch" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Ban className="h-3.5 w-3.5 mr-1" />}
                批量撤销（移除被共享者访问权）
              </Button>
            </div>
          ) : undefined
        }
        onQueryChange={(params) => pushQuery(params)}
      />

      {/* ---- 确认弹窗 ---- */}
      <ConfirmDialog
        open={!!confirmState}
        onOpenChange={(v) => { if (!v) setConfirmState(null) }}
        onConfirm={async () => {
          if (!confirmState) return
          if (confirmState.kind === "single") await doRevokeSingle(confirmState.row)
          else if (confirmState.kind === "allOfWs") await doRevokeAllOfWs(confirmState.row)
          else if (confirmState.kind === "batch") {
            setBusy("batch")
            await doBatchRevoke()
            setBusy("")
          }
          setConfirmState(null)
        }}
        title={confirmState?.kind === "batch" ? "批量撤销共享" : confirmState?.kind === "allOfWs" ? "整工作区撤销" : "撤销共享"}
        description={
          confirmState?.kind === "single"
            ? `确定撤销「${confirmState.row.workspaceName}」对用户「${confirmState.row.targetUsername}」的共享？撤销后该用户立即失去访问权（审计记录保留）。`
            : confirmState?.kind === "allOfWs"
            ? `确定撤销「${confirmState.row.workspaceName}」的全部共享（生效中 ${confirmState.row.activeSharesOfWs} 条）？所有被共享者将立即失去访问权。`
            : `确定撤销选中的 ${selectedIds.length} 条共享？对应被共享者将立即失去访问权。`
        }
        destructive
      />
    </div>
  )
}
