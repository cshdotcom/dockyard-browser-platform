"use client"

// 模板列表交互：新建 / 编辑（表单化配置：UA 下拉 / 时区 / 语言 / 变量 JSON）/
// 复制（deep copy → PRIVATE）/ 导出 JSON（链接下载）/ 导入 JSON / 删除

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Copy, Download, FileCode2, GitBranch, Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  upsertTemplateAction,
  copyTemplateAction,
  deleteTemplateAction,
  importTemplatesAction,
} from "@/server/actions/templates"

export interface TemplateConfig {
  ua: string
  timezone: string
  locale: string
  variables: Record<string, string>
}

export interface TemplateRow {
  id: string
  name: string
  description: string
  scope: string
  scopeLabel: string
  groupName: string | null
  version: number
  tags: string[]
  parentId: string | null
  parentName: string | null
  isOwner: boolean
  creatorName: string
  createdAt: string
  updatedAt: string
  config: TemplateConfig
}

const SCOPE_BADGE: Record<string, string> = {
  PRIVATE: "bg-teal-600 hover:bg-teal-600 text-white",
  GROUP: "bg-amber-500 hover:bg-amber-500 text-white",
  GLOBAL: "bg-violet-600 hover:bg-violet-600 text-white",
}

interface TemplatesTableProps {
  rows: TemplateRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  uaOptions: { id: string; ua: string; label: string }[]
  myGroups: { id: string; name: string }[]
  isAdmin: boolean
}

export function TemplatesTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, uaOptions, myGroups, isAdmin }: TemplatesTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const [busy, setBusy] = React.useState("")
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<TemplateRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<TemplateRow | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)
  const [importText, setImportText] = React.useState("")
  const [importing, setImporting] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  // 表单状态
  const [fName, setFName] = React.useState("")
  const [fDesc, setFDesc] = React.useState("")
  const [fScope, setFScope] = React.useState<"PRIVATE" | "GROUP" | "GLOBAL">("PRIVATE")
  const [fGroupId, setFGroupId] = React.useState("")
  const [fTags, setFTags] = React.useState("")
  const [fUa, setFUa] = React.useState("")
  const [fTimezone, setFTimezone] = React.useState("Asia/Shanghai")
  const [fLocale, setFLocale] = React.useState("zh-CN")
  const [fVariables, setFVariables] = React.useState("{}")

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
    setFDesc("")
    setFScope("PRIVATE")
    setFGroupId(myGroups[0]?.id || "")
    setFTags("")
    setFUa(uaOptions[0]?.ua || "")
    setFTimezone("Asia/Shanghai")
    setFLocale("zh-CN")
    setFVariables("{}")
    setFormOpen(true)
  }

  const openEdit = (row: TemplateRow) => {
    if (!row.isOwner && !(isAdmin && row.scope === "GLOBAL")) {
      toast.error("只能编辑自己创建的模板（全局模板限管理员）")
      return
    }
    setEditing(row)
    setFName(row.name)
    setFDesc(row.description)
    setFScope(row.scope as "PRIVATE" | "GROUP" | "GLOBAL")
    setFGroupId(row.groupName ? row.groupName : "")
    // 编辑时 groupId 无法从行数据拿到，需从 myGroups 中选择；GROUP 模板用组名展示
    setFGroupId("")
    setFTags(row.tags.join(", "))
    setFUa(row.config.ua)
    setFTimezone(row.config.timezone || "Asia/Shanghai")
    setFLocale(row.config.locale || "zh-CN")
    setFVariables(JSON.stringify(row.config.variables || {}, null, 2))
    setFormOpen(true)
  }

  const submit = async () => {
    if (!fName.trim()) {
      toast.error("模板名称必填")
      return
    }
    if (fScope === "GROUP" && !editing && !fGroupId) {
      toast.error("组共享模板必须选择一个你所在的用户组")
      return
    }
    let variables: Record<string, string> = {}
    try {
      variables = fVariables.trim() ? JSON.parse(fVariables) : {}
      if (typeof variables !== "object" || Array.isArray(variables) || variables === null) throw new Error("not object")
      for (const [k, v] of Object.entries(variables)) {
        if (typeof k !== "string" || typeof v !== "string") throw new Error("值必须是字符串")
      }
    } catch {
      toast.error("变量插值 JSON 格式非法：应为 { \"键\": \"值\" } 且值为字符串")
      return
    }
    const tags = fTags.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10)

    setSubmitting(true)
    try {
      const res = await upsertTemplateAction({
        id: editing?.id,
        name: fName.trim(),
        description: fDesc.trim(),
        scope: fScope,
        groupId: fScope === "GROUP" ? fGroupId || undefined : null,
        tags,
        config: { ua: fUa, timezone: fTimezone.trim(), locale: fLocale.trim(), variables },
      })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(editing ? "模板已更新（版本 +1）" : "模板创建成功")
      setFormOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const doCopy = async (row: TemplateRow) => {
    setBusy(`copy-${row.id}`)
    try {
      const res = await copyTemplateAction({ id: row.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`已复制为私有模板「${row.name}（副本）」`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setBusy(`del-${deleteTarget.id}`)
    try {
      const res = await deleteTemplateAction({ id: deleteTarget.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`模板「${deleteTarget.name}」已删除并移入回收站`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const doImport = async () => {
    if (!importText.trim()) {
      toast.error("请粘贴或选择 JSON 文件内容")
      return
    }
    setImporting(true)
    try {
      const res = await importTemplatesAction({ payload: importText })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      const data = res.data as { created: number; skipped: number } | undefined
      toast.success(`导入完成：成功 ${data?.created ?? 0} 条${data?.skipped ? `，跳过 ${data.skipped} 条（格式非法）` : ""}`)
      setImportOpen(false)
      setImportText("")
      router.refresh()
    } finally {
      setImporting(false)
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setImportText(text)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const columns = [
    {
      key: "name",
      title: "模板名称",
      sortable: true,
      render: (row: TemplateRow) => (
        <div>
          <p className="font-medium flex items-center gap-1.5">
            <FileCode2 className="h-3.5 w-3.5 text-teal-600 shrink-0" />
            {row.name}
            {row.parentId && (
              <Badge variant="outline" className="text-[10px] gap-0.5 font-normal" title={`继承自 ${row.parentName}`}>
                <GitBranch className="h-2.5 w-2.5" /> {row.parentName}
              </Badge>
            )}
          </p>
          {row.description && <p className="text-xs text-muted-foreground truncate max-w-72">{row.description}</p>}
          {row.tags.length > 0 && (
            <div className="flex gap-1 mt-1">
              {row.tags.slice(0, 4).map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px] font-normal">{t}</Badge>
              ))}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "scope",
      title: "范围",
      render: (row: TemplateRow) => (
        <div className="flex flex-col items-start gap-1">
          <Badge className={SCOPE_BADGE[row.scope]}>{row.scopeLabel}</Badge>
          {row.groupName && <span className="text-xs text-muted-foreground">{row.groupName}</span>}
        </div>
      ),
    },
    {
      key: "config",
      title: "配置摘要",
      render: (row: TemplateRow) => {
        const uaShort = row.config.ua ? row.config.ua.replace(/^Mozilla\/5\.0 \((.+?)\).*$/, "$1").slice(0, 28) : "默认"
        return (
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p className="font-mono truncate max-w-52" title={row.config.ua}>UA: {uaShort}</p>
            <p>时区 {row.config.timezone || "默认"} · 语言 {row.config.locale || "默认"}</p>
            {Object.keys(row.config.variables || {}).length > 0 && (
              <p>变量 × {Object.keys(row.config.variables).length}</p>
            )}
          </div>
        )
      },
    },
    { key: "version", title: "版本", sortable: true, render: (row: TemplateRow) => <span className="tabular-nums text-sm">v{row.version}</span> },
    { key: "creatorName", title: "创建人", render: (row: TemplateRow) => <span className="text-sm">{row.creatorName}</span> },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: TemplateRow) => <span className="text-sm">{row.createdAt}</span> },
  ]

  const canEdit = (row: TemplateRow) => row.isOwner || (isAdmin && row.scope === "GLOBAL")
  const canDelete = canEdit

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          复制他人 / 全局模板会生成一份属于你的私有副本；全局范围模板仅管理员可创建
        </p>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={onImportFile} aria-label="选择导入 JSON 文件" />
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1 h-4 w-4" /> 导入 JSON
          </Button>
          <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" /> 新建模板
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
        sortField={sortField}
        sortOrder={sortOrder}
        filters={[
          {
            key: "scope",
            placeholder: "范围",
            options: [
              { label: "私有", value: "PRIVATE" },
              { label: "组共享", value: "GROUP" },
              { label: "全局", value: "GLOBAL" },
            ],
          },
        ]}
        onQueryChange={pushQuery}
        emptyText="暂无可见模板"
        rowActions={(row) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => doCopy(row)}
              title="复制为我的私有模板"
              disabled={busy !== ""}
            >
              {busy === `copy-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
            </Button>
            <a
              href={`/api/export/template?id=${row.id}`}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="导出 JSON"
            >
              <Download className="h-4 w-4" />
            </a>
            <Button variant="ghost" size="icon" onClick={() => openEdit(row)} title={canEdit(row) ? "编辑" : "无权编辑"} disabled={busy !== "" || !canEdit(row)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteTarget(row)}
              title={canDelete(row) ? "删除" : "无权删除"}
              className="text-red-600 hover:text-red-700"
              disabled={busy !== "" || !canDelete(row)}
            >
              {busy === `del-${row.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        )}
      />

      {/* 新建 / 编辑弹窗 */}
      <Dialog open={formOpen} onOpenChange={(v) => !submitting && setFormOpen(v)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCode2 className="h-5 w-5 text-teal-600" />
              {editing ? `编辑模板「${editing.name}」` : "新建会话模板"}
            </DialogTitle>
            <DialogDescription>
              {editing ? "保存后版本号自动 +1；范围变更即时生效" : "配置将用于创建浏览器工作区时的会话参数预设"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">模板名称</Label>
                <Input id="tpl-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例如：欧洲电商采集" maxLength={100} />
              </div>
              <div className="space-y-1.5">
                <Label>共享范围</Label>
                <Select
                  value={fScope}
                  onValueChange={(v) => setFScope(v as "PRIVATE" | "GROUP" | "GLOBAL")}
                  disabled={!!editing && editing.scope === "GLOBAL" && !isAdmin}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRIVATE">私有（仅自己）</SelectItem>
                    <SelectItem value="GROUP" disabled={myGroups.length === 0}>组共享（我所在的组）</SelectItem>
                    {isAdmin && <SelectItem value="GLOBAL">全局（管理员）</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fScope === "GROUP" && (
              <div className="space-y-1.5">
                <Label>目标用户组</Label>
                {editing ? (
                  <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                    {editing.groupName || "保持原组不变"}（编辑时不可变更归属组）
                  </div>
                ) : (
                  <Select value={fGroupId} onValueChange={setFGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择用户组" />
                    </SelectTrigger>
                    <SelectContent>
                      {myGroups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="tpl-desc">描述（可选）</Label>
              <Input id="tpl-desc" value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="模板用途说明" maxLength={500} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-tags">标签（可选，逗号分隔）</Label>
              <Input id="tpl-tags" value={fTags} onChange={(e) => setFTags(e.target.value)} placeholder="采集, 移动端, 欧洲" />
            </div>

            <div className="space-y-2 rounded-md border p-3 bg-muted/30">
              <p className="text-sm font-medium">会话配置</p>

              <div className="space-y-1.5">
                <Label>User-Agent</Label>
                <Select value={fUa} onValueChange={setFUa}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 UA（启用记录）" />
                  </SelectTrigger>
                  <SelectContent>
                    {uaOptions.map((u) => (
                      <SelectItem key={u.id} value={u.ua}>
                        {u.label}
                      </SelectItem>
                    ))}
                    {fUa && !uaOptions.some((u) => u.ua === fUa) && (
                      <SelectItem value={fUa}>自定义（当前值）</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground font-mono truncate" title={fUa}>{fUa || "默认 UA"}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-tz">时区</Label>
                  <Input id="tpl-tz" value={fTimezone} onChange={(e) => setFTimezone(e.target.value)} placeholder="Asia/Shanghai" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-locale">语言</Label>
                  <Input id="tpl-locale" value={fLocale} onChange={(e) => setFLocale(e.target.value)} placeholder="zh-CN" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tpl-vars">变量插值（JSON，值为字符串）</Label>
                <Textarea
                  id="tpl-vars"
                  value={fVariables}
                  onChange={(e) => setFVariables(e.target.value)}
                  placeholder={'{\n  "targetSite": "https://example.com",\n  "retries": "3"\n}'}
                  rows={5}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submit} disabled={submitting} className="bg-teal-600 hover:bg-teal-700">
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? "保存修改" : "创建模板"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入弹窗 */}
      <Dialog open={importOpen} onOpenChange={(v) => !importing && setImportOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-teal-600" /> 导入模板 JSON
            </DialogTitle>
            <DialogDescription>
              支持单个对象或数组（最多 20 条）；导入后范围一律为私有。格式：
              <code className="font-mono text-xs">{"{ name, description?, tags?, config: { ua, timezone, locale, variables } }"}</code>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                选择文件
              </Button>
              <span className="text-xs text-muted-foreground">或直接粘贴 JSON 内容</span>
            </div>
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='[ { "name": "导入模板", "config": { "ua": "...", "timezone": "Asia/Shanghai", "locale": "zh-CN", "variables": {} } } ]'
              rows={10}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
              取消
            </Button>
            <Button onClick={doImport} disabled={importing} className="bg-teal-600 hover:bg-teal-700">
              {importing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              解析并导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={`删除模板「${deleteTarget?.name || ""}」`}
        description="删除为软删除并移入回收站，保留期内可恢复。若其他工作区正在引用该模板不受影响（引用已固化）。"
        confirmText="确认删除"
        destructive
        onConfirm={doDelete}
      />
    </div>
  )
}
