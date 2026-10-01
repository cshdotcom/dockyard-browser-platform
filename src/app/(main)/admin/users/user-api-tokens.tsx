"use client"

// 管理员代管：用户 API 密钥对话框
// 在用户管理行操作「API 密钥」中打开：
//   - 查看该用户全部有效密钥（级别/功能范围/IP/QPS/有效期/调用统计/最后调用）
//   - 手动为用户创建新密钥（级别单选 + 功能范围复选 + IP/QPS/有效期），明文仅展示一次
//   - 修改密钥配置 / 启停 / 吊销（软删除入回收站）
//   - 管理级（ADMIN 位）仅目标用户本身是管理员时可选
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy, Eye, EyeOff, KeyRound, Loader2, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react"
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
import { TOKEN_SCOPES, scopeLabel } from "@/lib/token-scopes"
import {
  adminListUserApiTokensAction,
  adminCreateUserApiTokenAction,
  adminUpdateUserApiTokenAction,
  adminToggleUserApiTokenAction,
  adminDeleteUserApiTokenAction,
} from "@/server/actions/admin-tokens"

export interface AdminApiTokenItem {
  id: string
  name: string
  tokenPrefix: string
  level: string
  levelLabel: string
  permissionsMask: number
  scopes: string[] | null
  ipWhitelist: string[] | null
  qpsLimit: number
  expireAt: string | null
  enabled: boolean
  callCount: number
  failCount: number
  lastCallAt: string | null
  createdByAdmin: boolean
  createdAt: string
}

interface UserApiTokensDialogProps {
  user: { id: string; username: string; displayName?: string | null; role: string } | null
  open: boolean
  onOpenChange: (v: boolean) => void
  viewerRole: string // 当前管理员角色（ADMIN / SUPER_ADMIN）
}

type Level = "READ_ONLY" | "READ_WRITE" | "ADMIN"
type FormMode = "list" | "create" | "edit"

const LEVEL_META: Record<Level, { title: string; hint: string; badgeClass: string }> = {
  READ_ONLY: { title: "只读", hint: "仅查询：列表/状态/任务查询，不能创建/修改/删除", badgeClass: "border-sky-300 text-sky-700 dark:text-sky-400" },
  READ_WRITE: { title: "读写", hint: "查询 + 创建/修改/执行（浏览器控制、批量编排等）", badgeClass: "border-emerald-300 text-emerald-700 dark:text-emerald-400" },
  ADMIN: { title: "管理级", hint: "含用户/令牌/强制管控等管理操作（仅管理员账号可授予）", badgeClass: "border-red-300 text-red-700 dark:text-red-400" },
}

const fmt = (iso: string | null): string => {
  if (!iso) return "—"
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function UserApiTokensDialog({ user, open, onOpenChange, viewerRole }: UserApiTokensDialogProps) {
  const router = useRouter()
  const [loading, setLoading] = React.useState(false)
  const [items, setItems] = React.useState<AdminApiTokenItem[]>([])
  const [summary, setSummary] = React.useState({ total: 0, enabled: 0, expired: 0, totalCalls: 0 })

  // 表单态
  const [mode, setMode] = React.useState<FormMode>("list")
  const [editing, setEditing] = React.useState<AdminApiTokenItem | null>(null)
  const [busy, setBusy] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [fName, setFName] = React.useState("")
  const [fLevel, setFLevel] = React.useState<Level>("READ_WRITE")
  const [fScopeUnlimited, setFScopeUnlimited] = React.useState(true)
  const [fScopes, setFScopes] = React.useState<string[]>([])
  const [fIpList, setFIpList] = React.useState("")
  const [fQps, setFQps] = React.useState(0)
  const [fPermanent, setFPermanent] = React.useState(false)
  const [fExpire, setFExpire] = React.useState("")

  // 明文一次展示
  const [plain, setPlain] = React.useState<{ token: string; prefix: string } | null>(null)
  const [showPlain, setShowPlain] = React.useState(true)
  const [confirmClosePlain, setConfirmClosePlain] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const [revokeTarget, setRevokeTarget] = React.useState<AdminApiTokenItem | null>(null)

  const targetIsAdmin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN"
  const viewerIsAdmin = viewerRole === "ADMIN" || viewerRole === "SUPER_ADMIN"
  const userId = user?.id

  const reload = React.useCallback(async () => {
    if (!userId) return
    setLoading(true)
    try {
      const res = await adminListUserApiTokensAction({ userId })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      const data = res.data as { items: AdminApiTokenItem[]; summary: { total: number; enabled: number; expired: number; totalCalls: number } } | undefined
      if (data) {
        setItems(data.items)
        setSummary(data.summary)
      }
    } finally {
      setLoading(false)
    }
  }, [userId])

  React.useEffect(() => {
    if (open && userId) {
      setMode("list")
      setEditing(null)
      setPlain(null)
      void reload()
    }
  }, [open, userId, reload])

  const openCreate = () => {
    setEditing(null)
    setFName("")
    setFLevel("READ_WRITE")
    setFScopeUnlimited(true)
    setFScopes([])
    setFIpList("")
    setFQps(0)
    setFPermanent(false)
    setFExpire("")
    setMode("create")
  }

  const openEdit = (it: AdminApiTokenItem) => {
    setEditing(it)
    setFName(it.name)
    setFLevel(it.level as Level)
    setFScopeUnlimited(!it.scopes || it.scopes.length === 0)
    setFScopes(it.scopes || [])
    setFIpList((it.ipWhitelist || []).join("\n"))
    setFQps(it.qpsLimit)
    setFPermanent(!it.expireAt)
    setFExpire(it.expireAt ? isoToLocalInput(it.expireAt) : "")
    setMode("edit")
  }

  const submit = async () => {
    if (!userId || !user) return
    if (!fName.trim()) {
      toast.error("令牌名称必填")
      return
    }
    if (!fScopeUnlimited && fScopes.length === 0) {
      toast.error("请至少勾选一项功能范围，或选择「不限」")
      return
    }
    let expireIso: string | null = null
    if (!fPermanent) {
      if (!fExpire) {
        toast.error("请选择到期时间，或勾选「永久有效」")
        return
      }
      expireIso = new Date(fExpire).toISOString()
      if (new Date(expireIso).getTime() <= Date.now()) {
        toast.error("到期时间必须晚于当前时间")
        return
      }
    }
    const ipList = fIpList.split("\n").map((s) => s.trim()).filter(Boolean)
    setSubmitting(true)
    try {
      const payload = {
        userId,
        id: editing?.id,
        name: fName.trim(),
        level: fLevel,
        scopes: fScopeUnlimited ? [] : fScopes,
        expireAtIso: expireIso,
        ipWhitelist: ipList,
        qps: fQps,
      }
      const res = mode === "create"
        ? await adminCreateUserApiTokenAction(payload)
        : await adminUpdateUserApiTokenAction(payload)
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      if (mode === "create") {
        const data = res.data as { token: string; tokenPrefix: string } | undefined
        if (data?.token) {
          setPlain({ token: data.token, prefix: data.tokenPrefix })
          setShowPlain(true)
          setCopied(false)
        }
        toast.success("已为该用户创建 API 密钥")
      } else {
        toast.success("密钥配置已更新")
      }
      setMode("list")
      await reload()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const doToggle = async (it: AdminApiTokenItem, enabled: boolean) => {
    setBusy(`toggle-${it.id}`)
    try {
      const res = await adminToggleUserApiTokenAction({ id: it.id, enabled })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(enabled ? "已启用" : "已停用")
      await reload()
    } finally {
      setBusy("")
    }
  }

  const doRevoke = async () => {
    if (!revokeTarget) return
    setBusy(`del-${revokeTarget.id}`)
    try {
      const res = await adminDeleteUserApiTokenAction({ id: revokeTarget.id, reason: "管理员在用户管理中吊销" })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(`密钥「${revokeTarget.name}」已吊销并移入回收站`)
      setRevokeTarget(null)
      await reload()
      router.refresh()
    } finally {
      setBusy("")
    }
  }

  const copyPlain = async () => {
    if (!plain) return
    try {
      await navigator.clipboard.writeText(plain.token)
      setCopied(true)
      toast.success("已复制到剪贴板")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  const levelBadge = (it: AdminApiTokenItem) => (
    <Badge variant="outline" className={cn("text-xs", LEVEL_META[(it.level as Level) || "READ_WRITE"].badgeClass)}>
      {it.levelLabel}
    </Badge>
  )

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v) }}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-teal-600" />
            API 密钥管理 · {user?.username}
            {user?.displayName ? <span className="text-sm text-muted-foreground font-normal">（{user.displayName}）</span> : null}
          </DialogTitle>
          <DialogDescription>
            管理员代管该用户的 API 密钥：创建、查看、修改配置、启停与吊销。明文密钥仅创建时展示一次，服务端只存哈希。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : mode === "list" ? (
          <div className="space-y-4">
            {/* 概览 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: "有效密钥", value: summary.total, hint: `启用 ${summary.enabled}` },
                { label: "已过期", value: summary.expired, hint: "超出有效期" },
                { label: "累计调用", value: summary.totalCalls, hint: "全部密钥合计" },
                { label: "管理员代建", value: items.filter((i) => i.createdByAdmin).length, hint: "非本人创建" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-lg font-semibold tabular-nums">{s.value}</p>
                  <p className="text-[10px] text-muted-foreground">{s.hint}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">共 {summary.total} 个密钥（按创建时间倒序）</p>
              {viewerIsAdmin && (
                <Button size="sm" className="bg-teal-600 hover:bg-teal-700" onClick={openCreate}>
                  <Plus className="mr-1 h-4 w-4" /> 为该用户创建密钥
                </Button>
              )}
            </div>

            {/* 密钥列表 */}
            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                该用户暂无 API 密钥。点击上方按钮手动创建。
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((it) => {
                  const expired = it.expireAt && new Date(it.expireAt).getTime() < Date.now()
                  return (
                    <div key={it.id} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm">{it.name}</p>
                            {levelBadge(it)}
                            {!it.enabled && <Badge variant="outline" className="text-xs">已停用</Badge>}
                            {expired && <Badge variant="outline" className="text-xs border-red-300 text-red-600">已过期</Badge>}
                            {it.createdByAdmin && <Badge variant="secondary" className="text-[10px]">管理员代建</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">{it.tokenPrefix}••••••••</p>
                        </div>
                        {viewerIsAdmin && (
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={it.enabled}
                              disabled={busy === `toggle-${it.id}`}
                              onCheckedChange={(v) => doToggle(it, v)}
                              aria-label={`启用或停用密钥 ${it.name}`}
                            />
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(it)} title="修改配置">
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-red-600 hover:text-red-700"
                              onClick={() => setRevokeTarget(it)}
                              title="吊销"
                              disabled={!!busy}
                            >
                              {busy === `del-${it.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-muted-foreground">功能范围：</span>
                          {!it.scopes || it.scopes.length === 0 ? (
                            <span className="text-muted-foreground">不限（全功能面）</span>
                          ) : (
                            it.scopes.map((s) => (
                              <Badge key={s} variant="secondary" className="text-[10px] font-normal">{scopeLabel(s)}</Badge>
                            ))
                          )}
                        </div>
                        <p>
                          <span className="text-muted-foreground">有效期：</span>
                          {it.expireAt ? fmt(it.expireAt) : <span className="text-teal-600">永久有效</span>}
                        </p>
                        <p>
                          <span className="text-muted-foreground">IP 白名单：</span>
                          {it.ipWhitelist && it.ipWhitelist.length > 0 ? `${it.ipWhitelist.length} 条规则` : "不限"}
                        </p>
                        <p>
                          <span className="text-muted-foreground">QPS：</span>
                          {it.qpsLimit > 0 ? `${it.qpsLimit}/s` : "全局默认"}
                        </p>
                        <p>
                          <span className="text-muted-foreground">调用：</span>
                          <span className="tabular-nums">{it.callCount}</span> 次
                          {it.failCount > 0 && <span className="text-red-600">（失败 {it.failCount}）</span>}
                          <span className="text-muted-foreground"> · 最后 {it.lastCallAt ? fmt(it.lastCallAt) : "从未"}</span>
                        </p>
                        <p>
                          <span className="text-muted-foreground">创建：</span>
                          {fmt(it.createdAt)}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          // ---- 创建 / 编辑表单 ----
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="adm-token-name">令牌名称</Label>
              <Input id="adm-token-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例如：数据同步专用（只读）" maxLength={64} />
            </div>

            <div className="space-y-1.5">
              <Label>权限级别</Label>
              <div className="space-y-2">
                {(Object.keys(LEVEL_META) as Level[])
                  .filter((k) => k !== "ADMIN" || targetIsAdmin)
                  .map((k) => (
                    <label
                      key={k}
                      className={cn(
                        "flex items-start gap-2 rounded-md border p-3 cursor-pointer transition-colors",
                        fLevel === k ? "border-teal-600 bg-teal-50 dark:bg-teal-950/40" : "border-input"
                      )}
                    >
                      <input type="radio" name="adm-token-level" className="mt-1 accent-teal-600" checked={fLevel === k} onChange={() => setFLevel(k)} />
                      <div>
                        <p className="text-sm font-medium">{LEVEL_META[k].title}</p>
                        <p className="text-xs text-muted-foreground">{LEVEL_META[k].hint}</p>
                      </div>
                    </label>
                  ))}
                {!targetIsAdmin && (
                  <p className="text-xs text-muted-foreground">该用户不是管理员账号，无法授予管理级密钥</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-teal-600" />
                  功能范围限制
                </Label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox checked={fScopeUnlimited} onCheckedChange={(v) => setFScopeUnlimited(v === true)} />
                  不限（开放全部功能面）
                </label>
              </div>
              {!fScopeUnlimited && (
                <div className="rounded-md border p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">勾选该密钥允许调用的功能面（与权限级别正交：只读只能查，读写可改）</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {TOKEN_SCOPES.map((s) => (
                      <label
                        key={s.key}
                        className={cn(
                          "flex items-start gap-2 rounded-md border p-2.5 cursor-pointer transition-colors",
                          fScopes.includes(s.key) ? "border-teal-600 bg-teal-50 dark:bg-teal-950/40" : "border-input"
                        )}
                      >
                        <Checkbox
                          checked={fScopes.includes(s.key)}
                          onCheckedChange={(v) => {
                            setFScopes((prev) => (v === true ? [...new Set([...prev, s.key])] : prev.filter((k) => k !== s.key)))
                          }}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium">{s.label}</p>
                          <p className="text-xs text-muted-foreground">{s.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Checkbox id="adm-token-perm" checked={fPermanent} onCheckedChange={(v) => setFPermanent(v === true)} />
                <Label htmlFor="adm-token-perm" className="text-sm font-normal">永久有效</Label>
              </div>
              {!fPermanent && (
                <Input type="datetime-local" value={fExpire} onChange={(e) => setFExpire(e.target.value)} aria-label="到期时间" />
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adm-token-ip">IP 白名单（可选）</Label>
              <Textarea
                id="adm-token-ip"
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
        )}

        {mode !== "list" && (
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode("list")} disabled={submitting}>
              返回列表
            </Button>
            <Button onClick={submit} disabled={submitting} className="bg-teal-600 hover:bg-teal-700">
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {mode === "create" ? "创建密钥" : "保存修改"}
            </Button>
          </DialogFooter>
        )}

        {/* 明文一次展示 */}
        <Dialog open={!!plain} onOpenChange={(v) => { if (!v && plain) setConfirmClosePlain(true) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-teal-600" />
                密钥创建成功
              </DialogTitle>
              <DialogDescription>
                完整密钥<strong className="text-red-600">仅在此时展示一次</strong>，关闭后无法再查看。请转交给用户并妥善保存。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/50 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs text-muted-foreground">完整密钥（{plain?.prefix}…）</span>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setShowPlain((s) => !s)} title={showPlain ? "隐藏" : "显示"}>
                      {showPlain ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button variant="outline" size="sm" onClick={copyPlain}>
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      {copied ? "已复制" : "一键复制"}
                    </Button>
                  </div>
                </div>
                <code className="block break-all font-mono text-xs leading-relaxed select-all">
                  {showPlain ? plain?.token : `${plain?.token.slice(0, 10)}${"•".repeat(28)}`}
                </code>
              </div>
              <div className="rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/40 dark:border-orange-800 p-3 text-xs text-orange-700 dark:text-orange-300">
                <p>· 请立即复制并转交用户保存到安全位置</p>
                <p>· 服务端仅存储 SHA-256 哈希，任何人都无法再次查看明文</p>
                <p>· 该密钥归属用户 {user?.username}，计入其个人令牌配额</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmClosePlain(true)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog open={confirmClosePlain} onOpenChange={setConfirmClosePlain}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认已妥善保存密钥？</AlertDialogTitle>
              <AlertDialogDescription>关闭后将无法再次查看完整密钥。请确认你已复制并转交用户保存。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmClosePlain(false)}>再看看</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { setPlain(null); setConfirmClosePlain(false) }}
                className="bg-teal-600 hover:bg-teal-700"
              >
                我已保存，关闭
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <ConfirmDialog
          open={!!revokeTarget}
          onOpenChange={(v) => !v && setRevokeTarget(null)}
          title={`吊销密钥「${revokeTarget?.name || ""}」`}
          description="吊销后该密钥立即失效，软删除并移入回收站（保留期内可恢复）。调用日志保留用于审计。此操作以管理员身份执行并写入审计。"
          confirmText="确认吊销"
          destructive
          onConfirm={doRevoke}
        />
      </DialogContent>
    </Dialog>
  )
}

