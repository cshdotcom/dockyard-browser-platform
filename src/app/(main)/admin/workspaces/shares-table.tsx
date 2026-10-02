"use client"

// r13c：管理员共享关系总列表（企业级共享权限管控中枢）
//   · 全景列：工作区/所有者/被共享者/权限/状态/沙箱否决/有效期/撤销时间/发起人
//   · 精确撤销：单人（行内）/ 批量（勾选）/ 整工作区（一键断掉全部共享）
//   · 沙箱级禁共享否决开关（四级管控最高层：开启后该工作区禁止任何新共享/链接）
//   · 筛选：状态（生效/已撤销/已过期）/ 权限（只读/可操作）/ 关键词（工作区名/uuid/用户名）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Share2, Ban, Undo2, Trash2, ExternalLink, UserX, Users2, Check } from "lucide-react"
import { DataTable, type Column } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  adminRevokeShareAction, adminBatchRevokeSharesAction, adminRevokeAllWorkspaceSharesAction,
  adminSetWorkspaceShareDisabledAction,
} from "@/server/actions/admin-workspaces"
import {
  adminSearchShareEvictTargetsAction, adminEvictUserSharesAction, adminEvictGroupSharesAction,
} from "@/server/actions/admin-share-evict"

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
  // r22b：按用户/按组强制清退弹窗（接收者维度批量撤销）
  const [evictOpen, setEvictOpen] = React.useState<"USER" | "GROUP" | null>(null)

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
        <div className="flex items-center gap-1.5 ml-auto">
          <Button variant="outline" size="sm" onClick={() => setEvictOpen("USER")} title="撤销某个用户作为接收者收到的全部生效共享">
            <UserX className="h-3.5 w-3.5 mr-1" /> 按用户清退
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEvictOpen("GROUP")} title="撤销某用户组全部成员作为接收者收到的全部生效共享">
            <Users2 className="h-3.5 w-3.5 mr-1" /> 按组清退
          </Button>
        </div>
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

      {/* ---- r22b：按用户/按组强制清退弹窗 ---- */}
      {evictOpen && (
        <ShareEvictDialog
          kind={evictOpen}
          open={!!evictOpen}
          onOpenChange={(v) => { if (!v) setEvictOpen(null) }}
          onDone={() => { setSelectedIds([]); router.refresh() }}
        />
      )}
    </div>
  )
}

// ---- r22b：按用户/组清退弹窗（搜索选择目标 + 确认 + 执行） ----
interface EvictTarget {
  id: string
  label: string
  sub: string
  memberCount: number
  activeCount: number
}

function ShareEvictDialog({ kind, open, onOpenChange, onDone }: {
  kind: "USER" | "GROUP"
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [q, setQ] = React.useState("")
  const [items, setItems] = React.useState<EvictTarget[]>([])
  const [searchBusy, setSearchBusy] = React.useState(false)
  const [selected, setSelected] = React.useState<EvictTarget | null>(null)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 搜索候选（防抖 300ms；携带生效共享条数供确认展示）
  React.useEffect(() => {
    if (!open) return
    const kw = q.trim()
    if (!kw) { setItems([]); return }
    let alive = true
    setSearchBusy(true)
    const t = setTimeout(async () => {
      try {
        const res = await adminSearchShareEvictTargetsAction({ kind, q: kw })
        if (alive && res.code === 0) setItems(res.data?.items || [])
        else if (alive) setItems([])
      } catch { if (alive) setItems([]) } finally { if (alive) setSearchBusy(false) }
    }, 300)
    return () => { alive = false; clearTimeout(t); setSearchBusy(false) }
  }, [q, kind, open])

  React.useEffect(() => {
    if (open) { setQ(""); setItems([]); setSelected(null); setConfirmOpen(false) }
  }, [open, kind])

  const exec = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const res = kind === "USER"
        ? await adminEvictUserSharesAction({ targetUserId: selected.id })
        : await adminEvictGroupSharesAction({ groupId: selected.id })
      if (res.code === 0) {
        const revoked = res.data?.revoked ?? 0
        if (kind === "USER") {
          toast.success(`已清退用户「${selected.label}」：撤销其收到的 ${revoked} 条生效共享`)
        } else {
          const groupRes = res as { data?: { memberCount?: number } }
          toast.success(`已清退组「${selected.label}」（${groupRes.data?.memberCount ?? 0} 名成员）：撤销 ${revoked} 条生效共享`)
        }
        setConfirmOpen(false)
        onOpenChange(false)
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              {kind === "USER" ? <UserX className="h-4 w-4" /> : <Users2 className="h-4 w-4" />}
              {kind === "USER" ? "按用户清退共享" : "按用户组清退共享"}
            </DialogTitle>
            <DialogDescription>
              {kind === "USER"
                ? "撤销所选用户作为接收者收到的全部生效共享（其自己的工作区与他人不受影响）"
                : "撤销所选组全部成员作为接收者收到的全部生效共享（不影响其工作区所有权）"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label>{kind === "USER" ? "搜索用户（用户名/昵称）" : "搜索用户组名称"}</Label>
              <div className="relative">
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "USER" ? "如：demo" : "如：默认组"} autoComplete="off" />
                {searchBusy && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            </div>
            {items.length > 0 && (
              <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
                {items.map((it) => {
                  const isSel = selected?.id === it.id
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-muted/70 transition",
                        isSel && "bg-red-50/70 dark:bg-red-950/30",
                      )}
                      onClick={() => setSelected(isSel ? null : it)}
                    >
                      <span className="min-w-0">
                        <span className="font-medium font-mono text-[13px]">{it.label}</span>
                        {it.sub && <span className="ml-1.5 text-xs text-muted-foreground truncate">{it.sub}</span>}
                        {kind === "GROUP" && <span className="ml-1.5 text-xs text-muted-foreground">成员 {it.memberCount}</span>}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {it.activeCount > 0 ? (
                          <Badge variant="secondary" className="text-[10px] text-red-600">生效共享 {it.activeCount} 条</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">无生效共享</Badge>
                        )}
                        {isSel && <Check className="h-3.5 w-3.5 text-red-600" />}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {q.trim() && !searchBusy && items.length === 0 && (
              <p className="text-xs text-red-600">未找到匹配{kind === "USER" ? "用户" : "用户组"}</p>
            )}
            {selected && (
              <div className="rounded-md border border-red-200 bg-red-50/70 dark:bg-red-950/30 dark:border-red-900 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                已选目标：{kind === "USER" ? "用户" : "用户组"}「{selected.label}」· 将撤销其收到的生效共享
                {selected.activeCount > 0 ? ` ${selected.activeCount} 条` : " 0 条（无生效共享，操作为空转）"}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
            <Button variant="destructive" disabled={!selected || busy} onClick={() => setConfirmOpen(true)}>
              <UserX className="h-3.5 w-3.5 mr-1" /> 清退其收到的共享
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(v) => { if (!busy) setConfirmOpen(v) }}
        title={kind === "USER" ? "按用户清退共享" : "按用户组清退共享"}
        description={
          selected
            ? kind === "USER"
              ? `确认清退用户「${selected.label}」收到的全部工作区共享？\n· 将撤销其作为接收者的生效共享 ${selected.activeCount} 条\n· 该用户立即失去相关访问权，审计记录保留`
              : `确认清退用户组「${selected.label}」（${selected.memberCount} 名成员）收到的全部工作区共享？\n· 将撤销组内成员作为接收者的生效共享 ${selected.activeCount} 条\n· 相关成员立即失去访问权，不影响工作区所有权`
            : ""
        }
        destructive
        confirmText="确认清退"
        loading={busy}
        onConfirm={exec}
      />
    </>
  )
}
