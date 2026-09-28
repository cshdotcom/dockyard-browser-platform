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
  Layers, Users, ShieldCheck, Undo2, Send, Search, Loader2, Save, Trash2, ChevronDown, ChevronRight,
  Network, Lock, Globe, CircleSlash, CheckCircle2, Ban, Info,
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
  deployPolicyAction, rollbackDeploymentAction, savePolicyTemplateAction, deletePolicyTemplateAction,
} from "@/server/actions/policy-deployments"

export interface DeploymentRow {
  id: string
  name: string
  note: string | null
  status: string
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

interface Props {
  deployments: DeploymentRow[]
  templates: TemplateRow[]
  targetGroups: TargetOptionGroup[]
  targetUsers: TargetOptionUser[]
  stats: { title: string; value: number; sub: string; icon: React.ReactNode }[]
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
  return parts
}

const statusBadge = (status: string) => {
  switch (status) {
    case "SUCCESS": return <Badge className="bg-emerald-600 hover:bg-emerald-600">全部成功</Badge>
    case "PARTIAL": return <Badge className="bg-amber-600 hover:bg-amber-600">部分成功</Badge>
    case "FAILED": return <Badge className="bg-red-600 hover:bg-red-600">失败</Badge>
    case "RUNNING": return <Badge className="bg-teal-600 hover:bg-teal-600">执行中</Badge>
    case "ROLLED_BACK": return <Badge variant="outline" className="border-violet-400/50 text-violet-500">已回滚</Badge>
    default: return <Badge variant="outline">{status}</Badge>
  }
}

export function PolicyDeployCenter(props: Props) {
  const router = useRouter()
  const [form, setForm] = React.useState<BundleForm>(DEFAULT_FORM)
  const [selectedGroups, setSelectedGroups] = React.useState<Set<string>>(new Set())
  const [selectedUsers, setSelectedUsers] = React.useState<Set<string>>(new Set())
  const [targetSearch, setTargetSearch] = React.useState("")
  const [deployName, setDeployName] = React.useState("")
  const [deployNote, setDeployNote] = React.useState("")
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [busy, setBusy] = React.useState("")
  const [resultData, setResultData] = React.useState<{
    status: string; total: number; success: number; failed: number
    failures: { target: string; reason: string }[]; affectedUsers: number
  } | null>(null)
  const [rollingBack, setRollingBack] = React.useState<DeploymentRow | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [saveTplOpen, setSaveTplOpen] = React.useState(false)
  const [tplName, setTplName] = React.useState("")
  const [tplDesc, setTplDesc] = React.useState("")

  const totalTargets = selectedGroups.size + selectedUsers.size
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

  const buildBundle = () => ({
    allowInternalNetwork: triValue(form.internal),
    allowSecureLocationAccess: triValue(form.secure),
    domainRules: form.domainEnabled
      ? { mode: form.domainMode, patterns: form.domainText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : null,
    ipRules: form.ipEnabled
      ? { mode: form.ipMode, values: form.ipText.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean) }
      : null,
  })

  const hasContent = () =>
    triValue(form.internal) !== null || triValue(form.secure) !== null || form.domainEnabled || form.ipEnabled

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
    })
    toast.success(`已加载模板「${tpl.name}」`)
  }

  const doDeploy = async () => {
    setBusy("deploy")
    try {
      const res = await deployPolicyAction({
        name: deployName,
        note: deployNote || null,
        bundle: buildBundle(),
        targetGroupIds: [...selectedGroups],
        targetUserIds: [...selectedUsers],
      })
      if (res.code === 0 && res.data) {
        setResultData({
          status: res.data.status,
          total: res.data.totalTargets,
          success: res.data.successTargets,
          failed: res.data.failedTargets,
          failures: res.data.failures,
          affectedUsers: res.data.affectedUsers,
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
          按用户 / 用户组批量下发访问控制策略包（内网访问 · 容器安全位置 · 域名黑白名单 · IP 黑白名单），全量前置快照、一键回滚、逐目标失败隔离
        </p>
      </div>

      {/* 统计卡 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {props.stats.map((s) => (
          <div key={s.title} className="rounded-lg border p-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-teal-600/10 text-teal-600 flex items-center justify-center shrink-0">{s.icon}</div>
            <div className="min-w-0">
              <p className="text-xl font-semibold leading-none">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.title} · {s.sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* ===== 左：策略包编辑 ===== */}
        <div className="lg:col-span-3 space-y-4">
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
            <Button
              className="w-full bg-teal-600 hover:bg-teal-700 font-semibold"
              disabled={!hasContent() || totalTargets === 0}
              onClick={() => setConfirmOpen(true)}
            >
              <Send className="h-4 w-4 mr-1.5" />
              下发策略（{totalTargets} 目标）
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
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Undo2 className="h-4 w-4 text-teal-600" /> 下发批次历史</h2>
          <span className="text-xs text-muted-foreground">最近 50 批</span>
        </div>
        {props.deployments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">暂无下发批次</p>
        ) : (
          <div className="divide-y">
            {props.deployments.map((d) => (
              <div key={d.id}>
                <div className="p-3 flex items-center gap-3 flex-wrap">
                  <button className="h-6 w-6 rounded inline-flex items-center justify-center hover:bg-muted" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                    {expanded === d.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{d.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {d.createdByUsername} · {d.deployedAt || "-"}{d.rolledBackAt ? ` · 回滚于 ${d.rolledBackAt}` : ""}
                      {bundleSummary(d.bundle).length > 0 && ` · ${bundleSummary(d.bundle).join(" / ")}`}
                    </p>
                  </div>
                  {statusBadge(d.status)}
                  <Badge variant="outline" className="text-[10px]">
                    {d.successTargets}/{d.totalTargets} 成功{d.failedTargets > 0 ? ` · ${d.failedTargets} 失败` : ""}
                  </Badge>
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
                        <table className="w-full text-xs">
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
                                <td className="p-2">{r.targetType === "GROUP" ? "用户组" : "用户"}</td>
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
              批次「{deployName || "（未命名）"}」将下发给 <b>{selectedGroups.size}</b> 个用户组与 <b>{selectedUsers.size}</b> 个用户
              （影响约 {affectedEstimate} 名用户）。
            </p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
              {bundleSummary(buildBundle() as Record<string, unknown>).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              域名/IP 规则为替换式下发；下发前自动全量快照，可一键回滚。该操作将记入审计与安全事件。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy === "deploy"}>取消</Button>
            <Button className="bg-teal-600 hover:bg-teal-700" onClick={doDeploy} disabled={busy === "deploy"}>
              {busy === "deploy" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} 确认下发
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
                <span>成功 {resultData.success} / 共 {resultData.total} · 影响约 {resultData.affectedUsers} 名用户</span>
              </div>
              {resultData.failures.length > 0 && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-3 max-h-48 overflow-y-auto">
                  {resultData.failures.map((f, i) => (
                    <p key={i} className="text-xs text-red-600 dark:text-red-400">
                      {f.target}：{f.reason}
                    </p>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">前置状态已快照，可在批次历史中一键回滚。</p>
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
