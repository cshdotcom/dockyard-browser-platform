"use client"

// r23-d：API-Key 策略对话框（用户级覆盖 / 组级基线，两套入口复用同一套三态字段组件）
// 策略链四级：每Key rateLimitPerMin > 用户级 tokenPolicy > 组级 tokenPolicy > 全局 token.* 配置
// · 三态字段：勾选「覆盖/设置」= 显式值（保存时仅传勾选字段）；未勾 = 继承（字段不出现在 JSON）
// · allowedScopes：勾选后不选任何功能面 = null（显式不限）
// · SUPER_ADMIN 目标用户不受限制（豁免），覆盖设置不生效

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Info, KeyRound, Loader2, Trash2 } from "lucide-react"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { TOKEN_SCOPES, scopeLabel } from "@/lib/token-scopes"
import { getUserTokenPolicyAction, setUserTokenPolicyAction } from "@/server/actions/users"
import { getGroupTokenPolicyAction, setGroupTokenPolicyAction } from "@/server/actions/groups"

// ============================================================
// 共享类型与工具
// ============================================================

export interface PolicySparse {
  allowCreate?: boolean
  maxPerUser?: number
  allowPermanent?: boolean
  maxLifetimeDays?: number
  rateLimitPerMin?: number
  allowedScopes?: string[] | null
}

type FieldKey = "allowCreate" | "maxPerUser" | "allowPermanent" | "maxLifetimeDays" | "rateLimitPerMin" | "allowedScopes"

const FIELD_KEYS: FieldKey[] = ["allowCreate", "maxPerUser", "allowPermanent", "maxLifetimeDays", "rateLimitPerMin", "allowedScopes"]

interface FieldsState {
  on: Record<FieldKey, boolean>
  v: {
    allowCreate: boolean
    maxPerUser: number
    allowPermanent: boolean
    maxLifetimeDays: number
    rateLimitPerMin: number
    allowedScopes: string[]
  }
}

const EMPTY_FIELDS = (): FieldsState => ({
  on: { allowCreate: false, maxPerUser: false, allowPermanent: false, maxLifetimeDays: false, rateLimitPerMin: false, allowedScopes: false },
  v: { allowCreate: false, maxPerUser: 5, allowPermanent: true, maxLifetimeDays: 365, rateLimitPerMin: 300, allowedScopes: [] },
})

/** 从已存稀疏 JSON 预填：出现的键 = 覆盖中，取其值 */
function prefillFromSparse(sparse: PolicySparse | null | undefined): FieldsState {
  const s = EMPTY_FIELDS()
  if (!sparse) return s
  if (typeof sparse.allowCreate === "boolean") { s.on.allowCreate = true; s.v.allowCreate = sparse.allowCreate }
  if (typeof sparse.maxPerUser === "number" && Number.isFinite(sparse.maxPerUser)) { s.on.maxPerUser = true; s.v.maxPerUser = Math.max(0, Math.floor(sparse.maxPerUser)) }
  if (typeof sparse.allowPermanent === "boolean") { s.on.allowPermanent = true; s.v.allowPermanent = sparse.allowPermanent }
  if (typeof sparse.maxLifetimeDays === "number" && Number.isFinite(sparse.maxLifetimeDays)) { s.on.maxLifetimeDays = true; s.v.maxLifetimeDays = Math.max(0, Math.floor(sparse.maxLifetimeDays)) }
  if (typeof sparse.rateLimitPerMin === "number" && Number.isFinite(sparse.rateLimitPerMin)) { s.on.rateLimitPerMin = true; s.v.rateLimitPerMin = Math.max(0, Math.floor(sparse.rateLimitPerMin)) }
  if (sparse.allowedScopes !== undefined && sparse.allowedScopes !== null) { s.on.allowedScopes = true; s.v.allowedScopes = sparse.allowedScopes.filter((x) => typeof x === "string") }
  if (sparse.allowedScopes === null) { s.on.allowedScopes = true; s.v.allowedScopes = [] }
  return s
}

/** 构建保存载荷：仅勾选字段；全空 → null（完全继承） */
function buildSparse(s: FieldsState): PolicySparse | null {
  const out: PolicySparse = {}
  if (s.on.allowCreate) out.allowCreate = s.v.allowCreate
  if (s.on.maxPerUser) out.maxPerUser = s.v.maxPerUser
  if (s.on.allowPermanent) out.allowPermanent = s.v.allowPermanent
  if (s.on.maxLifetimeDays) out.maxLifetimeDays = s.v.maxLifetimeDays
  if (s.on.rateLimitPerMin) out.rateLimitPerMin = s.v.rateLimitPerMin
  if (s.on.allowedScopes) out.allowedScopes = s.v.allowedScopes.length > 0 ? s.v.allowedScopes : null
  return Object.keys(out).length > 0 ? out : null
}

const overrideCount = (s: FieldsState) => FIELD_KEYS.filter((k) => s.on[k]).length

// ---- 来源徽章：user=teal / group=amber / global=slate ----
function SourceBadge({ src }: { src: string | undefined }) {
  if (src === "user") return <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px] px-1.5">用户级</Badge>
  if (src === "group") return <Badge className="bg-amber-500 hover:bg-amber-500 text-[10px] px-1.5">组级</Badge>
  return <Badge variant="secondary" className="text-[10px] px-1.5">全局默认</Badge>
}

const fmtEffective = {
  bool: (v: unknown) => (v === true ? "允许" : v === false ? "禁止" : "-"),
  num: (v: unknown, unit: string, zero: string) => (typeof v === "number" ? (v > 0 ? `${v} ${unit}` : zero) : "-"),
  scopes: (v: unknown) =>
    Array.isArray(v) && v.length > 0
      ? v.map((x) => scopeLabel(String(x))).join("、")
      : "不限（全功能面）",
}

// ============================================================
// 共享：三态字段组（mode=user 用户级覆盖 / mode=group 组级基线）
// ============================================================

// 单行三态字段（覆盖勾选 + 控件 + 说明）；顶层组件避免 render 内创建组件
function PolicyFieldRow({
  active, overrideWord, label, hint, onToggle, control, ariaLabel,
}: {
  active: boolean
  overrideWord: string
  label: string
  hint: string
  onToggle: () => void
  control: React.ReactNode
  ariaLabel: string
}) {
  return (
    <div className={cn("rounded-md border p-3 space-y-1.5 transition-colors", active && "border-teal-600/60 bg-teal-50/40 dark:bg-teal-950/30")}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <Checkbox checked={active} onCheckedChange={onToggle} aria-label={ariaLabel} />
          <span>{label}</span>
          {!active && <span className="text-[10px] text-muted-foreground">（未{overrideWord} = 继承）</span>}
        </label>
        <div className={cn("flex items-center gap-2", !active && "opacity-40 pointer-events-none")}>{control}</div>
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function PolicyFields({
  fields, setFields, mode,
}: {
  fields: FieldsState
  setFields: React.Dispatch<React.SetStateAction<FieldsState>>
  mode: "user" | "group"
}) {
  const toggleOn = (k: FieldKey) => setFields((prev) => ({ ...prev, on: { ...prev.on, [k]: !prev.on[k] } }))
  const overrideWord = mode === "user" ? "覆盖" : "设置"

  return (
    <div className="space-y-2.5">
      <PolicyFieldRow
        active={fields.on.allowCreate}
        overrideWord={overrideWord}
        label="允许创建 API-Key"
        hint={`勾选${overrideWord}后按开关强制允许/禁止该用户创建 API-Key；未勾选时走组级/全局`}
        onToggle={() => toggleOn("allowCreate")}
        ariaLabel={`${overrideWord} 允许创建 API-Key`}
        control={<Switch checked={fields.v.allowCreate} onCheckedChange={(v) => setFields((p) => ({ ...p, v: { ...p.v, allowCreate: v } }))} aria-label="允许创建开关" />}
      />
      <PolicyFieldRow
        active={fields.on.maxPerUser}
        overrideWord={overrideWord}
        label="单用户最大 Key 数量"
        hint="0 = 禁止持有任何 Key；生效值取策略链解析结果"
        onToggle={() => toggleOn("maxPerUser")}
        ariaLabel={`${overrideWord} 单用户最大 Key 数量`}
        control={<PrecisionInput value={fields.v.maxPerUser} onChange={(n) => setFields((p) => ({ ...p, v: { ...p.v, maxPerUser: Math.floor(n) } }))} min={0} max={10000} step={1} suffix="个" className="w-32" />}
      />
      <PolicyFieldRow
        active={fields.on.allowPermanent}
        overrideWord={overrideWord}
        label="允许永久 Key"
        hint={`勾选${overrideWord}后按开关控制能否创建永久有效 Key；关闭则创建时必须设有效期`}
        onToggle={() => toggleOn("allowPermanent")}
        ariaLabel={`${overrideWord} 允许永久 Key`}
        control={<Switch checked={fields.v.allowPermanent} onCheckedChange={(v) => setFields((p) => ({ ...p, v: { ...p.v, allowPermanent: v } }))} aria-label="允许永久开关" />}
      />
      <PolicyFieldRow
        active={fields.on.maxLifetimeDays}
        overrideWord={overrideWord}
        label="Key 最大有效时长"
        hint="单位天；0 = 不限时长（创建时校验）"
        onToggle={() => toggleOn("maxLifetimeDays")}
        ariaLabel={`${overrideWord} Key 最大有效时长`}
        control={<PrecisionInput value={fields.v.maxLifetimeDays} onChange={(n) => setFields((p) => ({ ...p, v: { ...p.v, maxLifetimeDays: Math.floor(n) } }))} min={0} max={3650} step={1} suffix="天" className="w-32" />}
      />
      <PolicyFieldRow
        active={fields.on.rateLimitPerMin}
        overrideWord={overrideWord}
        label="每分钟调用上限"
        hint="网关鉴权热路径逐 Key 限流；0 = 不限（走下一级）"
        onToggle={() => toggleOn("rateLimitPerMin")}
        ariaLabel={`${overrideWord} 每分钟调用上限`}
        control={<PrecisionInput value={fields.v.rateLimitPerMin} onChange={(n) => setFields((p) => ({ ...p, v: { ...p.v, rateLimitPerMin: Math.floor(n) } }))} min={0} max={1000000} step={1} suffix="次/分" className="w-36" />}
      />

      {/* allowedScopes：勾选覆盖 + 功能面多选（不选 = 显式不限 null） */}
      <div className={cn("rounded-md border p-3 space-y-2 transition-colors", fields.on.allowedScopes && "border-teal-600/60 bg-teal-50/40 dark:bg-teal-950/30")}>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox checked={fields.on.allowedScopes} onCheckedChange={() => toggleOn("allowedScopes")} aria-label={`${overrideWord}功能范围`} />
          <span>允许的功能范围</span>
          {!fields.on.allowedScopes ? (
            <span className="text-[10px] text-muted-foreground">（未{overrideWord} = 继承）</span>
          ) : fields.v.allowedScopes.length === 0 ? (
            <Badge variant="secondary" className="text-[10px]">不限（显式）</Badge>
          ) : (
            <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">限 {fields.v.allowedScopes.length} 项</Badge>
          )}
        </div>
        {fields.on.allowedScopes && (
          <div className="rounded-md border bg-background p-2">
            <p className="text-[11px] text-muted-foreground mb-1.5">勾选该用户 Key 可调用的功能面；全部不勾 = 显式不限（null）</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {TOKEN_SCOPES.map((sc) => {
                const checked = fields.v.allowedScopes.includes(sc.key)
                return (
                  <label
                    key={sc.key}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-2.5 py-1.5 cursor-pointer text-xs transition-colors",
                      checked ? "border-teal-600 bg-teal-50/60 dark:bg-teal-950/40" : "border-input"
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setFields((p) => ({
                          ...p,
                          v: { ...p.v, allowedScopes: v === true ? [...new Set([...p.v.allowedScopes, sc.key])] : p.v.allowedScopes.filter((x) => x !== sc.key) },
                        }))
                      }
                      className="shrink-0"
                    />
                    <span className="truncate">{sc.label}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// 1. 用户级 Token 策略对话框（用户管理行菜单入口）
// ============================================================

export function UserTokenPolicyDialog({
  user, open, onOpenChange,
}: {
  user: { id: string; username: string; displayName?: string | null; role: string } | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [effective, setEffective] = React.useState<Record<string, unknown> | null>(null)
  const [sources, setSources] = React.useState<Record<string, string>>({})
  const [fields, setFields] = React.useState<FieldsState>(EMPTY_FIELDS)
  const [clearOpen, setClearOpen] = React.useState(false)
  const [clearBusy, setClearBusy] = React.useState(false)

  // 打开时拉取四级链解析结果 + 用户级覆盖 JSON 回显
  React.useEffect(() => {
    if (!open || !user) return
    let cancelled = false
    setLoading(true)
    setEffective(null)
    setFields(EMPTY_FIELDS())
    getUserTokenPolicyAction({ id: user.id })
      .then((res) => {
        if (cancelled) return
        if (res.code !== 0) {
          toast.error(res.msg)
          return
        }
        setEffective((res.data?.effective as Record<string, unknown>) ?? null)
        setSources((res.data?.sources as Record<string, string>) ?? {})
        setFields(prefillFromSparse((res.data?.userPolicy as PolicySparse | null) ?? null))
      })
      .catch((e) => !cancelled && toast.error(e instanceof Error ? e.message : "加载策略失败"))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, user])

  const isSuperAdmin = user?.role === "SUPER_ADMIN"
  const count = overrideCount(fields)

  const save = async () => {
    if (!user) return
    setSaving(true)
    try {
      const res = await setUserTokenPolicyAction({ id: user.id, tokenPolicy: buildSparse(fields) })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(count > 0 ? `已保存用户级覆盖 ${count} 项` : "已保存（无覆盖字段，完全继承）")
      onOpenChange(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const doClear = async () => {
    if (!user) return
    setClearBusy(true)
    try {
      const res = await setUserTokenPolicyAction({ id: user.id, tokenPolicy: null })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success("已清除全部用户级覆盖（完全继承组级/全局）")
      setClearOpen(false)
      onOpenChange(false)
      router.refresh()
    } finally {
      setClearBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && !clearBusy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-teal-600" />
            API-Key 策略 · {user?.username || ""}
            {user?.displayName ? <span className="text-sm text-muted-foreground font-normal">（{user.displayName}）</span> : null}
          </DialogTitle>
          <DialogDescription>
            策略链四级：每 Key 独立限流 {'>'} 用户级覆盖 {'>'} 组级基线 {'>'} 全局默认；用户级仅覆盖勾选字段，其余继续继承。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 解析策略链中…
          </div>
        ) : (
          <ScrollArea className="max-h-[64vh] pr-2">
            <div className="space-y-4">
              {isSuperAdmin && (
                <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>该用户是超级管理员：平台豁免，不受 Token 策略限制（覆盖设置仅落库、不参与解析）。</span>
                </div>
              )}

              {/* ---- 当前生效策略（只读） ---- */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">当前生效策略（只读 · 四级链解析结果）</Label>
                </div>
                <div className="rounded-md border divide-y">
                  {[
                    { label: "允许创建 API-Key", value: fmtEffective.bool(effective?.allowCreate), src: sources.allowCreate },
                    { label: "单用户最大数量", value: fmtEffective.num(effective?.maxPerUser, "个", "禁止持有"), src: sources.maxPerUser },
                    { label: "允许永久 Key", value: fmtEffective.bool(effective?.allowPermanent), src: sources.allowPermanent },
                    { label: "最大有效时长", value: fmtEffective.num(effective?.maxLifetimeDays, "天", "不限"), src: sources.maxLifetimeDays },
                    { label: "每分钟调用上限", value: fmtEffective.num(effective?.rateLimitPerMin, "次/分", "不限"), src: sources.rateLimitPerMin },
                    { label: "允许的功能范围", value: fmtEffective.scopes(effective?.allowedScopes), src: sources.allowedScopes },
                  ].map((r) => (
                    <div key={r.label} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <span className="text-muted-foreground shrink-0">{r.label}</span>
                      <span className="flex items-center gap-2 min-w-0 justify-end">
                        <span className="truncate max-w-56 text-right" title={String(r.value)}>{r.value}</span>
                        <SourceBadge src={r.src} />
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              {/* ---- 用户级覆盖设置 ---- */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">用户级覆盖设置</Label>
                  <div className="flex items-center gap-2">
                    {count > 0 && <Badge className="bg-teal-600 hover:bg-teal-600 text-[10px]">覆盖 {count} 项</Badge>}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900"
                      disabled={saving || count === 0}
                      onClick={() => setClearOpen(true)}
                      title="tokenPolicy 置 null，该用户完全继承组级/全局策略"
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> 清除全部覆盖
                    </Button>
                  </div>
                </div>
                <PolicyFields fields={fields} setFields={setFields} mode="user" />
              </section>
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={save} disabled={saving || loading} className="bg-teal-600 hover:bg-teal-700">
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            保存覆盖
          </Button>
        </DialogFooter>

        <ConfirmDialog
          open={clearOpen}
          onOpenChange={(v) => !clearBusy && setClearOpen(v)}
          title="清除全部用户级覆盖"
          description={`确认清除用户 ${user?.username || ""} 的全部 Token 策略覆盖（${count} 项）？\n· tokenPolicy 将置为 null，该用户完全继承组级/全局策略\n· 组级与全局配置不受影响\n· 操作写入审计日志`}
          destructive
          confirmText="确认清除"
          loading={clearBusy}
          onConfirm={doClear}
        />
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 2. 组级 Token 策略对话框（组管理行菜单入口）
// ============================================================

export function GroupTokenPolicyDialog({
  group, open, onOpenChange,
}: {
  group: { id: string; name: string } | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [groupPolicy, setGroupPolicy] = React.useState<PolicySparse | null>(null)
  const [affectedMembers, setAffectedMembers] = React.useState(0)
  const [fields, setFields] = React.useState<FieldsState>(EMPTY_FIELDS)
  const [clearOpen, setClearOpen] = React.useState(false)
  const [clearBusy, setClearBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open || !group) return
    let cancelled = false
    setLoading(true)
    setFields(EMPTY_FIELDS())
    getGroupTokenPolicyAction({ id: group.id })
      .then((res) => {
        if (cancelled) return
        if (res.code !== 0) {
          toast.error(res.msg)
          return
        }
        const gp = (res.data?.groupPolicy as PolicySparse | null) ?? null
        setGroupPolicy(gp)
        setAffectedMembers(res.data?.affectedMembers ?? 0)
        setFields(prefillFromSparse(gp))
      })
      .catch((e) => !cancelled && toast.error(e instanceof Error ? e.message : "加载组级策略失败"))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, group])

  const count = overrideCount(fields)
  const hadPolicy = groupPolicy !== null

  const save = async () => {
    if (!group) return
    setSaving(true)
    try {
      const res = await setGroupTokenPolicyAction({ id: group.id, tokenPolicy: buildSparse(fields) })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success(count > 0 ? `已保存组级基线 ${count} 项（影响成员 ${affectedMembers} 人）` : "已保存（无基线字段，成员走用户级/全局）")
      onOpenChange(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const doClear = async () => {
    if (!group) return
    setClearBusy(true)
    try {
      const res = await setGroupTokenPolicyAction({ id: group.id, tokenPolicy: null })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success("已清除组级策略（成员走用户级/全局）")
      setClearOpen(false)
      onOpenChange(false)
      router.refresh()
    } finally {
      setClearBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && !clearBusy && onOpenChange(v)}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-500" />
            组级 API-Key 策略 · {group?.name || ""}
          </DialogTitle>
          <DialogDescription>
            组级为组内成员默认基线；用户级可覆盖收紧；数值多组取最严格（数量/时长/限流取最小，布尔禁止优先，范围取交集）。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载组级策略中…
          </div>
        ) : (
          <ScrollArea className="max-h-[64vh] pr-2">
            <div className="space-y-4">
              {/* 影响面提示 */}
              <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>
                  当前组内成员 <strong className="tabular-nums">{affectedMembers}</strong> 人将以此处勾选字段为默认基线；
                  {hadPolicy ? "组级已有基线设置" : "组级暂未设置任何基线"}（成员用户级未覆盖的字段走本组，再走全局默认）。
                </span>
              </div>

              {/* ---- 组级基线设置 ---- */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">组级基线设置</Label>
                  <div className="flex items-center gap-2">
                    {count > 0 && <Badge className="bg-amber-500 hover:bg-amber-500 text-[10px]">基线 {count} 项</Badge>}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-900"
                      disabled={saving || count === 0}
                      onClick={() => setClearOpen(true)}
                      title="tokenPolicy 置 null，成员完全走用户级/全局策略"
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> 清除组级策略
                    </Button>
                  </div>
                </div>
                <PolicyFields fields={fields} setFields={setFields} mode="group" />
              </section>
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={save} disabled={saving || loading} className="bg-teal-600 hover:bg-teal-700">
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            保存组级基线
          </Button>
        </DialogFooter>

        <ConfirmDialog
          open={clearOpen}
          onOpenChange={(v) => !clearBusy && setClearOpen(v)}
          title="清除组级策略"
          description={`确认清除用户组 ${group?.name || ""} 的全部 API-Key 策略基线（${count} 项）？\n· tokenPolicy 将置为 null，组内 ${affectedMembers} 名成员走各自用户级覆盖与全局默认\n· 用户级覆盖与全局配置不受影响\n· 操作写入审计日志`}
          destructive
          confirmText="确认清除"
          loading={clearBusy}
          onConfirm={doClear}
        />
      </DialogContent>
    </Dialog>
  )
}
