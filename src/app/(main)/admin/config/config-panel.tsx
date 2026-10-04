"use client"

// 系统配置交互面板：分类 Tabs + valueType 控件渲染（Switch/PrecisionInput/Input/Textarea）
// 逐项保存 / 分组整体保存 / 版本历史回滚；管理员只读（无保存按钮）
// r23-C：预警中心卡（ALERT）+ 安全防护卡（SECURITY）+ 底部配置生效自检（仅超级管理员）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Save, RotateCcw, History, Wrench, Lock, ShieldAlert, Mail, Siren, ShieldBan, ListChecks, ChevronDown, Search, X, ChevronRight, Plus, Trash2, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TIMEZONE_OPTIONS, TIMEZONE_LABELS, tzOffsetLabel } from "@/lib/tz-constants"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { HardwarePermsDialog } from "@/components/hardware/hardware-perms-dialog"
import { Cpu } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { setConfigAction, rollbackConfigAction, setSmtpConfigAction, testSmtpAction } from "@/server/actions/config"
import { cn } from "@/lib/utils"

export interface ConfigItem {
  key: string
  value: unknown
  type: string // string | number | boolean | json
  category: string
  description?: string
  version: number
}

export interface ConfigVersionRow {
  id: string
  configKey: string
  version: number
  before: unknown
  after: unknown
  operator: string
  createdAt: string
  currentVersion: number
}

// 配置生效自检行（r23-C）：由 server 端 page 计算后下发，仅 SUPER_ADMIN 可见
export interface SelfCheckRow {
  key: string
  value: string // 已脱敏的展示值（smtp.pass 等）
  status: "active" | "reserved"
  description: string
}
export interface SelfCheckData {
  rows: SelfCheckRow[]
  activeCount: number
  reservedCount: number
}

// r36：新增 CDP / WORKNODE / DOCKER / BACKUP 分类卡；补齐历史 TASKS 分类（此前键已注册但无标签页不展示）
const CATEGORY_ORDER = ["SECURITY", "HARDWARE", "SESSION", "CDP", "STORAGE", "BACKUP", "ALERT", "MAIL", "NETWORK", "DOCKER", "WORKNODE", "TASKS", "UI", "GENERAL", "MCP"] as const

const CATEGORY_LABEL: Record<string, string> = {
  SECURITY: "安全",
  HARDWARE: "硬件权限",
  SESSION: "会话",
  CDP: "CDP 网关",
  STORAGE: "存储",
  BACKUP: "备份容灾",
  ALERT: "告警",
  MAIL: "邮件",
  NETWORK: "网络",
  DOCKER: "Docker 编排",
  WORKNODE: "Worker 节点",
  TASKS: "自定义任务",
  UI: "界面",
  GENERAL: "通用",
  MCP: "MCP 网关",
}

// 长文本配置项用 Textarea（维护公告 / 登录页公告等）
const LONG_TEXT_KEYS = new Set(["maintenance.message", "ui.loginAnnouncement"])

// 硬件权限卡托管的键（专属卡片管理；17 项四级链的四级之一）
const HARDWARE_CARD_KEYS = new Set(["hardware.defaults"])

// 预警中心卡托管的键（不再重复渲染通用行）
// r34：邮件触发规则本地解析（AlertCard 使用）
function parseEmailRulesLocal(raw: string): Array<{ id: string; name: string; enabled: boolean; matchField: "title" | "resourceType" | "all"; keyword: string; minLevel: "ERROR" | "CRITICAL" | "WARNING" | "INFO" }> {
  try {
    const arr = JSON.parse(raw || "[]")
    if (!Array.isArray(arr)) return []
    return arr.filter((r): r is NonNullable<typeof r> => !!r && typeof r === "object")
  } catch {
    return []
  }
}

const ALERT_CARD_KEYS = new Set([
  "alert.emailEnabled", "alert.emailMinLevel", "alert.emailRecipients",
  "alert.hostEnabled", "alert.cpuThresholdPct", "alert.memThresholdPct", "alert.diskThresholdPct",
  "alert.sessionQuotaEnabled", "alert.singboxTrafficEnabled", "alert.proxyFailEnabled", "alert.backupFailEnabled",
  "alert.tokenExpireEnabled", "alert.zombieReclaimEnabled", "alert.configDriftEnabled", "alert.taskFailEnabled", "alert.quotaUserEnabled",
])

// 安全防护卡托管的键（不再重复渲染通用行）
const SECURITY_CARD_KEYS = new Set([
  "security.ipBanEnabled", "security.ipBanThreshold", "security.ipBanWindowMinutes", "security.ipBanMinutes",
  "security.ipBanApiCountEnabled", "security.ipBanAlertEnabled",
  // r35：2FA 强制策略三键 + 人机验证两键 → 统一进安全防护卡（"策略管理 2FA 功能项"显性按钮）
  "security.globalForce2fa", "security.force2faAdminExempt", "security.groupInheritForce2fa",
  "security.captchaAfterFailures", "security.captchaOnEmailCode",
  "security.allowWebKiosk", "security.allowVncAudio",
])

function jsonPreview(v: unknown, max = 90): string {
  const s = JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + "…" : s
}

export function ConfigPanel({
  items,
  versions,
  canEdit,
  selfCheck,
  initialTab,
  focusKey,
}: {
  items: ConfigItem[]
  versions: ConfigVersionRow[]
  canEdit: boolean
  selfCheck?: SelfCheckData
  /** r25-a 深链初始页签（/admin/config?tab=MAIL）：全局搜索设置项直达 */
  initialTab?: string
  /** r25-a 深链聚焦配置项（/admin/config?tab=X&key=Y）：高亮 + 滚动定位 */
  focusKey?: string
}) {
  const router = useRouter()

  // 本地编辑值与脏项
  const [values, setValues] = React.useState<Record<string, unknown>>(() =>
    Object.fromEntries(items.map((i) => [i.key, i.value]))
  )
  const [dirty, setDirty] = React.useState<Set<string>>(new Set())
  const [busyKey, setBusyKey] = React.useState<string>("")
  const [rollbackTarget, setRollbackTarget] = React.useState<ConfigVersionRow | null>(null)
  const [rollbackBusy, setRollbackBusy] = React.useState(false)
  // r34：全局配置搜索状态
  const [configSearch, setConfigSearch] = React.useState("")
  const [configHits, setConfigHits] = React.useState<ConfigItem[]>([])
  // SMTP 当前生效值（回显：保存前可见当前库内配置，避免空表单误保存/无法保存）
  const smtpInitial = React.useMemo(() => ({
    enabled: items.find((i) => i.key === "smtp.enabled")?.value === true,
    host: String(items.find((i) => i.key === "smtp.host")?.value ?? ""),
    port: Number(items.find((i) => i.key === "smtp.port")?.value ?? 465) || 465,
    secure: items.find((i) => i.key === "smtp.secure")?.value !== false,
    user: String(items.find((i) => i.key === "smtp.user")?.value ?? ""),
    from: String(items.find((i) => i.key === "smtp.from")?.value ?? ""),
    senderName: String(items.find((i) => i.key === "smtp.senderName")?.value ?? "Dockyard 平台"),
    hasPass: !!String(items.find((i) => i.key === "smtp.pass")?.value ?? ""),
  }), [items])

  React.useEffect(() => {
    setValues(Object.fromEntries(items.map((i) => [i.key, i.value])))
    setDirty(new Set())
  }, [items.map((i) => `${i.key}:${i.version}:${JSON.stringify(i.value)}`).join("|")])

  const setLocal = (key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }))
    setDirty((prev) => new Set(prev).add(key))
  }

  const saveItems = async (keys: string[], label: string) => {
    if (keys.length === 0) {
      toast.info("没有待保存的变更")
      return
    }
    setBusyKey(label)
    try {
      const payload = keys.map((k) => ({
        key: k,
        value: typeof values[k] === "number" ? Number(values[k]) : values[k],
      }))
      const res = await setConfigAction({ items: payload })
      if (res.code === 0) {
        toast.success(`已保存 ${payload.length} 项配置`)
        setDirty(new Set())
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusyKey("")
    }
  }

  const doRollback = async (row: ConfigVersionRow) => {
    setRollbackBusy(true)
    try {
      const res = await rollbackConfigAction({ key: row.configKey, version: row.version })
      if (res.code === 0) {
        toast.success(`已回滚 ${row.configKey} 至 v${row.version}（新版本号 v${res.data?.version}）`)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "回滚失败")
    } finally {
      setRollbackBusy(false)
      setRollbackTarget(null)
    }
  }

  const byCategory = React.useMemo(() => {
    const m = new Map<string, ConfigItem[]>()
    for (const it of items) {
      const arr = m.get(it.category) || []
      arr.push(it)
      m.set(it.category, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.key.localeCompare(b.key))
    return m
  }, [items])

  // r25-a 深链页签（受控 Tabs）：初始 / 后续聚焦均以 URL 参数驱动
  const validTab = (t?: string) => (t && (CATEGORY_ORDER as readonly string[]).includes(t) && byCategory.has(t) ? t : undefined)
  const [tab, setTab] = React.useState<string>(validTab(initialTab) || CATEGORY_ORDER[0])
  // 深链 focusKey：目标页签激活后滚动定位 + 高亮；行不在当前页签时先切换到其所属分类
  React.useEffect(() => {
    if (!focusKey) return
    const el = document.getElementById(`cfg-row-${encodeURIComponent(focusKey)}`)
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" })
      return
    }
    const own = items.find((i) => i.key === focusKey)
    if (own && own.category !== tab && byCategory.has(own.category)) setTab(own.category)
  }, [focusKey, tab, items, byCategory])

  const versionsByKey = React.useMemo(() => {
    const m = new Map<string, ConfigVersionRow[]>()
    for (const v of versions) {
      const arr = m.get(v.configKey) || []
      arr.push(v)
      m.set(v.configKey, arr)
    }
    return m
  }, [versions])

  const maintenanceEnabled = values["maintenance.enabled"] === true
  const maintenanceMessage = String(values["maintenance.message"] ?? "")
  const readonlyEnabled = values["readonly.enabled"] === true

  const renderControl = (item: ConfigItem) => {
    const disabled = !canEdit
    const v = values[item.key]
    // SMTP 密码永不回显（仅由专属卡片加密管理）
    if (item.key === "smtp.pass") {
      return (
        <Badge variant="secondary" className="text-[11px]">
          {String(v ?? "") ? "已配置（AES 加密）" : "未配置"}
        </Badge>
      )
    }
    // r31：平台时区选择器（常用时区下拉 + 当前生效标注）
    if (item.key === "general.timezone") {
      const cur = String(v ?? "Asia/Shanghai")
      return (
        <div className="flex flex-col items-end gap-1">
          <Select value={cur} onValueChange={(val) => setLocal(item.key, val)} disabled={disabled}>
            <SelectTrigger className="w-64 h-9 text-sm">
              <SelectValue placeholder="选择平台时区" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {TIMEZONE_OPTIONS.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{tz}</span>
                    <span className="text-[10px] text-muted-foreground">{TIMEZONE_LABELS[tz] || ""} · {tzOffsetLabel(tz)}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground">
            邮件/录像水印/到期时间等面向用户的服务器时间统一按此时区显示（存储仍为 UTC；变更约 1 分钟内生效）
          </span>
        </div>
      )
    }
    if (item.type === "boolean") {
      return (
        <Switch
          checked={v === true}
          onCheckedChange={(b) => setLocal(item.key, b)}
          disabled={disabled}
          aria-label={item.key}
        />
      )
    }
    if (item.type === "number") {
      return (
        <PrecisionInput
          value={typeof v === "number" ? v : Number(v) || 0}
          onChange={(n) => setLocal(item.key, n)}
          min={0}
          max={10000000}
          step={0.001}
          className="w-36"
          disabled={disabled}
        />
      )
    }
    if (LONG_TEXT_KEYS.has(item.key)) {
      return (
        <Textarea
          value={String(v ?? "")}
          onChange={(e) => setLocal(item.key, e.target.value)}
          rows={3}
          className="w-full max-w-xl"
          disabled={disabled}
        />
      )
    }
    return (
      <Input
        value={String(v ?? "")}
        onChange={(e) => setLocal(item.key, e.target.value)}
        className="w-full max-w-md"
        disabled={disabled}
      />
    )
  }

  const renderItemRow = (item: ConfigItem) => {
    const isDirty = dirty.has(item.key)
    const isFocused = focusKey === item.key
    return (
      <div
        key={item.key}
        id={`cfg-row-${encodeURIComponent(item.key)}`}
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4 transition-shadow",
          isFocused && "ring-2 ring-teal-500 ring-offset-1 border-teal-600/40",
        )}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium break-all">{item.key}</span>
            <Badge variant="outline" className="text-[10px] shrink-0">v{item.version}</Badge>
            {isDirty && <Badge className="bg-amber-500 hover:bg-amber-500 text-[10px] shrink-0">未保存</Badge>}
          </div>
          {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {renderControl(item)}
          {canEdit && (
            <Button
              size="sm"
              variant={isDirty ? "default" : "outline"}
              disabled={!isDirty || busyKey === item.key}
              onClick={() => saveItems([item.key], item.key)}
            >
              {busyKey === item.key && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              保存
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ---- 快捷开关卡片（置顶）：维护模式 / 只读模式 ---- */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-600" />
              <span className="font-medium">维护模式</span>
              {maintenanceEnabled ? (
                <Badge className="bg-amber-500 hover:bg-amber-500">已开启</Badge>
              ) : (
                <Badge variant="secondary">关闭</Badge>
              )}
            </div>
            <Switch
              checked={maintenanceEnabled}
              onCheckedChange={(b) => setLocal("maintenance.enabled", b)}
              disabled={!canEdit || busyKey === "maintenance"}
              aria-label="维护模式开关"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">维护提示公告（maintenance.message）</Label>
            <Textarea
              value={maintenanceMessage}
              onChange={(e) => setLocal("maintenance.message", e.target.value)}
              rows={2}
              disabled={!canEdit}
              placeholder="系统维护中，创建类操作暂不可用"
            />
          </div>
          {canEdit && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">开启后创建类写入操作将被拦截，查询不受影响</p>
              <Button
                size="sm"
                variant={dirty.has("maintenance.enabled") || dirty.has("maintenance.message") ? "default" : "outline"}
                disabled={(!dirty.has("maintenance.enabled") && !dirty.has("maintenance.message")) || busyKey === "maintenance"}
                onClick={() =>
                  saveItems(
                    ["maintenance.enabled", "maintenance.message"].filter((k) => dirty.has(k)),
                    "maintenance"
                  )
                }
              >
                {busyKey === "maintenance" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                保存维护设置
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-red-500" />
              <span className="font-medium">系统只读模式</span>
              {readonlyEnabled ? (
                <Badge variant="destructive">已开启</Badge>
              ) : (
                <Badge variant="secondary">关闭</Badge>
              )}
            </div>
            <Switch
              checked={readonlyEnabled}
              onCheckedChange={(b) => setLocal("readonly.enabled", b)}
              disabled={!canEdit || busyKey === "readonly.enabled"}
              aria-label="只读模式开关"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            readonly.enabled：开启后全平台禁止一切写入操作（含管理员），仅保留查询与导出。配置回滚/维护开关不受限。
          </p>
          {canEdit && (
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                variant={dirty.has("readonly.enabled") ? "destructive" : "outline"}
                disabled={!dirty.has("readonly.enabled") || busyKey === "readonly.enabled"}
                onClick={() => saveItems(["readonly.enabled"], "readonly.enabled")}
              >
                {busyKey === "readonly.enabled" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                保存只读开关
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ---- r34：全局配置搜索框（用户诉求：系统配置里专门搜配置的搜索框） ----
          跨全部分类：键名/描述实时匹配，命中时切换到虚拟「搜索结果」页签渲染，
          点选任意结果深链跳到所属分类页签并滚动定位高亮 ---- */}
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={configSearch}
          onChange={(e) => {
            setConfigSearch(e.target.value)
            const q = e.target.value.trim().toLowerCase()
            setConfigHits(q ? items.filter((i) => i.key.toLowerCase().includes(q) || (i.description || "").toLowerCase().includes(q)).slice(0, 50) : [])
            setTab(q && configHits.length >= 0 ? "__SEARCH__" : CATEGORY_ORDER[0])
          }}
          placeholder="搜索配置项（键名 / 描述，跨全部分类）…"
          className="pl-8"
          aria-label="搜索配置"
        />
        {configSearch && (
          <button type="button" aria-label="清空搜索" onClick={() => { setConfigSearch(""); setTab(CATEGORY_ORDER[0]) }} className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---- 分类 Tabs（r25-a 受控：支持 ?tab= 深链） ---- */}
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="flex-wrap h-auto gap-1">
          {configSearch.trim() && (
            <TabsTrigger value="__SEARCH__" className="data-[state=active]:bg-teal-50 data-[state=active]:text-teal-700">
              <Search className="mr-1 h-3.5 w-3.5" />
              搜索结果 {configHits.length}
            </TabsTrigger>
          )}
          {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => (
            <TabsTrigger key={c} value={c}>
              {CATEGORY_LABEL[c] || c}
              <span className="ml-1 text-xs opacity-60">{byCategory.get(c)?.length ?? 0}</span>
            </TabsTrigger>
          ))}
          <TabsTrigger value="__HISTORY__">
            <History className="mr-1 h-3.5 w-3.5" />
            版本历史
          </TabsTrigger>
        </TabsList>

        {/* ---- r34：搜索结果页签（跨分类命中清单） ---- */}
        {configSearch.trim() && (
          <TabsContent value="__SEARCH__" className="space-y-2 mt-4">
            <p className="text-sm text-muted-foreground">
              匹配「{configSearch.trim()}」的配置项 {configHits.length} 个（跨全部分类）；点击任意项跳转到所属分类并定位
            </p>
            {configHits.length === 0 && (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                未找到匹配的配置项（可尝试英文键名或简短关键词）
              </div>
            )}
            <div className="rounded-lg border divide-y">
              {configHits.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40"
                  onClick={() => {
                    setConfigSearch("")
                    setTab(i.category)
                    setTimeout(() => {
                      const el = document.getElementById(`cfg-row-${encodeURIComponent(i.key)}`)
                      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("ring-2", "ring-teal-400"); setTimeout(() => el.classList.remove("ring-2", "ring-teal-400"), 2000) }
                    }, 200)
                  }}
                >
                  <Badge variant="outline" className="shrink-0">{CATEGORY_LABEL[i.category] || i.category}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs truncate">{i.key}</span>
                    <span className="block text-xs text-muted-foreground truncate">{i.description || ""}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          </TabsContent>
        )}

        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => {
          const allList = byCategory.get(c) || []
          // MAIL 分类：smtp.* 由专属卡片管理，通用行仅渲染其余项
          // ALERT / SECURITY：r23 专属卡片（预警中心 / 安全防护）托管的键不再重复渲染
          const list =
            c === "MAIL" ? allList.filter((i) => !i.key.startsWith("smtp."))
              : c === "ALERT" ? allList.filter((i) => !ALERT_CARD_KEYS.has(i.key))
                : c === "SECURITY" ? allList.filter((i) => !SECURITY_CARD_KEYS.has(i.key))
                  : c === "HARDWARE" ? allList.filter((i) => !HARDWARE_CARD_KEYS.has(i.key))
                    : allList
          const dirtyInCategory = list.filter((i) => dirty.has(i.key))
          return (
            <TabsContent key={c} value={c} className="space-y-3 mt-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {CATEGORY_LABEL[c] || c} · {list.length} 项{canEdit ? "，修改后请逐项或整体保存" : "（只读）"}
                </p>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={dirtyInCategory.length === 0 || busyKey === `cat:${c}`}
                    onClick={() => saveItems(dirtyInCategory.map((i) => i.key), `cat:${c}`)}
                  >
                    {busyKey === `cat:${c}` && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    <Save className="mr-1 h-3.5 w-3.5" />
                    整体保存（{dirtyInCategory.length} 项变更）
                  </Button>
                )}
              </div>
              <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
                {/* r25-a 深链聚焦：专属卡片托管的键（smtp.* / ALERT_CARD_KEYS / SECURITY_CARD_KEYS）
                    无通用行 → 卡片自身承接 ring 高亮 + 定位锚点（id 与行规则一致） */}
                {c === "HARDWARE" && (
                  <div
                    id={focusKey === "hardware.defaults" ? `cfg-row-${encodeURIComponent("hardware.defaults")}` : undefined}
                    className={cn("lg:col-span-2 rounded-xl border p-4 space-y-3", focusKey === "hardware.defaults" && "ring-2 ring-teal-500 ring-offset-1")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-indigo-600" />
                        <div>
                          <div className="text-sm font-medium">17 项硬件权限 · 全局默认档</div>
                          <p className="text-xs text-muted-foreground">
                            摄像头/麦克风/定位/屏幕共享/剪贴板读写/通知/蓝牙/USB/串口/加速度/陀螺仪/磁力计/方向/运动/MIDI/HID
                            —— 每项独立开关（允许/审计/录制/静默）。四级链：沙箱 &gt; 用户 &gt; 用户组 &gt; 本默认档。
                          </p>
                        </div>
                      </div>
                      {canEdit && <HardwareDefaultsCard />}
                    </div>
                  </div>
                )}
                {c === "MAIL" && (
                  <div
                    id={focusKey?.startsWith("smtp.") ? `cfg-row-${encodeURIComponent(focusKey)}` : undefined}
                    className={cn("lg:col-span-2", focusKey?.startsWith("smtp.") && "ring-2 ring-teal-500 ring-offset-1 rounded-xl")}
                  >
                    <SmtpCard canEdit={canEdit} initial={smtpInitial} />
                  </div>
                )}
                {c === "ALERT" && (
                  <div
                    id={focusKey && ALERT_CARD_KEYS.has(focusKey) ? `cfg-row-${encodeURIComponent(focusKey)}` : undefined}
                    className={cn("lg:col-span-2", focusKey && ALERT_CARD_KEYS.has(focusKey) && "ring-2 ring-teal-500 ring-offset-1 rounded-xl")}
                  >
                    <AlertCard
                      canEdit={canEdit}
                      values={values}
                      dirtyKeys={dirty}
                      busyKey={busyKey}
                      setLocal={setLocal}
                      saveItems={saveItems}
                    />
                  </div>
                )}
                {c === "SECURITY" && (
                  <div
                    id={focusKey && SECURITY_CARD_KEYS.has(focusKey) ? `cfg-row-${encodeURIComponent(focusKey)}` : undefined}
                    className={cn("lg:col-span-2", focusKey && SECURITY_CARD_KEYS.has(focusKey) && "ring-2 ring-teal-500 ring-offset-1 rounded-xl")}
                  >
                    <SecurityCard
                      canEdit={canEdit}
                      values={values}
                      dirtyKeys={dirty}
                      busyKey={busyKey}
                      setLocal={setLocal}
                      saveItems={saveItems}
                    />
                  </div>
                )}
                {list.map(renderItemRow)}
              </div>
            </TabsContent>
          )
        })}

        {/* ---- 版本历史页签：按 configKey 分组 ---- */}
        <TabsContent value="__HISTORY__" className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              最近 {versions.length} 条变更记录，按配置项分组；回滚将生成新版本号（原版本不会被删除）
            </p>
          </div>
          {versionsByKey.size === 0 ? (
            <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
              暂无版本变更记录（配置从未被修改过）
            </div>
          ) : (
            <ScrollArea className="h-[65vh] rounded-lg border bg-card p-4">
              <div className="space-y-5">
                {[...versionsByKey.entries()].map(([key, rows]) => (
                  <div key={key} className="space-y-2">
                    <div className="flex items-center gap-2 sticky top-0 bg-card py-1 z-10">
                      <span className="font-mono text-sm font-semibold">{key}</span>
                      <Badge variant="outline">当前 v{rows[0].currentVersion}</Badge>
                      <span className="text-xs text-muted-foreground">{rows.length} 条历史</span>
                    </div>
                    <div className="rounded-md border divide-y">
                      {rows.map((row) => {
                        const isCurrent = row.version === row.currentVersion
                        return (
                          <div
                            key={row.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                          >
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <Badge variant={isCurrent ? "default" : "secondary"} className="shrink-0">
                                v{row.version}
                              </Badge>
                              <span className="text-xs text-muted-foreground font-mono truncate max-w-40" title={jsonPreview(row.before)}>
                                {jsonPreview(row.before, 40)}
                              </span>
                              <span className="text-muted-foreground text-xs">→</span>
                              <span className="text-xs font-mono truncate max-w-40" title={jsonPreview(row.after)}>
                                {jsonPreview(row.after, 40)}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span>{row.operator}</span>
                              <span>{row.createdAt}</span>
                              {canEdit && !isCurrent && (
                                <Button size="sm" variant="outline" onClick={() => setRollbackTarget(row)}>
                                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                  回滚到此版本
                                </Button>
                              )}
                              {isCurrent && <Badge variant="outline" className="text-[10px]">当前生效</Badge>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
      </Tabs>

      {/* ---- r23-C：配置生效自检（仅 SUPER_ADMIN，server 端计算后下发） ---- */}
      {selfCheck && <SelfCheckBlock data={selfCheck} />}

      {/* 回滚确认 */}
      <ConfirmDialog
        open={!!rollbackTarget}
        onOpenChange={(v) => !rollbackBusy && setRollbackTarget(v ? rollbackTarget : null)}
        title="回滚配置版本"
        destructive
        loading={rollbackBusy}
        description={
          rollbackTarget
            ? `将把 ${rollbackTarget.configKey} 回滚到 v${rollbackTarget.version}（值：${jsonPreview(rollbackTarget.after, 120)}）。\n回滚会立即生效并生成新版本号，操作全程审计留痕。`
            : ""
        }
        onConfirm={async () => {
          if (rollbackTarget) await doRollback(rollbackTarget)
        }}
      />

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 text-amber-600" />
          管理员仅可查看配置与版本历史；修改配置需要超级管理员权限。
        </div>
      )}
    </div>
  )
}


// ============================================================
// SMTP 邮箱服务器专属卡片：后台可改 + 密码加密落库 + 真实连接测试 + 测试邮件发送
// 保存后 30 秒内热生效（邮件传输器缓存按配置指纹失效重建）
// ============================================================
interface SmtpInitial {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  from: string
  senderName: string
  hasPass: boolean
}

function SmtpCard({ canEdit, initial }: { canEdit: boolean; initial: SmtpInitial }) {
  const router = useRouter()
  const [enabled, setEnabled] = React.useState(initial.enabled)
  const [host, setHost] = React.useState(initial.host)
  const [port, setPort] = React.useState(initial.port)
  const [secure, setSecure] = React.useState(initial.secure)
  const [user, setUser] = React.useState(initial.user)
  const [pass, setPass] = React.useState("")
  const [from, setFrom] = React.useState(initial.from)
  const [senderName, setSenderName] = React.useState(initial.senderName)
  const [testTo, setTestTo] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ ok: boolean; message: string } | null>(null)

  // 服务器端配置刷新（保存/回滚后 router.refresh 触发 items 变化）→ 表单同步当前生效值
  React.useEffect(() => {
    setEnabled(initial.enabled)
    setHost(initial.host)
    setPort(initial.port)
    setSecure(initial.secure)
    setUser(initial.user)
    setFrom(initial.from)
    setSenderName(initial.senderName)
    setPass("")
  }, [initial])

  const doSave = async () => {
    setSaving(true)
    try {
      const res = await setSmtpConfigAction({ enabled, host, port, secure, user, pass, from, senderName })
      if (res.code === 0) {
        toast.success(`SMTP 配置已保存并落库（${enabled ? `已启用 · ${host || "未填服务器"}:${port}` : "模拟模式"}${pass ? " · 密码已更新（AES 加密）" : ""}）`)
        setPass("") // 清空明文输入
        router.refresh()
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败")
    } finally { setSaving(false) }
  }

  const doTest = async (sendMail: boolean) => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testSmtpAction({ to: sendMail ? testTo : "" })
      if (res.code === 0 && res.data) {
        setTestResult({ ok: res.data.ok, message: res.data.message })
        if (res.data.ok) toast.success(res.data.message)
        else toast.error(res.data.message)
      } else toast.error(res.msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "测试失败")
    } finally { setTesting(false) }
  }

  return (
    <div className="lg:col-span-2 rounded-lg border border-teal-100 bg-teal-50/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-teal-600" />
          <span className="font-medium">邮箱验证服务器（SMTP）</span>
          {enabled ? (
            <Badge className="bg-emerald-500 hover:bg-emerald-500">已启用</Badge>
          ) : (
            <Badge variant="secondary">模拟模式（控制台输出）</Badge>
          )}
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} aria-label="SMTP 启用" />
      </div>
      <p className="text-xs text-muted-foreground">
        验证码 / 激活 / 告警邮件的发送服务器。修改后立即生效（30 秒内），连接测试执行真实 SMTP 握手；密码 AES 加密落库、界面永不回显。
        {initial.hasPass && <span className="ml-1 text-emerald-600">（密码已配置，留空保存则不修改）</span>}
      </p>
      {/* 当前生效配置回显（服务器端实时值，保存/回滚后 router.refresh 同步）*/}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">当前生效（数据库）：</span>
        <Badge variant={initial.enabled && initial.host ? "default" : "secondary"} className={initial.enabled && initial.host ? "bg-emerald-500 hover:bg-emerald-500" : ""}>
          {initial.enabled && initial.host ? `${initial.host}:${initial.port}${initial.secure ? " SSL" : " STARTTLS"}` : "模拟模式（验证码控制台输出）"}
        </Badge>
        {initial.user && <span className="text-muted-foreground">认证：{initial.user.slice(0, 2)}***{initial.user.slice(-2)}</span>}
      </div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">SMTP 服务器</Label>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" disabled={!canEdit} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">端口</Label>
          <PrecisionInput value={port} onChange={(n) => setPort(Math.round(n))} min={1} max={65535} step={1} className="w-full" disabled={!canEdit} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">加密方式</Label>
          <div className="flex h-9 items-center gap-2">
            <Switch checked={secure} onCheckedChange={setSecure} disabled={!canEdit} aria-label="SSL" />
            <span className="text-xs text-muted-foreground">{secure ? "SSL 直连（465）" : "STARTTLS（587）"}</span>
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">认证用户名</Label>
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="noreply@example.com" disabled={!canEdit} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">认证密码（留空 = 不修改{initial.hasPass ? "，当前已配置" : "，尚未配置"}）</Label>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••••" disabled={!canEdit} autoComplete="new-password" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">发件人地址（空 = 认证用户名）</Label>
          <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="noreply@example.com" disabled={!canEdit} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">发件人显示名</Label>
          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} disabled={!canEdit} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">测试收件邮箱（可选）</Label>
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="admin@example.com" type="email" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button size="sm" onClick={doSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            <Save className="mr-1 h-3.5 w-3.5" /> 保存 SMTP 配置
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => doTest(false)} disabled={testing}>
          {testing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          测试连接（真实握手）
        </Button>
        <Button size="sm" variant="outline" onClick={() => doTest(true)} disabled={testing || !testTo}>
          发送测试邮件
        </Button>
        {testResult && (
          <span className={cn("text-xs", testResult.ok ? "text-emerald-600" : "text-red-600")}>{testResult.message}</span>
        )}
      </div>
    </div>
  )
}


// ============================================================
// r23-C：预警中心卡（ALERT 分类）—— 邮件通道 / 宿主机水位 / 9 项分功能预警
// 复用主面板 values/dirty/setLocal/saveItems（setConfigAction 批量保存）
// ============================================================
interface CardFieldCtx {
  canEdit: boolean
  values: Record<string, unknown>
  dirtyKeys: Set<string>
  busyKey: string
  setLocal: (key: string, v: unknown) => void
  saveItems: (keys: string[], label: string) => Promise<void>
}

const ALERT_FEATURE_SWITCHES: { key: string; label: string; desc: string }[] = [
  { key: "alert.sessionQuotaEnabled", label: "会话配额水位预警", desc: "会话数接近配额上限时产生告警" },
  { key: "alert.singboxTrafficEnabled", label: "SingBox 流量超限预警", desc: "实例流量超出限额时告警" },
  { key: "alert.proxyFailEnabled", label: "代理节点故障预警", desc: "代理探测失败 / 异常下线时告警" },
  { key: "alert.backupFailEnabled", label: "备份异常预警", desc: "备份任务失败或产物异常时告警" },
  { key: "alert.tokenExpireEnabled", label: "Token 到期预警", desc: "API 令牌临期自动提醒" },
  { key: "alert.zombieReclaimEnabled", label: "僵死会话回收预警", desc: "僵死会话被自动回收时告警" },
  { key: "alert.configDriftEnabled", label: "配置漂移预警", desc: "运行参数偏离基线时告警" },
  { key: "alert.taskFailEnabled", label: "定时任务连续失败预警", desc: "任务连续失败达到阈值时告警" },
  { key: "alert.quotaUserEnabled", label: "用户磁盘配额水位预警", desc: "用户存储配额接近上限时告警" },
]

function AlertCard({ canEdit, values, dirtyKeys, busyKey, setLocal, saveItems }: CardFieldCtx) {
  const emailEnabled = values["alert.emailEnabled"] === true
  const hostEnabled = values["alert.hostEnabled"] === true
  const cardKeys = [...ALERT_CARD_KEYS]
  const dirtyCount = cardKeys.filter((k) => dirtyKeys.has(k)).length
  const saving = busyKey === "alert-card"

  return (
    <div className="lg:col-span-2 rounded-lg border border-amber-200 bg-amber-50/30 dark:border-amber-900/50 dark:bg-amber-950/10 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Siren className="h-4 w-4 text-amber-600" />
          <span className="font-medium">预警中心</span>
          {emailEnabled ? (
            <Badge className="bg-emerald-500 hover:bg-emerald-500">邮件通道开启</Badge>
          ) : (
            <Badge variant="secondary">邮件通道关闭</Badge>
          )}
          {hostEnabled ? (
            <Badge className="bg-emerald-500 hover:bg-emerald-500">水位预警开启</Badge>
          ) : (
            <Badge variant="secondary">水位预警关闭</Badge>
          )}
        </div>
        {canEdit && (
          <Button
            size="sm"
            variant={dirtyCount > 0 ? "default" : "outline"}
            disabled={dirtyCount === 0 || saving}
            onClick={() => saveItems(cardKeys.filter((k) => dirtyKeys.has(k)), "alert-card")}
          >
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            <Save className="mr-1 h-3.5 w-3.5" />
            保存预警设置（{dirtyCount} 项变更）
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        告警邮件通道 + 宿主机资源水位 + 各业务分功能预警的统一开关；低于 alert.emailMinLevel 的告警不发送邮件（含静默窗口抑制）。
      </p>

      {/* ---- 邮件通道 ---- */}
      <div className="rounded-md border bg-card p-3 space-y-3">
        <p className="text-sm font-medium flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-teal-600" /> 告警邮件通道（alert.email*）
        </p>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 items-end">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">告警邮件开关（alert.emailEnabled）</Label>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={emailEnabled} onCheckedChange={(b) => setLocal("alert.emailEnabled", b)} disabled={!canEdit} aria-label="告警邮件开关" />
              <span className="text-xs text-muted-foreground">{emailEnabled ? "开启" : "关闭"}</span>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">邮件最低级别（alert.emailMinLevel）</Label>
            <Select
              value={String(values["alert.emailMinLevel"] ?? "ERROR")}
              onValueChange={(v) => setLocal("alert.emailMinLevel", v)}
              disabled={!canEdit}
            >
              <SelectTrigger className="w-36" aria-label="邮件最低级别">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INFO">INFO（全部）</SelectItem>
                <SelectItem value="WARNING">WARNING</SelectItem>
                <SelectItem value="ERROR">ERROR</SelectItem>
                <SelectItem value="CRITICAL">CRITICAL（仅致命）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">收件人（alert.emailRecipients，逗号分隔）</Label>
            <Input
              value={String(values["alert.emailRecipients"] ?? "")}
              onChange={(e) => setLocal("alert.emailRecipients", e.target.value)}
              placeholder="留空=自动发给全部管理员邮箱"
              disabled={!canEdit}
            />
          </div>
        </div>
      </div>

      {/* ---- r34：邮件触发规则（按条件精确控制"什么情况发邮件"） ---- */}
      <div className="rounded-md border bg-card p-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <Siren className="h-3.5 w-3.5 text-rose-600" /> 邮件触发规则（alert.emailRules）
          </p>
          {canEdit && (
            <Button
              size="sm" variant="outline"
              onClick={() => {
                const cur = parseEmailRulesLocal(String(values["alert.emailRules"] ?? "[]"))
                const next = [...cur, { id: `r${Date.now()}`, name: `规则 ${cur.length + 1}`, enabled: true, matchField: "title" as const, keyword: "", minLevel: "ERROR" as const }]
                setLocal("alert.emailRules", JSON.stringify(next))
              }}
            >
              <Plus className="h-3.5 w-3.5" />新增规则
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          按「告警标题关键词 / 资源类型」精确控制哪些情况触发邮件：命中启用规则且级别达标 → 发送；命中禁用规则 → 显式抑制（deny 优先）。
          规则列表为空时回退全局最低级别逻辑。保存后生效（批量保存随预警卡）。
        </p>
        {(() => {
          const rules = parseEmailRulesLocal(String(values["alert.emailRules"] ?? "[]"))
          const setRules = (next: typeof rules) => setLocal("alert.emailRules", JSON.stringify(next))
          if (rules.length === 0) {
            return <p className="text-xs text-muted-foreground p-2 border border-dashed rounded text-center">暂无规则（全部告警按全局最低级别发送邮件）</p>
          }
          return (
            <div className="space-y-2">
              {rules.map((r, i) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <Input
                    value={r.name}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    placeholder="规则名称"
                    className="w-32 h-8 text-xs"
                    disabled={!canEdit}
                    aria-label="规则名称"
                  />
                  <select
                    value={r.matchField}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, matchField: e.target.value as "title" | "resourceType" | "all" } : x)))}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    disabled={!canEdit}
                    aria-label="匹配字段"
                  >
                    <option value="title">标题含关键词</option>
                    <option value="resourceType">资源类型含</option>
                    <option value="all">全部告警（通配）</option>
                  </select>
                  <Input
                    value={r.keyword}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, keyword: e.target.value } : x)))}
                    placeholder="关键词（如：磁盘 / WORKSPACE）"
                    className="flex-1 min-w-36 h-8 text-xs"
                    disabled={!canEdit || r.matchField === "all"}
                    aria-label="关键词"
                  />
                  <select
                    value={r.minLevel}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, minLevel: e.target.value as "ERROR" | "CRITICAL" | "WARNING" | "INFO" } : x)))}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    disabled={!canEdit}
                    aria-label="规则最低级别"
                  >
                    <option value="INFO">INFO+</option>
                    <option value="WARNING">WARNING+</option>
                    <option value="ERROR">ERROR+</option>
                    <option value="CRITICAL">仅 CRITICAL</option>
                  </select>
                  <div className="flex items-center gap-1.5">
                    <Switch checked={r.enabled} onCheckedChange={(b) => setRules(rules.map((x, j) => (j === i ? { ...x, enabled: b } : x)))} disabled={!canEdit} aria-label="规则开关" />
                    <span className="text-[10px] text-muted-foreground w-8">{r.enabled ? "启用" : "抑制"}</span>
                  </div>
                  {canEdit && (
                    <Button variant="ghost" size="sm" className="h-8 text-red-500" onClick={() => setRules(rules.filter((_, j) => j !== i))} title="删除规则">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )
        })()}
      </div>

      {/* ---- 宿主机资源水位 ---- */}
      <div className="rounded-md border bg-card p-3 space-y-3">
        <p className="text-sm font-medium flex items-center gap-2">
          <Siren className="h-3.5 w-3.5 text-amber-600" /> 宿主机资源水位预警（alert.hostEnabled / 阈值）
        </p>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">水位预警总开关（alert.hostEnabled）：宿主机指标超阈值时产生告警</span>
          <Switch checked={hostEnabled} onCheckedChange={(b) => setLocal("alert.hostEnabled", b)} disabled={!canEdit} aria-label="宿主机水位预警开关" />
        </div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">CPU 阈值 %（alert.cpuThresholdPct）</Label>
            <PrecisionInput
              value={Number(values["alert.cpuThresholdPct"] ?? 80)}
              onChange={(n) => setLocal("alert.cpuThresholdPct", n)}
              min={1} max={100} step={1} suffix="%" className="w-32"
              disabled={!canEdit}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">内存阈值 %（alert.memThresholdPct）</Label>
            <PrecisionInput
              value={Number(values["alert.memThresholdPct"] ?? 85)}
              onChange={(n) => setLocal("alert.memThresholdPct", n)}
              min={1} max={100} step={1} suffix="%" className="w-32"
              disabled={!canEdit}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">磁盘阈值 %（alert.diskThresholdPct）</Label>
            <PrecisionInput
              value={Number(values["alert.diskThresholdPct"] ?? 85)}
              onChange={(n) => setLocal("alert.diskThresholdPct", n)}
              min={1} max={100} step={1} suffix="%" className="w-32"
              disabled={!canEdit}
            />
            <p className="text-[10px] text-muted-foreground">磁盘按 Docker 容器存储位置统计（DockerRootDir 优先）</p>
          </div>
        </div>
      </div>

      {/* ---- 分功能预警开关（两列） ---- */}
      <div className="rounded-md border bg-card p-3 space-y-3">
        <p className="text-sm font-medium">分功能预警开关（9 项）</p>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2">
          {ALERT_FEATURE_SWITCHES.map((s) => {
            const on = values[s.key] === true
            return (
              <div key={s.key} className="flex items-start gap-2.5 rounded-md border bg-muted/20 px-3 py-2">
                <Switch checked={on} onCheckedChange={(b) => setLocal(s.key, b)} disabled={!canEdit} aria-label={s.label} className="mt-0.5" />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm leading-tight">{s.label}</p>
                  <p className="text-xs text-muted-foreground leading-snug">{s.desc}</p>
                </div>
                {dirtyKeys.has(s.key) && <Badge className="bg-amber-500 hover:bg-amber-500 text-[10px] shrink-0 ml-auto">未保存</Badge>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}


// ============================================================
// r23-C：安全防护卡（SECURITY 分类）—— IP 自动封禁参数 + 2FA 管理员豁免
// ============================================================
function SecurityCard({ canEdit, values, dirtyKeys, busyKey, setLocal, saveItems }: CardFieldCtx) {
  const ipBanEnabled = values["security.ipBanEnabled"] === true
  const apiCountEnabled = values["security.ipBanApiCountEnabled"] === true
  const alertEnabled = values["security.ipBanAlertEnabled"] === true
  const exempt2fa = values["security.force2faAdminExempt"] === true
  const cardKeys = [...SECURITY_CARD_KEYS]
  const dirtyCount = cardKeys.filter((k) => dirtyKeys.has(k)).length
  const saving = busyKey === "security-card"

  return (
    <div className="lg:col-span-2 rounded-lg border border-red-200 bg-red-50/30 dark:border-red-900/50 dark:bg-red-950/10 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldBan className="h-4 w-4 text-red-500" />
          <span className="font-medium">安全防护（IP封禁与2FA策略）</span>
          {ipBanEnabled ? (
            <Badge className="bg-emerald-500 hover:bg-emerald-500">IP封禁开启</Badge>
          ) : (
            <Badge variant="destructive">IP封禁关闭</Badge>
          )}
        </div>
        {canEdit && (
          <Button
            size="sm"
            variant={dirtyCount > 0 ? "default" : "outline"}
            disabled={dirtyCount === 0 || saving}
            onClick={() => saveItems(cardKeys.filter((k) => dirtyKeys.has(k)), "security-card")}
          >
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            <Save className="mr-1 h-3.5 w-3.5" />
            保存安全防护设置（{dirtyCount} 项变更）
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        登录失败 / API-Key 无效调用按 IP 计数，窗口内超阈值自动封禁；封禁期内拒绝该 IP 的一切登录与 Key 调用。实时处置见「IP 封禁」管理页。
      </p>

      <div className="rounded-md border bg-card p-3 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm font-medium">IP 自动封禁（security.ipBanEnabled）</span>
          <Switch checked={ipBanEnabled} onCheckedChange={(b) => setLocal("security.ipBanEnabled", b)} disabled={!canEdit} aria-label="IP自动封禁开关" />
        </div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">封禁阈值（次）</Label>
            <PrecisionInput
              value={Number(values["security.ipBanThreshold"] ?? 10)}
              onChange={(n) => setLocal("security.ipBanThreshold", n)}
              min={1} max={1000} step={1} suffix="次" className="w-32"
              disabled={!canEdit}
            />
            <p className="text-[10px] text-muted-foreground">security.ipBanThreshold：窗口内失败达到该次数即封禁</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">计数窗口（分钟）</Label>
            <PrecisionInput
              value={Number(values["security.ipBanWindowMinutes"] ?? 15)}
              onChange={(n) => setLocal("security.ipBanWindowMinutes", n)}
              min={1} max={1440} step={1} suffix="分" className="w-32"
              disabled={!canEdit}
            />
            <p className="text-[10px] text-muted-foreground">security.ipBanWindowMinutes：失败计数的时间窗口</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">封禁时长（分钟）</Label>
            <PrecisionInput
              value={Number(values["security.ipBanMinutes"] ?? 30)}
              onChange={(n) => setLocal("security.ipBanMinutes", n)}
              min={1} max={10080} step={1} suffix="分" className="w-32"
              disabled={!canEdit}
            />
            <p className="text-[10px] text-muted-foreground">security.ipBanMinutes：自动封禁持续时长（手动封禁不受限）</p>
          </div>
        </div>
        <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2">
          <div className="flex items-start gap-2.5 rounded-md border bg-muted/20 px-3 py-2">
            <Switch checked={apiCountEnabled} onCheckedChange={(b) => setLocal("security.ipBanApiCountEnabled", b)} disabled={!canEdit} aria-label="API无效调用计数" className="mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm leading-tight">API-Key 无效调用计入封禁</p>
              <p className="text-xs text-muted-foreground leading-snug">security.ipBanApiCountEnabled：无效 Key 访问同样累计失败计数</p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 rounded-md border bg-muted/20 px-3 py-2">
            <Switch checked={alertEnabled} onCheckedChange={(b) => setLocal("security.ipBanAlertEnabled", b)} disabled={!canEdit} aria-label="封禁告警开关" className="mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm leading-tight">封禁产生安全告警</p>
              <p className="text-xs text-muted-foreground leading-snug">security.ipBanAlertEnabled：触发封禁时产生 SECURITY 告警</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md border bg-card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-amber-500" />
          <p className="text-sm font-semibold">多因素验证（2FA）强制策略</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">全局强制绑定 2FA</p>
              <p className="text-[11px] text-muted-foreground leading-snug">所有用户登录后未绑定 2FA 将被门控（仅可访问账号安全页完成绑定）。粒度：全局 &lt; 用户组 &lt; 用户表单 &lt; 2FA 管控菜单。</p>
            </div>
            <Switch checked={values["security.globalForce2fa"] === true} onCheckedChange={(b) => setLocal("security.globalForce2fa", b)} disabled={!canEdit} aria-label="全局强制2FA" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">用户组继承强制 2FA</p>
              <p className="text-[11px] text-muted-foreground leading-snug">用户组的"组级强制2FA"开关对成员生效（组管理表单可按组覆盖）。</p>
            </div>
            <Switch checked={values["security.groupInheritForce2fa"] === true} onCheckedChange={(b) => setLocal("security.groupInheritForce2fa", b)} disabled={!canEdit} aria-label="组继承强制2FA" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">强制 2FA 管理员豁免</p>
              <p className="text-[11px] text-muted-foreground leading-snug">SUPER_ADMIN/ADMIN 不受门控（保障应急通道；普通用户不受影响）。</p>
            </div>
            <Switch checked={exempt2fa} onCheckedChange={(b) => setLocal("security.force2faAdminExempt", b)} disabled={!canEdit} aria-label="2FA管理员豁免" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">人机验证码触发阈值</p>
              <p className="text-[11px] text-muted-foreground leading-snug">登录失败 N 次后要求图形验证码（0=始终要求；-1=从不）。</p>
              <PrecisionInput value={Number(values["security.captchaAfterFailures"] ?? 3)} min={-1} max={20} step={1} onChange={(v) => setLocal("security.captchaAfterFailures", Math.round(v))} disabled={!canEdit} className="mt-1 w-24" />
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5 sm:col-span-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">网页模式（纯网页内容显示）</p>
              <p className="text-[11px] text-muted-foreground leading-snug">允许用户在 VNC 会话进入"网页模式"：只显示网页内容、隐藏全部控制界面、期间不弹任何其他弹窗（Esc 退出）。用户级/组级可用权限锁 blockWebKiosk 单独禁止。全局关闭时所有人不可用。</p>
            </div>
            <Switch checked={values["security.allowWebKiosk"] === true} onCheckedChange={(b) => setLocal("security.allowWebKiosk", b)} disabled={!canEdit} aria-label="网页模式开关" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5 sm:col-span-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">VNC 远程声音回传</p>
              <p className="text-[11px] text-muted-foreground leading-snug">允许控制端收听沙箱浏览器声音（静音/音量控制在前端声音按钮）。用户级可用权限锁 blockVncAudio 单独禁止。</p>
            </div>
            <Switch checked={values["security.allowVncAudio"] === true} onCheckedChange={(b) => setLocal("security.allowVncAudio", b)} disabled={!canEdit} aria-label="VNC声音回传开关" />
          </div>
          <div className="flex items-start justify-between gap-3 rounded-md border p-2.5 sm:col-span-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">邮箱验证码发送前人机验证</p>
              <p className="text-[11px] text-muted-foreground leading-snug">发送邮箱验证码（登录/注册/找回/换绑）前必须先通过图形验证码 —— 防脚本刷码轰炸邮箱（r35 新增，配合每分钟 IP 限流与每邮箱频控）。</p>
            </div>
            <Switch checked={values["security.captchaOnEmailCode"] === true} onCheckedChange={(b) => setLocal("security.captchaOnEmailCode", b)} disabled={!canEdit} aria-label="邮箱验证码人机验证" />
          </div>
        </div>
      </div>
    </div>
  )
}


// ============================================================
// r23-C：配置生效自检 —— 键清单 + 当前值（脱敏）+ 生效状态徽章
// 数据由 server 端 page.tsx 计算（内置接线清单），仅 SUPER_ADMIN 下发
// ============================================================
function SelfCheckBlock({ data }: { data: SelfCheckData }) {
  return (
    <div className="rounded-lg border bg-card">
      <Collapsible>
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ListChecks className="h-4 w-4 text-teal-600" />
            <span className="font-medium">配置生效自检</span>
            <span className="text-xs text-muted-foreground">
              共 {data.rows.length} 项 · 生效 {data.activeCount} · 预留 {data.reservedCount}
            </span>
          </div>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              <ChevronDown className="mr-1 h-3.5 w-3.5" />
              展开键清单
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          {/* r34：改用 ScrollArea 修复「自检清单滑不动」 —— 原 max-h+overflow-y 在 CollapsibleContent
              动画容器内滚动失效（Radix 动画期间的 height 约束与原生滚动冲突）；ScrollArea 为独立滚动区 */}
          <ScrollArea className="h-[60vh] border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30%]">配置键</TableHead>
                  <TableHead className="w-[18%]">当前值</TableHead>
                  <TableHead className="w-[12%]">生效状态</TableHead>
                  <TableHead>说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono text-xs break-all">{r.key}</TableCell>
                    <TableCell className="font-mono text-xs max-w-48 truncate" title={r.value}>{r.value}</TableCell>
                    <TableCell>
                      {r.status === "active" ? (
                        <Badge className="bg-emerald-500 hover:bg-emerald-500 text-[10px]">✅ 生效中</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">⏸️ 功能预留</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.description || (r.status === "reserved" ? "功能预留：尚无运行时读取点" : "")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
          <p className="px-4 py-2 border-t text-[11px] text-muted-foreground">
            「生效中」= 存在真实读取点（任务调度 / 请求链路 / 策略门控等）；「功能预留」= 已落库但暂无运行时读取点，调整后不改变当前行为。
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// r29-a：硬件权限全局默认档卡片（触发全局 scope 对话框；仅超级管理员可保存 —— action 内校验）
function HardwareDefaultsCard() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Cpu className="mr-1 h-3.5 w-3.5" /> 编辑默认档
      </Button>
      <HardwarePermsDialog
        open={open}
        onOpenChange={setOpen}
        scope="global"
        targetName="全局默认档"
      />
    </>
  )
}
