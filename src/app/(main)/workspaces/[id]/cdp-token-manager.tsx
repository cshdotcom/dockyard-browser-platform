"use client"

// r37：CDP 公网连接地址管理器（持久票据全生命周期）
//   · 列表：地址/标签/有效期（永久|自定义）/次数/状态（生效|已吊销|已过期）/最近使用
//   · 创建：永久 或 自定义分钟；次数上限；标签备注
//   · 「重新创建」（轮换）：旧地址立即失效 + 生成新地址（泄露自救）
//   · 吊销 / 修改（有效期/次数/标签）
//   · 网关未配置 → 引导文案（管理员配置后地址生效）

import * as React from "react"
import { useRouter } from "next/navigation"
import { Plus, RefreshCcw, Ban, Copy, Loader2, Ticket, CheckCircle2, Pencil } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import {
  listCdpEndpointTokensAction,
  createCdpEndpointTokenAction,
  revokeCdpEndpointTokenAction,
  rotateCdpEndpointTokenAction,
  updateCdpEndpointTokenAction,
} from "@/server/actions/cdp-gateway"
import { cn } from "@/lib/utils"

interface TokenRow {
  id: string
  tid: string
  label: string | null
  note: string | null
  address: string | null
  expireAt: string | null
  expired: boolean
  maxUses: number
  useCount: number
  lastUsedAt: string | null
  lastUsedIp: string | null
  revokedAt: string | null
  revokeReason: string | null
  createdVia: string
  createdAt: string
}

export function CdpTokenManager({ workspaceId, canOperate, isRunning }: { workspaceId: string; canOperate: boolean; isRunning: boolean }) {
  const router = useRouter()
  const [rows, setRows] = React.useState<TokenRow[]>([])
  const [gatewayConfigured, setGatewayConfigured] = React.useState(true)
  const [globalAllow, setGlobalAllow] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [rotateTarget, setRotateTarget] = React.useState<TokenRow | null>(null)
  const [editTarget, setEditTarget] = React.useState<TokenRow | null>(null)

  const reload = React.useCallback(async () => {
    const res = await listCdpEndpointTokensAction({ workspaceId })
    if (res.code === 0 && res.data) {
      setRows(res.data.tokens as unknown as TokenRow[])
      setGatewayConfigured(res.data.gatewayConfigured)
      setGlobalAllow(res.data.globalAllow)
    }
    setLoading(false)
  }, [workspaceId])

  React.useEffect(() => { void reload() }, [reload])

  const doRevoke = async (t: TokenRow) => {
    const res = await revokeCdpEndpointTokenAction({ tokenId: t.id, reason: "手动吊销" })
    if (res.code === 0) { toast.success("地址已吊销（网关实时生效，旧地址立即拒连）"); void reload(); router.refresh() }
    else toast.error(res.msg)
  }

  const copyAddr = async (addr: string | null) => {
    if (!addr) return toast.error("网关未配置，无可用地址")
    try {
      await navigator.clipboard.writeText(addr)
      toast.success("连接地址已复制（自动化工具的 browserWSEndpoint 直接填入）")
    } catch {
      toast.info(addr)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-1.5"><Ticket className="h-4 w-4 text-sky-500" />公网连接地址管理（持久票据）</CardTitle>
            <CardDescription>
              支持永久 / 自定义有效期；地址泄露可一键「重新创建」（旧地址立即失效）；吊销/轮换经网关实时校验即时生效
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)} disabled={!canOperate || !isRunning} title={isRunning ? "创建新的持久连接地址" : "沙箱运行后可创建"}>
            <Plus className="mr-1 h-4 w-4" />创建地址
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!gatewayConfigured && (
          <div className="rounded-md border border-amber-300 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-800 p-2.5 text-xs text-amber-700 dark:text-amber-300">
            CDP 公网网关未配置：地址将生成但暂不可外网连接。请管理员在「系统配置 → CDP 网关 → 公网网关地址」填写穿透域名（配置后无需重建，地址自动生效）。
          </div>
        )}
        {!globalAllow && (
          <div className="rounded-md border border-red-300 bg-red-50/70 dark:bg-red-950/30 dark:border-red-800 p-2.5 text-xs text-red-600 dark:text-red-300">
            管理员已全局停用持久连接地址（cdp.allowPersistentTokens=false）；仅管理员可强制创建。
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground border border-dashed rounded-lg">暂无持久连接地址</p>
        ) : (
          <div className="rounded-md border divide-y max-h-80 overflow-y-auto">
            {rows.map((t) => {
              const dead = !!t.revokedAt || t.expired || (t.maxUses > 0 && t.useCount >= t.maxUses)
              return (
                <div key={t.id} className="p-3 text-sm space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-medium truncate max-w-32">{t.label || `地址 ${t.tid.slice(0, 8)}`}</span>
                      {t.revokedAt ? (
                        <Badge variant="secondary" className="text-[10px] text-red-600">已吊销{t.revokeReason ? `·${t.revokeReason}` : ""}</Badge>
                      ) : t.expired ? (
                        <Badge variant="secondary" className="text-[10px] text-amber-600">已过期</Badge>
                      ) : t.maxUses > 0 && t.useCount >= t.maxUses ? (
                        <Badge variant="secondary" className="text-[10px] text-amber-600">次数用尽</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] text-teal-600">生效中</Badge>
                      )}
                      {t.createdVia === "ADMIN" && <Badge variant="outline" className="text-[10px]">管理员创建</Badge>}
                      <Badge variant="outline" className="text-[10px]">{t.expireAt ? `至 ${new Date(t.expireAt).toLocaleString()}` : "永久有效"}</Badge>
                      <Badge variant="outline" className="text-[10px]">已连 {t.useCount}{t.maxUses > 0 ? `/${t.maxUses}` : ""} 次</Badge>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!t.revokedAt && (
                        <>
                          <Button variant="ghost" size="sm" title="复制连接地址" onClick={() => void copyAddr(t.address)}><Copy className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="sm" title="重新创建（轮换地址）" className="text-sky-600" onClick={() => setRotateTarget(t)} disabled={!canOperate}><RefreshCcw className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="sm" title="修改（有效期/次数/标签）" onClick={() => setEditTarget(t)} disabled={!canOperate}><Pencil className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="sm" title="吊销（立即失效）" className="text-red-500" onClick={() => void doRevoke(t)} disabled={!canOperate}><Ban className="h-4 w-4" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                  {t.address && <code className="block text-[11px] font-mono break-all text-muted-foreground select-all">{t.address}</code>}
                  <p className="text-[11px] text-muted-foreground">
                    创建 {new Date(t.createdAt).toLocaleString()}
                    {t.lastUsedAt ? ` · 最近使用 ${new Date(t.lastUsedAt).toLocaleString()}${t.lastUsedIp ? `（${t.lastUsedIp}）` : ""}` : " · 未使用过"}
                  </p>
                </div>
              )
            })}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          地址形态 <code className="font-mono">ws(s)://&lt;网关域名&gt;/p/&lt;票据&gt;</code>：不可猜测、可轮换、吊销即时生效；沙箱重启后地址自动指向最新 CDP 端点（无需重建）。
        </p>
      </CardContent>

      {/* 创建弹窗 */}
      <TokenCreateDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onDone={() => { void reload(); router.refresh() }} />

      {/* 轮换确认 */}
      <RotateConfirmDialog target={rotateTarget} workspaceId={workspaceId} open={!!rotateTarget} onOpenChange={(v) => !v && setRotateTarget(null)} onDone={() => { void reload(); router.refresh() }} />

      {/* 修改弹窗 */}
      <TokenEditDialog target={editTarget} workspaceId={workspaceId} open={!!editTarget} onOpenChange={(v) => !v && setEditTarget(null)} onDone={() => { void reload(); router.refresh() }} />
    </Card>
  )
}

// ---- 创建地址弹窗 ----
function TokenCreateDialog({ workspaceId, open, onOpenChange, onDone }: { workspaceId: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [label, setLabel] = React.useState("")
  const [note, setNote] = React.useState("")
  const [mode, setMode] = React.useState<"permanent" | "custom">("permanent")
  const [minutes, setMinutes] = React.useState(1440)
  const [maxUses, setMaxUses] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const res = await createCdpEndpointTokenAction({
        workspaceId,
        label: label || undefined,
        note: note || undefined,
        expiry: { mode, minutes: mode === "custom" ? minutes : undefined },
        maxUses,
      })
      if (res.code === 0 && res.data) {
        toast.success(`持久连接地址已创建${res.data.address ? "" : "（网关配置后生效）"}：${res.data.address?.slice(0, 48) || ""}…`)
        onOpenChange(false)
        setLabel(""); setNote(""); setMode("permanent"); setMinutes(1440); setMaxUses(0)
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-4 w-4 text-sky-500" />创建持久连接地址</DialogTitle>
          <DialogDescription>地址长期有效（与一次性票据互补）；可随时吊销或轮换</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>标签（如：自动化接入 / 客户联调）</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="自动化接入" />
          </div>
          <div className="space-y-1.5">
            <Label>有效期</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "permanent" | "custom")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="permanent">永久有效（直到吊销/轮换）</SelectItem>
                <SelectItem value="custom">自定义时长</SelectItem>
              </SelectContent>
            </Select>
            {mode === "custom" && (
              <div className="flex items-center gap-2 pt-1">
                <Input type="number" min={1} max={5256000} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 1)} className="h-8" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">分钟后过期</span>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>建连次数上限（0=不限）</Label>
            <Input type="number" min={0} max={1000000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value) || 0)} className="h-8" />
          </div>
          <div className="space-y-1.5">
            <Label>备注（可选）</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="交接给项目组的接入地址" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- 轮换确认弹窗（重新创建：旧地址立即失效 + 新地址） ----
function RotateConfirmDialog({ target, workspaceId, open, onOpenChange, onDone }: { target: TokenRow | null; workspaceId: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const doRotate = async () => {
    if (!target) return
    setBusy(true)
    try {
      const res = await rotateCdpEndpointTokenAction({ tokenId: target.id, reason: "轮换重建（地址更换）" })
      if (res.code === 0 && res.data) {
        toast.success(`已重新创建：旧地址立即失效，新地址 ${res.data.newToken.address?.slice(0, 40) || ""}…（复制可在列表操作）`)
        onOpenChange(false)
        onDone()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }
  return (
    <Dialog open={open && !!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><RefreshCcw className="h-4 w-4 text-sky-500" />重新创建连接地址</DialogTitle>
          <DialogDescription>
            疑似泄露/交接变更时使用：旧地址「{target?.label || target?.tid.slice(0, 8)}」立即失效（网关实时拒连），新地址立即生成并继承有效期与次数配置。
          </DialogDescription>
        </DialogHeader>
        {target?.address && <code className="text-[11px] font-mono break-all rounded bg-muted p-2">{target.address}</code>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={doRotate} disabled={busy} className="bg-sky-600 hover:bg-sky-700">{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 重新创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- 修改弹窗（有效期/次数/标签） ----
function TokenEditDialog({ target, workspaceId, open, onOpenChange, onDone }: { target: TokenRow | null; workspaceId: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [mode, setMode] = React.useState<"permanent" | "custom">("permanent")
  const [minutes, setMinutes] = React.useState(1440)
  const [maxUses, setMaxUses] = React.useState(0)
  const [label, setLabel] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (target) {
      setMode(target.expireAt ? "custom" : "permanent")
      setMinutes(target.expireAt ? Math.max(1, Math.round((new Date(target.expireAt).getTime() - Date.now()) / 60000)) : 1440)
      setMaxUses(target.maxUses)
      setLabel(target.label || "")
    }
  }, [target])

  const submit = async () => {
    if (!target) return
    setBusy(true)
    try {
      const res = await updateCdpEndpointTokenAction({
        tokenId: target.id,
        label: label || undefined,
        expiry: { mode, minutes: mode === "custom" ? minutes : undefined },
        maxUses,
      })
      if (res.code === 0) { toast.success("地址设置已更新"); onOpenChange(false); onDone() }
      else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open && !!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4" />修改连接地址</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>标签</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </div>
          <div className="space-y-1.5">
            <Label>有效期</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "permanent" | "custom")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="permanent">永久有效</SelectItem>
                <SelectItem value="custom">自定义时长（从现在起）</SelectItem>
              </SelectContent>
            </Select>
            {mode === "custom" && (
              <div className="flex items-center gap-2 pt-1">
                <Input type="number" min={1} max={5256000} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 1)} className="h-8" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">分钟</span>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>次数上限（0=不限）</Label>
            <Input type="number" min={0} max={1000000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value) || 0)} className="h-8" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
