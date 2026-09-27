"use client"

// 令牌列表交互：新建（明文一次展示）/ 编辑 / 删除 / 启停
// 有效期：快捷选项 7天/30天/90天/1年/永久 + 自定义 datetime-local
// 权限：read/write/execute/admin 复选框 → 位掩码 1/2/4/8

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Copy, Eye, EyeOff, KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { DataTable } from "@/components/shared/data-table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  createApiTokenAction,
  updateApiTokenAction,
  deleteApiTokenAction,
  toggleApiTokenAction,
} from "@/server/actions/tokens"

export interface TokenRow {
  id: string
  name: string
  prefix: string
  permissionsMask: number
  status: "PERMANENT" | "NORMAL" | "EXPIRING" | "EXPIRED"
  enabled: boolean
  qpsLimit: number
  ipWhitelist: string[]
  lastCallAt: string
  callCount: number
  createdAt: string
  expireAt: string
  expireAtIso: string | null
}

const STATUS_META: Record<TokenRow["status"], { label: string; className: string }> = {
  PERMANENT: { label: "永久有效", className: "bg-teal-600 hover:bg-teal-600 text-white" },
  NORMAL: { label: "正常", className: "bg-emerald-600 hover:bg-emerald-600 text-white" },
  EXPIRING: { label: "即将到期", className: "bg-orange-500 hover:bg-orange-500 text-white" },
  EXPIRED: { label: "已过期", className: "bg-red-600 hover:bg-red-600 text-white" },
}

function maskLabel(mask: number): string {
  const parts: string[] = []
  if (mask & 1) parts.push("读")
  if (mask & 2) parts.push("写")
  if (mask & 4) parts.push("执行")
  if (mask & 8) parts.push("管理")
  return parts.length ? parts.join(" / ") : "无"
}

// ISO → datetime-local 值（本地时区）
function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type ExpiryMode = "7d" | "30d" | "90d" | "1y" | "permanent" | "custom"

const EXPIRY_PRESETS: { key: ExpiryMode; label: string; days?: number }[] = [
  { key: "7d", label: "7 天", days: 7 },
  { key: "30d", label: "30 天", days: 30 },
  { key: "90d", label: "90 天", days: 90 },
  { key: "1y", label: "1 年", days: 365 },
  { key: "permanent", label: "永久" },
  { key: "custom", label: "自定义" },
]

function presetIso(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString()
}

interface TokensTableProps {
  rows: TokenRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  role: string
}

export function TokensTable({ rows, total, page, pageSize, keyword, sortField, sortOrder, filters, role }: TokensTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [busy, setBusy] = React.useState("")
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<TokenRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<TokenRow | null>(null)
  // 明文一次展示
  const [plainToken, setPlainToken] = React.useState<string | null>(null)
  const [showPlain, setShowPlain] = React.useState(true)
  const [confirmClose, setConfirmClose] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  // ---- 新建/编辑表单状态 ----
  const [fName, setFName] = React.useState("")
  const [fExpiryMode, setFExpiryMode] = React.useState<ExpiryMode>("30d")
  const [fCustomExpire, setFCustomExpire] = React.useState("")
  const [fPerm, setFPerm] = React.useState({ read: true, write: false, execute: false, admin: false })
  const [fIpList, setFIpList] = React.useState("")
  const [fQps, setFQps] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setFName("")
    setFExpiryMode("30d")
    setFCustomExpire("")
    setFPerm({ read: true, write: false, execute: false, admin: false })
    setFIpList("")
    setFQps(0)
    setFormOpen(true)
  }

  const openEdit = (row: TokenRow) => {
    setEditing(row)
    setFName(row.name)
    if (!row.expireAtIso) {
      setFExpiryMode("permanent")
      setFCustomExpire("")
    } else {
      setFExpiryMode("custom")
      setFCustomExpire(isoToLocalInput(row.expireAtIso))
    }
    setFPerm({
      read: !!(row.permissionsMask & 1),
      write: !!(row.permissionsMask & 2),
      execute: !!(row.permissionsMask & 4),
      admin: !!(row.permissionsMask & 8),
    })
    setFIpList(row.ipWhitelist.join("\n"))
    setFQps(row.qpsLimit)
    setFormOpen(true)
  }

  // undefined = 前端校验失败（已 toast 提示）；null = 永久；string = 具体 ISO 时间
  const buildExpireIso = (): string | null | undefined => {
    if (fExpiryMode === "permanent") return null
    if (fExpiryMode === "custom") {
      if (!fCustomExpire) {
        toast.error("请选择自定义到期时间")
        return undefined
      }
      return new Date(fCustomExpire).toISOString()
    }
    const preset = EXPIRY_PRESETS.find((p) => p.key === fExpiryMode)
    return presetIso(preset?.days || 30)
  }

  const submit = async () => {
    if (!fName.trim()) {
      toast.error("令牌名称必填")
      return
    }
    const expireIso = buildExpireIso()
    if (expireIso === undefined) return
    const ipList = fIpList.split("\n").map((s) => s.trim()).filter(Boolean)
    setSubmitting(true)
    try {
      const payload = {
        id: editing?.id,
        name: fName.trim(),
        expireAtIso: expireIso,
        permissions: fPerm,
        ipWhitelist: ipList,
        qps: fQps,
      }
      const res = editing
        ? await updateApiTokenAction(payload)
        : await createApiTokenAction(payload)
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      if (editing) {
        toast.success("令牌已更新")
      } else {
        const data = res.data as { token: string } | undefined
        if (data?.token) {
          setPlainToken(data.token)
          setShowPlain(true)
          setCopied(false)
        }
        toast.success("令牌创建成功")
      }
      setFormOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setBusy(`del-${deleteTarget.id}`)
    try {
      const res = await deleteApiTokenAction({ id: deleteTarget.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`令牌「${deleteTarget.name}」已删除并移入回收站`)
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const doToggle = async (row: TokenRow, enabled: boolean) => {
    setBusy(`toggle-${row.id}`)
    try {
      const res = await toggleApiTokenAction({ id: row.id, enabled })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(enabled ? "令牌已启用" : "令牌已禁用")
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const copyPlain = async () => {
    if (!plainToken) return
    try {
      await navigator.clipboard.writeText(plainToken)
      setCopied(true)
      toast.success("已复制到剪贴板")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  const columns = [
    {
      key: "name",
      title: "名称",
      sortable: true,
      render: (row: TokenRow) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground font-mono">{row.prefix}</p>
        </div>
      ),
    },
    {
      key: "permissionsMask",
      title: "权限",
      render: (row: TokenRow) => (
        <div className="flex flex-wrap gap-1">
          {row.permissionsMask & 1 && <Badge variant="outline" className="text-xs">读</Badge>}
          {row.permissionsMask & 2 && <Badge variant="outline" className="text-xs">写</Badge>}
          {row.permissionsMask & 4 && <Badge variant="outline" className="text-xs">执行</Badge>}
          {row.permissionsMask & 8 && <Badge variant="outline" className="text-xs">管理</Badge>}
          {row.permissionsMask === 0 && <span className="text-xs text-muted-foreground">无</span>}
        </div>
      ),
    },
    {
      key: "status",
      title: "状态",
      render: (row: TokenRow) => {
        const meta = STATUS_META[row.status]
        return (
          <div className="flex flex-col gap-1 items-start">
            <Badge className={meta.className}>{meta.label}</Badge>
            {!row.enabled && <Badge variant="outline" className="text-xs">已禁用</Badge>}
          </div>
        )
      },
    },
    {
      key: "expireAt",
      title: "到期时间",
      sortable: true,
      render: (row: TokenRow) => (
        <span className={cn("text-sm", row.status === "PERMANENT" && "text-teal-600 font-medium")}>
          {row.expireAt}
        </span>
      ),
    },
    {
      key: "qpsLimit",
      title: "QPS 限制",
      render: (row: TokenRow) => <span className="tabular-nums text-sm">{row.qpsLimit > 0 ? row.qpsLimit : "默认"}</span>,
    },
    {
      key: "ipWhitelist",
      title: "IP 白名单",
      render: (row: TokenRow) =>
        row.ipWhitelist.length ? (
          <span className="text-xs font-mono" title={row.ipWhitelist.join("\n")}>
            {row.ipWhitelist.length} 条规则
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">不限</span>
        ),
    },
    { key: "lastCallAt", title: "最后调用", sortable: true, render: (row: TokenRow) => <span className="text-sm">{row.lastCallAt}</span> },
    { key: "callCount", title: "累计调用", sortable: true, render: (row: TokenRow) => <span className="tabular-nums text-sm">{row.callCount}</span> },
    { key: "createdAt", title: "创建时间", sortable: true, render: (row: TokenRow) => <span className="text-sm">{row.createdAt}</span> },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          明文令牌只在创建时展示一次；调用 API 时以 <code className="font-mono">Authorization: Bearer dy_…</code> 方式携带
        </p>
        <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" /> 新建令牌
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
            key: "enabled",
            placeholder: "启用状态",
            options: [
              { label: "启用", value: "true" },
              { label: "禁用", value: "false" },
            ],
          },
        ]}
        onQueryChange={pushQuery}
        emptyText="暂无 API 令牌"
        rowActions={(row) => (
          <div className="flex items-center justify-end gap-2">
            <Switch
              checked={row.enabled}
              disabled={busy === `toggle-${row.id}`}
              onCheckedChange={(v) => doToggle(row, v)}
              aria-label={`启用或禁用令牌 ${row.name}`}
            />
            <Button variant="ghost" size="icon" onClick={() => openEdit(row)} title="编辑" disabled={!!busy}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteTarget(row)}
              title="删除"
              className="text-red-600 hover:text-red-700"
              disabled={!!busy}
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
              <KeyRound className="h-5 w-5 text-teal-600" />
              {editing ? "编辑令牌" : "新建 API 令牌"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "可调整名称、有效期、权限、IP 白名单与 QPS 限制"
                : "创建后明文仅展示一次，请立即复制保存到安全位置"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="token-name">令牌名称</Label>
              <Input id="token-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例如：CI 流水线专用" maxLength={64} />
            </div>

            <div className="space-y-1.5">
              <Label>有效期</Label>
              <div className="flex flex-wrap gap-2">
                {EXPIRY_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setFExpiryMode(p.key)}
                    className={cn(
                      "rounded-md border px-3 py-1.5 text-sm transition-colors",
                      fExpiryMode === p.key
                        ? "border-teal-600 bg-teal-600 text-white"
                        : "border-input bg-background hover:bg-muted"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {fExpiryMode === "custom" && (
                <div className="pt-2">
                  <Input
                    type="datetime-local"
                    value={fCustomExpire}
                    onChange={(e) => setFCustomExpire(e.target.value)}
                    aria-label="自定义到期时间"
                  />
                </div>
              )}
              {fExpiryMode === "permanent" && role !== "SUPER_ADMIN" && (
                <p className="text-xs text-orange-600">系统策略可能限制普通用户创建永久令牌，提交时将自动校验</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>权限（位掩码）</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { key: "read", label: "读取", hint: "位 1 · 查询类接口" },
                    { key: "write", label: "写入", hint: "位 2 · 创建/修改" },
                    { key: "execute", label: "执行", hint: "位 4 · 运行类操作" },
                    { key: "admin", label: "管理", hint: "位 8 · 高危管理操作" },
                  ] as const
                ).map((it) => (
                  <label
                    key={it.key}
                    className={cn(
                      "flex items-start gap-2 rounded-md border p-3 cursor-pointer transition-colors",
                      fPerm[it.key] ? "border-teal-600 bg-teal-50 dark:bg-teal-950/40" : "border-input"
                    )}
                  >
                    <Checkbox
                      checked={fPerm[it.key]}
                      onCheckedChange={(v) => setFPerm((prev) => ({ ...prev, [it.key]: v === true }))}
                      className="mt-0.5"
                    />
                    <div>
                      <p className="text-sm font-medium">{it.label}</p>
                      <p className="text-xs text-muted-foreground">{it.hint}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="token-ip">IP 白名单（可选）</Label>
              <Textarea
                id="token-ip"
                value={fIpList}
                onChange={(e) => setFIpList(e.target.value)}
                placeholder={"每行一个 IP 或 CIDR 段，例如：\n192.168.1.10\n10.0.0.0/24\n留空表示不限制来源 IP"}
                rows={4}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label>独立 QPS 限制（0 = 使用全局默认）</Label>
              <PrecisionInput value={fQps} onChange={setFQps} min={0} max={100000} suffix="次/秒" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submit} disabled={submitting} className="bg-teal-600 hover:bg-teal-700">
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {editing ? "保存修改" : "创建令牌"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={`删除令牌「${deleteTarget?.name || ""}」`}
        description="删除后该令牌立即失效，将软删除并移入回收站（保留期内可由管理员恢复）。关联的调用日志会保留用于审计。"
        confirmText="确认删除"
        destructive
        onConfirm={doDelete}
      />

      {/* 明文一次展示弹窗 */}
      <Dialog
        open={!!plainToken}
        onOpenChange={(v) => {
          // 关闭需要二次确认
          if (!v && plainToken) setConfirmClose(true)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-teal-600" />
              令牌创建成功
            </DialogTitle>
            <DialogDescription>
              完整令牌<strong className="text-red-600">仅在此时展示一次</strong>，关闭后无法再查看。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border bg-muted/50 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs text-muted-foreground">完整令牌</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowPlain((s) => !s)}
                    title={showPlain ? "隐藏" : "显示"}
                  >
                    {showPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyPlain}>
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {copied ? "已复制" : "一键复制"}
                  </Button>
                </div>
              </div>
              <code className="block break-all font-mono text-xs leading-relaxed select-all">
                {showPlain ? plainToken : `${plainToken?.slice(0, 10)}${"•".repeat(28)}`}
              </code>
            </div>
            <div className="rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/40 dark:border-orange-800 p-3 text-xs text-orange-700 dark:text-orange-300">
              <p>· 请立即复制并保存到密码管理器等安全位置</p>
              <p>· 服务端仅存储 SHA-256 哈希，任何人都无法再次查看明文</p>
              <p>· 遗失只能删除旧令牌后重新创建</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(true)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 关闭明文弹窗的二次确认 */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认已妥善保存令牌？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭后将无法再次查看完整令牌。请确认你已复制并保存到安全位置。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmClose(false)}>再看看</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setPlainToken(null)
                setConfirmClose(false)
              }}
              className="bg-teal-600 hover:bg-teal-700"
            >
              我已保存，关闭
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
