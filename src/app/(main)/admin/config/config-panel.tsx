"use client"

// 系统配置交互面板：分类 Tabs + valueType 控件渲染（Switch/PrecisionInput/Input/Textarea）
// 逐项保存 / 分组整体保存 / 版本历史回滚；管理员只读（无保存按钮）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Save, RotateCcw, History, Wrench, Lock, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfirmDialog, PrecisionInput } from "@/components/shared/confirm"
import { setConfigAction, rollbackConfigAction } from "@/server/actions/config"

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

const CATEGORY_ORDER = ["SECURITY", "SESSION", "STORAGE", "ALERT", "NETWORK", "UI", "GENERAL", "MCP"] as const

const CATEGORY_LABEL: Record<string, string> = {
  SECURITY: "安全",
  SESSION: "会话",
  STORAGE: "存储",
  ALERT: "告警",
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
      <div className="grid gap-4 lg:grid-cols-2">
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
          const list = byCategory.get(c) || []
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
              <div className="grid gap-3 lg:grid-cols-2">
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
