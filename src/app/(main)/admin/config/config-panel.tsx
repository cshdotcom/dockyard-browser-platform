"use client"

// 系统配置交互面板：分类 Tabs + valueType 控件渲染（Switch/PrecisionInput/Input/Textarea）
// 逐项保存 / 分组整体保存 / 版本历史回滚；管理员只读（无保存按钮）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Save, RotateCcw, History, Wrench, Lock, ShieldAlert, Mail } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
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

const CATEGORY_ORDER = ["SECURITY", "SESSION", "STORAGE", "ALERT", "MAIL", "NETWORK", "UI", "GENERAL", "MCP"] as const

const CATEGORY_LABEL: Record<string, string> = {
  SECURITY: "安全",
  SESSION: "会话",
  STORAGE: "存储",
  ALERT: "告警",
  MAIL: "邮件",
  NETWORK: "网络",
  UI: "界面",
  GENERAL: "通用",
  MCP: "MCP 网关",
}

// 长文本配置项用 Textarea（维护公告 / 登录页公告等）
const LONG_TEXT_KEYS = new Set(["maintenance.message", "ui.loginAnnouncement"])

function jsonPreview(v: unknown, max = 90): string {
  const s = JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + "…" : s
}

export function ConfigPanel({
  items,
  versions,
  canEdit,
}: {
  items: ConfigItem[]
  versions: ConfigVersionRow[]
  canEdit: boolean
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
    return (
      <div key={item.key} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4">
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

      {/* ---- 分类 Tabs ---- */}
      <Tabs defaultValue={CATEGORY_ORDER[0]} className="w-full">
        <TabsList className="flex-wrap h-auto gap-1">
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

        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => {
          const allList = byCategory.get(c) || []
          // MAIL 分类：smtp.* 由专属卡片管理，通用行仅渲染其余项
          const list = c === "MAIL" ? allList.filter((i) => !i.key.startsWith("smtp.")) : allList
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
                {c === "MAIL" && <SmtpCard canEdit={canEdit} initial={smtpInitial} />}
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
