"use client"

// 公告管理交互：CRUD 弹窗（GLOBAL/GROUP/USER 范围选择器 + 多选发布通道 + MD 编辑器）+ 预览弹窗
// r15：内容 Markdown/HTML 双支持（轻量编辑器工具栏）；发布通道多选：展示方式（弹窗/跑马灯/强制阅读）
// + 站内信（通知铃）可叠加或单独发送

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { BellRing, Clock3, Eye, Loader2, Megaphone, Pencil, Plus, Power, PowerOff, Search, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { BatchBar, BatchFailuresDialog, BatchConfirmDialog, useBatch } from "@/components/shared/batch-ui"
import { AnnouncementContent, AnnouncementSummary, contentToPlainText } from "@/components/announcements/announcement-content"
import { AnnouncementEditor } from "@/components/announcements/announcement-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { upsertAnnouncementAction, toggleAnnouncementAction, deleteAnnouncementAction } from "@/server/actions/announcements"
import { batchToggleAnnouncementsAction, batchDeleteAnnouncementsAction } from "@/server/actions/batch"

export interface AnnouncementRow {
  id: string
  title: string
  content: string
  type: string // GLOBAL | GROUP | USER
  groupId: string | null
  groupName: string | null
  userId: string | null
  targetUsername: string | null
  displayType: string // 主展示方式（兼容字段）
  displayTypes: string[] // 多选发布通道（含 POPUP/MARQUEE/FORCE_VIEW）
  notifyInbox: boolean // 站内信通道
  notifiedAt: string | null // 站内信已投递时间
  startAt: string | null // 显示开始时间（空=立即）
  endAt: string | null // 结束时间（空=永久）
  persistAfterRead: boolean // 已读后仍持续显示
  allowDismiss: boolean // 允许「今日不再提醒」
  enabled: boolean
  creatorName: string
  createdAt: string
}

const TYPE_LABEL: Record<string, string> = { GLOBAL: "全站", GROUP: "用户组", USER: "定向用户" }
const DISPLAY_LABEL: Record<string, string> = { POPUP: "弹窗", MARQUEE: "跑马灯", FORCE_VIEW: "强制阅读" }

interface AnnouncementsTableProps {
  rows: AnnouncementRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  groupOptions: { id: string; name: string }[]
  userOptions: { id: string; username: string; displayName: string }[]
}

export function AnnouncementsTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, groupOptions, userOptions }: AnnouncementsTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AnnouncementRow | null>(null)
  const [previewTarget, setPreviewTarget] = React.useState<AnnouncementRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<AnnouncementRow | null>(null)
  // r22：行点击详情预览（点击标题列打开完整内容 + 全量元信息）
  const [detailTarget, setDetailTarget] = React.useState<AnnouncementRow | null>(null)

  // ---- 批量操作（勾选 + 批量停用/启用 + 批量删除）----
  const btch = useBatch(rows, `${keyword || ""}|${JSON.stringify(filters)}`)

  // 表单状态
  const [fTitle, setFTitle] = React.useState("")
  const [fContent, setFContent] = React.useState("")
  const [fType, setFType] = React.useState<"GLOBAL" | "GROUP" | "USER">("GLOBAL")
  const [fGroupId, setFGroupId] = React.useState("")
  const [fUserId, setFUserId] = React.useState("")
  const [fDisplays, setFDisplays] = React.useState<string[]>(["POPUP"]) // 多选展示方式
  const [fNotifyInbox, setFNotifyInbox] = React.useState(false) // 站内信通道
  const [fStartAt, setFStartAt] = React.useState("") // datetime-local
  const [fEndAt, setFEndAt] = React.useState("") // datetime-local
  const [fPersist, setFPersist] = React.useState(false) // 已读后仍持续显示
  const [fAllowDismiss, setFAllowDismiss] = React.useState(true) // 允许今日不再提醒
  const [fEnabled, setFEnabled] = React.useState(true)
  // 用户搜索器
  const [userSearch, setUserSearch] = React.useState("")
  const [pickedUser, setPickedUser] = React.useState<{ id: string; username: string } | null>(null)

  // datetime-local 显示用（分钟精度）
  const toLocalInput = (iso: string | null): string => {
    if (!iso) return ""
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    const p = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const toggleDisplay = (d: string, on: boolean) => {
    setFDisplays((prev) => (on ? Array.from(new Set([...prev, d])) : prev.filter((x) => x !== d)))
  }

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const openCreate = () => {
    setEditing(null)
    setFTitle("")
    setFContent("")
    setFType("GLOBAL")
    setFGroupId("")
    setFUserId("")
    setFDisplays(["POPUP"])
    setFNotifyInbox(false)
    setFStartAt("")
    setFEndAt("")
    setFPersist(false)
    setFAllowDismiss(true)
    setFEnabled(true)
    setUserSearch("")
    setPickedUser(null)
    setFormOpen(true)
  }

  const openEdit = (row: AnnouncementRow) => {
    setEditing(row)
    setFTitle(row.title)
    setFContent(row.content)
    setFType(row.type as "GLOBAL" | "GROUP" | "USER")
    setFGroupId(row.groupId || "")
    setFUserId(row.userId || "")
    setFDisplays(row.displayTypes?.length ? row.displayTypes : [row.displayType])
    setFNotifyInbox(!!row.notifyInbox)
    setFStartAt(toLocalInput(row.startAt))
    setFEndAt(toLocalInput(row.endAt))
    setFPersist(!!row.persistAfterRead)
    setFAllowDismiss(row.allowDismiss !== false)
    setFEnabled(row.enabled)
    const u = userOptions.find((x) => x.id === row.userId)
    setPickedUser(u ? { id: u.id, username: u.username } : null)
    setUserSearch("")
    setFormOpen(true)
  }

  const submit = async () => {
    if (!fTitle.trim()) {
      toast.error("公告标题必填")
      return
    }
    if (!fContent.trim()) {
      toast.error("公告内容必填")
      return
    }
    if (fType === "GROUP" && !fGroupId) {
      toast.error("请选择目标用户组")
      return
    }
    if (fType === "USER" && !fUserId) {
      toast.error("请搜索并选择目标用户")
      return
    }
    if (fDisplays.length === 0 && !fNotifyInbox) {
      toast.error("至少选择一种发布通道：展示方式（弹窗/跑马灯/强制阅读）或站内信")
      return
    }
    // 时效校验：开始必须早于结束
    if (fStartAt && fEndAt && new Date(fStartAt).getTime() >= new Date(fEndAt).getTime()) {
      toast.error("显示开始时间必须早于结束时间")
      return
    }
    setBusy("form")
    try {
      const res = await upsertAnnouncementAction({
        id: editing?.id,
        title: fTitle.trim(),
        content: fContent.trim(),
        type: fType,
        groupId: fType === "GROUP" ? fGroupId : undefined,
        userId: fType === "USER" ? fUserId : undefined,
        displayTypes: fDisplays,
        notifyInbox: fNotifyInbox,
        startAt: fStartAt || undefined,
        endAt: fEndAt || undefined,
        persistAfterRead: fPersist,
        allowDismiss: fAllowDismiss,
        enabled: fEnabled,
      })
      if (res.code === 0) {
        const delivered = res.data?.inboxDelivered
        toast.success(
          editing
            ? "公告已更新"
            : fNotifyInbox
              ? `公告已创建${delivered != null ? `，站内信已投递 ${delivered} 位用户` : ""}`
              : "公告已创建",
        )
        setFormOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy("")
    }
  }

  const callAction = async (name: string, fn: () => Promise<{ code: number; msg: string }>) => {
    setBusy(name)
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
      setBusy("")
    }
  }

  const filteredUsers = React.useMemo(() => {
    const kw = userSearch.trim().toLowerCase()
    if (!kw) return userOptions.slice(0, 8)
    return userOptions.filter((u) => u.username.toLowerCase().includes(kw) || u.displayName.toLowerCase().includes(kw)).slice(0, 20)
  }, [userSearch, userOptions])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">点击公告标题可查看详情预览；删除为物理删除（不进回收站）；停用后用户端 ≤30s 内不再显示</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          新建公告
        </Button>
      </div>

      {btch.selected.length > 0 && (
        <BatchBar count={btch.selected.length} onClear={() => btch.setSelected([])} busy={!!btch.busy} label="条">
          <Button size="sm" variant="outline" disabled={!!btch.busy} onClick={() => btch.runBatch("批量停用", () => batchToggleAnnouncementsAction({ ids: btch.selected, enabled: false }))}>
            <PowerOff className="mr-1 h-3.5 w-3.5" /> 批量停用
          </Button>
          <Button size="sm" variant="outline" disabled={!!btch.busy} onClick={() => btch.runBatch("批量启用", () => batchToggleAnnouncementsAction({ ids: btch.selected, enabled: true }))}>
            <Power className="mr-1 h-3.5 w-3.5" /> 批量启用
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-red-600 hover:text-red-700 border-red-200 dark:border-red-900"
            disabled={!!btch.busy}
            onClick={() => btch.confirmBatch(
              "批量删除公告",
              `确认删除选中的 ${btch.selected.length} 条公告？\n公告不进回收站（物理删除）；如仅需用户端不再显示建议优先停用。`,
              () => btch.runBatch("批量删除", () => batchDeleteAnnouncementsAction({ ids: btch.selected })),
              "DELETE",
            )}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> 批量删除
          </Button>
        </BatchBar>
      )}

      <BatchFailuresDialog failures={btch.failures} onClose={() => btch.setFailures(null)} />
      <BatchConfirmDialog action={btch.confirmAction} onClose={() => btch.setConfirmAction(null)} busy={!!btch.busy} />

      <DataTable
        rows={rows}
        selectedIds={btch.selected}
        onSelectedChange={btch.setSelected}
        batchToolbar={<span className="text-xs text-muted-foreground">已选 {btch.selected.length} / {rows.length} 条</span>}
        total={total}
        page={page}
        pageSize={pageSize}
        keyword={keyword}
        sortField={sortField}
        sortOrder={sortOrder}
        onQueryChange={pushQuery}
        filters={[
          {
            key: "type",
            placeholder: "公告类型",
            options: [
              { label: "全站", value: "GLOBAL" },
              { label: "用户组", value: "GROUP" },
              { label: "定向用户", value: "USER" },
            ],
          },
          {
            key: "displayType",
            placeholder: "展示方式",
            options: [
              { label: "弹窗", value: "POPUP" },
              { label: "跑马灯", value: "MARQUEE" },
              { label: "强制阅读", value: "FORCE_VIEW" },
            ],
          },
          {
            key: "enabled",
            placeholder: "启用状态",
            options: [
              { label: "已启用", value: "true" },
              { label: "已停用", value: "false" },
            ],
          },
        ]}
        emptyText="暂无公告"
        columns={[
          {
            key: "title",
            title: "标题（点击查看详情）",
            render: (r) => (
              <button
                type="button"
                className="min-w-0 max-w-64 text-left group"
                onClick={() => setDetailTarget(r)}
                title={`点击查看详情：${r.title}`}
                aria-label={`查看公告详情：${r.title}`}
              >
                <p className="text-sm font-medium truncate group-hover:text-teal-600 group-hover:underline">{r.title}</p>
                <p className="text-xs text-muted-foreground truncate" title={contentToPlainText(r.content, 200)}>
                  <AnnouncementSummary content={r.content} maxLen={60} />
                </p>
              </button>
            ),
          },
          {
            key: "type",
            title: "类型",
            render: (r) => (
              <Badge
                className={cn(
                  r.type === "GLOBAL" ? "bg-teal-600 hover:bg-teal-600 text-white" : r.type === "GROUP" ? "bg-sky-600 hover:bg-sky-600 text-white" : "bg-secondary"
                )}
              >
                {TYPE_LABEL[r.type] || r.type}
              </Badge>
            ),
          },
          {
            key: "scope",
            title: "范围",
            render: (r) => {
              if (r.type === "GLOBAL") return <span className="text-sm text-muted-foreground">全站用户</span>
              if (r.type === "GROUP") return <span className="text-sm">{r.groupName || r.groupId || "未知组"}</span>
              return <span className="text-sm font-mono text-xs">{r.targetUsername || r.userId || "未知用户"}</span>
            },
          },
          {
            key: "channels",
            title: "发布通道",
            render: (r) => (
              <div className="flex flex-wrap gap-1">
                {(r.displayTypes?.length ? r.displayTypes : [r.displayType]).map((d) => (
                  <Badge key={d} variant="outline" className="text-[11px]">{DISPLAY_LABEL[d] || d}</Badge>
                ))}
                {r.notifyInbox && (
                  <Badge key="inbox" className="bg-violet-600 hover:bg-violet-600 text-white text-[11px]">
                    <BellRing className="mr-0.5 h-2.5 w-2.5" />站内信
                  </Badge>
                )}
                {!r.displayTypes?.length && !r.notifyInbox && <Badge variant="outline" className="text-[11px]">未设置</Badge>}
              </div>
            ),
          },
          {
            key: "enabled",
            title: "启用",
            render: (r) => (
              <Switch
                checked={r.enabled}
                disabled={busy === `toggle:${r.id}`}
                onCheckedChange={(b) => callAction(`toggle:${r.id}`, () => toggleAnnouncementAction({ id: r.id, enabled: b }))}
                aria-label={`启用 ${r.title}`}
              />
            ),
          },
          { key: "creatorName", title: "创建人", render: (r) => <span className="text-sm">{r.creatorName}</span> },
          { key: "createdAt", title: "创建时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span> },
        ]}
        rowActions={(r) => (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setPreviewTarget(r)} aria-label={`预览 ${r.title}`}>
              <Eye className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={`编辑 ${r.title}`}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={() => setDeleteTarget(r)}
              disabled={busy === `delete:${r.id}`}
              aria-label={`删除 ${r.title}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      />

      {/* 新建/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !v && setFormOpen(false)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-teal-600" />
              {editing ? "编辑公告" : "新建公告"}
            </DialogTitle>
            <DialogDescription>范围决定投放对象；发布通道可多选组合（含站内信）；内容支持 Markdown 与直接 HTML</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>公告标题</Label>
              <Input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="如：平台升级维护通知" maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label>公告内容（Markdown / HTML）</Label>
              <AnnouncementEditor value={fContent} onChange={setFContent} rows={9} />
            </div>
            <div className="space-y-1.5">
              <Label>范围类型</Label>
              <RadioGroup value={fType} onValueChange={(v) => setFType(v as "GLOBAL" | "GROUP" | "USER")} className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="GLOBAL" /> 全站（GLOBAL）
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="GROUP" /> 用户组（GROUP）
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="USER" /> 定向用户（USER）
                </label>
              </RadioGroup>
            </div>
            {fType === "GROUP" && (
              <div className="space-y-1.5">
                <Label>目标用户组</Label>
                <Select value={fGroupId || "__none__"} onValueChange={(v) => setFGroupId(v === "__none__" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="选择用户组" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未选择</SelectItem>
                    {groupOptions.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {fType === "USER" && (
              <div className="space-y-2">
                <Label>目标用户（输入用户名搜索后选择）</Label>
                <div className="flex gap-2">
                  <Input
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="输入用户名 / 昵称关键词"
                    className="flex-1"
                  />
                  <Button variant="secondary" size="sm" aria-label="搜索用户">
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
                {pickedUser && (
                  <div className="flex items-center justify-between rounded-md border border-teal-200 bg-teal-50 dark:bg-teal-950/20 px-3 py-1.5 text-sm">
                    <span>
                      已选择：<span className="font-medium">{pickedUser.username}</span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => { setPickedUser(null); setFUserId("") }} aria-label="取消选择">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                <ScrollArea className="h-32 rounded-md border">
                  <div className="divide-y">
                    {filteredUsers.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-muted text-left"
                        onClick={() => {
                          setPickedUser({ id: u.id, username: u.username })
                          setFUserId(u.id)
                        }}
                      >
                        <span>{u.username}</span>
                        <span className="text-xs text-muted-foreground">{u.displayName || "-"}</span>
                      </button>
                    ))}
                    {filteredUsers.length === 0 && (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">未找到匹配用户</p>
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>发布通道（可多选组合；站内信可与其他通道叠加，也可单独发送）</Label>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {(["POPUP", "MARQUEE", "FORCE_VIEW"] as const).map((d) => (
                  <label
                    key={d}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 text-sm transition",
                      fDisplays.includes(d) ? "border-teal-300 bg-teal-50/70 dark:bg-teal-950/30" : "hover:bg-muted/60",
                    )}
                  >
                    <Checkbox checked={fDisplays.includes(d)} onCheckedChange={(v) => toggleDisplay(d, v === true)} />
                    <span className="font-medium">{DISPLAY_LABEL[d]}</span>
                    <span className="text-xs text-muted-foreground">
                      {d === "POPUP" ? "登录后弹窗一次" : d === "MARQUEE" ? "顶部滚动公告条" : "必须阅读确认"}
                    </span>
                  </label>
                ))}
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 text-sm transition",
                    fNotifyInbox ? "border-violet-300 bg-violet-50/70 dark:bg-violet-950/30" : "hover:bg-muted/60",
                  )}
                >
                  <Checkbox checked={fNotifyInbox} onCheckedChange={(v) => setFNotifyInbox(v === true)} />
                  <span className="font-medium flex items-center gap-1">
                    <BellRing className="h-3.5 w-3.5 text-violet-500" /> 站内信（通知铃）
                  </span>
                  <span className="text-xs text-muted-foreground">发送到用户消息中心；可单独发送</span>
                </label>
              </div>
              {fDisplays.length === 0 && !fNotifyInbox && (
                <p className="text-xs text-red-600">至少选择一种发布通道（当前未选择任何通道）</p>
              )}
              {fDisplays.length === 0 && fNotifyInbox && (
                <p className="text-xs text-violet-600">仅站内信：公告不会弹窗/滚动，只发送到目标用户消息中心（通知铃）</p>
              )}
              {editing?.notifiedAt && fNotifyInbox && (
                <p className="text-xs text-muted-foreground">站内信已于 {editing.notifiedAt} 投递过（不会重复发送；范围变更后新增用户不补发）</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5 text-teal-600" />显示时效（定时发布 / 到期自动隐藏）</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">显示开始时间（空 = 立即显示）</Label>
                  <Input type="datetime-local" value={fStartAt} onChange={(e) => setFStartAt(e.target.value)} aria-label="显示开始时间" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">结束时间（空 = 永久有效）</Label>
                  <Input type="datetime-local" value={fEndAt} onChange={(e) => setFEndAt(e.target.value)} aria-label="结束时间" />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">未到开始时间不展示；超过结束时间后用户端不再显示（站内信保留可回看）；管理列表可查全部</p>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span>
                  <span className="text-sm font-medium block">已读后仍持续显示</span>
                  <span className="text-xs text-muted-foreground">弹窗公告被已读后，用户每次刷新页面仍会弹出（除非勾选「今日不再提醒」）</span>
                </span>
                <Switch checked={fPersist} onCheckedChange={setFPersist} aria-label="已读后仍持续显示" />
              </label>
              <div className="border-t pt-2">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="text-sm font-medium block">允许用户「今日不再提醒」</span>
                    <span className="text-xs text-muted-foreground">关闭后用户无法跳过弹窗/跑马灯（适用于强制合规通知）</span>
                  </span>
                  <Switch checked={fAllowDismiss} onCheckedChange={setFAllowDismiss} aria-label="允许今日不再提醒" />
                </label>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">立即启用</p>
                <p className="text-xs text-muted-foreground">关闭则保存为草稿，不投放给用户；停用后用户端 ≤30 秒内不再显示</p>
              </div>
              <Switch checked={fEnabled} onCheckedChange={setFEnabled} aria-label="启用公告" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={busy === "form"}>
              {busy === "form" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? "保存修改" : "创建公告"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 预览弹窗：按展示方式模拟（内容按 MD/HTML 渲染，与用户端一致） */}
      {previewTarget && (
        <Dialog open onOpenChange={(v) => !v && setPreviewTarget(null)}>
          <DialogContent className={cn(previewTarget.displayType === "MARQUEE" ? "max-w-2xl p-0 overflow-hidden" : "max-w-lg")}>
            {previewTarget.displayType === "POPUP" && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Megaphone className="h-4 w-4 text-teal-600" />
                    {previewTarget.title}
                  </DialogTitle>
                  <DialogDescription>预览：弹窗展示（用户登录后弹出一次）</DialogDescription>
                </DialogHeader>
                <div className="rounded-md border p-4 max-h-72 overflow-y-auto">
                  <AnnouncementContent content={previewTarget.content} />
                </div>
                <DialogFooter>
                  <Button onClick={() => setPreviewTarget(null)}>知道了</Button>
                </DialogFooter>
              </>
            )}
            {previewTarget.displayType === "MARQUEE" && (
              <>
                <DialogHeader className="px-6 pt-6">
                  <DialogTitle>跑马灯预览</DialogTitle>
                  <DialogDescription>预览：页面顶部滚动公告条（循环滚动，纯文本摘要）</DialogDescription>
                </DialogHeader>
                <div className="px-6 pb-2">
                  <div className="overflow-hidden rounded-md border bg-muted">
                    <div
                      className="whitespace-nowrap py-2 text-sm"
                      style={{ animation: "dy-marquee 14s linear infinite" }}
                    >
                      🔔 {previewTarget.title} —— <AnnouncementSummary content={previewTarget.content} maxLen={80} />
                    </div>
                  </div>
                  <style>{`@keyframes dy-marquee { 0% { transform: translateX(100%); } 100% { transform: translateX(-100%); } }`}</style>
                </div>
                <DialogFooter className="px-6 pb-6">
                  <Button variant="outline" onClick={() => setPreviewTarget(null)}>关闭预览</Button>
                </DialogFooter>
              </>
            )}
            {previewTarget.displayType === "FORCE_VIEW" && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Megaphone className="h-4 w-4 text-red-500" />
                    {previewTarget.title}
                  </DialogTitle>
                  <DialogDescription>预览：强制阅读（用户必须勾选确认后才能继续操作）</DialogDescription>
                </DialogHeader>
                <ForceViewPreview
                  row={previewTarget}
                  onDone={() => setPreviewTarget(null)}
                />
              </>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* r22：行点击详情预览 —— 完整 MD/HTML 渲染（限高滚动不溢出）+ 全量元信息，与用户端详情弹窗一致 */}
      <Dialog open={!!detailTarget} onOpenChange={(v) => { if (!v) setDetailTarget(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <Megaphone className="h-5 w-5 text-teal-600 shrink-0" />
              <span className="truncate">{detailTarget?.title}</span>
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 flex-wrap">
              公告详情预览 · 用户端渲染效果一致
            </DialogDescription>
          </DialogHeader>
          {/* 元信息总览 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs rounded-md border bg-muted/40 p-3">
            <p>
              <span className="text-muted-foreground">类型：</span>
              <span className="font-medium">{detailTarget ? TYPE_LABEL[detailTarget.type] || detailTarget.type : "-"}</span>
            </p>
            <p className="truncate">
              <span className="text-muted-foreground">范围：</span>
              <span className="font-medium">
                {detailTarget
                  ? detailTarget.type === "GLOBAL"
                    ? "全站用户"
                    : detailTarget.type === "GROUP"
                      ? detailTarget.groupName || detailTarget.groupId || "未知组"
                      : detailTarget.targetUsername || detailTarget.userId || "未知用户"
                  : "-"}
              </span>
            </p>
            <p className="truncate">
              <span className="text-muted-foreground">创建人：</span>
              <span className="font-medium">{detailTarget?.creatorName || "-"}</span>
            </p>
            <p className="col-span-2 sm:col-span-1">
              <span className="text-muted-foreground">发布通道：</span>
              <span className="font-medium">
                {detailTarget
                  ? [
                      ...(detailTarget.displayTypes?.length ? detailTarget.displayTypes : [detailTarget.displayType]),
                      ...(detailTarget.notifyInbox ? ["站内信"] : []),
                    ]
                      .map((d) => DISPLAY_LABEL[d] || (d === "站内信" ? "站内信" : d))
                      .join(" / ") || "未设置"
                  : "-"}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground">显示时效：</span>
              <span className="font-medium">
                {detailTarget ? `${detailTarget.startAt || "立即"} ~ ${detailTarget.endAt || "永久"}` : "-"}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground">状态：</span>
              <span className="font-medium">{detailTarget?.enabled ? "已启用" : "已停用"}</span>
            </p>
            <p>
              <span className="text-muted-foreground">已读后仍显示：</span>
              <span className="font-medium">{detailTarget?.persistAfterRead ? "是" : "否"}</span>
            </p>
            <p>
              <span className="text-muted-foreground">允许今日不再提醒：</span>
              <span className="font-medium">{detailTarget ? (detailTarget.allowDismiss ? "是" : "否" ) : "-"}</span>
            </p>
            <p>
              <span className="text-muted-foreground">创建时间：</span>
              <span className="font-medium tabular-nums">{detailTarget?.createdAt || "-"}</span>
            </p>
          </div>
          {/* 完整内容：限高 + 滚动（长 MD/HTML 公告不溢出不错乱） */}
          <ScrollArea className="max-h-[50vh] rounded-md border px-3 py-2">
            <AnnouncementContent content={detailTarget?.content || ""} />
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailTarget(null)}>关闭</Button>
            <Button
              variant="secondary"
              onClick={() => {
                const t = detailTarget
                setDetailTarget(null)
                if (t) openEdit(t)
              }}
            >
              <Pencil className="mr-1 h-4 w-4" /> 编辑公告
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除公告"
        destructive
        requirePhrase="DELETE"
        description={`确认删除公告「${deleteTarget?.title}」？\n公告不进回收站（物理删除），删除前会将完整内容快照写入审计日志。`}
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (deleteTarget) await callAction("delete", () => deleteAnnouncementAction({ id: deleteTarget.id }))
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}

// 强制阅读预览：勾选“我已阅读”后才能关闭（内容 MD 渲染）
function ForceViewPreview({ row, onDone }: { row: AnnouncementRow; onDone: () => void }) {
  const [checked, setChecked] = React.useState(false)
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-4 max-h-64 overflow-y-auto">
        <AnnouncementContent content={row.content} />
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
        我已完整阅读该公告内容
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>仅关闭预览</Button>
        <Button disabled={!checked} onClick={onDone}>
          确认阅读并继续
        </Button>
      </DialogFooter>
    </div>
  )
}
