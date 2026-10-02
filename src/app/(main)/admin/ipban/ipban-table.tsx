"use client"

// r23-C：IP 封禁管理客户端表格
// · 数据源：listIpBansAction（服务端分页 + 搜索 + 状态筛选），useEffect 挂载/变更加载
// · 手动封禁（IPv4 校验 / 时长 0=长期 / 原因必填 → ConfirmDialog）
// · 解封（可填备注 → manualUnbanIpAction）
// · 行多选 + 批量删除（封禁中的记录前端预判禁用，提示先解封）

import * as React from "react"
import { toast } from "sonner"
import {
  Loader2, Search, RefreshCw, Plus, Trash2, ShieldOff, ShieldBan, Inbox,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { ConfirmDialog, PrecisionInput, StatCard } from "@/components/shared/confirm"
import {
  listIpBansAction, manualBanIpAction, manualUnbanIpAction, deleteIpBanRecordAction,
} from "@/server/actions/admin-ipban"
import { cn } from "@/lib/utils"

interface IpBanRow {
  id: string
  ip: string
  source: string
  failCount: number
  firstFailAt: string | null
  lastFailAt: string | null
  bannedUntil: string | null
  remainMinutes: number | null
  reason: string | null
  note: string | null
  unbannedAt: string | null
  updatedAt: string
}

interface ListResult {
  items: IpBanRow[]
  total: number
  page: number
  pageSize: number
  stats: { banned: number; counting: number }
}

const PAGE_SIZE = 20
const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

// 客户端日期格式化（server 的 fmtDate 不可在客户端 import，与 share-dialogs 同模式）
function fmtDT(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  LOGIN: { label: "登录失败", cls: "bg-amber-500 hover:bg-amber-500 text-white" },
  API_KEY: { label: "API-Key", cls: "bg-orange-500 hover:bg-orange-500 text-white" },
  MANUAL: { label: "手动", cls: "bg-red-500 hover:bg-red-500 text-white" },
}

export function IpBanTable() {
  // ---- 列表状态（服务端分页） ----
  const [q, setQ] = React.useState("")
  const [status, setStatus] = React.useState<"all" | "banned" | "counting">("all")
  const [page, setPage] = React.useState(1)
  const [data, setData] = React.useState<ListResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await listIpBansAction({ q: q.trim(), status, page, pageSize: PAGE_SIZE })
      if (res.code === 0 && res.data) {
        setData(res.data)
        // 数据刷新后剔除已不存在的勾选
        const ids = new Set(res.data.items.map((i) => i.id))
        setSelected((prev) => {
          const next = new Set([...prev].filter((id) => ids.has(id)))
          return next.size === prev.size ? prev : next
        })
      } else {
        toast.error(res.msg || "加载封禁记录失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "网络异常")
    } finally {
      setLoading(false)
    }
  }, [q, status, page])

  React.useEffect(() => {
    const t = setTimeout(() => { void load() }, 250)
    return () => clearTimeout(t)
  }, [load])

  // ---- 手动封禁表单 + 确认 ----
  const [banOpen, setBanOpen] = React.useState(false)
  const [banIp, setBanIp] = React.useState("")
  const [banMinutes, setBanMinutes] = React.useState(60)
  const [banReason, setBanReason] = React.useState("")
  const [banNote, setBanNote] = React.useState("")
  const [banErrors, setBanErrors] = React.useState<{ ip?: string; reason?: string }>({})
  const [banConfirm, setBanConfirm] = React.useState(false)
  const [banBusy, setBanBusy] = React.useState(false)

  const openBanDialog = () => {
    setBanIp(""); setBanMinutes(60); setBanReason(""); setBanNote("")
    setBanErrors({}); setBanConfirm(false)
    setBanOpen(true)
  }

  const validateBanForm = (): boolean => {
    const errs: { ip?: string; reason?: string } = {}
    if (!IP_RE.test(banIp.trim())) errs.ip = "IPv4 格式非法，如 203.0.113.7"
    if (banReason.trim().length < 2) errs.reason = "原因至少 2 个字符"
    setBanErrors(errs)
    return Object.keys(errs).length === 0
  }

  const doManualBan = async () => {
    setBanBusy(true)
    try {
      const res = await manualBanIpAction({
        ip: banIp.trim(),
        minutes: banMinutes,
        reason: banReason.trim(),
        note: banNote.trim() || undefined,
      })
      if (res.code === 0) {
        toast.success(`已封禁 ${banIp.trim()}（${banMinutes === 0 ? "长期" : `${banMinutes} 分钟`}）`)
        setBanOpen(false)
        setPage(1)
        void load()
      } else {
        toast.error(res.msg || "封禁失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "封禁失败")
    } finally {
      setBanBusy(false)
      setBanConfirm(false)
    }
  }

  // ---- 解封（可填备注） ----
  const [unbanTarget, setUnbanTarget] = React.useState<IpBanRow | null>(null)
  const [unbanNote, setUnbanNote] = React.useState("")
  const [unbanBusy, setUnbanBusy] = React.useState(false)

  const doUnban = async () => {
    if (!unbanTarget) return
    setUnbanBusy(true)
    try {
      const res = await manualUnbanIpAction({ id: unbanTarget.id, note: unbanNote.trim() || undefined })
      if (res.code === 0) {
        toast.success(`已解封 ${unbanTarget.ip}，失败计数已清零`)
        setUnbanTarget(null)
        void load()
      } else {
        toast.error(res.msg || "解封失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "解封失败")
    } finally {
      setUnbanBusy(false)
    }
  }

  // ---- 单行删除 ----
  const [deleteTarget, setDeleteTarget] = React.useState<IpBanRow | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      const res = await deleteIpBanRecordAction({ ids: [deleteTarget.id] })
      if (res.code === 0) {
        toast.success(`已删除 ${res.data?.deleted ?? 1} 条封禁记录`)
        setDeleteTarget(null)
        void load()
      } else {
        toast.error(res.msg || "删除失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败")
    } finally {
      setDeleteBusy(false)
    }
  }

  // ---- 批量删除（封禁中的记录前端预判禁用） ----
  const [batchConfirm, setBatchConfirm] = React.useState(false)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const rows = data?.items ?? []
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedBanned = selectedRows.filter((r) => r.remainMinutes != null)
  const batchDisabled = selected.size === 0 || selectedBanned.length > 0

  const doBatchDelete = async () => {
    setBatchBusy(true)
    try {
      const res = await deleteIpBanRecordAction({ ids: [...selected] })
      if (res.code === 0) {
        toast.success(`已删除 ${res.data?.deleted ?? selected.size} 条封禁记录`)
        setSelected(new Set())
        setBatchConfirm(false)
        void load()
      } else {
        toast.error(res.msg || "批量删除失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量删除失败")
    } finally {
      setBatchBusy(false)
    }
  }

  // ---- 全选（当前页） ----
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const someChecked = rows.some((r) => selected.has(r.id))
  const toggleAll = (v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (v) rows.forEach((r) => next.add(r.id))
      else rows.forEach((r) => next.delete(r.id))
      return next
    })
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const stats = data?.stats ?? { banned: 0, counting: 0 }

  return (
    <div className="space-y-4">
      {/* ---- 统计卡 ---- */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <StatCard title="封禁中" value={stats.banned} sub="bannedUntil > 当前时间" icon={<ShieldBan className="h-4 w-4" />} tone={stats.banned > 0 ? "danger" : "success"} />
        <StatCard title="计数中" value={stats.counting} sub="失败计数 > 0 且未被封禁" icon={<ShieldOff className="h-4 w-4" />} tone={stats.counting > 0 ? "warning" : "success"} />
        <StatCard title="记录总数" value={data?.total ?? "—"} sub={`当前筛选 · 第 ${page} / ${totalPages} 页`} icon={<Inbox className="h-4 w-4" />} />
      </div>

      {/* ---- 筛选/操作栏 ---- */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            placeholder="搜索 IP / 原因 / 备注..."
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v as typeof status); setPage(1) }}>
          <SelectTrigger className="w-32" aria-label="状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="banned">封禁中</SelectItem>
            <SelectItem value="counting">计数中</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          刷新
        </Button>
        <Button size="sm" onClick={openBanDialog} className="bg-red-600 hover:bg-red-700">
          <Plus className="mr-1 h-3.5 w-3.5" />
          手动封禁
        </Button>
      </div>

      {/* ---- 批量工具条 ---- */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <span className="text-muted-foreground">已选 {selected.size} 条</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={batchDisabled || batchBusy}
            onClick={() => setBatchConfirm(true)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            批量删除（{selected.size}）
          </Button>
          {selectedBanned.length > 0 && (
            <span className="text-xs text-amber-600">
              选中含 {selectedBanned.length} 条封禁生效中的记录，请先解封再删除
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            清空选择
          </Button>
        </div>
      )}

      {/* ---- 表格 ---- */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAll(v === true)}
                    aria-label="全选当前页"
                  />
                </TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="w-20">来源</TableHead>
                <TableHead className="w-16">失败</TableHead>
                <TableHead className="w-36">最近失败</TableHead>
                <TableHead className="w-48">封禁至</TableHead>
                <TableHead className="w-44">原因</TableHead>
                <TableHead className="w-36">备注</TableHead>
                <TableHead className="w-36">解封时间</TableHead>
                <TableHead className="w-28">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data && (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    加载封禁记录中...
                  </TableCell>
                </TableRow>
              )}
              {!loading && data && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                    暂无封禁记录{q || status !== "all" ? "（可调整搜索或状态筛选）" : ""}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const active = r.remainMinutes != null
                const src = SOURCE_META[r.source] || { label: r.source, cls: "bg-secondary text-secondary-foreground" }
                return (
                  <TableRow key={r.id} className={cn(active && "bg-red-50/50 dark:bg-red-950/10")}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={(v) => setSelected((prev) => {
                          const next = new Set(prev)
                          if (v === true) next.add(r.id)
                          else next.delete(r.id)
                          return next
                        })}
                        aria-label={`选择 ${r.ip}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-sm font-medium whitespace-nowrap">{r.ip}</TableCell>
                    <TableCell>
                      <Badge className={cn("text-[10px]", src.cls)}>{src.label}</Badge>
                    </TableCell>
                    <TableCell className="tabular-nums text-sm">{r.failCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDT(r.lastFailAt)}</TableCell>
                    <TableCell>
                      {active ? (
                        <div className="space-y-0.5">
                          <Badge variant="destructive" className="text-[10px]">封禁中 · 剩 {r.remainMinutes} 分</Badge>
                          <p className="text-xs text-muted-foreground whitespace-nowrap">{fmtDT(r.bannedUntil)}</p>
                        </div>
                      ) : r.bannedUntil ? (
                        <p className="text-xs text-muted-foreground whitespace-nowrap">
                          已过期
                          <span className="block">{fmtDT(r.bannedUntil)}</span>
                        </p>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">计数中</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs max-w-44 truncate" title={r.reason || ""}>{r.reason || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-36 truncate" title={r.note || ""}>{r.note || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.unbannedAt ? fmtDT(r.unbannedAt) : "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {active ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => { setUnbanTarget(r); setUnbanNote("") }}
                          >
                            <ShieldOff className="mr-1 h-3 w-3" />
                            解封
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">—</span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-red-600 hover:text-red-700"
                          disabled={active}
                          title={active ? "封禁生效中，请先解封再删除" : "删除该条记录"}
                          onClick={() => setDeleteTarget(r)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {/* ---- 简单分页条 ---- */}
        {data && data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <p className="text-xs text-muted-foreground">
              共 {data.total} 条 · 每页 {PAGE_SIZE} 条 · 第 {page} / {totalPages} 页
            </p>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page <= 1 || loading} onClick={() => setPage(1)}>首页</Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页</Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page >= totalPages || loading} onClick={() => setPage(totalPages)}>尾页</Button>
            </div>
          </div>
        )}
      </div>

      {/* ---- 手动封禁表单弹窗 ---- */}
      <Dialog open={banOpen} onOpenChange={(v) => { if (!banBusy) setBanOpen(v) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldBan className="h-5 w-5 text-red-500" />
              手动封禁 IP
            </DialogTitle>
            <DialogDescription>
              立即封禁指定 IP：封禁期内该 IP 的一切登录与 API-Key 调用将被拒绝（自动封禁与手动封禁同一张表）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">IP 地址（必填，IPv4）</Label>
              <Input
                value={banIp}
                onChange={(e) => setBanIp(e.target.value)}
                placeholder="192.0.2.99"
                className="font-mono"
                aria-invalid={!!banErrors.ip}
              />
              {banErrors.ip ? (
                <p className="text-xs text-red-600">{banErrors.ip}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">格式校验：0-255 四段点分十进制</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">封禁时长（分钟，0 = 长期）</Label>
              <PrecisionInput
                value={banMinutes}
                onChange={(n) => setBanMinutes(Math.round(n))}
                min={0}
                max={525600}
                step={1}
                suffix="分"
                className="w-40"
              />
              <p className="text-[11px] text-muted-foreground">范围 0-525600；0 视为长期封禁（100 年），默认 60</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">封禁原因（必填，2-200 字）</Label>
              <Input
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="如：异常爆破来源，人工处置"
                aria-invalid={!!banErrors.reason}
              />
              {banErrors.reason && <p className="text-xs text-red-600">{banErrors.reason}</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">备注（可选）</Label>
              <Input value={banNote} onChange={(e) => setBanNote(e.target.value)} placeholder="如：来自告警 #123 关联处置" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanOpen(false)} disabled={banBusy}>取消</Button>
            <Button
              variant="destructive"
              disabled={banBusy}
              onClick={() => { if (validateBanForm()) setBanConfirm(true) }}
            >
              下一步（确认封禁）
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 手动封禁确认 ---- */}
      <ConfirmDialog
        open={banConfirm}
        onOpenChange={(v) => { if (!banBusy) setBanConfirm(v) }}
        title="确认封禁该 IP？"
        destructive
        loading={banBusy}
        description={
          `IP：${banIp.trim() || "—"}\n` +
          `时长：${banMinutes === 0 ? "长期（100 年）" : `${banMinutes} 分钟`}\n` +
          `原因：${banReason.trim() || "—"}${banNote.trim() ? `\n备注：${banNote.trim()}` : ""}\n` +
          `封禁立即生效，操作全程审计留痕。`
        }
        onConfirm={doManualBan}
      />

      {/* ---- 解封确认（可填备注） ---- */}
      <Dialog open={!!unbanTarget} onOpenChange={(v) => { if (!unbanBusy && !v) setUnbanTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff className="h-5 w-5 text-teal-600" />
              解封确认
            </DialogTitle>
            <DialogDescription>
              将解除 {unbanTarget?.ip} 的封禁并清零失败计数；该 IP 可立即恢复登录与 API-Key 调用。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">备注（可选，写入审计）</Label>
            <Input
              value={unbanNote}
              onChange={(e) => setUnbanNote(e.target.value)}
              placeholder="如：确认为误报，已核实"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnbanTarget(null)} disabled={unbanBusy}>取消</Button>
            <Button onClick={doUnban} disabled={unbanBusy} className="bg-teal-600 hover:bg-teal-700">
              {unbanBusy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              确认解封
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 单行删除确认 ---- */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!deleteBusy && !v) setDeleteTarget(null) }}
        title="删除封禁记录？"
        destructive
        loading={deleteBusy}
        description={
          deleteTarget
            ? `将删除 ${deleteTarget.ip} 的封禁记录（含失败计数历史）。\n记录删除后该 IP 的历史计数不可恢复；仅可删除未在封禁生效中的记录。`
            : ""
        }
        onConfirm={doDelete}
      />

      {/* ---- 批量删除确认 ---- */}
      <ConfirmDialog
        open={batchConfirm}
        onOpenChange={(v) => { if (!batchBusy && !v) setBatchConfirm(false) }}
        title="批量删除封禁记录？"
        destructive
        loading={batchBusy}
        description={
          `将删除已选 ${selected.size} 条封禁记录：\n${selectedRows.map((r) => r.ip).join("、")}\n` +
          `仅可删除未在封禁生效中的记录；删除后历史计数不可恢复。`
        }
        onConfirm={doBatchDelete}
      />
    </div>
  )
}
