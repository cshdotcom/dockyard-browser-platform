"use client"

// Webhook 规则 CRUD + 投递记录（最近20条）：URL / 密钥 / 触发事件多选 / 绑定用户组 / 启用

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Pencil, Plus, Trash2, Webhook } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { upsertWebhookRuleAction, deleteWebhookRuleAction, toggleWebhookRuleAction } from "@/server/actions/alerts"
import { batchToggleWebhookRulesAction, batchDeleteWebhookRulesAction } from "@/server/actions/batch"
import { Trash2, Loader2 } from "lucide-react"

export interface WebhookRuleRow {
  id: string
  name: string
  url: string
  secret: string | null
  events: string[]
  groupId: string | null
  enabled: boolean
  failCount: number
  createdAt: string
}

export interface WebhookDeliveryRow {
  id: string
  url: string
  event: string
  status: string
  attempts: number
  lastError: string | null
  sentAt: string | null
  createdAt: string
}

const EVENT_OPTIONS = ["SESSION", "PROXY", "SINGBOX", "TOKEN", "SYSTEM", "SECURITY"] as const

const GROUPABLE_EVENT_LABEL: Record<string, string> = {
  SESSION: "会话事件",
  PROXY: "代理事件",
  SINGBOX: "SingBox 事件",
  TOKEN: "API-Token 事件",
  SYSTEM: "系统事件",
  SECURITY: "安全事件",
}

interface WebhookRulesTableProps {
  rows: WebhookRuleRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  deliveries: WebhookDeliveryRow[]
  groupOptions: { id: string; name: string }[]
}

export function WebhookRulesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, deliveries, groupOptions }: WebhookRulesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [sel, setSel] = React.useState<string[]>([])
  const [batchBusy, setBatchBusy] = React.useState("")
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)

  const runWbBatch = async (label: string, fn: () => Promise<{ code: number; msg: string; data?: { affected: number } | null }>, okText: string) => {
    setBatchBusy(label)
    try {
      const res = await fn()
      if (res.code === 0) {
        toast.success(okText.replace("{n}", String(res.data?.affected ?? 0)))
        setSel([])
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量操作失败")
    } finally {
      setBatchBusy("")
    }
  }
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<WebhookRuleRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<WebhookRuleRow | null>(null)

  // 表单状态
  const [fName, setFName] = React.useState("")
  const [fUrl, setFUrl] = React.useState("")
  const [fSecret, setFSecret] = React.useState("")
  const [fEvents, setFEvents] = React.useState<string[]>(["SYSTEM"])
  const [fGroupId, setFGroupId] = React.useState("")
  const [fEnabled, setFEnabled] = React.useState(true)

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
    setFName("")
    setFUrl("")
    setFSecret("")
    setFEvents(["SYSTEM"])
    setFGroupId("")
    setFEnabled(true)
    setFormOpen(true)
  }

  const openEdit = (row: WebhookRuleRow) => {
    setEditing(row)
    setFName(row.name)
    setFUrl(row.url)
    setFSecret(row.secret || "")
    setFEvents(row.events.length > 0 ? row.events : [])
    setFGroupId(row.groupId || "")
    setFEnabled(row.enabled)
    setFormOpen(true)
  }

  const toggleEvent = (ev: string, checked: boolean) => {
    setFEvents((prev) => (checked ? [...new Set([...prev, ev])] : prev.filter((e) => e !== ev)))
  }

  const submit = async () => {
    if (!fName.trim()) {
      toast.error("规则名称必填")
      return
    }
    if (!/^https?:\/\//.test(fUrl.trim())) {
      toast.error("URL 必须以 http:// 或 https:// 开头")
      return
    }
    setBusy("form")
    try {
      const res = await upsertWebhookRuleAction({
        id: editing?.id,
        name: fName.trim(),
        url: fUrl.trim(),
        secret: fSecret.trim() || undefined,
        events: fEvents,
        groupId: fGroupId || undefined,
        enabled: fEnabled,
      })
      if (res.code === 0) {
        toast.success(editing ? "Webhook 规则已更新" : "Webhook 规则已创建")
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

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Webhook 外发通道：命中触发事件的告警将投递到规则 URL（支持 HMAC 密钥签名、失败重试、用户组范围绑定）
          </p>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            新建 Webhook
          </Button>
        </div>

        <DataTable
        selectedIds={sel}
        onSelectedChange={setSel}
        batchToolbar={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runWbBatch("on", () => batchToggleWebhookRulesAction({ ids: sel, enabled: true }), "已批量启用 {n} 条 Webhook 规则")}>
              批量启用
            </Button>
            <Button size="sm" variant="outline" disabled={!!batchBusy} onClick={() => runWbBatch("off", () => batchToggleWebhookRulesAction({ ids: sel, enabled: false }), "已批量停用 {n} 条 Webhook 规则")}>
              批量停用
            </Button>
            <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900" disabled={!!batchBusy} onClick={() => setBatchDeleteOpen(true)}>
              {batchBusy === "delete" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
              批量删除
            </Button>
          </div>
        }
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
              key: "enabled",
              placeholder: "启用状态",
              options: [
                { label: "已启用", value: "true" },
                { label: "已停用", value: "false" },
              ],
            },
          ]}
          emptyText="暂无 Webhook 规则"
          columns={[
            { key: "name", title: "名称", render: (r) => <span className="text-sm font-medium">{r.name}</span> },
            {
              key: "url",
              title: "URL",
              render: (r) => <span className="font-mono text-[10px] block max-w-56 truncate" title={r.url}>{r.url}</span>,
            },
            {
              key: "secret",
              title: "密钥",
              render: (r) => (
                <span className="text-xs text-muted-foreground font-mono">{r.secret ? "••••••（已设置）" : "-"}</span>
              ),
            },
            {
              key: "events",
              title: "触发事件",
              render: (r) => (
                <div className="flex flex-wrap gap-1">
                  {r.events.length === 0 ? (
                    <Badge variant="outline" className="text-[10px]">全部事件</Badge>
                  ) : (
                    r.events.map((ev) => (
                      <Badge key={ev} variant="secondary" className="text-[10px]">
                        {GROUPABLE_EVENT_LABEL[ev] || ev}
                      </Badge>
                    ))
                  )}
                </div>
              ),
            },
            {
              key: "groupId",
              title: "绑定用户组",
              render: (r) => {
                const g = groupOptions.find((x) => x.id === r.groupId)
                return g ? <Badge variant="outline" className="text-[10px]">{g.name}</Badge> : <span className="text-xs text-muted-foreground">全平台</span>
              },
            },
            {
              key: "failCount",
              title: "连续失败",
              sortable: true,
              render: (r) =>
                r.failCount > 0 ? <Badge variant="destructive" className="text-[10px]">{r.failCount} 次</Badge> : <span className="text-xs text-muted-foreground">0</span>,
            },
            {
              key: "enabled",
              title: "启用",
              render: (r) => (
                <Switch
                  checked={r.enabled}
                  disabled={busy === `toggle:${r.id}`}
                  onCheckedChange={(b) => callAction(`toggle:${r.id}`, () => toggleWebhookRuleAction({ id: r.id, enabled: b }))}
                  aria-label={`启用 ${r.name}`}
                />
              ),
            },
            { key: "createdAt", title: "创建时间", sortable: true, render: (r) => <span className="text-xs tabular-nums">{r.createdAt}</span> },
          ]}
          rowActions={(r) => (
            <div className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => openEdit(r)} aria-label={`编辑 ${r.name}`}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={() => setDeleteTarget(r)}
                aria-label={`删除 ${r.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        />
      </div>

      {/* 投递记录（最近20条） */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="h-4 w-4 text-teal-600" />
            投递记录（最近 20 条）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">暂无投递记录（产生告警后将自动外发并记录）</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL</TableHead>
                    <TableHead className="w-40">事件</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                    <TableHead className="w-20">尝试次数</TableHead>
                    <TableHead className="w-44">最近错误</TableHead>
                    <TableHead className="w-40">投递时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <span className="font-mono text-[10px] block max-w-64 truncate" title={d.url}>{d.url}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px]">{d.event}</Badge>
                      </TableCell>
                      <TableCell><StatusBadge status={d.status} /></TableCell>
                      <TableCell className="tabular-nums text-sm">{d.attempts}</TableCell>
                      <TableCell>
                        <span className="text-xs text-red-600 block max-w-44 truncate" title={d.lastError || ""}>
                          {d.lastError || "-"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{d.sentAt || d.createdAt}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新建/编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !v && setFormOpen(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 Webhook 规则" : "新建 Webhook 规则"}</DialogTitle>
            <DialogDescription>密钥用于投递负载的 HMAC 签名（服务端保存，审计自动脱敏）</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>规则名称</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="如：运维值班群机器人" maxLength={64} />
            </div>
            <div className="space-y-1.5">
              <Label>Webhook URL</Label>
              <Input value={fUrl} onChange={(e) => setFUrl(e.target.value)} placeholder="https://example.com/hook" className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label>HMAC 签名密钥（可选）</Label>
              <Input value={fSecret} onChange={(e) => setFSecret(e.target.value)} placeholder="留空 = 不签名" type="password" autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label>触发事件（多选，不选 = 全部事件）</Label>
              <div className="grid grid-cols-3 gap-2 rounded-md border p-3">
                {EVENT_OPTIONS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={fEvents.includes(ev)} onCheckedChange={(v) => toggleEvent(ev, v === true)} />
                    {GROUPABLE_EVENT_LABEL[ev]}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>绑定用户组（可选，限定告警归属范围）</Label>
              <Select value={fGroupId || "__all__"} onValueChange={(v) => setFGroupId(v === "__all__" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="全平台" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全平台（不限定）</SelectItem>
                  {groupOptions.map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">启用规则</p>
                <p className="text-xs text-muted-foreground">关闭后不再投递（失败重试也暂停）</p>
              </div>
              <Switch checked={fEnabled} onCheckedChange={setFEnabled} aria-label="启用 webhook" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={busy === "form"}>
              {busy === "form" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? "保存修改" : "创建规则"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（软删除） */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="删除 Webhook 规则"
        destructive
        requirePhrase="DELETE"
        description={`确认删除「${deleteTarget?.name}」？\n规则将软删除（deletedAt 标记），历史投递记录保留可查，审计留痕。`}
        confirmText="确认删除"
        loading={busy === "delete"}
        onConfirm={async () => {
          if (deleteTarget) await callAction("delete", () => deleteWebhookRuleAction({ id: deleteTarget.id }))
          setDeleteTarget(null)
        }}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(v) => !v && setBatchDeleteOpen(v)}
        title={`批量删除 ${sel.length} 条 Webhook 规则`}
        description={`将软删除选中的 ${sel.length} 条投递规则：\n· 历史投递记录保留可查\n· 恢复需管理员在数据库层面处理`}
        requirePhrase="DELETE"
        destructive
        loading={batchBusy === "delete"}
        confirmText="确认批量删除"
        onConfirm={() => runWbBatch("delete", () => batchDeleteWebhookRulesAction({ ids: sel }), "已批量删除 {n} 条规则")}
      />
    </div>
  )
}
