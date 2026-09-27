"use client"

// 公告管理交互：CRUD 弹窗（GLOBAL/GROUP/USER 范围选择器 + POPUP/MARQUEE/FORCE_VIEW 展示方式）+ 预览弹窗

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Eye, Loader2, Megaphone, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
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
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { upsertAnnouncementAction, toggleAnnouncementAction, deleteAnnouncementAction } from "@/server/actions/announcements"

export interface AnnouncementRow {
  id: string
  title: string
  content: string
  type: string // GLOBAL | GROUP | USER
  groupId: string | null
  groupName: string | null
  userId: string | null
  targetUsername: string | null
  displayType: string // POPUP | MARQUEE | FORCE_VIEW
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

  // 表单状态
  const [fTitle, setFTitle] = React.useState("")
  const [fContent, setFContent] = React.useState("")
  const [fType, setFType] = React.useState<"GLOBAL" | "GROUP" | "USER">("GLOBAL")
  const [fGroupId, setFGroupId] = React.useState("")
  const [fUserId, setFUserId] = React.useState("")
  const [fDisplay, setFDisplay] = React.useState<"POPUP" | "MARQUEE" | "FORCE_VIEW">("POPUP")
  const [fEnabled, setFEnabled] = React.useState(true)
  // 用户搜索器
  const [userSearch, setUserSearch] = React.useState("")
  const [pickedUser, setPickedUser] = React.useState<{ id: string; username: string } | null>(null)

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
    setFDisplay("POPUP")
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
    setFDisplay(row.displayType as "POPUP" | "MARQUEE" | "FORCE_VIEW")
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
    setBusy("form")
    try {
      const res = await upsertAnnouncementAction({
        id: editing?.id,
        title: fTitle.trim(),
        content: fContent.trim(),
        type: fType,
        groupId: fType === "GROUP" ? fGroupId : undefined,
        userId: fType === "USER" ? fUserId : undefined,
        displayType: fDisplay,
        enabled: fEnabled,
      })
      if (res.code === 0) {
        toast.success(editing ? "公告已更新" : "公告已创建")
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">删除为物理删除（公告不进回收站），删除前完整快照入审计日志</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          新建公告
        </Button>
      </div>

      <DataTable
        rows={rows}
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
            title: "标题",
            render: (r) => (
              <div className="min-w-0">
                <p className="text-sm font-medium truncate max-w-56" title={r.title}>{r.title}</p>
                <p className="text-xs text-muted-foreground truncate max-w-56" title={r.content}>{r.content}</p>
              </div>
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
            key: "displayType",
            title: "展示方式",
            render: (r) => <Badge variant="outline">{DISPLAY_LABEL[r.displayType] || r.displayType}</Badge>,
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
            <DialogDescription>范围类型决定投放对象；展示方式决定用户端呈现形态（可随时预览）</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>公告标题</Label>
              <Input value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="如：平台升级维护通知" maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label>公告内容</Label>
              <Textarea value={fContent} onChange={(e) => setFContent(e.target.value)} rows={5} placeholder="支持多行文本，用户端按展示方式渲染" maxLength={5000} />
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
              <Label>展示方式</Label>
              <RadioGroup value={fDisplay} onValueChange={(v) => setFDisplay(v as "POPUP" | "MARQUEE" | "FORCE_VIEW")} className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="POPUP" /> 弹窗（POPUP）
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="MARQUEE" /> 跑马灯（MARQUEE）
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <RadioGroupItem value="FORCE_VIEW" /> 强制阅读（FORCE_VIEW）
                </label>
              </RadioGroup>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">立即启用</p>
                <p className="text-xs text-muted-foreground">关闭则保存为草稿，不投放给用户</p>
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

      {/* 预览弹窗：按展示方式模拟 */}
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
                <div className="rounded-md border p-4">
                  <p className="text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">{previewTarget.content}</p>
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
                  <DialogDescription>预览：页面顶部滚动公告条（循环滚动）</DialogDescription>
                </DialogHeader>
                <div className="px-6 pb-2">
                  <div className="overflow-hidden rounded-md border bg-muted">
                    <div
                      className="whitespace-nowrap py-2 text-sm"
                      style={{ animation: "dy-marquee 14s linear infinite" }}
                    >
                      🔔 {previewTarget.title} —— {previewTarget.content}
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

// 强制阅读预览：勾选“我已阅读”后才能关闭
function ForceViewPreview({ row, onDone }: { row: AnnouncementRow; onDone: () => void }) {
  const [checked, setChecked] = React.useState(false)
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-4 max-h-56 overflow-y-auto">
        <p className="text-sm whitespace-pre-wrap">{row.content}</p>
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
