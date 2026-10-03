"use client"

// 策略下发中心交互组件：
//   · 策略包编辑（内网/安全位置三态开关 + 域名黑白名单 + IP 黑白名单 + 模板加载/保存）
//   · 目标选择（用户组 + 用户，支持搜索/全选）
//   · 下发确认 → 逐目标结果弹窗
//   · 批次历史（状态徽章/影响面/一键回滚/详情展开）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Layers, Users, ShieldCheck, Undo2, Send, Search, Loader2, Save, Trash2, ChevronDown, ChevronRight, X,
  Network, Lock, Globe, CircleSlash, CheckCircle2, Ban, Info, Clock, Timer, CalendarClock, XCircle, Plug, MonitorSmartphone,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/shared/confirm"
import { cn } from "@/lib/utils"
import {
  deployPolicyAction, rollbackDeploymentAction, cancelScheduledDeploymentAction,
  savePolicyTemplateAction, deletePolicyTemplateAction,
} from "@/server/actions/policy-deployments"

export interface DeploymentRow {
  id: string
  name: string
  note: string | null
  status: string
  effectiveMode: string
  effectiveAt: string | null
  activatedAt: string | null
  cancelledAt: string | null
  totalTargets: number
  successTargets: number
  failedTargets: number
  createdByUsername: string
  deployedAt: string | null
  rolledBackAt: string | null
  bundle: Record<string, unknown>
  results: Array<{ targetId: string; targetType: string; targetName: string; ok: boolean; reason?: string }> | null
}

export interface TemplateRow {
  id: string
  name: string
  description: string | null
  builtin: boolean
  bundle: Record<string, unknown> | null
}

export interface TargetOptionGroup { id: string; name: string; memberCount: number; path: string }
export interface TargetOptionUser { id: string; username: string; displayName: string | null; role: string; groupNames: string[] }
export interface TargetOptionWorkspace { id: string; name: string; ownerUsername: string; status: string; mode: string }

interface Props {
  deployments: DeploymentRow[]
  templates: TemplateRow[]
  targetGroups: TargetOptionGroup[]
  targetUsers: TargetOptionUser[]
  targetWorkspaces: TargetOptionWorkspace[]
  stats: { title: string; value: number; sub: string; icon: React.ReactNode; tone?: "default" | "warning" | "success" | "danger" }[]
}

type TriState = "keep" | "allow" | "deny"

interface BundleForm {
  internal: TriState
  secure: TriState
  domainEnabled: boolean
  domainMode: "BLACKLIST" | "WHITELIST"
  domainText: string
  ipEnabled: boolean
  ipMode: "BLACKLIST" | "WHITELIST"
  ipText: string
  endpointEnabled: boolean
  endpointMode: "BLACKLIST" | "WHITELIST"
  endpointText: string
  fileEnabled: boolean
  fileDownload: TriState
  fileUpload: TriState
  fileScheme: TriState
}

const DEFAULT_FORM: BundleForm = {
  internal: "keep",
  secure: "keep",
  domainEnabled: false,
  domainMode: "BLACKLIST",
  domainText: "",
  ipEnabled: false,
  ipMode: "BLACKLIST",
  ipText: "",
  endpointEnabled: false,
  endpointMode: "BLACKLIST",
  endpointText: "",
  fileEnabled: false,
  fileDownload: "keep",
  fileUpload: "keep",
  fileScheme: "keep",
}

function triValue(t: TriState): boolean | null {
  return t === "keep" ? null : t === "allow"
}

function TriToggle({ label, desc, value, onChange }: { label: string; desc: string; value: TriState; onChange: (v: TriState) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground truncate">{desc}</p>
      </div>
      <div className="flex items-center rounded-lg border p-0.5 shrink-0 ml-3">
        {(["keep", "deny", "allow"] as TriState[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              value === v
                ? v === "allow"
                  ? "bg-emerald-600 text-white"
                  : v === "deny"
                    ? "bg-red-600 text-white"
                    : "bg-slate-600 text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "keep" ? "不修改" : v === "deny" ? "禁止" : "允许"}
          </button>
        ))}
      </div>
    </div>
  )
}

function bundleSummary(b: Record<string, unknown>): string[] {
  const parts: string[] = []
  const a = b.allowInternalNetwork
  const s = b.allowSecureLocationAccess
  if (a === true) parts.push("允许内网")
  else if (a === false) parts.push("禁止内网")
  if (s === true) parts.push("允许安全位置")
  else if (s === false) parts.push("禁止安全位置")
  const d = b.domainRules as { mode?: string; patterns?: string[] } | null
  if (d) parts.push(d.mode === "WHITELIST" ? `域名白名单 ${d.patterns?.length || 0} 项` : `域名黑名单 ${d.patterns?.length || 0} 项`)
  const i = b.ipRules as { mode?: string; values?: string[] } | null
  if (i) parts.push(i.mode === "WHITELIST" ? `IP 白名单 ${i.values?.length || 0} 项` : `IP 黑名单 ${i.values?.length || 0} 项`)
  const e = b.endpointRules as { mode?: string; patterns?: string[] } | null
  const f = b.fileRules as { allowDownload?: boolean; allowUpload?: boolean; allowFileScheme?: boolean } | null
  if (e) parts.push(e.mode === "WHITELIST" ? `端点放行例外 ${e.patterns?.length || 0} 项` : `端点封禁 ${e.patterns?.length || 0} 项`)
  if (f) {
    const fp: string[] = []
    if (f.allowDownload === false) fp.push("禁下载")
    if (f.allowUpload === false) fp.push("禁上传")
    if (f.allowFileScheme === true) fp.push("开 file://")
    else if (f.allowDownload !== false && f.allowUpload !== false) fp.push("禁 file://")
    if (fp.length > 0) parts.push(`文件限制：${fp.join("/")}`)
  }
  return parts
}

const statusBadge = (status: string) => {
  switch (status) {
    case "SUCCESS": return <Badge className="bg-emerald-600 hover:bg-emerald-600">全部成功</Badge>
    case "PARTIAL": return <Badge className="bg-amber-600 hover:bg-amber-600">部分成功</Badge>
    case "FAILED": return <Badge className="bg-red-600 hover:bg-red-600">失败</Badge>
    case "RUNNING": return <Badge className="bg-teal-600 hover:bg-teal-600">执行中</Badge>
    case "PENDING": return <Badge className="bg-sky-600 hover:bg-sky-600"><Clock className="h-3 w-3 mr-1" />待生效</Badge>
    case "CANCELLED": return <Badge variant="outline" className="border-slate-400/60 text-slate-500"><XCircle className="h-3 w-3 mr-1" />已取消</Badge>
    case "ROLLED_BACK": return <Badge variant="outline" className="border-violet-400/50 text-violet-500">已回滚</Badge>
    default: return <Badge variant="outline">{status}</Badge>
  }
}

export function PolicyDeployCenter(props: Props) {
  const router = useRouter()
  const [form, setForm] = React.useState<BundleForm>(DEFAULT_FORM)
  const [selectedGroups, setSelectedGroups] = React.useState<Set<string>>(new Set())
  const [selectedUsers, setSelectedUsers] = React.useState<Set<string>>(new Set())
  const [selectedWorkspaces, setSelectedWorkspaces] = React.useState<Set<string>>(new Set())
  const [targetSearch, setTargetSearch] = React.useState("")
  const [deployName, setDeployName] = React.useState("")
  const [deployNote, setDeployNote] = React.useState("")
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState("")
  const [resultData, setResultData] = React.useState<{
    status: string; total: number; success: number; failed: number
    failures: { target: string; reason: string }[]; affectedUsers: number
    scheduled: boolean; effectiveAt: string | null
  } | null>(null)
  const [rollingBack, setRollingBack] = React.useState<DeploymentRow | null>(null)
  const [cancelling, setCancelling] = React.useState<DeploymentRow | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  // r25-b 批次历史关键词搜索：名称/备注/操作人/状态（客户端实时过滤）
  const [deployFilter, setDeployFilter] = React.useState("")
  const filteredDeployments = React.useMemo(() => {
    const kw = deployFilter.trim().toLowerCase()
    if (!kw) return props.deployments
    return props.deployments.filter((d) =>
      d.name.toLowerCase().includes(kw)
      || (d.note || "").toLowerCase().includes(kw)
      || d.createdByUsername.toLowerCase().includes(kw)
      || d.status.toLowerCase().includes(kw)
      || (d.results || []).some((r) => r.targetName.toLowerCase().includes(kw)))
  }, [deployFilter, props.deployments])
  const [saveTplOpen, setSaveTplOpen] = React.useState(false)
  const [tplName, setTplName] = React.useState("")
  const [tplDesc, setTplDesc] = React.useState("")

  // —— 定时生效 ——
  const [effectiveMode, setEffectiveMode] = React.useState<"IMMEDIATE" | "SCHEDULED">("IMMEDIATE")
  const [effectiveAt, setEffectiveAt] = React.useState("") // datetime-local

  const effectiveAtLocalIso = React.useMemo(() => {
    if (effectiveMode !== "SCHEDULED" || !effectiveAt) return null
    return new Date(effectiveAt).toISOString()
  }, [effectiveMode, effectiveAt])

  const applyPreset = (minutes: number) => {
    const d = new Date(Date.now() + minutes * 60_000)
    setEffectiveAt(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)
  }

  const totalTargets = selectedGroups.size + selectedUsers.size + selectedWorkspaces.size
  const affectedEstimate = React.useMemo(() => {
    const groupMemberSum = props.targetGroups
      .filter((g) => selectedGroups.has(g.id))
      .reduce((acc, g) => acc + g.memberCount, 0)
    return groupMemberSum + selectedUsers.size
  }, [selectedGroups, selectedUsers, props.targetGroups])

  const filteredGroups = props.targetGroups.filter((g) =>
    !targetSearch || g.name.includes(targetSearch) || g.path.includes(targetSearch),
  )
  const filteredUsers = props.targetUsers.filter((u) =>
    !targetSearch || u.username.includes(targetSearch) || (u.displayName || "").includes(targetSearch) || u.groupNames.some((n) => n.includes(targetSearch)),
  )
  const filteredWorkspaces = props.targetWorkspaces.filter((w) =>
    !targetSearch || w.name.includes(targetSearch) || w.ownerUsername.includes(targetSearch),
  )

  const buildBundle = () => ({
    allowInternalNetwork: triValue(form.internal),
    allowSecureLocationAccess: triValue(form.secure),
    domainRules: form.domainEnabled
      ? { mode: form.domainMode, patterns: form.domainText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : null,
    ipRules: form.ipEnabled
      ? { mode: form.ipMode, values: form.ipText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : null,
    endpointRules: form.endpointEnabled
      ? { mode: form.endpointMode, patterns: form.endpointText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : null,
    fileRules: form.fileEnabled && (triValue(form.fileDownload) !== null || triValue(form.fileUpload) !== null || triValue(form.fileScheme) !== null)
      ? {
          allowDownload: triValue(form.fileDownload) !== null ? triValue(form.fileDownload)! : true,
          allowUpload: triValue(form.fileUpload) !== null ? triValue(form.fileUpload)! : true,
          allowFileScheme: triValue(form.fileScheme) !== null ? triValue(form.fileScheme)! : false,
        }
      : null,
  })

  const hasContent = () =>
    triValue(form.internal) !== null || triValue(form.secure) !== null || form.domainEnabled || form.ipEnabled || form.endpointEnabled
    || (form.fileEnabled && (triValue(form.fileDownload) !== null || triValue(form.fileUpload) !== null || triValue(form.fileScheme) !== null))

  const loadTemplate = (tpl: TemplateRow) => {
    const b = (tpl.bundle || {}) as Record<string, unknown>
    setForm({
      internal: b.allowInternalNetwork === true ? "allow" : b.allowInternalNetwork === false ? "deny" : "keep",
      secure: b.allowSecureLocationAccess === true ? "allow" : b.allowSecureLocationAccess === false ? "deny" : "keep",
      domainEnabled: !!b.domainRules,
      domainMode: ((b.domainRules as { mode?: string } | null)?.mode === "WHITELIST" ? "WHITELIST" : "BLACKLIST"),
      domainText: ((b.domainRules as { patterns?: string[] } | null)?.patterns || []).join("\n"),
      ipEnabled: !!b.ipRules,
      ipMode: ((b.ipRules as { mode?: string } | null)?.mode === "WHITELIST" ? "WHITELIST" : "BLACKLIST"),
      ipText: ((b.ipRules as { values?: string[] } | null)?.values || []).join("\n"),
      endpointEnabled: !!b.endpointRules,
      endpointMode: ((b.endpointRules as { mode?: string } | null)?.mode === "WHITELIST" ? "WHITELIST" : "BLACKLIST"),
      endpointText: ((b.endpointRules as { patterns?: string[] } | null)?.patterns || []).join("\n"),
      fileEnabled: !!b.fileRules,
      fileDownload: (b.fileRules as { allowDownload?: boolean } | null)?.allowDownload === true ? "allow" : (b.fileRules as { allowDownload?: boolean } | null)?.allowDownload === false ? "deny" : "keep",
      fileUpload: (b.fileRules as { allowUpload?: boolean } | null)?.allowUpload === true ? "allow" : (b.fileRules as { allowUpload?: boolean } | null)?.allowUpload === false ? "deny" : "keep",
      fileScheme: (b.fileRules as { allowFileScheme?: boolean } | null)?.allowFileScheme === true ? "allow" : (b.fileRules as { allowFileScheme?: boolean } | null)?.allowFileScheme === false ? "deny" : "keep",
    })
    toast.success(`已加载模板「${tpl.name}」`)
  }

  const doDeploy = async () => {
    if (effectiveMode === "SCHEDULED" && !effectiveAt) {
      toast.error("请选择定时生效时间")
      return
    }
    setBusy("deploy")
    try {
      const res = await deployPolicyAction({
        name: deployName,
        note: deployNote || null,
        bundle: buildBundle(),
        targetGroupIds: [...selectedGroups],
        targetUserIds: [...selectedUsers],
        targetWorkspaceIds: [...selectedWorkspaces],
        effectiveAt: effectiveAtLocalIso,
      })
      if (res.code === 0 && res.data) {
        setResultData({
          status: res.data.status,
          total: res.data.totalTargets,
          success: res.data.successTargets,
          failed: res.data.failedTargets,
          failures: res.data.failures,
          affectedUsers: res.data.affectedUsers,
          scheduled: res.data.scheduled,
          effectiveAt: res.data.effectiveAt,
        })
        setConfirmOpen(false)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "下发失败")
    } finally {
      setBusy("")
    }
  }

  const doCancel = async () => {
    if (!cancelling) return
    setBusy("cancel")
    try {
      const res = await cancelScheduledDeploymentAction({ id: cancelling.id })
      if (res.code === 0) {
        toast.success(`已取消定时批次「${res.data?.name || cancelling.name}」（策略未发生任何变更）`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取消失败")
    } finally {
      setBusy("")
      setCancelling(null)
    }
  }

  const doRollback = async () => {
    if (!rollingBack) return
    setBusy("rollback")
    try {
      const res = await rollbackDeploymentAction({ id: rollingBack.id })
      if (res.code === 0) {
        toast.success(`已回滚 ${res.data?.rolledBackTargets ?? 0} 个目标的前置状态`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "回滚失败")
    } finally {
      setBusy("")
      setRollingBack(null)
    }
  }

  const saveTemplate = async () => {
    if (!tplName.trim()) return toast.error("请填写模板名称")
    setBusy("saveTpl")
    try {
      const res = await savePolicyTemplateAction({ name: tplName.trim(), description: tplDesc.trim() || null, bundle: buildBundle() })
      if (res.code === 0) {
        toast.success("模板已保存")
        setSaveTplOpen(false)
        setTplName("")
        setTplDesc("")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusy("")
    }
  }

  const deleteTemplate = async (id: string, name: string) => {
    setBusy(`delTpl-${id}`)
    try {
      const res = await deletePolicyTemplateAction({ id })
      if (res.code === 0) {
        toast.success(`模板「${name}」已删除`)
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">策略下发中心</h1>
        <p className="text-sm text-muted-foreground mt-1">
          按【用户 / 用户组 / 单沙箱】三级定向批量下发访问控制策略包（内网访问 · 容器安全位置 · 域名黑白名单 · IP 黑白名单 · 端点级精确限制 · 文件限制），支持定时生效；全量前置快照、一键回滚、逐目标失败隔离；沙箱目标即时重刷策略文件并重启浏览器进程生效
        </p>
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-2 lg:grid-cols-6">
        {props.stats.map((s) => (
          <div key={s.title} className={cn("rounded-lg border p-4 flex items-center gap-3", s.tone === "warning" && "border-amber-300/60 bg-amber-50/50 dark:border-amber-800/50 dark:bg-amber-950/20")}>
            <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center shrink-0", s.tone === "warning" ? "bg-amber-600/10 text-amber-600" : "bg-teal-600/10 text-teal-600")}>{s.icon}</div>
            <div className="min-w-0">
              <p className="text-xl font-semibold leading-none">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1 truncate">{s.title} · {s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-5 min-w-0">
        {/* ===== 左：策略包编辑 ===== */}
        <div className="lg:col-span-3 space-y-4 min-w-0">
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5"><Network className="h-4 w-4 text-teal-600" /> 网络访问开关</h2>
              <span className="text-[11px] text-muted-foreground">三态：不修改 / 禁止 / 允许</span>
            </div>
            <TriToggle
              label="允许访问内网"
              desc="RFC1918 私有网段 / 链路本地 / 云元数据 / mDNS"
              value={form.internal}
              onChange={(v) => setForm({ ...form, internal: v })}
            />
            <TriToggle
              label="允许访问容器内安全位置"
              desc="本机 CDP/VNC 端口、file://、chrome:// 管理页、平台内部端点"
              value={form.secure}
              onChange={(v) => setForm({ ...form, secure: v })}
            />
          </div>

          {/* 域名黑白名单 */}
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                {form.domainMode === "WHITELIST" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleSlash className="h-4 w-4 text-red-600" />}
                域名黑白名单
              </h2>
              <div className="flex items-center gap-2">
                <Select value={form.domainMode} onValueChange={(v) => setForm({ ...form, domainMode: v as "BLACKLIST" | "WHITELIST" })} disabled={!form.domainEnabled}>
                  <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BLACKLIST">黑名单（阻断）</SelectItem>
                    <SelectItem value="WHITELIST">白名单（严格放行）</SelectItem>
                  </SelectContent>
                </Select>
                <Switch checked={form.domainEnabled} onCheckedChange={(v) => setForm({ ...form, domainEnabled: v })} />
              </div>
            </div>
            {form.domainEnabled ? (
              <>
                <Textarea
                  value={form.domainText}
                  onChange={(e) => setForm({ ...form, domainText: e.target.value })}
                  placeholder={form.domainMode === "WHITELIST" ? "*.company.example&#10;docs.company.example（仅这些域名可访问，其余全部阻断）" : "*.gambling.example&#10;malware.test（这些域名被阻断）"}
                  className="font-mono text-xs min-h-24"
                  disabled={false}
                />
                <p className="text-[11px] text-muted-foreground">
                  每行一个，支持通配符；<b>替换式下发</b>：目标作用域内原有规则将被本批规则替换（原规则进入快照可回滚）
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">关闭时不修改目标现有域名规则</p>
            )}
          </div>

          {/* IP 黑白名单 */}
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                {form.ipMode === "WHITELIST" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Ban className="h-4 w-4 text-red-600" />}
                IP 黑白名单（会话出口侧）
              </h2>
              <div className="flex items-center gap-2">
                <Select value={form.ipMode} onValueChange={(v) => setForm({ ...form, ipMode: v as "BLACKLIST" | "WHITELIST" })} disabled={!form.ipEnabled}>
                  <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BLACKLIST">黑名单</SelectItem>
                    <SelectItem value="WHITELIST">白名单</SelectItem>
                  </SelectContent>
                </Select>
                <Switch checked={form.ipEnabled} onCheckedChange={(v) => setForm({ ...form, ipEnabled: v })} />
              </div>
            </div>
            {form.ipEnabled ? (
              <>
                <Textarea
                  value={form.ipText}
                  onChange={(e) => setForm({ ...form, ipText: e.target.value })}
                  placeholder="203.0.113.0/24&#10;198.51.100.7"
                  className="font-mono text-xs min-h-20"
                />
                <p className="text-[11px] text-muted-foreground">每行一个 IP 或 CIDR；同样为替换式下发（快照可回滚）</p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">关闭时不修改目标现有 IP 规则</p>
            )}
          </div>

          {/* 端点级精确限制（host:port） */}
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                {form.endpointMode === "WHITELIST" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Plug className="h-4 w-4 text-red-600" />}
                端点级精确限制（host:port）
              </h2>
              <div className="flex items-center gap-2">
                <Select value={form.endpointMode} onValueChange={(v) => setForm({ ...form, endpointMode: v as "BLACKLIST" | "WHITELIST" })} disabled={!form.endpointEnabled}>
                  <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BLACKLIST">封禁（精确拦截）</SelectItem>
                    <SelectItem value="WHITELIST">放行例外（白例外）</SelectItem>
                  </SelectContent>
                </Select>
                <Switch checked={form.endpointEnabled} onCheckedChange={(v) => setForm({ ...form, endpointEnabled: v })} />
              </div>
            </div>
            {form.endpointEnabled ? (
              <>
                <Textarea
                  value={form.endpointText}
                  onChange={(e) => setForm({ ...form, endpointText: e.target.value })}
                  placeholder={"10.0.0.5:8080&#10;192.168.1.0/24:443&#10;*.corp.example:22&#10;127.0.0.1:9222&#10;[::1]:5900（每行一个，host:port 精确到端口）"}
                  className="font-mono text-xs min-h-20"
                />
                <p className="text-[11px] text-muted-foreground">
                  支持 IP/域名/CIDR + 精确端口；<code className="mx-0.5">host:*</code> 任意端口、<code className="mx-0.5">host:80-90</code> 端口区间、<code className="mx-0.5">[::1]:port</code> IPv6。
                  内网整体放行时仍可封指定端点；127.0.0.1 / localhost 等环回地址在禁止内网时全端口拦截
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">关闭时不修改目标现有端点规则</p>
            )}
          </div>

          {/* 文件限制（下载/上传/file://） */}
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <MonitorSmartphone className="h-4 w-4 text-teal-600" />
                文件访问限制（下载 / 上传 / file://）
              </h2>
              <Switch checked={form.fileEnabled} onCheckedChange={(v) => setForm({ ...form, fileEnabled: v })} />
            </div>
            {form.fileEnabled ? (
              <div className="space-y-2">
                <TriToggle
                  label="允许文件下载"
                  desc="禁止 → Chromium DownloadRestrictions=2 全禁下载"
                  value={form.fileDownload}
                  onChange={(v) => setForm({ ...form, fileDownload: v })}
                />
                <TriToggle
                  label="允许文件上传"
                  desc="禁止 → 文件拾取器封禁（AllowFileSelectionDialogs=false）"
                  value={form.fileUpload}
                  onChange={(v) => setForm({ ...form, fileUpload: v })}
                />
                <TriToggle
                  label="允许 file:// 本地访问"
                  desc="系统默认禁止；开启需明确放行（沙箱内本地文件浏览）"
                  value={form.fileScheme}
                  onChange={(v) => setForm({ ...form, fileScheme: v })}
                />
                <p className="text-[11px] text-muted-foreground">
                  三项均为「不修改=保持目标现有配置」；对运行中沙箱目标即时重刷策略文件并重启浏览器进程生效
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">关闭时不修改目标现有文件限制配置</p>
            )}
          </div>

          {/* 模板 */}
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5"><Layers className="h-4 w-4 text-teal-600" /> 策略模板</h2>
              <Button size="sm" variant="outline" onClick={() => setSaveTplOpen(true)} disabled={!hasContent()}>
                <Save className="h-3.5 w-3.5 mr-1" /> 存为模板
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {props.templates.length === 0 && <p className="text-xs text-muted-foreground">暂无模板</p>}
              {props.templates.map((t) => (
                <div key={t.id} className="flex items-center gap-1 rounded-lg border bg-muted/30 pl-3 pr-1 py-1">
                  <button type="button" className="text-xs hover:text-teal-600 transition-colors" onClick={() => loadTemplate(t)} title={t.description || t.name}>
                    {t.builtin && <span className="text-teal-600 mr-1">内置</span>}{t.name}
                  </button>
                  {!t.builtin && (
                    <button
                      type="button"
                      className="h-5 w-5 rounded inline-flex items-center justify-center text-muted-foreground hover:text-red-600"
                      onClick={() => deleteTemplate(t.id, t.name)}
                      title="删除模板"
                      disabled={busy === `delTpl-${t.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ===== 右：目标选择 ===== */}
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-1.5"><Users className="h-4 w-4 text-teal-600" /> 下发目标</h2>
              <Badge variant="outline" className="border-teal-600/40 text-teal-600">
                已选 {totalTargets} · 影响约 {affectedEstimate} 用户
              </Badge>
            </div>
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={targetSearch} onChange={(e) => setTargetSearch(e.target.value)} placeholder="搜索组 / 用户名 / 组路径" className="h-8 pl-8 text-xs" />
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground flex items-center justify-between">
                <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> 用户组（{filteredGroups.length}）</span>
                <button
                  className="text-teal-600 hover:underline"
                  onClick={() => {
                    if (selectedGroups.size === filteredGroups.length) setSelectedGroups(new Set())
                    else setSelectedGroups(new Set(filteredGroups.map((g) => g.id)))
                  }}
                >全选/清空</button>
              </p>
              <ScrollArea className="h-40 rounded-lg border">
                <div className="p-2 space-y-0.5">
                  {filteredGroups.map((g) => {
                    const checked = selectedGroups.has(g.id)
                    return (
                      <label key={g.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer text-xs hover:bg-muted/50", checked && "bg-teal-600/10")}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedGroups)
                            if (checked) next.delete(g.id)
                            else next.add(g.id)
                            setSelectedGroups(next)
                          }}
                          className="accent-teal-600 h-3.5 w-3.5"
                        />
                        <span className="font-medium truncate">{g.name}</span>
                        <span className="text-muted-foreground truncate hidden sm:inline">{g.path !== g.name ? g.path : ""}</span>
                        <span className="ml-auto text-muted-foreground shrink-0">{g.memberCount}人</span>
                      </label>
                    )
                  })}
                  {filteredGroups.length === 0 && <p className="text-xs text-muted-foreground p-2">无匹配组</p>}
                </div>
              </ScrollArea>

              <p className="text-[11px] font-medium text-muted-foreground flex items-center justify-between pt-1">
                <span className="flex items-center gap-1"><Users className="h-3 w-3" /> 用户（{filteredUsers.length}）</span>
                <button
                  className="text-teal-600 hover:underline"
                  onClick={() => {
                    if (selectedUsers.size === filteredUsers.length) setSelectedUsers(new Set())
                    else setSelectedUsers(new Set(filteredUsers.map((u) => u.id)))
                  }}
                >全选/清空</button>
              </p>
              <ScrollArea className="h-40 rounded-lg border">
                <div className="p-2 space-y-0.5">
                  {filteredUsers.map((u) => {
                    const checked = selectedUsers.has(u.id)
                    return (
                      <label key={u.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer text-xs hover:bg-muted/50", checked && "bg-teal-600/10")}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedUsers)
                            if (checked) next.delete(u.id)
                            else next.add(u.id)
                            setSelectedUsers(next)
                          }}
                          className="accent-teal-600 h-3.5 w-3.5"
                        />
                        <span className="font-medium truncate">{u.displayName || u.username}</span>
                        <span className="text-muted-foreground">@{u.username}</span>
                        <span className="ml-auto text-muted-foreground shrink-0 truncate hidden sm:inline">{u.groupNames[0] || "未分组"}</span>
                      </label>
                    )
                  })}
                  {filteredUsers.length === 0 && <p className="text-xs text-muted-foreground p-2">无匹配用户</p>}
                </div>
              </ScrollArea>

              <p className="text-[11px] font-medium text-muted-foreground flex items-center justify-between pt-1">
                <span className="flex items-center gap-1"><MonitorSmartphone className="h-3 w-3" /> 单沙箱（{filteredWorkspaces.length}）—— 最高优先定向</span>
                <button
                  className="text-teal-600 hover:underline"
                  onClick={() => {
                    if (selectedWorkspaces.size === filteredWorkspaces.length) setSelectedWorkspaces(new Set())
                    else setSelectedWorkspaces(new Set(filteredWorkspaces.map((w) => w.id)))
                  }}
                >全选/清空</button>
              </p>
              <ScrollArea className="h-40 rounded-lg border">
                <div className="p-2 space-y-0.5">
                  {filteredWorkspaces.map((w) => {
                    const checked = selectedWorkspaces.has(w.id)
                    return (
                      <label key={w.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer text-xs hover:bg-muted/50", checked && "bg-teal-600/10")}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedWorkspaces)
                            if (checked) next.delete(w.id)
                            else next.add(w.id)
                            setSelectedWorkspaces(next)
                          }}
                          className="accent-teal-600 h-3.5 w-3.5"
                        />
                        <span className="font-medium truncate">{w.name}</span>
                        <span className="text-muted-foreground">@{w.ownerUsername}</span>
                        <span className={cn("ml-auto text-[10px] shrink-0", w.status === "RUNNING" ? "text-emerald-600" : "text-muted-foreground")}>{w.status}</span>
                      </label>
                    )
                  })}
                  {filteredWorkspaces.length === 0 && <p className="text-xs text-muted-foreground p-2">无匹配沙箱（仅 NoVNC 重度沙箱支持定向下发）</p>}
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* 下发执行 */}
          <div className="rounded-xl border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">下发批次名称</Label>
              <Input value={deployName} onChange={(e) => setDeployName(e.target.value)} placeholder="如：研发部 Q4 网络策略收紧" className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">备注（可选）</Label>
              <Input value={deployNote} onChange={(e) => setDeployNote(e.target.value)} placeholder="下发原因 / 工单号" className="h-8 text-xs" />
            </div>

            {/* —— 定时生效 —— */}
            <div className="rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50/60 dark:bg-sky-950/25 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs flex items-center gap-1.5 text-sky-800 dark:text-sky-300">
                  <CalendarClock className="h-3.5 w-3.5" />
                  生效方式
                </Label>
                <div className="flex items-center rounded-lg border p-0.5">
                  {(["IMMEDIATE", "SCHEDULED"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setEffectiveMode(m)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        effectiveMode === m ? "bg-sky-600 text-white" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m === "IMMEDIATE" ? "立即生效" : "定时生效"}
                    </button>
                  ))}
                </div>
              </div>
              {effectiveMode === "SCHEDULED" && (
                <div className="space-y-2">
                  <Input
                    type="datetime-local"
                    value={effectiveAt}
                    onChange={(e) => setEffectiveAt(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: "+5 分钟", min: 5 },
                      { label: "+1 小时", min: 60 },
                      { label: "明早 9 点", min: 0, next9: true },
                      { label: "+1 天", min: 1440 },
                    ].map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => {
                          if (p.next9) {
                            const d = new Date(Date.now() + 24 * 3600_000)
                            d.setHours(9, 0, 0, 0)
                            setEffectiveAt(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`)
                          } else applyPreset(p.min!)
                        }}
                        className="rounded-md border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-sky-400/60 hover:text-sky-600 transition-colors"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-sky-700 dark:text-sky-300/80 flex items-start gap-1">
                    <Clock className="h-3 w-3 mt-0.5 shrink-0" />
                    批次将以 PENDING 状态落库，到点由定时任务（每分钟）自动激活；激活前可随时取消
                  </p>
                </div>
              )}
            </div>

            <Button
              className="w-full bg-teal-600 hover:bg-teal-700 font-semibold"
              disabled={!hasContent() || totalTargets === 0 || (effectiveMode === "SCHEDULED" && !effectiveAt)}
              onClick={() => setConfirmOpen(true)}
            >
              {effectiveMode === "SCHEDULED" ? <CalendarClock className="h-4 w-4 mr-1.5" /> : <Send className="h-4 w-4 mr-1.5" />}
              {effectiveMode === "SCHEDULED" ? `排期定时策略（${totalTargets} 目标）` : `下发策略（${totalTargets} 目标）`}
            </Button>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              下发前自动快照全部目标当前状态；执行后可在批次历史一键回滚。组级规则对组成员即时生效（新会话起）。
            </p>
          </div>
        </div>
      </div>

      {/* ===== 批次历史 ===== */}
      <div className="rounded-xl border">
        <div className="p-4 border-b flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Undo2 className="h-4 w-4 text-teal-600" /> 下发批次历史</h2>
          {/* r25-b 批次历史关键词搜索：名称/备注/操作人/状态实时过滤 */}
          <div className="flex min-w-52 md:max-w-xs items-center gap-2 rounded-md border px-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={deployFilter}
              onChange={(e) => setDeployFilter(e.target.value)}
              placeholder="搜批次 / 备注 / 操作人 / 状态…"
              className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              aria-label="搜索下发批次"
            />
            {deployFilter && (
              <button type="button" aria-label="清空搜索" onClick={() => setDeployFilter("")} className="rounded p-0.5 text-muted-foreground hover:text-foreground shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">最近 50 批</span>
        </div>
        {props.deployments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">暂无下发批次</p>
        ) : filteredDeployments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">无匹配「{deployFilter}」的下发批次</p>
        ) : (
          <div className="divide-y">
            {filteredDeployments.map((d) => (
              <div key={d.id}>
                <div className="p-3 flex items-center gap-3 flex-wrap">
                  <button className="h-6 w-6 rounded inline-flex items-center justify-center hover:bg-muted" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                    {expanded === d.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5">
                      {d.name}
                      {d.effectiveMode === "SCHEDULED" && (
                        <Badge variant="outline" className="border-sky-400/50 text-sky-600 text-[10px] shrink-0">
                          <Timer className="h-2.5 w-2.5 mr-0.5" />定时
                        </Badge>
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {d.createdByUsername}
                      {d.status === "PENDING" && d.effectiveAt ? ` · 定时生效：${d.effectiveAt}` : d.deployedAt ? ` · ${d.deployedAt}` : " · 未执行"}
                      {d.activatedAt ? ` · 激活于 ${d.activatedAt}` : ""}
                      {d.cancelledAt ? ` · 取消于 ${d.cancelledAt}` : ""}
                      {d.rolledBackAt ? ` · 回滚于 ${d.rolledBackAt}` : ""}
                      {bundleSummary(d.bundle).length > 0 && ` · ${bundleSummary(d.bundle).join(" / ")}`}
                    </p>
                  </div>
                  {statusBadge(d.status)}
                  {d.status !== "PENDING" && d.status !== "CANCELLED" && (
                    <Badge variant="outline" className="text-[10px]">
                      {d.successTargets}/{d.totalTargets} 成功{d.failedTargets > 0 ? ` · ${d.failedTargets} 失败` : ""}
                    </Badge>
                  )}
                  {d.status === "PENDING" && d.effectiveMode === "SCHEDULED" && (
                    <Button size="sm" variant="outline" className="h-7 border-slate-400/50 text-slate-500 hover:bg-slate-500/10" onClick={() => setCancelling(d)}>
                      <XCircle className="h-3 w-3 mr-1" /> 取消
                    </Button>
                  )}
                  {d.status !== "ROLLED_BACK" && (d.status === "SUCCESS" || d.status === "PARTIAL") && (
                    <Button size="sm" variant="outline" className="h-7 border-violet-400/50 text-violet-500 hover:bg-violet-500/10" onClick={() => setRollingBack(d)}>
                      <Undo2 className="h-3 w-3 mr-1" /> 回滚
                    </Button>
                  )}
                </div>
                {expanded === d.id && (
                  <div className="px-4 pb-4 pt-1 space-y-2">
                    {d.note && <p className="text-xs text-muted-foreground">备注：{d.note}</p>}
                    <div className="rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap">
                      {JSON.stringify(d.bundle, null, 2)}
                    </div>
                    {d.results && d.results.length > 0 && (
                      <div className="rounded-lg border max-h-56 overflow-y-auto">
                        <table className="w-full min-w-max text-xs">
                          <thead className="bg-muted/50 sticky top-0">
                            <tr>
                              <th className="text-left p-2 font-medium">类型</th>
                              <th className="text-left p-2 font-medium">目标</th>
                              <th className="text-left p-2 font-medium">结果</th>
                              <th className="text-left p-2 font-medium">原因</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.results.map((r, i) => (
                              <tr key={i} className="border-t">
                                <td className="p-2">{r.targetType === "GROUP" ? "用户组" : r.targetType === "SANDBOX" ? "单沙箱" : "用户"}</td>
                                <td className="p-2">{r.targetName}</td>
                                <td className="p-2">{r.ok ? <span className="text-emerald-600">成功</span> : <span className="text-red-600">失败</span>}</td>
                                <td className="p-2 text-muted-foreground">{r.reason || "-"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== 下发确认弹窗 ===== */}
      <Dialog open={confirmOpen} onOpenChange={(v) => !busy && setConfirmOpen(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认下发策略</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              批次「{deployName || "（未命名）"}」将{effectiveMode === "SCHEDULED" ? "定时排期给" : "下发给"} <b>{selectedGroups.size}</b> 个用户组、<b>{selectedUsers.size}</b> 个用户与 <b>{selectedWorkspaces.size}</b> 个单沙箱
              （影响约 {affectedEstimate} 名用户）{effectiveMode === "SCHEDULED" && effectiveAt ? `，生效时刻 ${effectiveAt.replace("T", " ")}` : ""}。
            </p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
              {bundleSummary(buildBundle() as Record<string, unknown>).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {effectiveMode === "SCHEDULED"
                ? "定时批次不立即变更任何策略；到点由定时任务自动激活执行，激活前可取消。排期与激活均记入审计与安全事件。"
                : "域名/IP/端点规则为替换式下发；下发前自动全量快照，可一键回滚。该操作将记入审计与安全事件。"}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy === "deploy"}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={doDeploy} disabled={busy === "deploy"}>
              {busy === "deploy" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {effectiveMode === "SCHEDULED" ? "确认排期" : "确认下发"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== 下发结果弹窗 ===== */}
      <Dialog open={!!resultData} onOpenChange={(v) => !v && setResultData(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>下发结果</DialogTitle>
          </DialogHeader>
          {resultData && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                {statusBadge(resultData.status)}
                {resultData.scheduled ? (
                  <span>已排期 {resultData.total} 个目标 · 定时生效：{resultData.effectiveAt ? new Date(resultData.effectiveAt).toLocaleString() : "-"}</span>
                ) : (
                  <span>成功 {resultData.success} / 共 {resultData.total} · 影响约 {resultData.affectedUsers} 名用户</span>
                )}
              </div>
              {resultData.scheduled && (
                <p className="text-xs text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900 rounded-lg p-3 flex items-start gap-1.5">
                  <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  批次当前为待生效（PENDING）：未变更任何策略；到点后由「定时策略下发到点激活」任务自动执行，激活前可在批次历史中取消。
                </p>
              )}
              {resultData.failures.length > 0 && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-3 max-h-48 overflow-y-auto">
                  {resultData.failures.map((f, i) => (
                    <p key={i} className="text-xs text-red-600 dark:text-red-400">
                      {f.target}：{f.reason}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{resultData.scheduled ? "排期与到点激活均记入审计与安全事件。" : "前置状态已快照，可在批次历史中一键回滚。"}</p>
            </div>
          )}
          <DialogFooter>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={() => setResultData(null)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== 回滚确认 ===== */}
      <ConfirmDialog
        open={!!rollingBack}
        onOpenChange={(v) => !busy && setRollingBack(v ? rollingBack : null)}
        title="回滚下发批次"
        description={`批次「${rollingBack?.name}」下发前已快照 ${rollingBack?.totalTargets || 0} 个目标状态。回滚将恢复开关字段与域名/IP 规则到下发前（组内手动新增的同作用域规则以快照为准）。`}
        destructive
        confirmText="确认回滚"
        loading={busy === "rollback"}
        onConfirm={doRollback}
      />

      {/* ===== 取消定时批次确认 ===== */}
      <ConfirmDialog
        open={!!cancelling}
        onOpenChange={(v) => !busy && setCancelling(v ? cancelling : null)}
        title="取消定时策略批次"
        description={`批次「${cancelling?.name}」尚未生效（定时于 ${cancelling?.effectiveAt || "-"}）。取消后不发生任何策略变更，批次转入已取消状态；不可恢复（如需重新下发请新建批次）。`}
        destructive
        confirmText="确认取消批次"
        loading={busy === "cancel"}
        onConfirm={doCancel}
      />

      {/* ===== 存为模板弹窗 ===== */}
      <Dialog open={saveTplOpen} onOpenChange={(v) => !busy && setSaveTplOpen(v)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>保存策略模板</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>模板名称</Label>
              <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="如：外勤人员严格隔离" />
            </div>
            <div className="space-y-1.5">
              <Label>描述（可选）</Label>
              <Input value={tplDesc} onChange={(e) => setTplDesc(e.target.value)} placeholder="适用场景说明" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveTplOpen(false)} disabled={busy === "saveTpl"}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={saveTemplate} disabled={busy === "saveTpl"}>
              {busy === "saveTpl" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 保存模板
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
